# CLAUDE.md

This file provides guidance to Claude Code when working in this repo.

## Project overview

Personal job-hunting automation for a Data Engineer candidate. Scrapes LinkedIn recruiter posts, extracts structured fields with Gemini AI, scores each job against the candidate's resume, surfaces results in a React dashboard, and sends cold-outreach emails interactively.

**4-stage fully concurrent pipeline:**

```
Stage 1 SCRAPE          Stage 2 EXTRACT           Stage 3 FILTER           Stage 4 SCORE
──────────────          ───────────────           ──────────────           ─────────────
Playwright bot     →    Gemini AI parses     →    Location + exp      →    Unified model
extracts posted_at       raw queue files           + contract + email        cascade (Gemini
from "X hours ago"       inserts ALL posts         + cloud detection         + Groq) vs resume
writes data/queue/       into raw + norm DB        + foreign remote          writes ats_scores
*.json batch files       (email_subject_format      check → target_jobs
                          email_required_fields)    deletes batch file
                         then deletes file          after final pass
```

Stages 1+2 run concurrently (producer/consumer). Stages 3+4 run concurrently and continuously
alongside Stage 2, polling for new data as it arrives. All 4 stages start before the scraper
begins, so scoring happens in real-time as posts flow through the pipeline.

**Email outreach** (separate CLI, not part of pipeline):
```
scripts/send_outreach.py  →  filter by posted_at + cloud_fit + ATS score
                          →  show full job details  →  y/n/q per job  (or --auto-send)
                          →  AI generates email (candidate_info.txt + resume + post)
                          →  Gmail SMTP send with resume attached
                          →  logs to email_outreach + marks job_tracker 'applied'
```

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

# Re-score after editing resume / ats_prompt.txt (snapshots to data/scores_history.json)
python scripts/rescore.py                    # archive current scores, clear, rescore all
python scripts/rescore.py --label v3         # custom archive label
python scripts/compare_scores.py             # diff last two snapshots
python scripts/compare_scores.py --list      # list available snapshots

# Email outreach CLI
python scripts/send_outreach.py              # past 24h · aws_match · ATS ≥ 50  (interactive y/n/q)
python scripts/send_outreach.py --min-score 65
python scripts/send_outreach.py --hours 48
python scripts/send_outreach.py --min-score 0 --auto-send   # batch-send ALL matched jobs, no prompts
# Every send (success or failure) is logged to email_outreach; tracker auto-marked 'applied'

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
  candidate_info.txt             [gitignored] flat text file — all personal details for email builder
                                   format: KEY: value, missing fields marked (not provided)
  candidate_info.example.txt     committed dummy-data template — copy → candidate_info.txt
  linkedin_cookies.json          [gitignored] saved LinkedIn session; delete to force re-login

prompts/
  ats_prompt.txt                 system prompt for ATS scoring API call
  email_builder_prompt.txt       3-source prompt: [MY_INFO] + [MY_RESUME] + [RAW_POST]
                                   AI extracts subject, body, missing_fields from these three inputs

scripts/
  view_jobs.py                   CLI: print all normalized_posts to terminal
  view_scores.py                 CLI: print ats_scores > 60 with full breakdown
  send_outreach.py               Outreach CLI — filters by posted_at + cloud_fit + ATS score;
                                   shows full job detail; y/n/q per job OR --auto-send to batch;
                                   generates email via AI cascade + sends via Gmail SMTP;
                                   logs every send to email_outreach; marks tracker 'applied'
  rescore.py                     archive current scores → data/scores_history.json, clear
                                   ats_scores, re-run the scorer cascade on all target_jobs
                                   (use after editing the resume or ats_prompt.txt)
  compare_scores.py              diff two score snapshots in data/scores_history.json — shows
                                   which jobs moved up/down; --list to see available snapshots
  adhoc/                         one-time / migration scripts — run manually when needed
    backfill_country.py          back-fills location_country on existing target_jobs by calling
                                   Gemini with a lightweight single-field prompt;
                                   dry-run by default, --apply to write to DB

