-- LinkedIn Scraper — SQLite schema
-- Two tables with a 1-to-1 FK relation:
--   raw_posts        : verbatim post data scraped from LinkedIn
--   normalized_posts : structured fields extracted from raw_posts

-- ── raw_posts ────────────────────────────────────────────────
-- One row per post that survived the producer-side filters
-- (hiring CTA, India, contract, email present, experience window).
-- This is the source of truth; we can re-run extraction against it.
CREATE TABLE IF NOT EXISTS raw_posts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,

    -- LinkedIn identifiers (UNIQUE on URN is how we dedup across runs)
    activity_urn      TEXT    NOT NULL UNIQUE,
    post_url          TEXT    NOT NULL,

    -- Verbatim DOM content
    post_content      TEXT    NOT NULL,
    post_author       TEXT,
    author_headline   TEXT,
    profile_url       TEXT,

    -- Producer state
    days_filter       INTEGER NOT NULL,      -- 1, 7, or 30
    scraped_at        TEXT    NOT NULL,

    -- Extraction lifecycle: pending → done | failed
    extraction_status TEXT    NOT NULL DEFAULT 'pending',
    extracted_at      TEXT,
    extract_error     TEXT
);

CREATE INDEX IF NOT EXISTS idx_raw_status     ON raw_posts(extraction_status);
CREATE INDEX IF NOT EXISTS idx_raw_scraped_at ON raw_posts(scraped_at DESC);


-- ── normalized_posts ─────────────────────────────────────────
-- One row per successfully-extracted raw_post. Always has an FK back
-- to raw_posts so we can join verbatim content with parsed fields.
CREATE TABLE IF NOT EXISTS normalized_posts (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_post_id                 INTEGER NOT NULL UNIQUE
                                REFERENCES raw_posts(id) ON DELETE CASCADE,

    -- Job
    title                       TEXT,
    company                     TEXT,

    -- Location
    location_raw                TEXT,
    location_city               TEXT,
    location_state              TEXT,
    is_remote                   INTEGER NOT NULL DEFAULT 0,
    work_mode                   TEXT,                       -- remote|hybrid|onsite

    -- Years
    experience_min              REAL,
    experience_max              REAL,
    role_type                   TEXT    NOT NULL DEFAULT 'fulltime',

    -- Recruiter (denormalized here for now — easy to read)
    recruiter_email             TEXT,
    recruiter_name              TEXT,
    recruiter_designation       TEXT,
    recruiter_current_company   TEXT,

    -- Apply path
    apply_via                   TEXT,                       -- email|linkedin_easy|website
    apply_url                   TEXT,

    -- Tech stack
    skills                      TEXT,                       -- comma-joined extracted skills

    -- Provenance
    extracted_by                TEXT    NOT NULL DEFAULT 'regex',
    created_at                  TEXT    NOT NULL,

    -- NER training lifecycle: not_trained → trained
    -- Flipped by model/train.py after each successful training run so only
    -- NEW posts are used on the next run (incremental training).
    is_trained                  TEXT    NOT NULL DEFAULT 'not_trained'
);

CREATE INDEX IF NOT EXISTS idx_norm_raw_id  ON normalized_posts(raw_post_id);
CREATE INDEX IF NOT EXISTS idx_norm_company ON normalized_posts(company);
CREATE INDEX IF NOT EXISTS idx_norm_state   ON normalized_posts(location_state);
CREATE INDEX IF NOT EXISTS idx_norm_email   ON normalized_posts(recruiter_email);
-- idx_norm_trained is created in database.py init_db() after the is_trained
-- column migration, so it works on both new and pre-existing databases.


-- ── target_jobs ───────────────────────────────────────────────
-- Posts that passed location + experience filters. Feeds the ATS scorer.
-- Only stores IDs and the date they were queued — raw content lives in
-- raw_posts, structured fields in normalized_posts.
CREATE TABLE IF NOT EXISTS target_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    norm_post_id    INTEGER NOT NULL UNIQUE
                    REFERENCES normalized_posts(id) ON DELETE CASCADE,
    raw_post_id     INTEGER NOT NULL
                    REFERENCES raw_posts(id) ON DELETE CASCADE,
    filtered_at     TEXT    NOT NULL           -- date this row was queued
);

