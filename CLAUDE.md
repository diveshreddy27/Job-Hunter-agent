# CLAUDE.md

This file provides guidance to Claude Code when working in this repo.

## Project overview

Personal job-hunting automation for a Data Engineer candidate. Scrapes LinkedIn recruiter posts, extracts structured fields with Gemini AI, scores each job against the candidate's resume, and surfaces results in a React dashboard.

**4-stage fully concurrent pipeline:**

```
Stage 1 SCRAPE          Stage 2 EXTRACT           Stage 3 FILTER           Stage 4 SCORE
──────────────          ───────────────           ──────────────           ─────────────
Playwright bot     →    Gemini AI parses     →    Location + exp      →    Unified model
minimal pre-filter       raw queue files           + contract + email        cascade (Gemini
writes data/queue/       inserts ALL posts         rules → target_jobs       + Groq) vs resume
*.json batch files       into raw + norm DB        deletes batch file        writes ats_scores
                         then deletes file         after final pass
```

Stages 1+2 run concurrently (producer/consumer). Stages 3+4 run concurrently and continuously
alongside Stage 2, polling for new data as it arrives. All 4 stages start before the scraper
begins, so scoring happens in real-time as posts flow through the pipeline.

---

## Commands

```bash
# Install (Python)
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python -m playwright install-deps   # Linux/WSL only

# Install (Node — dashboard frontend)
cd dashboard/frontend && npm install

# Run full pipeline
python main.py                       # past 24h, headless
python main.py --days 7              # past week
python main.py --days 30 --limit 50  # past month, capped at 50
python main.py --visible             # show browser window

# Run dashboard (both servers)
./start_dashboard.sh
# Flask API → http://localhost:5000
# React UI  → http://localhost:5173

# CLI inspection (no dashboard)
python scripts/view_jobs.py      # all normalized_posts
python scripts/view_scores.py    # ats_scores > 60, sorted by score

# Train local NER model
python model/train.py                    # incremental — only new (is_trained='not_trained') posts
python model/train.py --all              # retrain from scratch, ignores is_trained flag
python model/train.py --iters 40 --min 50
# Or trigger via dashboard: POST /api/train-ner
```

---

## File map

