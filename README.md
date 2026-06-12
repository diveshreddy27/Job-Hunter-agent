# Job Hunter Agent

A personal job-hunting automation pipeline for Data Engineer roles in India. It scrapes LinkedIn recruiter posts, extracts structured job data with Gemini AI, scores each job against your resume with an enterprise-grade ATS engine, and surfaces everything in a React dashboard.

## How It Works

```
LinkedIn Posts
     │
     ▼
Stage 1 — SCRAPE (Playwright)
  Pre-filter: hiring CTA · India · not contract · has email · experience window
     │ writes raw_posts
     ▼
Stage 2 — EXTRACT (Gemini AI, concurrent thread)
  Parses: title · company · location · skills · recruiter info · apply path
     │ writes normalized_posts
     ▼
Stage 3 — FILTER (rules)
  Location: Hyderabad · Mumbai · Pune · Chennai · Bengaluru · Kolkata · remote/unknown
  Experience: overlaps candidate window (2–4 yrs)
     │ writes target_jobs
     ▼
Stage 4 — SCORE (Gemini AI cascade)
  11 sub-scores · 4 probability predictions · matched/gap skills · keyword injections
     │ writes ats_scores
     ▼
React Dashboard  ←→  Flask API (port 5000)
```

All four stages run end-to-end when you call `python main.py`. Stages 1 and 2 run concurrently (producer/consumer threads); stages 3 and 4 run sequentially after extraction drains.

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

### Configure `settings.py`

