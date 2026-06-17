"""
SQLite layer for the LinkedIn scraper.

Two tables (see schema.sql):
  raw_posts          : verbatim DOM content of filter-surviving posts
  normalized_posts   : structured fields parsed from raw_posts (1-to-1 FK)

Producer (scraper) writes only to raw_posts. Consumer (extractor) reads
pending raw_posts and writes the parsed equivalent into normalized_posts,
flipping the raw row's status to `done` (or `failed` + error).
"""
import sqlite3
import pathlib
from datetime import datetime, timezone
from typing import Optional


DB_PATH     = pathlib.Path(__file__).parent.parent / "data" / "linkedin_scraper.db"
SCHEMA_PATH = pathlib.Path(__file__).parent / "schema.sql"


def get_conn() -> sqlite3.Connection:
    """One connection per call. WAL + FK enforcement on."""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db() -> None:
    DB_PATH.parent.mkdir(exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA_PATH.read_text())
        # Additive migrations — safe to run on existing DBs
        existing = {row[1] for row in conn.execute("PRAGMA table_info(normalized_posts)")}
        if "skills" not in existing:
            conn.execute("ALTER TABLE normalized_posts ADD COLUMN skills TEXT")
        if "is_trained" not in existing:
            conn.execute(
                "ALTER TABLE normalized_posts ADD COLUMN "
                "is_trained TEXT NOT NULL DEFAULT 'not_trained'"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_norm_trained "
                "ON normalized_posts(is_trained)"
            )

        norm_v2 = {row[1] for row in conn.execute("PRAGMA table_info(normalized_posts)")}
        if "email_subject_format" not in norm_v2:
            conn.execute("ALTER TABLE normalized_posts ADD COLUMN email_subject_format TEXT")
        if "email_required_fields" not in norm_v2:
            conn.execute("ALTER TABLE normalized_posts ADD COLUMN email_required_fields TEXT")
        if "location_country" not in norm_v2:
            conn.execute("ALTER TABLE normalized_posts ADD COLUMN location_country TEXT")

        rp_existing = {row[1] for row in conn.execute("PRAGMA table_info(raw_posts)")}
        if "posted_at" not in rp_existing:
            conn.execute("ALTER TABLE raw_posts ADD COLUMN posted_at TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_rp_posted_at ON raw_posts(posted_at)")
        tj_existing = {row[1] for row in conn.execute("PRAGMA table_info(target_jobs)")}
        if "clouds_required" not in tj_existing:
            conn.execute("ALTER TABLE target_jobs ADD COLUMN clouds_required TEXT NOT NULL DEFAULT ''")
        if "cloud_fit" not in tj_existing:
            conn.execute("ALTER TABLE target_jobs ADD COLUMN cloud_fit TEXT NOT NULL DEFAULT ''")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_tj_cloud_fit ON target_jobs(cloud_fit)")

        ats_existing = {row[1] for row in conn.execute("PRAGMA table_info(ats_scores)")}
        if "tailored_resume_path" not in ats_existing:
            conn.execute("ALTER TABLE ats_scores ADD COLUMN tailored_resume_path TEXT")
            ats_existing.add("tailored_resume_path")

        if "provider" not in ats_existing:
            conn.execute("ALTER TABLE ats_scores ADD COLUMN provider TEXT NOT NULL DEFAULT 'gemini'")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_ats_provider ON ats_scores(provider)")
            ats_existing.add("provider")

        # Unified cascade era: one score per job (UNIQUE on target_job_id only).
        # If the DB still has the dual-scoring UNIQUE(target_job_id, provider)
        # constraint, collapse to a single row per job — keeping gemini where
        # available, otherwise the groq row.
        ats_schema = (conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='ats_scores'"
        ).fetchone() or ("",))[0] or ""
        if "UNIQUE(target_job_id, provider)" in ats_schema:
            conn.executescript("""
                CREATE TABLE ats_scores_v3 (
                    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
                    target_job_id               INTEGER NOT NULL
                                                REFERENCES target_jobs(id) ON DELETE CASCADE,
                    provider                    TEXT    NOT NULL DEFAULT 'gemini',
                    final_ats_score             INTEGER,
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
                    ats_pass_probability        REAL,
                    shortlist_probability       REAL,
                    interview_probability       REAL,
                    rejection_probability       REAL,
                    matched_skills              TEXT,
                    critical_gap_skills         TEXT,
                    resume_strengths            TEXT,
                    resume_weaknesses           TEXT,
                    priority_changes            TEXT,
                    keyword_injections          TEXT,
                    estimated_improved_score    INTEGER,
                    tailored_resume_latex       TEXT,
                    tailored_resume_path        TEXT,
                    raw_response                TEXT,
                    model_used                  TEXT,
                    scored_at                   TEXT NOT NULL,
                    UNIQUE(target_job_id)
                );
                -- Keep gemini row per job; fall back to groq row when no gemini exists.
                INSERT INTO ats_scores_v3 (
                    id, target_job_id, provider,
                    final_ats_score, keyword_match_score, semantic_alignment_score,
                    technical_skills_score, experience_relevance_score, project_alignment_score,
                    impact_score, ats_structure_score, recruiter_readability_score,
                    seniority_fit_score, domain_fit_score, tailoring_readiness_score,
                    ats_pass_probability, shortlist_probability, interview_probability,
                    rejection_probability,
                    matched_skills, critical_gap_skills, resume_strengths, resume_weaknesses,
                    priority_changes, keyword_injections,
                    estimated_improved_score, tailored_resume_latex, tailored_resume_path,
                    raw_response, model_used, scored_at
                )
                SELECT
                    id, target_job_id, provider,
                    final_ats_score, keyword_match_score, semantic_alignment_score,
                    technical_skills_score, experience_relevance_score, project_alignment_score,
                    impact_score, ats_structure_score, recruiter_readability_score,
                    seniority_fit_score, domain_fit_score, tailoring_readiness_score,
                    ats_pass_probability, shortlist_probability, interview_probability,
                    rejection_probability,
                    matched_skills, critical_gap_skills, resume_strengths, resume_weaknesses,
                    priority_changes, keyword_injections,
                    estimated_improved_score, tailored_resume_latex, tailored_resume_path,
                    raw_response, model_used, scored_at
                FROM ats_scores WHERE provider = 'gemini'
                UNION ALL
                SELECT
                    id, target_job_id, provider,
                    final_ats_score, keyword_match_score, semantic_alignment_score,
                    technical_skills_score, experience_relevance_score, project_alignment_score,
                    impact_score, ats_structure_score, recruiter_readability_score,
                    seniority_fit_score, domain_fit_score, tailoring_readiness_score,
                    ats_pass_probability, shortlist_probability, interview_probability,
                    rejection_probability,
                    matched_skills, critical_gap_skills, resume_strengths, resume_weaknesses,
                    priority_changes, keyword_injections,
                    estimated_improved_score, tailored_resume_latex, tailored_resume_path,
                    raw_response, model_used, scored_at
                FROM ats_scores
                WHERE provider != 'gemini'
                  AND target_job_id NOT IN (
                      SELECT target_job_id FROM ats_scores WHERE provider = 'gemini'
                  );
                DROP TABLE ats_scores;
                ALTER TABLE ats_scores_v3 RENAME TO ats_scores;
                CREATE INDEX IF NOT EXISTS idx_ats_final     ON ats_scores(final_ats_score DESC);
                CREATE INDEX IF NOT EXISTS idx_ats_shortlist ON ats_scores(shortlist_probability DESC);
                CREATE INDEX IF NOT EXISTS idx_ats_provider  ON ats_scores(provider);
            """)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── raw_posts ────────────────────────────────────────────────