```
main.py                          entry point: argparse + thread orchestration for all 4 stages
settings.py                      global config — filter rules, model cascade definitions
                                   (secrets loaded from .env via python-dotenv)
.env.example                     copy → .env, fill in API keys + credentials
start_dashboard.sh               bash script: starts Flask (5000) + Vite (5173) together

config/
  candidate_profile.py           [gitignored] personal details injected into outreach emails
  linkedin_cookies.json          [gitignored] saved LinkedIn session; delete to force re-login

prompts/
  ats_prompt.txt                 system prompt for ATS scoring API call
  email_builder_prompt.txt       prompt template for cold outreach email generation

scripts/
  view_jobs.py                   CLI: print all normalized_posts to terminal
  view_scores.py                 CLI: print ats_scores > 60 with full breakdown

pipeline/
  scraper/
    linkedin_scraper.py          Stage 1: Playwright login, search, infinite-scroll posts feed;
                                   minimal pre-filter (URN + non-empty content only);
                                   writes raw post dicts to StagingWriter buffer
    extractor.py                 Stage 2 helper: _normalize() routes to local NER or Gemini;
                                   _normalize_with_gemini() builds prompt, calls API, applies
                                   two post-processing fixes:
                                     Fix 1: derive location_state from city via INDIA_STATES map
                                     Fix 2: regex fallback for experience_max when Gemini misses it
    location_utils.py            regex helpers: extract_location, extract_experience,
                                   extract_salary, extract_recruiter_email, detect_work_mode,
                                   is_india_job, is_contract_role, experience_in_range
  staging/
    writer.py                    StagingWriter: buffers posts, flushes to data/queue/*.json
                                   at STAGING_BATCH_SIZE (default 10)
    processor.py                 daemon thread (Stage 2 worker):
                                   - polls data/queue/*.json every 2s
                                   - dedup check: skips URN already in raw_posts (no Gemini call)
                                   - calls _normalize() → Gemini (or local NER)
                                   - _ingest(raw, norm): inserts into raw_posts + normalized_posts
                                   - deletes batch file after processing
                                   - exits when stop_event set AND queue is empty
  ats/
    filter.py                    Stage 3: reads normalized_posts not yet in target_jobs;
                                   applies 4 ordered business filters:
                                     1. location (city/state/remote/null)
                                     2. experience overlap with candidate window
                                     3. contract/freelance role check
                                     4. recruiter email present (REQUIRE_EMAIL_FOR_INGESTION)
                                   passing posts → target_jobs
    scorer.py                    Stage 4: unified model cascade scorer with 3 parallel workers;
                                   pulls unscored target_jobs continuously; on 429 skips model
                                   until reset window; on 503 retries 3×; writes ats_scores
  outreach/
    builder.py                   reads prompt + resume + job data, calls AI cascade,
                                   returns {subject, body, model_used}
    sender.py                    Gmail SMTP sender — attaches resume PDF, sends to recruiter

db/
  schema.sql                     CREATE TABLE for all 5 tables + indexes
  database.py                    all DB helpers: insert_raw_post (accepts scraped_at),
                                   insert_normalized_post, insert_target_job, insert_ats_score,
                                   get_pending_raw_posts, get_unscored_targets,
                                   get_untrained_normalized_posts, mark_posts_trained,
                                   stats, flush_all

data/                            [gitignored] runtime data — never committed
  linkedin_scraper.db            SQLite database (WAL mode)
  model_usage/                   daily RPD counters persisted across runs
  queue/                         live batch files (data/queue/raw/) consumed by processor

dashboard/
  app.py                         Flask API server — REST endpoints only, no page rendering;
                                   auto-creates job_tracker table on startup;
                                   normalizes probabilities via normalize_prob()
  frontend/
    index.html                   SPA shell: Tailwind CDN + CSS-variable theme tokens (light/dark)
                                   + Material Symbols + Google Fonts; theme bootstrap script
    vite.config.js               Vite with /api proxy → http://localhost:5000
    src/
      main.jsx                   React entry point
      App.jsx                    BrowserRouter + 9 routes (/leaderboard redirects to /jobs)
      index.css                  minimal body reset (Tailwind via CDN)
      components/Layout.jsx      sidebar (grouped nav, theme toggle, pipeline status panel)
                                   + topbar (search, Run Pipeline btn with live status polling)
      components/charts.jsx      dependency-free SVG charts: DonutChart, AreaChart, HBarList,
                                   ColumnChart, ScoreRing, GrowBar — colors from CSS vars
      components/ui.jsx          PageHeader, Card, StatCard, ScoreChip, ModePill, TrackerBadge,
                                   TRACKER_META, EmptyState, Loading, input/select classes
      pages/Overview.jsx         landing: KPI cards · funnel w/ conversion % · score donut ·
                                   work-mode donut · scrape trend · top jobs · extraction health
      pages/Analytics.jsx        market insights: skill demand · companies · apply channels ·
                                   experience donut · locations · score trend · resume profile
      pages/Jobs.jsx             filterable jobs table (score/mode/search/sort) + save-to-tracker
      pages/Tracker.jsx          application tracker kanban: saved→applied→interviewing→offer/rejected
      pages/AtsDetail.jsx        full job breakdown: sub-scores · skills · predictions · tracker control
      pages/SkillsGap.jsx        gap skill bars · avg score ring · top resume changes · keyword cloud
      pages/Recruiters.jsx       recruiter directory with search
      pages/RawData.jsx          paginated raw posts browser

model/
  train.py                       incremental spaCy NER trainer — reads normalized_posts WHERE
                                   is_trained='not_trained', marks them trained after success;
                                   --all flag retrains from scratch on all posts
  predict.py                     LocalExtractor class: NER + regex, same API as Gemini extractor
  linkedin_ner/                  trained spaCy model (JOB_TITLE, COMPANY, SKILL)

utils/
  model_tracker.py               ModelUsageTracker: tracks daily RPD counts per Gemini model;
                                   models over their RPD quota are permanently skipped until
                                   tomorrow; persists across scorer workers via shared instance

prompts/ats_prompt.txt           system prompt for the ATS scoring API call
resume/                          drop resume here (.pdf or .txt) — scorer auto-detects
config/
  linkedin_cookies.json          saved LinkedIn session (auto-created; delete to force re-login)
  resume.json                    structured resume (optional, unused by current pipeline)
view_jobs.py                     CLI: print all normalized_posts to terminal
view_scores.py                   CLI: print ats_scores > 60 with full breakdown
```

---