CREATE INDEX IF NOT EXISTS idx_target_norm ON target_jobs(norm_post_id);
CREATE INDEX IF NOT EXISTS idx_target_date ON target_jobs(filtered_at);


-- ── ats_scores ────────────────────────────────────────────────
-- Full ATS evaluation result for each target_job.
-- Two rows per target: provider='gemini' and provider='groq' (dual scoring).
-- Key numeric fields stored as columns for easy querying/sorting.
-- Full API response preserved in raw_response for ML training data.
CREATE TABLE IF NOT EXISTS ats_scores (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    target_job_id               INTEGER NOT NULL
                                REFERENCES target_jobs(id) ON DELETE CASCADE,
    provider                    TEXT    NOT NULL DEFAULT 'gemini',   -- gemini | groq

    -- Overall score
    final_ats_score             INTEGER,           -- 0–100

    -- 11 sub-scores from score_breakdown
    keyword_match_score         INTEGER,
    semantic_alignment_score    INTEGER,
    technical_skills_score      INTEGER,
    experience_relevance_score  INTEGER,
    project_alignment_score     INTEGER,
    impact_score                INTEGER,
    ats_structure_score         INTEGER,
    recruiter_readability_score INTEGER,
    seniority_fit_score         INTEGER,
    domain_fit_score            INTEGER,
    tailoring_readiness_score   INTEGER,

    -- Prediction probabilities (0–100)
    ats_pass_probability        REAL,
    shortlist_probability       REAL,
    interview_probability       REAL,
    rejection_probability       REAL,

    -- Key insights (JSON arrays stored as TEXT)
    matched_skills              TEXT,   -- job_analysis.matched_skills
    critical_gap_skills         TEXT,   -- job_analysis.gap_skills.critical
    resume_strengths            TEXT,   -- resume_analysis.resume_strengths
    resume_weaknesses           TEXT,   -- resume_analysis.resume_weaknesses
    priority_changes            TEXT,   -- improvement_recommendations.highest_priority_changes
    keyword_injections          TEXT,   -- improvement_recommendations.keyword_injections

    -- Tailored resume output
    estimated_improved_score    INTEGER,
    tailored_resume_latex       TEXT,   -- full LaTeX resume string

    -- Tailored resume file (set when prompt decides tailoring_required=true)
    -- Internal name: job_{id}_Divesh_Reddy_{Role}_Resume.tex
    -- Send name:     Divesh_Reddy_{Role}_Resume.tex (strip job_{id}_ prefix)
    tailored_resume_path        TEXT,

    -- Complete API response (for ML training)
    raw_response                TEXT,

    -- Provenance
    model_used                  TEXT,
    scored_at                   TEXT NOT NULL,

    UNIQUE(target_job_id)
);

CREATE INDEX IF NOT EXISTS idx_ats_final     ON ats_scores(final_ats_score DESC);
CREATE INDEX IF NOT EXISTS idx_ats_shortlist ON ats_scores(shortlist_probability DESC);
-- idx_ats_provider is created in database.py init_db() after the provider-column
-- migration, so it works on both new and pre-existing databases.


-- ── job_tracker ───────────────────────────────────────────────
-- Application tracker driven by the dashboard (saved → applied →
-- interviewing → offer | rejected). Also auto-created by dashboard/app.py
-- so existing databases pick it up without a migration step.
CREATE TABLE IF NOT EXISTS job_tracker (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    target_job_id INTEGER NOT NULL UNIQUE
                  REFERENCES target_jobs(id) ON DELETE CASCADE,
    status        TEXT NOT NULL DEFAULT 'saved',   -- saved|applied|interviewing|offer|rejected
    notes         TEXT,
    updated_at    TEXT NOT NULL
);