def insert_raw_post(
    *,
    activity_urn:    str,
    post_url:        str,
    post_content:    str,
    post_author:     Optional[str] = None,
    author_headline: Optional[str] = None,
    profile_url:     Optional[str] = None,
    days_filter:     int = 1,
    scraped_at:      Optional[str] = None,
    posted_at:       Optional[str] = None,
) -> Optional[int]:
    """Insert one raw_posts row. Returns the new id, or None when the URN
    already exists (cross-run dedup)."""
    with get_conn() as conn:
        try:
            cur = conn.execute(
                """INSERT INTO raw_posts (
                    activity_urn, post_url, post_content,
                    post_author, author_headline, profile_url,
                    days_filter, scraped_at, posted_at
                ) VALUES (?,?,?,?,?,?,?,?,?)""",
                (activity_urn, post_url, post_content,
                 post_author or "", author_headline or "",
                 profile_url or "", days_filter,
                 scraped_at or now_iso(), posted_at),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None  # duplicate URN


def backfill_posted_at(activity_urn: str, posted_at: str) -> None:
    """Set posted_at on an existing row only when it is currently NULL.
    Safe to call on every duplicate — no-op if already populated."""
    if not posted_at:
        return
    with get_conn() as conn:
        conn.execute(
            "UPDATE raw_posts SET posted_at = ? WHERE activity_urn = ? AND posted_at IS NULL",
            (posted_at, activity_urn),
        )


def get_pending_raw_posts(limit: int = 5) -> list:
    """Pull a batch of raw posts awaiting extraction, oldest first."""
    with get_conn() as conn:
        return conn.execute(
            """SELECT * FROM raw_posts
               WHERE extraction_status = 'pending'
               ORDER BY scraped_at ASC, id ASC
               LIMIT ?""",
            (limit,),
        ).fetchall()


# ── normalized_posts ─────────────────────────────────────────

# Columns the extractor is allowed to set on insert. Kept explicit so a
# typo in the extractor doesn't silently write to a non-existent column.
_NORM_COLS = (
    "title", "company",
    "location_raw", "location_city", "location_state", "location_country",
    "is_remote", "work_mode",
    "experience_min", "experience_max",
    "role_type",
    "recruiter_email", "recruiter_name",
    "recruiter_designation", "recruiter_current_company",
    "apply_via", "apply_url",
    "skills",
    "email_subject_format",
    "email_required_fields",
    "extracted_by",
)


def insert_normalized_post(raw_post_id: int, fields: dict) -> int:
    """Insert one normalized_posts row AND mark its raw_posts row done.
    Atomic — both writes share a transaction so the raw status can't
    drift from the normalized data."""
    used = {k: fields.get(k) for k in _NORM_COLS}
    cols = ["raw_post_id"] + list(used.keys()) + ["created_at"]
    vals = [raw_post_id]  + list(used.values()) + [now_iso()]
    placeholders = ",".join("?" * len(cols))

    with get_conn() as conn:
        cur = conn.execute(
            f"INSERT INTO normalized_posts ({','.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        conn.execute(
            "UPDATE raw_posts SET extraction_status='done', extracted_at=? "
            "WHERE id=?",
            (now_iso(), raw_post_id),
        )
        return cur.lastrowid


def mark_raw_failed(raw_post_id: int, error: str) -> None:
    """Record an extraction failure on a raw_posts row."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE raw_posts SET extraction_status='failed', "
            "extracted_at=?, extract_error=? WHERE id=?",
            (now_iso(), (error or "")[:500], raw_post_id),
        )


def get_untrained_normalized_posts() -> list:
    """Return all normalized_posts not yet used for NER training, joined with
    the raw post text needed to build spaCy training examples."""
    with get_conn() as conn:
        return conn.execute("""
            SELECT n.id, n.title, n.company, n.skills,
                   n.email_subject_format, n.email_required_fields,
                   r.post_author, r.author_headline, r.post_content
            FROM normalized_posts n
            JOIN raw_posts r ON r.id = n.raw_post_id
            WHERE n.is_trained = 'not_trained'
              AND n.title IS NOT NULL
            ORDER BY n.id
        """).fetchall()


def mark_posts_trained(norm_post_ids: list) -> None:
    """Flip is_trained = 'trained' for a batch of normalized_posts rows."""
    if not norm_post_ids:
        return
    placeholders = ",".join("?" * len(norm_post_ids))
    with get_conn() as conn:
        conn.execute(
            f"UPDATE normalized_posts SET is_trained = 'trained' "
            f"WHERE id IN ({placeholders})",
            norm_post_ids,
        )


# ── Stats / utilities ────────────────────────────────────────

# ── target_jobs ──────────────────────────────────────────────

def insert_target_job(norm_post_id: int, raw_post_id: int,
                      clouds_required: str = "", cloud_fit: str = "") -> Optional[int]:
    """Insert into target_jobs. Returns new id or None if already exists."""
    with get_conn() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO target_jobs (norm_post_id, raw_post_id, filtered_at, "
                "clouds_required, cloud_fit) VALUES (?,?,?,?,?)",
                (norm_post_id, raw_post_id, now_iso(), clouds_required, cloud_fit),
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None


def get_unscored_targets() -> list:
    """Return target_jobs with no ats_scores rows at all (legacy — use get_targets_to_score)."""
    with get_conn() as conn:
        return conn.execute("""
            SELECT t.id as target_id, t.norm_post_id, t.raw_post_id,
                   r.post_content, r.post_author, r.author_headline,
                   n.title, n.company, n.skills, n.experience_min, n.experience_max
            FROM target_jobs t
            JOIN raw_posts r        ON r.id = t.raw_post_id
            JOIN normalized_posts n ON n.id = t.norm_post_id
            WHERE (SELECT COUNT(*) FROM ats_scores a WHERE a.target_job_id = t.id) = 0
            ORDER BY t.id
        """).fetchall()


def get_targets_to_score() -> list:
    """Return target_jobs with no ATS score yet (unified cascade — one score per job)."""
    return get_unscored_targets()


# ── ats_scores ────────────────────────────────────────────────

def insert_ats_score(target_job_id: int, fields: dict, provider: str = "gemini") -> int:
    """Insert one ats_scores row. provider is 'gemini' or 'groq'."""
    cols = [
        "target_job_id", "provider",
        "final_ats_score", "keyword_match_score", "semantic_alignment_score",
        "technical_skills_score", "experience_relevance_score", "project_alignment_score",
        "impact_score", "ats_structure_score", "recruiter_readability_score",
        "seniority_fit_score", "domain_fit_score", "tailoring_readiness_score",
        "ats_pass_probability", "shortlist_probability", "interview_probability",
        "rejection_probability",
        "matched_skills", "critical_gap_skills", "resume_strengths",
        "resume_weaknesses", "priority_changes", "keyword_injections",
        "estimated_improved_score", "tailored_resume_latex",
        "tailored_resume_path",
        "raw_response", "model_used", "scored_at",
    ]
    vals = [target_job_id, provider] + [fields.get(c) for c in cols[2:]]
    placeholders = ",".join("?" * len(cols))
    with get_conn() as conn:
        cur = conn.execute(
            f"INSERT INTO ats_scores ({','.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        return cur.lastrowid


def stats() -> dict:
    with get_conn() as conn:
        def n(sql, *args):
            return conn.execute(sql, args).fetchone()[0]
        return {
            "raw_total":   n("SELECT COUNT(*) FROM raw_posts"),
            "raw_pending": n("SELECT COUNT(*) FROM raw_posts WHERE extraction_status='pending'"),
            "raw_done":    n("SELECT COUNT(*) FROM raw_posts WHERE extraction_status='done'"),
            "raw_failed":  n("SELECT COUNT(*) FROM raw_posts WHERE extraction_status='failed'"),
            "normalized":  n("SELECT COUNT(*) FROM normalized_posts"),
        }


def flush_all() -> dict:
    """Drop everything — use with care."""
    with get_conn() as conn:
        raw  = conn.execute("SELECT COUNT(*) FROM raw_posts").fetchone()[0]
        norm = conn.execute("SELECT COUNT(*) FROM normalized_posts").fetchone()[0]
        # ON DELETE CASCADE handles the normalized rows
        conn.execute("DELETE FROM raw_posts")
        conn.execute("DELETE FROM sqlite_sequence "
                     "WHERE name IN ('raw_posts','normalized_posts')")
    return {"raw_deleted": raw, "normalized_deleted": norm}