## Stage 1 — Scraper (`scraper/linkedin_scraper.py`)

**What it does:**
- Playwright-driven Chromium browser, runs headless by default
- Logs into LinkedIn using cookie cache (`config/linkedin_cookies.json`); re-authenticates if expired
- Searches LinkedIn with `LINKEDIN_SEARCH_QUERY`, filtered by `--days` (rounds to 1/7/30)
- Scrapes the **Posts feed** (infinite scroll) via `LINKEDIN_SCRAPE_POSTS=True`
- Jobs tab (`LINKEDIN_SCRAPE_JOBS`) is wired but no-op — not connected to DB yet
- Stops after `POSTS_END_OF_FEED_ROUNDS` (default 3) consecutive rounds with no new posts

**Pre-filter (minimal — just enough to avoid garbage):**
1. `activity_urn` must be resolvable from card DOM
2. Post body must have non-empty text

All business-logic filtering (India, experience, contract, email) is deliberately **not here** —
Gemini normalizes first, then deterministic rules decide in Stage 3.

**Output:** raw post dicts buffered in `StagingWriter`; flushed to `data/queue/raw/batch_TIMESTAMP.json`
every `STAGING_BATCH_SIZE` (default 10) posts. Final flush on scraper exit.

---

## Stage 2 — Extractor / Processor (`pipeline/staging/processor.py` + `pipeline/scraper/extractor.py`)

**What it does (daemon thread, starts before scraper):**
- Polls `data/queue/raw/*.json` every 2 seconds
- For each batch file, processes posts one by one:

  1. **Dedup check** — queries `raw_posts WHERE activity_urn = ?`; skips if already in DB (no Gemini call wasted)
  2. **`_normalize(raw)`** — routes to local NER model (when `USE_LOCAL_MODEL=True`) or Gemini API
  3. **`_ingest(raw, norm)`** — atomically inserts into `raw_posts` + `normalized_posts`, preserves original `scraped_at` from batch file; returns `False` on duplicate URN (race condition guard)
  4. **Deletes batch file** — once all posts in the file are processed (no `processed/` directory; data is in DB)

- Exits when `stop_event` is set (scraper done) AND `data/queue/raw/` is empty

**Gemini extraction features:**
- Model: `GEMINI_EXTRACT_MODEL` (default `gemini-3.1-flash-lite`, 1000 RPD free tier)
- Rate limit: `REQUEST_DELAY = 4.5s` between calls (15 RPM headroom)
- RPD tracking: `ModelUsageTracker` skips model if daily quota hit
- Returns structured JSON: title, company, location, experience, skills, recruiter email, apply info
- **Fix 1:** derives `location_state` from city via `INDIA_STATES` map when Gemini leaves state null
- **Fix 2:** regex fallback for `experience_max` when Gemini returns only min

**Local NER fallback:**
- When `USE_LOCAL_MODEL=True`, tries spaCy NER model first; falls back to Gemini if no title extracted
- Trained on `normalized_posts` (same data the pipeline produces)

---

## Stage 3 — Filter (`ats/filter.py`)

**What it does (background thread, polls every 15s):**
- Reads `normalized_posts LEFT JOIN target_jobs WHERE t.id IS NULL` — all posts not yet filtered
- Applies 4 ordered checks to each post (all must pass):

| # | Filter | Logic |
|---|--------|-------|
| 1 | **Location** | city in `ATS_TARGET_CITIES` OR state in `ATS_TARGET_STATES` OR `is_remote=1` OR (both null AND `ATS_INCLUDE_NULL_LOCATION=True`) |
| 2 | **Experience** | `exp_min ≤ ATS_CANDIDATE_EXP_MAX AND exp_max ≥ ATS_CANDIDATE_EXP_MIN` (or both null → pass) |
| 3 | **Contract** | `role_type != 'contract'` AND `is_contract_role(post_content)` is False |
| 4 | **Email** | `recruiter_email` is non-null (when `REQUIRE_EMAIL_FOR_INGESTION=True`) |

- Passing posts → `target_jobs` (insert; skip on duplicate)
- Logs PASS/SKIP reason for every post
- Runs a **final pass** after scraper_done event, then sets `filter_done` to unblock scorer exit

---

## Stage 4 — Scorer (`ats/scorer.py`)

**What it does (3 parallel worker threads):**
- Continuously pulls unscored `target_jobs` from DB via `get_unscored_targets()`
- `in_flight` set prevents two workers picking up the same job
- Each worker runs the **unified model cascade** for every job:

