# Job Hunter Agent

A personal job-hunting automation pipeline for Data Engineer roles in India. Scrapes LinkedIn recruiter posts, extracts structured job data with Gemini AI, scores each job against your resume with an enterprise-grade ATS engine, surfaces everything in a React dashboard, and sends cold-outreach emails with one keystroke.

## How It Works

```
LinkedIn Posts
     │
     ▼
Stage 1 — SCRAPE (Playwright)
  Extracts: post content · author · recruiter info · posted_at timestamp
  Minimal pre-filter: URN resolvable + non-empty content
  Writes raw batch files → data/queue/raw/
     │
     ▼
Stage 2 — EXTRACT (Gemini AI, concurrent thread)
  Parses: title · company · location · skills · recruiter info · apply path
          email_subject_format · email_required_fields
  Writes normalized_posts; deletes batch file
     │
     ▼
Stage 3 — FILTER (deterministic rules, concurrent thread)
  Location : target cities / states / remote (India only) / null
  Experience: overlaps candidate window (2–4 yrs)
  Contract  : rejects contract/freelance roles
  Email     : recruiter email must be present
  Cloud     : detects AWS/GCP/Azure → cloud_fit tag (hashtags stripped)
  Foreign   : rejects non-India posts — uses extracted location_country first,
              falls back to is_india_job() for both remote AND null-location posts
  Writes target_jobs with clouds_required + cloud_fit
     │
     ▼
Stage 4 — SCORE (Gemini / Groq cascade, 3 parallel workers)
  11 sub-scores · 4 probability predictions · matched/gap skills
  keyword injections · resume strengths/weaknesses · priority changes
  Writes ats_scores
     │
     ▼
React Dashboard ←→ Flask API (port 5000)

     + Interactive Email Outreach CLI
       scripts/send_outreach.py
       (posted_at IS NOT NULL · posted in last 24h · AWS match · ATS ≥ 50 · unsent only)
```

All four stages run concurrently when you call `python main.py`. Stage 1+2 are producer/consumer; stages 3+4 poll for new data continuously alongside them.

---

## Setup

```bash
# Python environment
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python -m playwright install-deps   # Linux / WSL only

# Node environment (dashboard)
cd dashboard/frontend && npm install
```

### Configure `.env`

Copy `.env.example` → `.env` and fill in:

| Key | What to set |
|-----|-------------|
| `SCRAPE_LINKEDIN_EMAIL` / `SCRAPE_LINKEDIN_PASSWORD` | Dedicated scraping account (not your main LinkedIn) |
| `GEMINI_API_KEY` | Free key from [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `GROQ_API_KEY` | Free key from [console.groq.com](https://console.groq.com) (prefix `gsk_`) |
| `SENDER_EMAIL` | Gmail address to send outreach from |
| `SMTP_APP_PASSWORD` | Gmail App Password (myaccount.google.com → Security → App Passwords) |

Key settings in `settings.py`:

| Variable | Purpose |
|----------|---------|
| `LINKEDIN_SEARCH_QUERY` | LinkedIn search string |
| `ATS_CANDIDATE_EXP_MIN/MAX` | Your experience window for Stage 3 filter |
| `ATS_TARGET_CITIES/STATES` | Cities/states you're willing to work in |
| `REQUIRE_EMAIL_FOR_INGESTION` | Drop posts without a recruiter email (default True) |

### Candidate info

Copy `config/candidate_info.example.txt` → `config/candidate_info.txt` and fill in your details. The email builder reads this directly — mark missing fields as `(not provided)` and they'll be tracked in `data/missing_fields.json` for incremental improvement.

### Resume

Drop your resume as `resume/YourName_Resume.pdf` (or `.txt`). The scorer and email builder auto-detect it.

### LinkedIn cookies

On first run, `config/linkedin_cookies.json` doesn't exist — the scraper does a fresh headless login and saves the session. If LinkedIn shows a security checkpoint, a visible browser opens automatically; solve it and press Enter. Delete the cookie file to force a fresh login.

---

## Running the Pipeline

```bash
python main.py                       # past 24h, headless
python main.py --days 7              # past week
python main.py --days 30 --limit 50  # past month, capped at 50 posts
python main.py --visible             # show the browser window
```

---

## Email Outreach

```bash
python scripts/send_outreach.py              # past 24h · AWS match · ATS ≥ 50  (interactive)
python scripts/send_outreach.py --min-score 65
python scripts/send_outreach.py --hours 48
python scripts/send_outreach.py --min-score 0 --auto-send   # batch-send all, no prompts
```

Shows every detail for each matching job (scores, predictions, recruiter info, full post). Type `y` to generate + send, `n` to skip, `q` to quit. `--auto-send` skips all prompts and sends everything.

- Filters by `posted_at` only — jobs without a `posted_at` timestamp are excluded (matches dashboard UI counts exactly)
- Already-sent jobs are excluded — re-running the CLI never double-sends to the same job
- Email is AI-generated from your `candidate_info.txt` + resume + raw post
- Resume PDF attached automatically
- Every send is logged to `email_outreach`; job auto-marked `applied` in Tracker
- Missing recruiter-requested fields logged to `data/missing_fields.json` for incremental fill

---

## Dashboard

```bash
./start_dashboard.sh
```

| Server | URL |
|--------|-----|
| Flask API | http://localhost:5000 |
| React UI  | http://localhost:5173 |

A modern, theme-aware (light/dark) React UI — frosted-glass cards (18px blur, overflow-hidden), gradient accents, a multi-blob ambient aurora backdrop, subtle dot-grid texture, and animated entrances throughout. Cold emails can be drafted and sent inline from Jobs, Tracker, and ATS Detail via the AI **Email Composer** modal.

Key UI features:
- **Animated count-up stats** — all KPI numbers count from 0 on page load (ease-out cubic, 750ms)
- **Staggered entrance animations** — cards, chips, and skill tags fade-up or pop-in with per-item delays
- **Slide-in drawer** — Recruiters page opens a right-side panel with all posts for that recruiter

### Pages

| Page | What it shows |
|------|---------------|
| Overview `/` | Pipeline funnel · score distribution · work modes · cloud fit · scrape trend · top jobs (animated) |
| Analytics `/analytics` | Skill demand · companies · cloud demand · locations · score trend · resume profile |
| Pipeline `/pipeline` | 4-stage DAG flow (Scrape → Extract → Filter → Score) with live metrics, animated flow edges, configure & run (days/limit/visible), stop button, live colorized run log |
| Jobs `/jobs` | Filterable leaderboard — score / mode / cloud fit / posted age / Net New / search / sort; bulk send with minimize + stop |
| ATS Detail `/ats/:id` | Full breakdown: animated score ring · 11 sub-scores (staggered) · predictions · skills/keywords (pop-in) · outreach playbook · send email |
| Skills Gap `/skills-gap` | Gap skills frequency · keyword cloud (pop-in) · top resume changes |
| Recruiters `/recruiters` | Card grid (staggered) → click to open side drawer with all that recruiter's posts, scores, skills, email hints |
| Tracker `/tracker` | Kanban: saved → applied → interviewing → offer/rejected; pop-in cards |
| Outreach `/outreach` | Sent-email history + recruiter-requested fields missing from candidate_info |
| Raw Data `/raw-data` | Paginated browser of scraped posts (full post text, posted/scraped age) |

---

## CLI Inspection

```bash
python scripts/view_jobs.py      # all normalized_posts
python scripts/view_scores.py    # ats_scores > 60, sorted by score
```

Re-score after editing your resume or the ATS prompt, then compare runs:

```bash
python scripts/rescore.py            # snapshot current scores → data/scores_history.json, rescore all
python scripts/compare_scores.py     # diff the last two snapshots (which jobs moved up/down)
```

---

## Local NER Model (optional)

After accumulating posts, train a local spaCy NER model as extraction fallback:

```bash
python model/train.py               # incremental (new posts only)
python model/train.py --all         # retrain from scratch
```

Set `USE_LOCAL_MODEL = True` in `settings.py`. Gemini remains active as fallback when the local model can't find a job title. Entities trained: `JOB_TITLE`, `COMPANY`, `SKILL`, `SUBJECT_FORMAT`.

---

## Database

`db/linkedin_scraper.db` — SQLite with WAL mode, 6 tables:

```
raw_posts          UNIQUE(activity_urn)   verbatim post DOM · posted_at timestamp
normalized_posts   FK → raw_posts         structured Gemini extraction · email fields
target_jobs        FK → normalized_posts  posts passing all 4 filters · cloud_fit
ats_scores         FK → target_jobs       full ATS evaluation (11 scores + predictions)
job_tracker        FK → target_jobs       application tracker (dashboard only)
email_outreach     FK → target_jobs       cold-email send log (dashboard + CLI)
```

Key columns added beyond the base schema:

| Table | Column | Purpose |
|-------|--------|---------|
| `raw_posts` | `posted_at` | Absolute timestamp from LinkedIn "X hours ago" |
| `normalized_posts` | `email_subject_format` | Subject line format recruiter specified |
| `normalized_posts` | `email_required_fields` | Fields recruiter explicitly asks for |
| `normalized_posts` | `location_country` | Gemini-extracted target country; primary foreign-post filter signal |
| `target_jobs` | `clouds_required` | Detected cloud platforms (aws,gcp,azure) |
| `target_jobs` | `cloud_fit` | `aws_match` / `no_cloud_req` / `other_cloud_only` |

---

## ATS Scoring Details

**11 sub-scores (0–100):** keyword match · semantic alignment · technical skills · experience relevance · project alignment · impact · ATS structure · recruiter readability · seniority fit · domain fit · tailoring readiness

**4 predictions (0–100%):** ATS pass · shortlist · interview · rejection probability

**Insights:** matched skills · critical gap skills · resume strengths/weaknesses · priority changes · keyword injections

**Model cascade** (best → fallback): `gemini-3.5-flash` → `gemini-2.5-flash` → `llama-4-scout` → `llama-3.3-70b` → `gemini-3.1-flash-lite` → `gemini-2.5-flash-lite` → `qwen3-32b` → `gemma-4-31b-it` → `gemma-4-26b-a4b-it` → `llama-3.1-8b`

---

## Project Structure

```
job-hunter-agent/
├── main.py                          entry point — runs all 4 pipeline stages
├── settings.py                      all config (credentials, search, filters, models)
├── start_dashboard.sh               start Flask API + React dev server together
│
├── pipeline/
│   ├── scraper/
│   │   ├── linkedin_scraper.py      Stage 1: Playwright scraper + posted_at extraction
│   │   ├── extractor.py             Stage 2: Gemini extraction worker
│   │   └── location_utils.py        regex helpers + foreign country detection
│   ├── staging/
│   │   ├── writer.py                StagingWriter: buffers posts → batch files
│   │   └── processor.py             batch file consumer → DB; backfills posted_at on dedup
│   ├── ats/
│   │   ├── filter.py                Stage 3: 4 filters + cloud detection + foreign remote check
│   │   └── scorer.py                Stage 4: 3-worker cascade scorer
│   └── outreach/
│       ├── builder.py               AI email generator (candidate_info + resume + post)
│       └── sender.py                Gmail SMTP sender with resume attachment
│
├── db/
│   ├── schema.sql                   table definitions
│   ├── database.py                  all DB helpers + additive migrations
│   └── linkedin_scraper.db          SQLite database (gitignored)
│
├── dashboard/
│   ├── app.py                       Flask API (REST endpoints + job_tracker; pipeline log + stop)
│   └── frontend/                    React + Vite SPA
│       ├── index.html               Tailwind CDN + theme tokens + glass/aurora/animation styles
│       ├── src/
│       │   ├── App.jsx              Router + 11 routes
│       │   ├── components/
│       │   │   ├── Layout.jsx       glass sidebar (shimmer brand, full-fill active nav) + topbar
│       │   │   ├── charts.jsx       dependency-free SVG charts
│       │   │   ├── ui.jsx           shared UI: StatCard, ScoreChip (glow), inputs, etc.
│       │   │   └── EmailComposer.jsx  AI email draft/edit/send modal
│       │   └── pages/               Overview · Analytics · Pipeline · Jobs · Tracker · AtsDetail ·
│       │                            SkillsGap · Recruiters (card+drawer) · Outreach · RawData
│       └── vite.config.js           /api proxy → Flask (+ polling watch for WSL HMR)
│
├── scripts/
│   ├── send_outreach.py             Outreach CLI (interactive or --auto-send batch)
│   ├── rescore.py                   archive + clear + rescore all target_jobs
│   ├── compare_scores.py            diff score snapshots in data/scores_history.json
│   ├── view_jobs.py                 CLI: print all normalized_posts
│   ├── view_scores.py               CLI: print ats_scores > 60
│   └── adhoc/                       one-time / migration scripts
│       └── backfill_country.py      back-fill location_country on existing target_jobs
│
├── model/
│   ├── train.py                     spaCy NER trainer (incremental or full)
│   ├── predict.py                   LocalExtractor class
│   └── linkedin_ner/                trained model artifacts (gitignored)
│
├── prompts/
│   ├── ats_prompt.txt               ATS scoring system prompt
│   └── email_builder_prompt.txt     Email generation prompt
│
├── config/
│   ├── candidate_info.txt           Your personal details for email builder (gitignored)
│   ├── candidate_info.example.txt   Template — copy → candidate_info.txt and fill in (committed)
│   └── linkedin_cookies.json        Saved LinkedIn session (gitignored; delete to force re-login)
│
├── resume/
│   └── *.pdf / *.txt                Your resume (gitignored; scorer + builder auto-detect)
│
└── data/                            Runtime data (gitignored)
    ├── linkedin_scraper.db
    ├── queue/raw/                   Live batch files (ephemeral)
    ├── model_usage/                 Daily RPD counters
    ├── pipeline_run.log             stdout+stderr of the most recent pipeline run (overwritten each run)
    └── missing_fields.json          Fields recruiter asked for but not in candidate_info.txt

```

---

## Known Limitations

- **Salary always null** — Indian recruiters almost never disclose salary in LinkedIn posts.
- **Null company (~40%)** — recruiter works at a staffing firm and doesn't name the end client.
- **Probability format** — Gemini sometimes returns probabilities as 0–1 or 0–100. `app.py` normalizes automatically.
- **LinkedIn Jobs tab** — `LINKEDIN_SCRAPE_JOBS = True` is wired but no-op; not connected to the DB pipeline yet.
- **posted_at for old posts** — Posts scraped before `posted_at` was added have `NULL` and are excluded from all time-filtered queries (dashboard and outreach CLI both require `posted_at IS NOT NULL`).
- **location_country for existing posts** — Only newly scraped posts get `location_country` from Gemini. Run `python scripts/adhoc/backfill_country.py --apply` to fill it in for existing `target_jobs` rows. Until then, Stage 3 falls back to `is_india_job()` code detection (which can false-positive on tech abbreviations like "DBT" → Belgium).