| Key | What to set |
|-----|-------------|
| `SCRAPE_LINKEDIN_EMAIL` / `SCRAPE_LINKEDIN_PASSWORD` | A dedicated scraping account (not your main LinkedIn) |
| `LINKEDIN_SEARCH_QUERY` | Search query, e.g. `'"Data Engineer" and "hiring" and "aws"'` |
| `TARGET_ROLE` | Your target role label (used in logging) |
| `CANDIDATE_EXPERIENCE_MIN/MAX` | Your years of experience window (pre-scrape filter) |
| `ATS_CANDIDATE_EXP_MIN/MAX` | Experience window for the ATS filter (post-extraction) |
| `GEMINI_API_KEY` | Free key from [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `ATS_TARGET_CITIES` / `ATS_TARGET_STATES` | Cities/states you're willing to work in |

### LinkedIn cookies

On first run, `config/linkedin_cookies.json` doesn't exist — the scraper does a fresh headless login and saves the session. If LinkedIn shows a security checkpoint, a visible browser opens automatically; solve it and press Enter. Delete the cookie file to force a fresh login.

### Resume

Drop your resume as `resume/YourName_Resume.pdf` (or `.txt`). The ATS scorer reads it automatically — no config needed.

## Running the Scraper

```bash
python main.py                       # past 24h, headless
python main.py --days 7              # past week
python main.py --days 30 --limit 50  # past month, capped at 50 posts
python main.py --visible             # show the browser window
python main.py --no-email-filter     # keep posts without a recruiter email
```

## Running the Dashboard

```bash
./start_dashboard.sh
```

Opens both servers and prints URLs. Press `Ctrl+C` to stop both.

| Server | URL | Purpose |
|--------|-----|---------|
| Flask API | http://localhost:5000 | REST endpoints only |
| React UI | http://localhost:5173 | Dashboard (proxies `/api/*` to Flask) |

Or start them separately:

```bash
# Terminal 1
python dashboard/app.py

# Terminal 2
cd dashboard/frontend && npm run dev
```

## Dashboard Pages

| Page | URL | What it shows |
|------|-----|---------------|
| Overview | `/` | Pipeline funnel · avg ATS score · extraction rate · score distribution · top 8 jobs |
| Job Leaderboard | `/leaderboard` | All scored jobs, filterable by score/mode/search, sortable |
| ATS Detail | `/ats/:id` | Full breakdown for one job: 11 sub-scores · predictions · matched/gap skills · keyword injections · priority actions |
| Skills Gap | `/skills-gap` | Gap skills frequency across all jobs · weaknesses · keyword cloud |
| Recruiter Directory | `/recruiters` | All unique recruiters with email, company, post count, best score |
| Raw Posts | `/raw-data` | Paginated browser of scraped LinkedIn posts with extraction status |

## CLI Viewers (no dashboard needed)

```bash
python view_jobs.py      # print all normalized_posts to terminal
python view_scores.py    # print all ats_scores > 60 with full breakdown
```

## Local NER Model (optional)

After accumulating 50+ posts, you can train a local spaCy NER model to replace Gemini for the extraction stage (faster, free, offline):

```bash
python model/train.py               # train with defaults
python model/train.py --iters 40    # more iterations
```

Then set `USE_LOCAL_MODEL = True` in `settings.py`. Gemini remains active as fallback when the local model can't find a job title.

## Database

`db/linkedin_scraper.db` — SQLite with WAL mode, 4 tables:

```
raw_posts          UNIQUE(activity_urn)   verbatim post DOM, extraction lifecycle
normalized_posts   FK → raw_posts         structured fields from Gemini extraction
target_jobs        FK → normalized_posts  posts passing location + experience filter
ats_scores         FK → target_jobs       full AI ATS evaluation
```

```bash
sqlite3 db/linkedin_scraper.db
.tables
SELECT extraction_status, COUNT(*) FROM raw_posts GROUP BY extraction_status;
SELECT title, company, final_ats_score FROM normalized_posts JOIN target_jobs t ON t.norm_post_id = normalized_posts.id JOIN ats_scores s ON s.target_job_id = t.id ORDER BY final_ats_score DESC;
```

## Project Structure

```
job-hunter-agent/
├── main.py                        entry point — runs all 4 pipeline stages
├── settings.py                    all config (credentials, search, filters, models)
├── start_dashboard.sh             start Flask API + React dev server together
├── requirements.txt               Python dependencies
│
├── scraper/
│   ├── linkedin_scraper.py        Stage 1: Playwright-driven LinkedIn scraper
│   ├── extractor.py               Stage 2: Gemini extraction worker (consumer thread)
│   └── location_utils.py          regex helpers: location, experience, salary, email
│
├── ats/
│   ├── filter.py                  Stage 3: location + experience filter → target_jobs
│   └── scorer.py                  Stage 4: Gemini ATS scorer with model cascade
│
├── db/
│   ├── schema.sql                 table definitions (4 tables)
│   ├── database.py                all DB read/write functions
│   └── linkedin_scraper.db        SQLite database
│
├── dashboard/
│   ├── app.py                     Flask API server (REST endpoints only)
│   └── frontend/                  React + Vite SPA
│       ├── index.html             Tailwind CDN + Google Fonts + Material Symbols
│       ├── vite.config.js         Vite config with /api proxy to Flask
│       ├── src/
│       │   ├── main.jsx           React entry point
│       │   ├── App.jsx            React Router setup
│       │   ├── index.css          minimal global reset
│       │   ├── components/
│       │   │   └── Layout.jsx     sidebar + header (shared shell)
│       │   └── pages/
│       │       ├── Overview.jsx
│       │       ├── Leaderboard.jsx
│       │       ├── AtsDetail.jsx
│       │       ├── SkillsGap.jsx
│       │       ├── Recruiters.jsx
│       │       └── RawData.jsx
│       └── package.json
│
├── model/
│   ├── train.py                   train spaCy NER on DB pairs (optional)
│   ├── predict.py                 LocalExtractor class (drop-in for Gemini)
│   └── linkedin_ner/              trained spaCy model artifacts
│
├── prompts/
│   └── ats_prompt.txt             system prompt for the ATS scoring LLM call
│
├── resume/
│   └── *.pdf / *.txt              your resume (scorer auto-detects)
│
├── config/
│   ├── linkedin_cookies.json      saved session (auto-created, gitignore this)
│   └── resume.json                structured resume data (optional)
│
└── view_jobs.py / view_scores.py  CLI inspection tools
```

## ATS Scoring Details

The scorer sends each job's full post text + your resume to Gemini and receives:

**11 sub-scores (0–100):** keyword match · semantic alignment · technical skills · experience relevance · project alignment · impact · ATS structure · recruiter readability · seniority fit · domain fit · tailoring readiness

**4 predictions (0–100%):** ATS pass probability · shortlist probability · interview probability · rejection probability

**Insights:** matched skills · critical gap skills · resume strengths/weaknesses · priority changes · keyword injections

**Model cascade** (falls back on 429): `gemini-2.5-flash` → `gemini-3.5-flash` → `gemini-3.0-flash` → `gemini-2.5-flash-lite` → `gemma-4-31b-it`

## Known Limitations

- **Salary always null** — Indian recruiters almost never disclose salary in LinkedIn posts.
- **Null company (~40%)** — recruiter works at a staffing firm and doesn't name the end client.
- **Probability inconsistency** — Gemini sometimes returns probabilities as 0–1 or 0–100. `app.py` normalizes these automatically.
- **LinkedIn Jobs tab** — `LINKEDIN_SCRAPE_JOBS = True` is a no-op; Jobs tab scraping is not yet wired to the DB pipeline.