**Unified model cascade (`ATS_UNIFIED_MODELS`, best → worst quality):**

| Priority | Model | API | Notes |
|----------|-------|-----|-------|
| 1 | `gemini-3.5-flash` | Gemini | Best quality, 20 RPD |
| 2 | `gemini-2.5-flash` | Gemini | Thinking model, 20 RPD |
| 3 | `meta-llama/llama-4-scout-17b-16e-instruct` | Groq | Llama 4, newest |
| 4 | `llama-3.3-70b-versatile` | Groq | 70B workhorse |
| 5 | `gemini-3.1-flash-lite` | Gemini | 1000 RPD workhorse |
| 6 | `gemini-2.5-flash-lite` | Gemini | 1000 RPD fallback |
| 7 | `qwen/qwen3-32b` | Groq | Groq fallback |
| 8 | `gemma-4-31b-it` | Gemini | 1440 RPD |
| 9 | `gemma-4-26b-a4b-it` | Gemini | 1440 RPD |
| 10 | `llama-3.1-8b-instant` | Groq | Smallest, last resort |

**Rate-limit handling:**
- `_AvailabilityTracker` — shared across all 3 workers
  - On **429**: marks model unavailable for `reset_seconds` (parsed from response headers/body); cascade skips it
  - After successful Groq call: proactively marks limited when `remaining_tokens < GROQ_SCORE_MIN_TOK_REMAINING (4000)`
  - `wait_for_any()`: blocks until the soonest model resets when ALL eligible models are limited
- `ModelUsageTracker` — daily RPD counts for Gemini models; permanently skips exhausted models until tomorrow
- On **503**: retries up to 3× with 10s/20s backoff
- Always starts from index 0 (best model) per job — better models are re-tried once their window resets
- Up to 10 cascade rounds before giving up on a job

**Scoring output (per job → `ats_scores`):**
- `final_ats_score` (0–100)
- 11 sub-scores: keyword_match, semantic_alignment, technical_skills, experience_relevance,
  project_alignment, impact, ats_structure, recruiter_readability, seniority_fit, domain_fit, tailoring_readiness
- 4 probabilities: ats_pass, shortlist, interview, rejection (stored 0–100; normalize on read if > 1)
- JSON arrays: matched_skills, critical_gap_skills, resume_strengths, resume_weaknesses,
  priority_changes, keyword_injections
- `raw_response` (full JSON for ML training), `model_used`, `provider`, `scored_at`

**Exit condition:** `filter_done` event is set AND no more unscored jobs remain

---

## Thread orchestration (`main.py`)

```
startup:
  db.init_db()
  extractor thread  (daemon)        ← starts first
  filter_loop thread (daemon)       ← starts second
  scorer thread (daemon, 3 workers) ← starts third
  scraper (main thread)             ← runs last

shutdown sequence:
  scraper finishes → staging_writer.flush() → stop_extractor.set()
  extractor.join(timeout=3600)      ← wait up to 60 min to drain all Gemini calls
  scraper_done.set()                ← tells filter loop to do final pass
  filter_thread.join()              ← wait for final pass + filter_done.set()
  scorer_thread.join()              ← wait for all queued jobs to be scored
  db.stats() → final log summary
```

Two threading events coordinate the shutdown:
- `scraper_done` — set after extractor fully drains data/queue/raw/; triggers filter's final pass
- `filter_done` — set after filter's final pass; allows scorer workers to exit

---

## Database — 5 tables

`db/linkedin_scraper.db` (SQLite, WAL mode). All pipeline writes go through `db/database.py`.
`job_tracker` is written only by `dashboard/app.py`.