pipeline/
  scraper/
    linkedin_scraper.py          Stage 1: Playwright login, search, infinite-scroll posts feed;
                                   minimal pre-filter (URN + non-empty content only);
                                   extracts "X hours ago" text → posted_at absolute timestamp;
                                   writes raw post dicts to StagingWriter buffer
    extractor.py                 Stage 2 helper: _normalize() routes to local NER or Gemini;
                                   _normalize_with_gemini() builds prompt, calls API, applies
                                   post-processing fixes:
                                     Fix 1: derive location_state from city via INDIA_STATES map
                                     Fix 2: regex fallback for experience_max when Gemini misses it
                                   also extracts: email_subject_format, email_required_fields
    location_utils.py            regex helpers: extract_location, extract_experience,
                                   extract_salary, extract_recruiter_email, detect_work_mode,
                                   is_india_job, is_contract_role, experience_in_range,
                                   parse_posted_hours, extract_locations (GeoText country detection)
                                   _FOREIGN_HARD: explicit foreign markers (LATAM, MENA, GCC, etc.)
  staging/
    writer.py                    StagingWriter: buffers posts, flushes to data/queue/*.json
                                   at STAGING_BATCH_SIZE (default 10)
    processor.py                 daemon thread (Stage 2 worker):
                                   - polls data/queue/*.json every 2s
                                   - dedup check: skips URN already in raw_posts (no Gemini call)
                                   - on dedup: calls backfill_posted_at() to update timestamp
                                   - calls _normalize() → Gemini (or local NER)
                                   - _ingest(raw, norm): inserts into raw_posts + normalized_posts
                                   - deletes batch file after processing
                                   - exits when stop_event set AND queue is empty
  ats/
    filter.py                    Stage 3: reads normalized_posts not yet in target_jobs;
                                   applies 4 ordered business filters + cloud detection:
                                     1. location (city/state/remote/null)
                                        remote: also runs is_india_job() — rejects posts
                                        mentioning foreign countries (Nigeria, LATAM, etc.)
                                     2. experience overlap with candidate window
                                     3. contract/freelance role check
                                     4. recruiter email present (REQUIRE_EMAIL_FOR_INGESTION)
                                   detect_clouds(): scans post + skills for AWS/GCP/Azure keywords;
                                   strips #hashtags before matching (reach tags ≠ requirements);
                                   sets clouds_required (csv) + cloud_fit (aws_match/no_cloud_req/
                                   other_cloud_only) on insert → target_jobs
    scorer.py                    Stage 4: unified model cascade scorer with 3 parallel workers;
                                   pulls unscored target_jobs continuously; on 429 skips model
                                   until reset window; on 503 retries 3×; writes ats_scores
  outreach/
    builder.py                   reads candidate_info.txt + resume + raw post content;
                                   fills [MY_INFO]/[MY_RESUME]/[RAW_POST] placeholders in prompt;
                                   calls Gemini/Groq cascade; parses {subject, body, missing_fields};
                                   appends missing fields to data/missing_fields.json
    sender.py                    Gmail SMTP sender — attaches resume PDF, sends to recruiter

db/
  schema.sql                     CREATE TABLE for all 5 tables + indexes
  database.py                    all DB helpers: insert_raw_post (accepts scraped_at + posted_at),
                                   backfill_posted_at (UPDATE WHERE posted_at IS NULL),
                                   insert_normalized_post, insert_target_job (clouds_required,
                                   cloud_fit), insert_ats_score, get_pending_raw_posts,
                                   get_unscored_targets, get_untrained_normalized_posts,
                                   mark_posts_trained, stats, flush_all

data/                            [gitignored] runtime data — never committed
  linkedin_scraper.db            SQLite database (WAL mode)
  model_usage/                   daily RPD counters persisted across runs
  queue/                         live batch files (data/queue/raw/) consumed by processor
  scores_history.json            score snapshots written by scripts/rescore.py;
                                   read by scripts/compare_scores.py to diff resume changes
  missing_fields.json            recruiter-requested fields absent from candidate_info.txt

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
      App.jsx                    BrowserRouter + 10 routes (/leaderboard redirects to /jobs)
      index.css                  minimal body reset (Tailwind via CDN)
      components/Layout.jsx      glass sidebar (gradient brand, grouped nav w/ active rail,
                                   theme toggle, pipeline status w/ live ping) + glass topbar
                                   (search, gradient Run Pipeline btn with live status polling)
      components/charts.jsx      dependency-free SVG charts: DonutChart, AreaChart (glow line),
                                   HBarList, ColumnChart, ScoreRing, GrowBar — colors from CSS vars
      components/ui.jsx          PageHeader (gradient title), Card (glass + optional hover),
                                   StatCard (glow icon tile), ScoreChip (conic progress ring),
                                   ModePill, TrackerBadge, TRACKER_META, CloudFitPill, CloudChips,
                                   CLOUD_FIT_META, relativeTime(), EmptyState, Loading, Skeleton,
                                   input/select classes
      components/EmailComposer.jsx  modal for AI-drafting + editing + sending a cold email for a
                                   job; calls /generate-email then /send-email; used by AtsDetail,
                                   Jobs, and Tracker
      pages/Overview.jsx         landing: KPI cards (incl. Hot Leads) · funnel w/ conversion % ·
                                   score donut · work-mode + cloud-fit donuts · scrape trend ·
                                   top jobs · extraction health
      pages/Analytics.jsx        market insights: skill demand · companies · cloud demand ·
                                   scoring models · apply channels · experience donut · locations ·
                                   score trend · resume profile
      pages/Jobs.jsx             filterable jobs table — filters: score/mode/cloud_fit/posted-age/
                                   has-email/tracker-status/search/sort; Posted + Cloud columns;
                                   save-to-tracker
      pages/Tracker.jsx          application tracker kanban: saved→applied→interviewing→offer/rejected
      pages/AtsDetail.jsx        full job breakdown: sub-scores · skills · predictions · cloud +
                                   posted-age badges · Outreach Playbook (subject format, required
                                   fields, email history) · tracker control · generate/send email
      pages/SkillsGap.jsx        gap skill bars · avg score ring · top resume changes · keyword cloud
      pages/Recruiters.jsx       recruiter directory with search
      pages/Outreach.jsx         sent-email history + missing candidate_info.txt fields
      pages/RawData.jsx          paginated raw posts browser (shows posted_at + scraped_at)

model/
  train.py                       incremental spaCy NER trainer — reads normalized_posts WHERE
                                   is_trained='not_trained', marks them trained after success;
                                   --all flag retrains from scratch on all posts
  predict.py                     LocalExtractor class: NER + regex, same API as Gemini extractor
  linkedin_ner/                  trained spaCy model (JOB_TITLE, COMPANY, SKILL, SUBJECT_FORMAT)

utils/
  model_tracker.py               ModelUsageTracker: tracks daily RPD counts per Gemini model;
                                   models over their RPD quota are permanently skipped until
                                   tomorrow; persists across scorer workers via shared instance

prompts/ats_prompt.txt           system prompt for the ATS scoring API call
resume/                          drop resume here (.pdf or .txt) — scorer auto-detects
config/
  candidate_info.txt             [gitignored] flat key:value personal details for email builder
  candidate_info.example.txt     committed template — copy → candidate_info.txt and fill in
  linkedin_cookies.json          [gitignored] saved LinkedIn session (auto-created; delete to force re-login)
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

**`posted_at` extraction:**
- Reads `span.update-components-actor__sub-description` — the LinkedIn "X hours/days ago" element
- Calls `parse_posted_hours(time_text)` → float hours elapsed
- Computes `posted_at = now - timedelta(hours=hours_ago)` as an absolute ISO timestamp
- Stored in `raw_posts.posted_at`; used by `send_outreach.py` to filter by actual post age
- If the DOM element is missing, `posted_at = None` (graceful — old posts unaffected)

**Output:** raw post dicts buffered in `StagingWriter`; flushed to `data/queue/raw/batch_TIMESTAMP.json`
every `STAGING_BATCH_SIZE` (default 10) posts. Final flush on scraper exit.

---

## Stage 2 — Extractor / Processor (`pipeline/staging/processor.py` + `pipeline/scraper/extractor.py`)

**What it does (daemon thread, starts before scraper):**
- Polls `data/queue/raw/*.json` every 2 seconds
- For each batch file, processes posts one by one:

  1. **Dedup check** — queries `raw_posts WHERE activity_urn = ?`; skips if already in DB (no Gemini call wasted); calls `backfill_posted_at()` on duplicate to update timestamp if it was previously null
  2. **`_normalize(raw)`** — routes to local NER model (when `USE_LOCAL_MODEL=True`) or Gemini API
  3. **`_ingest(raw, norm)`** — atomically inserts into `raw_posts` + `normalized_posts`, preserves original `scraped_at` and `posted_at` from batch file; returns `False` on duplicate URN (race condition guard)
  4. **Deletes batch file** — once all posts in the file are processed (no `processed/` directory; data is in DB)

- Exits when `stop_event` is set (scraper done) AND `data/queue/raw/` is empty

**Gemini extraction features:**
- Model: `GEMINI_EXTRACT_MODEL` (default `gemini-3.1-flash-lite`, 1000 RPD free tier)
- Rate limit: `REQUEST_DELAY = 4.5s` between calls (15 RPM headroom)
- RPD tracking: `ModelUsageTracker` skips model if daily quota hit
- Returns structured JSON: title, company, location, experience, skills, recruiter email, apply info, **email_subject_format**, **email_required_fields**, **location_country**
- **Fix 1:** derives `location_state` from city via `INDIA_STATES` map when Gemini leaves state null
- **Fix 2:** regex fallback for `experience_max` when Gemini returns only min
- **email_subject_format:** exact subject line format recruiter specified (e.g. `Name | Role | Exp | CTC | NP`)
- **email_required_fields:** comma-separated token list of fields recruiter explicitly requests — mapped to canonical tokens: `current_ctc`, `expected_ctc`, `notice_period`, `current_location`, `preferred_locations`, `experience`, `current_company`, `current_designation`, `open_to_relocation`, `pan_number`, `linkedin_url`, `github_url`, `availability`, `work_mode_preference`, `resume_link`
- **location_country:** country the job targets ("India", "United States", etc.) — inferred from post content; "unknown"/null = ambiguous; used by Stage 3 as the primary foreign-post signal

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
| 1 | **Location** | city in `ATS_TARGET_CITIES` OR state in `ATS_TARGET_STATES` OR (`is_remote=1` AND India/global — see below) OR (both null AND `ATS_INCLUDE_NULL_LOCATION=True` AND India/global) |
| 2 | **Experience** | `exp_min ≤ ATS_CANDIDATE_EXP_MAX AND exp_max ≥ ATS_CANDIDATE_EXP_MIN` (or both null → pass) |
| 3 | **Contract** | `role_type != 'contract'` AND `is_contract_role(post_content)` is False |
| 4 | **Email** | `recruiter_email` is non-null (when `REQUIRE_EMAIL_FOR_INGESTION=True`) |

**Foreign post rejection (within filter 1 — two-layer check):**

Layer 1 — extracted `location_country` (preferred, most accurate):
- If `location_country` is set and not "India" / "unknown" → reject immediately with `"foreign country: {country}"`
- If `location_country` is "India" → skip code-based check, go straight to city/state matching

Layer 2 — code-based fallback (when `location_country` is null):
- Applies to **both** `is_remote=1` posts **and** null city+state posts
- Runs `is_india_job(post_content, location_hint)` — returns False when a foreign country is detected with no India signal
- Remote post fails → `"remote but foreign country detected"`
- Null-location post fails → `"null location but foreign country detected"`
- Posts with no detectable country pass (global/ambiguous = keep)
- `_FOREIGN_HARD` covers abbreviations GeoText can't resolve: `latam`, `latin america`, `mena region`, `gcc region`, `apac region`, `emea region`

**Future:** once `location_country` is reliably populated for all posts (via the normal pipeline + `scripts/adhoc/backfill_country.py`), the code-based `is_india_job()` fallback can be removed.

**Cloud detection (on passing posts):**
`detect_clouds(post_content, skills)` scans for AWS/GCP/Azure keywords. Strips `#hashtags` before matching (recruiters add `#aws` for LinkedIn reach, not as job requirements). Sets:
- `clouds_required`: comma-separated detected platforms (e.g. `"aws,gcp"`)
- `cloud_fit`: `aws_match` | `no_cloud_req` | `other_cloud_only`

- Passing posts → `target_jobs` with `clouds_required` + `cloud_fit` (insert; skip on duplicate)
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

## Database — 6 tables

`db/linkedin_scraper.db` (SQLite, WAL mode). All pipeline writes go through `db/database.py`.
`job_tracker` and `email_outreach` are written only by `dashboard/app.py` (both auto-created on startup).

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
| `scraped_at` | TEXT | our scrape time (ISO 8601) |
| `posted_at` | TEXT | actual LinkedIn post time derived from "X hours ago" (ISO 8601, nullable for old posts) |
| `extraction_status` | TEXT | `pending` → `done` or `failed` |
| `extracted_at` | TEXT | when extraction completed |
| `extract_error` | TEXT | error string if failed |

### `normalized_posts`
Structured fields extracted by Gemini (or local NER). 1-to-1 FK to `raw_posts`.
**All posts live here** — including ones filtered out in Stage 3.
This is the training dataset for the local NER model.

Key columns: `title`, `company`, `location_city`, `location_state`, `location_country`,
`is_remote` (0/1), `work_mode` (remote/hybrid/onsite), `experience_min/max`, `skills` (CSV),
`recruiter_email/name/designation/current_company`, `apply_via`, `apply_url`,
`email_subject_format` (recruiter's subject line template or null),
`email_required_fields` (canonical token CSV of fields recruiter asked for, or null),
`extracted_by` (gemini/local_ner), `created_at`,
`is_trained` (`not_trained` → `trained` after NER training run).

`location_country`: Gemini-extracted target country ("India", "United States", etc.) or null.
Primary foreign-post signal in Stage 3 — takes priority over `is_india_job()` code detection.
Back-fill existing target_jobs rows with `scripts/adhoc/backfill_country.py --apply`.

### `target_jobs`
Posts that passed **all 4** Stage 3 filters + cloud detection. Bridge to `ats_scores`.

Columns: `norm_post_id` (UNIQUE FK), `raw_post_id` (shortcut FK), `filtered_at`,
`clouds_required` (comma-sep: `aws`, `gcp`, `azure`), `cloud_fit` (`aws_match` | `no_cloud_req` | `other_cloud_only`).

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

### `email_outreach`
Cold-email send log — written by **both** `dashboard/app.py` (via `/api/jobs/<id>/send-email`)
and `scripts/send_outreach.py` (CLI) on every send attempt. Surfaced by `/api/outreach` and
the AtsDetail Outreach Playbook. Auto-created on startup.

Columns: `target_job_id` (FK), `to_email`, `subject`, `body_text`, `sent_at`,
`status` (sent|failed|pending), `error`, `model_used`.

---

## Dashboard API endpoints

All under `/api/` — Flask server on port 5000, proxied by Vite on port 5173.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/stats` | GET | overview counts, funnel, score bands, work modes, scrape-by-date chart, `cloud_fit` split, `fresh_24h`/`fresh_48h`, `hot_leads` (fresh+aws+60) |
| `/api/analytics` | GET | market insights: companies/skills/locations, exp buckets, apply channels, avg sub-scores, score trend, extracted_by, `cloud_fit`, `cloud_demand` (aws/azure/gcp), `model_usage` |
| `/api/jobs` | GET | scored jobs (incl. `tracker_status`, `posted_at`, `cloud_fit`, `clouds_list`); params: `score_min`, `work_mode`, `cloud_fit`, `posted_within` (hours), `has_email`, `tracker`, `q`, `sort` (score/date/posted/interview) |
| `/api/jobs/<id>` | GET | full job detail (incl. tracker status/notes, `posted_at`, `clouds_list`, `email_required_list`, `email_subject_format`, `outreach_history`) |
| `/api/jobs/<id>/generate-email` | POST | AI-generate `{subject, body, missing_fields}` via outreach builder cascade |
| `/api/jobs/<id>/send-email` | POST | send `{subject, body, to_email}` via Gmail SMTP; logs to `email_outreach`; auto-marks tracker `applied` |
| `/api/skills-gap` | GET | critical_gap_skills frequency across all ats_scores, top 20 |
| `/api/recruiters` | GET | unique recruiters grouped by email; includes avg/best score, post count |
| `/api/raw-posts` | GET | paginated raw_posts joined with normalized + scores (incl. `posted_at`); params: `page`, `limit`, `q` |
| `/api/tracker` | GET | all tracked jobs with status + job info + interview probability |
| `/api/tracker/<target_id>` | POST | upsert `{status, notes}`; status ∈ saved/applied/interviewing/offer/rejected |
| `/api/tracker/<target_id>` | DELETE | remove job from tracker |
| `/api/outreach` | GET | sent-email history from `email_outreach` joined with job + score; totals sent/failed |
| `/api/pipeline-status` | GET | `running` flag, pending extraction count, unscored targets, last run time |
| `/api/run-pipeline` | POST | spawns `python main.py` as background subprocess (no-op if already running) |
| `/api/train-ner/status` | GET | NER training state: running, last_run, untrained_count, error |
| `/api/train-ner` | POST | trigger incremental NER training in background; body `{"all":true}` to retrain from scratch |
| `/api/missing-fields` | GET | fields recruiter asked for that were missing from candidate_info.txt; sorted by frequency |

---

## NER training lifecycle

Goal: supplement Gemini extraction (Stage 2) with a local spaCy model for faster/offline use.

```
Every Gemini call → normalized_posts (is_trained='not_trained')
                         │
          POST /api/train-ner  (or  python model/train.py)
                         │
     reads WHERE is_trained='not_trained' AND title IS NOT NULL
     trains JOB_TITLE, COMPANY, SKILL, SUBJECT_FORMAT entities
     marks processed rows → is_trained='trained'
                         │
          next call trains only on NEW posts (incremental)
```

Once model quality is acceptable: set `USE_LOCAL_MODEL = True` in `settings.py`.
Gemini remains active as fallback when local model returns no title.

## Email outreach lifecycle

```
send_outreach.py  [--min-score N] [--hours N] [--auto-send]
     │
     ├── Query: posted_at IS NOT NULL
     │          AND posted_at >= now-Nh        ← strict: no COALESCE fallback to scored_at
     │          AND cloud_fit='aws_match'
     │          AND ats_score >= N
     │          AND NOT already in email_outreach  ← never re-sends to same job
     │          (dedup by recruiter email — highest score per recruiter)
     │
     ├── Display all job details (scores, predictions, recruiter, raw post, email hints)
     │
     ├── y (or --auto-send) → build_email(job)
     │         reads candidate_info.txt (flat key:value, missing = "(not provided)")
     │         reads resume PDF/TXT from resume/
     │         fills [MY_INFO]/[MY_RESUME]/[RAW_POST] in email_builder_prompt.txt
     │         calls Gemini/Groq cascade → {subject, body, missing_fields}
     │         appends missing_fields → data/missing_fields.json (accumulates over time)
     │         → send_email(to, subject, body) via Gmail SMTP with resume attached
     │         → INSERT INTO email_outreach (status='sent', model_used, subject, body)
     │         → UPSERT job_tracker SET status='applied'
     │
     └── n / q → skip / quit
```

`--auto-send` skips both the per-job y/n/q prompt and the email preview confirm — useful for
batching all matched jobs in one go (e.g. `--min-score 0 --auto-send`).

**Filter alignment with UI:** the `posted_within` filter in `dashboard/app.py` uses
`r.posted_at IS NOT NULL AND r.posted_at >= datetime('now', ? || ' hours')`.
`send_outreach.py` uses the same clause — counts shown in the UI and sent by the CLI will match.

`data/missing_fields.json` tracks which fields recruiters asked for that weren't in
`candidate_info.txt`. View via `/api/missing-fields` or directly. Fill them in over time.

---

## settings.py key variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SCRAPE_LINKEDIN_EMAIL/PASSWORD` | — | LinkedIn scraping account credentials |
| `LINKEDIN_SEARCH_QUERY` | `'"Data Engineer" and "hiring" and "aws"'` | LinkedIn search query |
| `CANDIDATE_EXPERIENCE_MIN/MAX` | 2.0 / 4.0 | Informational only; real filter is Stage 3 |
| `GEMINI_API_KEY` | — | Google AI Studio key |
| `GROQ_API_KEY` | — | Groq console key (prefix `gsk_`, NOT xAI's `xai-`) |
| `SENDER_EMAIL` | — | Gmail address for sending outreach emails |
| `SMTP_APP_PASSWORD` | — | Gmail App Password (Google Account → Security → App Passwords) |
| `SMTP_SERVER` | `smtp.gmail.com` | SMTP server (hardcoded; change if not using Gmail) |
| `SMTP_PORT` | `587` | SMTP port for STARTTLS |
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
- **Vite HMR requires polling on WSL** — `vite.config.js` sets `server.watch.usePolling: true`.
  The project lives on the Windows mount (`/mnt/c`), where native file-change events don't fire,
  so without polling the browser silently keeps running stale code after every edit. Symptom of a
  regression here: edits to `.jsx` files don't appear until a manual server restart.
- Theming: light/dark via CSS variables in `index.html` (`:root` = light, `.dark` = dark)
  mapped to semantic Tailwind tokens (`bg`, `surface`, `surface-2/3`, `ink`, `muted`, `faint`,
  `accent`, `accent-2`, `line`, `--chart-1..6`). The accent is a two-stop gradient
  (`accent` → `accent-2`); reusable visual helpers live in `index.html`'s `<style>`:
  `.card` (frosted glass + hairline), `.card-hover`, `.gradient-text`, `.gradient-accent`,
  `.glow-accent`, and `.fade-up`/`.fade-up-1..6` staggered entrance. An ambient aurora glow
  (`body::before`) sits behind content; all motion respects `prefers-reduced-motion`. Charts in
  `charts.jsx` reference `rgb(var(--…))` directly so they re-theme automatically. Toggle persists
  to `localStorage('jh-theme')`; head script applies it before first paint. When adding UI: use
  semantic tokens and these helpers, never hardcode hex colors.
- `db/database.py` runs additive migrations on `init_db()`: adds `skills`, `is_trained`
  columns to `normalized_posts` if missing; adds `tailored_resume_path`, `provider` columns
  to `ats_scores` if missing; collapses legacy `UNIQUE(target_job_id, provider)` constraint
  on `ats_scores` to `UNIQUE(target_job_id)` (one score per job).