### `raw_posts`
Source of truth. One row per unique LinkedIn post (dedup by `activity_urn`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | auto-increment |
| `activity_urn` | TEXT UNIQUE | `urn:li:activity:NNN` — cross-run dedup key |
| `post_url` | TEXT | full LinkedIn post URL |
| `post_content` | TEXT | verbatim post text |
| `post_author` | TEXT | recruiter display name |
| `author_headline` | TEXT | recruiter's LinkedIn headline |
| `profile_url` | TEXT | recruiter's LinkedIn profile |
| `days_filter` | INTEGER | 1, 7, or 30 |
| `scraped_at` | TEXT | original scrape time from batch file (ISO 8601) |
| `extraction_status` | TEXT | `pending` → `done` or `failed` |
| `extracted_at` | TEXT | when extraction completed |
| `extract_error` | TEXT | error string if failed |

### `normalized_posts`
Structured fields extracted by Gemini (or local NER). 1-to-1 FK to `raw_posts`.
**All posts live here** — including ones filtered out in Stage 3.
This is the training dataset for the local NER model.

Key columns: `title`, `company`, `location_city`, `location_state`, `is_remote` (0/1),
`work_mode` (remote/hybrid/onsite), `experience_min/max`, `skills` (CSV),
`recruiter_email/name/designation/current_company`, `apply_via`, `apply_url`,
`extracted_by` (gemini/local_ner), `created_at`,
`is_trained` (`not_trained` → `trained` after NER training run).

### `target_jobs`
Posts that passed **all 4** Stage 3 filters. Bridge to `ats_scores`.

Columns: `norm_post_id` (UNIQUE FK), `raw_post_id` (shortcut FK), `filtered_at`.

### `ats_scores`
Full ATS evaluation. One row per `target_job` (UNIQUE on `target_job_id`).

Key columns: `final_ats_score` (0–100), 11 sub-scores, 4 probabilities (stored 0–100;
normalize on read via `normalize_prob()` if > 1 divide by 100), JSON arrays: `matched_skills`,
`critical_gap_skills`, `resume_strengths`, `resume_weaknesses`, `priority_changes`,
`keyword_injections`, `raw_response` (full API JSON for ML training), `model_used`,
`provider` (gemini/groq), `scored_at`.

### `job_tracker`
Application tracker, driven by dashboard UI only. Auto-created by `dashboard/app.py`.

Columns: `target_job_id` (UNIQUE FK), `status` (saved|applied|interviewing|offer|rejected),
`notes`, `updated_at`.

---

## Dashboard API endpoints

All under `/api/` — Flask server on port 5000, proxied by Vite on port 5173.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats` | GET | overview counts, funnel (today's scraped/extracted/filtered/scored), score bands, work modes, scrape-by-date chart |
| `/api/analytics` | GET | market insights: top companies/skills/locations, exp buckets, apply channels, avg sub-scores, score trend, extracted_by breakdown |
| `/api/jobs` | GET | scored jobs (incl. `tracker_status`); params: `score_min`, `work_mode`, `q`, `sort` (score/date/interview) |
| `/api/jobs/<id>` | GET | full job detail for ATS detail page (incl. tracker status/notes) |
| `/api/skills-gap` | GET | critical_gap_skills frequency across all ats_scores, top 20 |
| `/api/recruiters` | GET | unique recruiters grouped by email; includes avg/best score, post count |
| `/api/raw-posts` | GET | paginated raw_posts joined with normalized + scores; params: `page`, `limit`, `q` |
| `/api/tracker` | GET | all tracked jobs with status + job info + interview probability |
| `/api/tracker/<target_id>` | POST | upsert `{status, notes}`; status ∈ saved/applied/interviewing/offer/rejected |
| `/api/tracker/<target_id>` | DELETE | remove job from tracker |
| `/api/pipeline-status` | GET | `running` flag, pending extraction count, unscored targets, last run time |
| `/api/run-pipeline` | POST | spawns `python main.py` as background subprocess (no-op if already running) |
| `/api/train-ner/status` | GET | NER training state: running, last_run, untrained_count, error |
| `/api/train-ner` | POST | trigger incremental NER training in background; body `{"all":true}` to retrain from scratch |

---

## NER training lifecycle

Goal: replace Gemini extraction (Stage 2) with a local spaCy model trained on accumulated data.

```
Every Gemini call → normalized_posts (is_trained='not_trained')
                         │
          POST /api/train-ner  (or  python model/train.py)
                         │
     reads WHERE is_trained='not_trained' AND title IS NOT NULL
     trains JOB_TITLE, COMPANY, SKILL entities
     marks processed rows → is_trained='trained'
                         │
          next call trains only on NEW posts (incremental)
```

Once model quality is acceptable: set `USE_LOCAL_MODEL = True` in `settings.py`.
Gemini remains active as fallback when local model returns no title.

---

## settings.py key variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SCRAPE_LINKEDIN_EMAIL/PASSWORD` | — | LinkedIn scraping account credentials |
| `LINKEDIN_SEARCH_QUERY` | `'"Data Engineer" and "hiring" and "aws"'` | LinkedIn search query |
| `CANDIDATE_EXPERIENCE_MIN/MAX` | 2.0 / 4.0 | Informational only; real filter is Stage 3 |
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `GROQ_API_KEY` | — | Groq console key (prefix `gsk_`, NOT xAI's `xai-`) |
| `GEMINI_EXTRACT_MODEL` | `gemini-3.1-flash-lite` | Extraction model (Stage 2), 1000 RPD |
| `GEMINI_MODEL_LIMITS` | see settings.py | RPD caps per model for daily quota tracking |
| `ATS_UNIFIED_MODELS` | 10-model list | Scorer cascade ordered best → worst quality |
| `GROQ_SCORE_MIN_TOK_REMAINING` | 4000 | Proactive Groq token guard threshold |
| `ATS_TARGET_CITIES/STATES` | Hyderabad, Mumbai, etc. | Stage 3 location filter |
| `ATS_CANDIDATE_EXP_MIN/MAX` | 2.0 / 4.0 | Stage 3 experience filter |
| `ATS_INCLUDE_REMOTE` | True | Remote jobs always pass Stage 3 location check |
| `ATS_INCLUDE_NULL_LOCATION` | True | Unknown location → keep (don't miss opportunities) |
| `REQUIRE_EMAIL_FOR_INGESTION` | True | Stage 3 drops posts with no recruiter email |
| `USE_LOCAL_MODEL` | False | Use trained spaCy NER instead of Gemini for extraction |
| `SCRAPE_HEADLESS` | True | Show browser window when False |
| `SCRAPE_MAX_PAGES` | 40 | Jobs tab pagination ceiling |
| `LINKEDIN_SCRAPE_POSTS` | True | Enable Posts tab scraping |
| `LINKEDIN_SCRAPE_JOBS` | False | Jobs tab (wired but no-op) |
| `STAGING_DIR` | `staging` | Directory for scraper→processor file queue |
| `STAGING_BATCH_SIZE` | 10 | Posts per staging batch file |
| `INDIA_STATES` | city→state map | Used by extractor Fix 1 to derive missing state |

---

## Notes

- `config/linkedin_cookies.json` is auto-created on first login. Delete it to force fresh login.
- `--days` is rounded UP to LinkedIn's bucket (1/7/30).
- Re-running is safe — `UNIQUE(activity_urn)` on `raw_posts` makes inserts idempotent.
- Probability columns in `ats_scores` are inconsistently returned by models (0–1 or 0–100).
  `dashboard/app.py` normalizes via `normalize_prob()`. Always read probabilities through the API.
- `view_scores.py` uses its own `pct()` helper that handles both formats.
- **No `data/queue/processed/` directory** — batch files are deleted immediately after their posts
  are written to the DB. The data lives in SQLite; the files are ephemeral.
- `data/queue/training/training_data.jsonl` is a legacy file from the pre-DB architecture.
  `model/train.py` still reads it as a fallback for URNs not in the DB, but it's effectively
  obsolete as the DB accumulates posts.
- The React frontend uses Tailwind CSS via CDN (not PostCSS build-time) because node_modules
  on the Windows/WSL filesystem have corrupted package.json files that break PostCSS plugin
  loading. Classes are JIT-compiled in the browser. If `npm run dev` fails with
  "Error parsing …/package.json: not valid JSON", a node_modules file got NUL-corrupted —
  fix with `rm -rf node_modules/<pkg> && npm install <pkg> --no-save`.
- Theming: light/dark via CSS variables in `index.html` (`:root` = light, `.dark` = dark)
  mapped to semantic Tailwind tokens (`bg`, `surface`, `ink`, `muted`, `accent`, `line`,
  `--chart-1..6`). Charts in `charts.jsx` reference `rgb(var(--…))` directly so they
  re-theme automatically. Toggle persists to `localStorage('jh-theme')`; head script applies
  it before first paint. When adding UI: use semantic tokens, never hardcode hex colors.
- `db/database.py` runs additive migrations on `init_db()`: adds `skills`, `is_trained`
  columns to `normalized_posts` if missing; adds `tailored_resume_path`, `provider` columns
  to `ats_scores` if missing; collapses legacy `UNIQUE(target_job_id, provider)` constraint
  on `ats_scores` to `UNIQUE(target_job_id)` (one score per job).
