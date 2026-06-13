"""
Job Hunter Agent — API Server (Flask)
Serves only REST API endpoints consumed by the React frontend.

React dev server: http://localhost:5173  (proxies /api/* here)
API only:         http://localhost:5000
"""
import json
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)
DB_PATH = Path(__file__).parent.parent / "data" / "linkedin_scraper.db"

# Handle to the last pipeline subprocess started via /api/run-pipeline
_pipeline_proc = None

# NER training state (in-process background thread)
_ner_state = {"running": False, "last_run": None, "last_count": 0, "error": None}

TRACKER_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected"]


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_tracker_table():
    """Application tracker lives dashboard-side; created on demand so the
    scraper pipeline never needs to know about it."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_tracker (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            target_job_id INTEGER NOT NULL UNIQUE
                          REFERENCES target_jobs(id) ON DELETE CASCADE,
            status        TEXT NOT NULL DEFAULT 'saved',
            notes         TEXT,
            updated_at    TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()


init_tracker_table()


def init_email_outreach_table():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS email_outreach (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            target_job_id INTEGER NOT NULL REFERENCES target_jobs(id),
            to_email      TEXT NOT NULL,
            subject       TEXT,
            body_text     TEXT,
            sent_at       TEXT,
            status        TEXT DEFAULT 'pending',
            error         TEXT,
            model_used    TEXT
        )
    """)
    conn.commit()
    conn.close()


init_email_outreach_table()


def normalize_prob(v):
    """Probabilities are stored inconsistently (0-1 or 0-100). Always return 0-100."""
    if v is None:
        return None
    v = float(v)
    return round(v * 100 if v <= 1 else v, 1)


def parse_json_field(v):
    if not v:
        return []
    try:
        parsed = json.loads(v)
        if isinstance(parsed, list):
            return parsed
        return [str(parsed)]
    except Exception:
        return [v] if v else []


# ── API ──────────────────────────────────────────────────────────────────────

@app.route("/api/stats")
def api_stats():
    conn = get_db()
    raw_total = conn.execute("SELECT COUNT(*) FROM raw_posts").fetchone()[0]
    raw_done  = conn.execute("SELECT COUNT(*) FROM raw_posts WHERE extraction_status='done'").fetchone()[0]
    raw_fail  = conn.execute("SELECT COUNT(*) FROM raw_posts WHERE extraction_status='failed'").fetchone()[0]
    normalized = conn.execute("SELECT COUNT(*) FROM normalized_posts").fetchone()[0]
    targeted  = conn.execute("SELECT COUNT(*) FROM target_jobs").fetchone()[0]
    scored    = conn.execute("SELECT COUNT(*) FROM ats_scores WHERE 1=1").fetchone()[0]
    avg_score = conn.execute("SELECT ROUND(AVG(final_ats_score),1) FROM ats_scores WHERE 1=1").fetchone()[0]
    high80    = conn.execute("SELECT COUNT(*) FROM ats_scores WHERE 1=1 AND final_ats_score >= 80").fetchone()[0]
    last_run  = conn.execute("SELECT MAX(scraped_at) FROM raw_posts").fetchone()[0]

    by_date = [dict(r) for r in conn.execute(
        "SELECT substr(scraped_at,1,10) as date, COUNT(*) as cnt FROM raw_posts GROUP BY date ORDER BY date"
    )]

    by_status = {r["extraction_status"]: r["cnt"] for r in conn.execute(
        "SELECT extraction_status, COUNT(*) as cnt FROM raw_posts GROUP BY extraction_status"
    )}

    # Today's funnel (last scraped date)
    today = last_run[:10] if last_run else ""
    today_scraped  = conn.execute("SELECT COUNT(*) FROM raw_posts WHERE substr(scraped_at,1,10)=?", (today,)).fetchone()[0]
    today_extracted = conn.execute(
        "SELECT COUNT(*) FROM raw_posts WHERE substr(scraped_at,1,10)=? AND extraction_status='done'", (today,)
    ).fetchone()[0]
    today_targeted = conn.execute(
        "SELECT COUNT(*) FROM target_jobs t JOIN raw_posts r ON r.id=t.raw_post_id WHERE substr(r.scraped_at,1,10)=?", (today,)
    ).fetchone()[0]
    today_scored = conn.execute(
        "SELECT COUNT(*) FROM ats_scores s JOIN target_jobs t ON t.id=s.target_job_id JOIN raw_posts r ON r.id=t.raw_post_id WHERE substr(r.scraped_at,1,10)=?", (today,)
    ).fetchone()[0]

    # Rejection reasons approximation from last run
    # (We store these in log only; approximate from normalized vs raw)
    work_modes = {r["work_mode"] or "unknown": r["cnt"] for r in conn.execute(
        "SELECT work_mode, COUNT(*) as cnt FROM normalized_posts GROUP BY work_mode"
    )}

    score_bands = {}
    for row in conn.execute("""
        SELECT CASE
            WHEN final_ats_score>=80 THEN '80-100'
            WHEN final_ats_score>=60 THEN '60-79'
            WHEN final_ats_score>=40 THEN '40-59'
            ELSE '<40'
        END as band, COUNT(*) as cnt FROM ats_scores WHERE 1=1 GROUP BY band
    """):
        score_bands[row["band"]] = row["cnt"]

    # Cloud-fit split across targeted jobs (the pipeline's core outreach signal)
    cloud_fit = {r["cloud_fit"] or "unknown": r["cnt"] for r in conn.execute(
        "SELECT cloud_fit, COUNT(*) as cnt FROM target_jobs GROUP BY cloud_fit"
    )}

    # Freshness — jobs whose LinkedIn post is recent (by posted_at, not scrape time)
    fresh_24h = conn.execute(
        "SELECT COUNT(*) FROM target_jobs t JOIN raw_posts r ON r.id=t.raw_post_id "
        "WHERE r.posted_at >= datetime('now','-24 hours')"
    ).fetchone()[0]
    fresh_48h = conn.execute(
        "SELECT COUNT(*) FROM target_jobs t JOIN raw_posts r ON r.id=t.raw_post_id "
        "WHERE r.posted_at >= datetime('now','-48 hours')"
    ).fetchone()[0]
    # Hot leads: fresh (48h) + aws_match + score >= 60 — the outreach shortlist
    hot_leads = conn.execute(
        "SELECT COUNT(*) FROM target_jobs t "
        "JOIN raw_posts r ON r.id=t.raw_post_id "
        "JOIN ats_scores s ON s.target_job_id=t.id "
        "WHERE r.posted_at >= datetime('now','-48 hours') "
        "AND t.cloud_fit='aws_match' AND s.final_ats_score >= 60"
    ).fetchone()[0]

    conn.close()
    return jsonify({
        "raw_total": raw_total,
        "raw_done": raw_done,
        "raw_failed": raw_fail,
        "normalized": normalized,
        "targeted": targeted,
        "scored": scored,
        "avg_score": avg_score,
        "high_match_80": high80,
        "last_run": last_run[:16].replace("T", " ") if last_run else "—",
        "by_date": by_date,
        "by_status": by_status,
        "today": today,
        "today_funnel": {
            "scraped": today_scraped,
            "extracted": today_extracted,
            "filtered": today_targeted,
            "scored": today_scored,
        },
        "work_modes": work_modes,
        "score_bands": score_bands,
        "cloud_fit": cloud_fit,
        "fresh_24h": fresh_24h,
        "fresh_48h": fresh_48h,
        "hot_leads": hot_leads,
    })


@app.route("/api/jobs")
def api_jobs():
    score_min   = request.args.get("score_min", 0, type=int)
    work_mode   = request.args.get("work_mode", "")
    search      = request.args.get("q", "").strip()
    sort        = request.args.get("sort", "score")
    cloud_fit   = request.args.get("cloud_fit", "")          # aws_match | no_cloud_req | other_cloud_only
    posted_hrs  = request.args.get("posted_within", 0, type=int)  # 0 = any age
    has_email   = request.args.get("has_email", "")          # "1" to require recruiter email
    tracker     = request.args.get("tracker", "")            # tracker status filter; "untracked" supported

    conn = get_db()
    query = """
        SELECT t.id AS target_id,
               t.clouds_required, t.cloud_fit,
               n.title, n.company, n.location_city, n.location_state,
               n.work_mode, n.is_remote, n.experience_min, n.experience_max,
               n.recruiter_email, n.recruiter_name, n.apply_url,
               n.skills, n.email_required_fields, n.email_subject_format,
               s.final_ats_score,
               s.shortlist_probability, s.interview_probability,
               s.matched_skills, s.critical_gap_skills,
               s.priority_changes, s.keyword_injections,
               s.seniority_fit_score, s.technical_skills_score,
               r.scraped_at, r.posted_at, r.post_url,
               k.status AS tracker_status
        FROM target_jobs t
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN raw_posts r        ON r.id = t.raw_post_id
        LEFT JOIN ats_scores s  ON s.target_job_id = t.id
        LEFT JOIN job_tracker k ON k.target_job_id = t.id
        WHERE COALESCE(s.final_ats_score, 0) >= ?
    """
    params = [score_min]

    if work_mode and work_mode != "all":
        query += " AND n.work_mode = ?"
        params.append(work_mode)

    if cloud_fit and cloud_fit != "all":
        query += " AND t.cloud_fit = ?"
        params.append(cloud_fit)

    if posted_hrs and posted_hrs > 0:
        query += " AND r.posted_at IS NOT NULL AND r.posted_at >= datetime('now', ? || ' hours')"
        params.append(-posted_hrs)

    if has_email == "1":
        query += " AND n.recruiter_email IS NOT NULL AND TRIM(n.recruiter_email) != ''"

    if tracker == "untracked":
        query += " AND k.status IS NULL"
    elif tracker and tracker != "all":
        query += " AND k.status = ?"
        params.append(tracker)

    if search:
        query += " AND (n.title LIKE ? OR n.company LIKE ? OR n.recruiter_email LIKE ? OR n.skills LIKE ?)"
        s = f"%{search}%"
        params += [s, s, s, s]

    order = {
        "score":     "s.final_ats_score DESC",
        "date":      "r.scraped_at DESC",
        "posted":    "r.posted_at DESC",
        "interview": "s.interview_probability DESC",
    }
    query += f" ORDER BY {order.get(sort, 'COALESCE(s.final_ats_score,0) DESC')}"

    rows = conn.execute(query, params).fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d["shortlist_probability"] = normalize_prob(d["shortlist_probability"])
        d["interview_probability"] = normalize_prob(d["interview_probability"])
        d["matched_skills"]    = parse_json_field(d["matched_skills"])
        d["critical_gap_skills"] = parse_json_field(d["critical_gap_skills"])
        d["priority_changes"]  = parse_json_field(d["priority_changes"])
        d["keyword_injections"] = parse_json_field(d["keyword_injections"])
        d["skills_list"] = [s.strip() for s in (d["skills"] or "").split(",") if s.strip()]
        d["clouds_list"] = [c.strip() for c in (d["clouds_required"] or "").split(",") if c.strip()]
        d["location"] = ", ".join(filter(None, [d["location_city"], d["location_state"]]))
        result.append(d)

    return jsonify(result)


@app.route("/api/jobs/<int:target_id>")
def api_job_detail(target_id):
    conn = get_db()
    row = conn.execute("""
        SELECT t.id AS target_id,
               t.clouds_required, t.cloud_fit,
               n.*, r.post_content, r.post_url, r.post_author, r.scraped_at, r.posted_at,
               s.*,
               k.status AS tracker_status, k.notes AS tracker_notes
        FROM target_jobs t
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN raw_posts r        ON r.id = t.raw_post_id
        LEFT JOIN ats_scores s  ON s.target_job_id = t.id
        LEFT JOIN job_tracker k ON k.target_job_id = t.id
        WHERE t.id = ?
    """, (target_id,)).fetchone()

    # outreach history for this job (most recent first)
    outreach = [dict(o) for o in conn.execute("""
        SELECT to_email, subject, sent_at, status, error, model_used
        FROM email_outreach WHERE target_job_id = ? ORDER BY id DESC
    """, (target_id,)).fetchall()]
    conn.close()

    if not row:
        return jsonify({"error": "not found"}), 404

    d = dict(row)
    for field in ["matched_skills", "critical_gap_skills", "resume_strengths",
                  "resume_weaknesses", "priority_changes", "keyword_injections"]:
        d[field] = parse_json_field(d.get(field))
    for field in ["shortlist_probability", "interview_probability",
                  "ats_pass_probability", "rejection_probability"]:
        d[field] = normalize_prob(d.get(field))
    d["location"] = ", ".join(filter(None, [d.get("location_city"), d.get("location_state")]))
    d["skills_list"] = [s.strip() for s in (d.get("skills") or "").split(",") if s.strip()]
    d["clouds_list"] = [c.strip() for c in (d.get("clouds_required") or "").split(",") if c.strip()]
    d["email_required_list"] = [f.strip() for f in (d.get("email_required_fields") or "").split(",") if f.strip()]
    d["outreach_history"] = outreach
    return jsonify(d)


@app.route("/api/skills-gap")
def api_skills_gap():
    conn = get_db()
    rows = conn.execute("SELECT critical_gap_skills FROM ats_scores WHERE 1=1 AND critical_gap_skills IS NOT NULL").fetchall()
    conn.close()

    freq = {}
    for row in rows:
        for skill in parse_json_field(row["critical_gap_skills"]):
            skill = skill.strip()
            if skill:
                freq[skill] = freq.get(skill, 0) + 1

    total_jobs = len(rows)
    sorted_gaps = sorted(freq.items(), key=lambda x: x[1], reverse=True)
    return jsonify([
        {"skill": k, "count": v, "pct": round(v / total_jobs * 100) if total_jobs else 0}
        for k, v in sorted_gaps[:20]
    ])


@app.route("/api/recruiters")
def api_recruiters():
    conn = get_db()
    rows = conn.execute("""
        SELECT
            n.recruiter_email,
            n.recruiter_name,
            n.recruiter_designation,
            n.recruiter_current_company,
            COUNT(DISTINCT n.id) as post_count,
            GROUP_CONCAT(DISTINCT n.company) as companies,
            MAX(r.scraped_at) as last_seen,
            ROUND(AVG(s.final_ats_score), 1) as avg_score,
            MAX(s.final_ats_score) as best_score,
            COUNT(DISTINCT t.id) as scored_count
        FROM normalized_posts n
        JOIN raw_posts r ON r.id = n.raw_post_id
        LEFT JOIN target_jobs t ON t.norm_post_id = n.id
        LEFT JOIN ats_scores s ON s.target_job_id = t.id         WHERE n.recruiter_email IS NOT NULL
        GROUP BY n.recruiter_email
        ORDER BY post_count DESC, avg_score DESC
    """).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/raw-posts")
def api_raw_posts():
    page  = request.args.get("page", 1, type=int)
    limit = request.args.get("limit", 20, type=int)
    q     = request.args.get("q", "").strip()
    offset = (page - 1) * limit

    conn = get_db()

    where = "WHERE 1=1"
    params = []
    if q:
        where += " AND (r.post_content LIKE ? OR r.post_author LIKE ?)"
        params += [f"%{q}%", f"%{q}%"]

    total = conn.execute(f"SELECT COUNT(*) FROM raw_posts r {where}", params).fetchone()[0]
    rows = conn.execute(f"""
        SELECT r.id, r.post_author, r.author_headline, r.scraped_at, r.posted_at,
               r.extraction_status, r.days_filter, r.post_url,
               r.post_content,
               n.title, n.company, n.work_mode, n.recruiter_email,
               n.experience_min, n.experience_max,
               s.final_ats_score
        FROM raw_posts r
        LEFT JOIN normalized_posts n ON n.raw_post_id = r.id
        LEFT JOIN target_jobs t ON t.raw_post_id = r.id
        LEFT JOIN ats_scores s ON s.target_job_id = t.id         {where}
        ORDER BY r.id DESC
        LIMIT ? OFFSET ?
    """, params + [limit, offset]).fetchall()
    conn.close()

    return jsonify({
        "total": total,
        "page": page,
        "pages": (total + limit - 1) // limit,
        "rows": [dict(r) for r in rows]
    })


@app.route("/api/analytics")
def api_analytics():
    """Market-level insights: companies, skill demand, locations, experience,
    apply channels, average sub-scores, score trend."""
    conn = get_db()

    top_companies = [dict(r) for r in conn.execute("""
        SELECT n.company, COUNT(*) AS cnt, ROUND(AVG(s.final_ats_score),1) AS avg_score
        FROM normalized_posts n
        LEFT JOIN target_jobs t ON t.norm_post_id = n.id
        LEFT JOIN ats_scores s  ON s.target_job_id = t.id         WHERE n.company IS NOT NULL AND TRIM(n.company) != ''
          AND LOWER(TRIM(n.company)) NOT IN ('null', 'none', 'unknown', 'n/a')
        GROUP BY LOWER(TRIM(n.company))
        ORDER BY cnt DESC LIMIT 12
    """)]

    # Skill demand: skills column is CSV — count in Python
    skill_freq = {}
    for row in conn.execute("SELECT skills FROM normalized_posts WHERE skills IS NOT NULL"):
        for sk in row["skills"].split(","):
            sk = sk.strip()
            if sk:
                key = sk.lower()
                skill_freq[key] = skill_freq.get(key, {"skill": sk, "count": 0})
                skill_freq[key]["count"] += 1
    top_skills = sorted(skill_freq.values(), key=lambda x: x["count"], reverse=True)[:24]

    locations = [dict(r) for r in conn.execute("""
        SELECT COALESCE(NULLIF(TRIM(location_city),''),'Unknown') AS city, COUNT(*) AS cnt
        FROM normalized_posts
        GROUP BY LOWER(COALESCE(NULLIF(TRIM(location_city),''),'Unknown'))
        ORDER BY cnt DESC LIMIT 10
    """)]

    exp_buckets = {"0-2 yrs": 0, "2-4 yrs": 0, "4-6 yrs": 0, "6+ yrs": 0, "Unspecified": 0}
    for row in conn.execute("SELECT experience_min FROM normalized_posts"):
        e = row["experience_min"]
        if e is None:
            exp_buckets["Unspecified"] += 1
        elif e < 2:
            exp_buckets["0-2 yrs"] += 1
        elif e < 4:
            exp_buckets["2-4 yrs"] += 1
        elif e < 6:
            exp_buckets["4-6 yrs"] += 1
        else:
            exp_buckets["6+ yrs"] += 1

    apply_via = {r["channel"]: r["cnt"] for r in conn.execute("""
        SELECT COALESCE(NULLIF(TRIM(apply_via),''),'unknown') AS channel, COUNT(*) AS cnt
        FROM normalized_posts GROUP BY channel
    """)}

    sub_score_cols = [
        "keyword_match_score", "semantic_alignment_score", "technical_skills_score",
        "experience_relevance_score", "project_alignment_score", "impact_score",
        "ats_structure_score", "recruiter_readability_score", "seniority_fit_score",
        "domain_fit_score", "tailoring_readiness_score",
    ]
    avg_row = conn.execute(
        "SELECT " + ", ".join(f"ROUND(AVG({c}),1) AS {c}" for c in sub_score_cols) +
        " FROM ats_scores WHERE 1=1"
    ).fetchone()
    avg_sub_scores = {c: avg_row[c] for c in sub_score_cols}

    score_trend = [dict(r) for r in conn.execute("""
        SELECT substr(scored_at,1,10) AS date,
               ROUND(AVG(final_ats_score),1) AS avg_score, COUNT(*) AS cnt
        FROM ats_scores WHERE 1=1 GROUP BY date ORDER BY date
    """)]

    extracted_by = {r["extracted_by"]: r["cnt"] for r in conn.execute(
        "SELECT extracted_by, COUNT(*) AS cnt FROM normalized_posts GROUP BY extracted_by"
    )}

    cloud_fit = {r["cloud_fit"] or "unknown": r["cnt"] for r in conn.execute(
        "SELECT cloud_fit, COUNT(*) AS cnt FROM target_jobs GROUP BY cloud_fit"
    )}

    # Individual cloud-platform demand across targeted jobs (clouds_required is CSV)
    cloud_demand = {"aws": 0, "azure": 0, "gcp": 0}
    for row in conn.execute("SELECT clouds_required FROM target_jobs WHERE clouds_required != ''"):
        for cl in (row["clouds_required"] or "").split(","):
            cl = cl.strip().lower()
            if cl in cloud_demand:
                cloud_demand[cl] += 1

    # Used by the scorer cascade — which model graded each job
    model_usage = [dict(r) for r in conn.execute("""
        SELECT COALESCE(model_used,'unknown') AS model, provider, COUNT(*) AS cnt
        FROM ats_scores GROUP BY model_used ORDER BY cnt DESC
    """)]

    conn.close()
    return jsonify({
        "top_companies": top_companies,
        "top_skills": top_skills,
        "locations": locations,
        "experience_buckets": exp_buckets,
        "apply_via": apply_via,
        "avg_sub_scores": avg_sub_scores,
        "score_trend": score_trend,
        "extracted_by": extracted_by,
        "cloud_fit": cloud_fit,
        "cloud_demand": cloud_demand,
        "model_usage": model_usage,
    })


# ── Application tracker ──────────────────────────────────────────────────────

@app.route("/api/tracker")
def api_tracker():
    conn = get_db()
    rows = conn.execute("""
        SELECT k.target_job_id, k.status, k.notes, k.updated_at,
               n.title, n.company, n.work_mode, n.recruiter_email, n.recruiter_name,
               n.location_city, n.location_state, n.apply_url,
               s.final_ats_score, s.interview_probability,
               r.post_url
        FROM job_tracker k
        JOIN target_jobs t      ON t.id = k.target_job_id
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN raw_posts r        ON r.id = t.raw_post_id
        LEFT JOIN ats_scores s  ON s.target_job_id = t.id         ORDER BY k.updated_at DESC
    """).fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d["interview_probability"] = normalize_prob(d["interview_probability"])
        d["location"] = ", ".join(filter(None, [d.pop("location_city"), d.pop("location_state")]))
        result.append(d)
    return jsonify(result)


@app.route("/api/tracker/<int:target_id>", methods=["POST", "DELETE"])
def api_tracker_update(target_id):
    conn = get_db()
    if request.method == "DELETE":
        conn.execute("DELETE FROM job_tracker WHERE target_job_id = ?", (target_id,))
        conn.commit()
        conn.close()
        return jsonify({"status": "removed"})

    body = request.get_json(silent=True) or {}
    status = body.get("status", "saved")
    if status not in TRACKER_STATUSES:
        conn.close()
        return jsonify({"error": f"status must be one of {TRACKER_STATUSES}"}), 400

    exists = conn.execute("SELECT 1 FROM target_jobs WHERE id = ?", (target_id,)).fetchone()
    if not exists:
        conn.close()
        return jsonify({"error": "target job not found"}), 404

    now = datetime.now().isoformat(timespec="seconds")
    conn.execute("""
        INSERT INTO job_tracker (target_job_id, status, notes, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(target_job_id) DO UPDATE SET
            status     = excluded.status,
            notes      = COALESCE(excluded.notes, job_tracker.notes),
            updated_at = excluded.updated_at
    """, (target_id, status, body.get("notes"), now))
    conn.commit()
    conn.close()
    return jsonify({"status": status, "target_job_id": target_id, "updated_at": now})


# ── NER training ─────────────────────────────────────────────────────────────

@app.route("/api/train-ner/status")
def api_train_ner_status():
    """Return training state and count of posts awaiting their first training run."""
    conn = get_db()
    untrained = conn.execute(
        "SELECT COUNT(*) FROM normalized_posts "
        "WHERE is_trained = 'not_trained' AND title IS NOT NULL"
    ).fetchone()[0]
    conn.close()
    return jsonify({
        "running":        _ner_state["running"],
        "last_run":       _ner_state["last_run"],
        "last_count":     _ner_state["last_count"],
        "error":          _ner_state["error"],
        "untrained_count": untrained,
    })


@app.route("/api/train-ner", methods=["POST"])
def api_train_ner():
    """
    Kick off an incremental NER training run in a background thread.
    Trains only on normalized_posts WHERE is_trained = 'not_trained',
    then marks them trained so the next call only processes new posts.

    Optional JSON body:
      { "all": true }   — retrain from scratch (ignores is_trained flag)
    """
    if _ner_state["running"]:
        return jsonify({"status": "already_running"}), 409

    body        = request.get_json(silent=True) or {}
    retrain_all = bool(body.get("all", False))

    def _run():
        import threading
        _ner_state["running"] = True
        _ner_state["error"]   = None
        try:
            import sys as _sys
            _sys.path.insert(0, str(Path(__file__).parent.parent))
            from model.train import train, load_training_data
            data, _ = load_training_data(retrain_all=retrain_all)
            _ner_state["last_count"] = len(data)
            ok = train(retrain_all=retrain_all)
            if not ok:
                _ner_state["error"] = f"Not enough examples ({len(data)}) to train"
            _ner_state["last_run"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        except Exception as exc:
            _ner_state["error"] = str(exc)
            app.logger.error("NER training failed: %s", exc)
        finally:
            _ner_state["running"] = False

    import threading
    threading.Thread(target=_run, daemon=True, name="ner-trainer").start()
    return jsonify({"status": "started", "retrain_all": retrain_all})


# ── Pipeline control ─────────────────────────────────────────────────────────

@app.route("/api/pipeline-status")
def api_pipeline_status():
    """Live pipeline state: subprocess liveness + extraction backlog."""
    global _pipeline_proc
    running = _pipeline_proc is not None and _pipeline_proc.poll() is None

    conn = get_db()
    pending = conn.execute(
        "SELECT COUNT(*) FROM raw_posts WHERE extraction_status='pending'"
    ).fetchone()[0]
    unscored = conn.execute("""
        SELECT COUNT(*) FROM target_jobs t
        WHERE (SELECT COUNT(*) FROM ats_scores s WHERE s.target_job_id = t.id) = 0
    """).fetchone()[0]
    last_run = conn.execute("SELECT MAX(scraped_at) FROM raw_posts").fetchone()[0]
    conn.close()

    return jsonify({
        "running": running,
        "exit_code": _pipeline_proc.returncode if _pipeline_proc and not running else None,
        "pending_extraction": pending,
        "unscored_targets": unscored,
        "last_run": last_run[:16].replace("T", " ") if last_run else None,
    })


@app.route("/api/run-pipeline", methods=["POST"])
def api_run_pipeline():
    """Trigger the full pipeline in background (no-op if already running)."""
    global _pipeline_proc
    if _pipeline_proc is not None and _pipeline_proc.poll() is None:
        return jsonify({"status": "already_running"})

    project_root = Path(__file__).parent.parent
    venv_python  = project_root / "venv" / "bin" / "python"
    _pipeline_proc = subprocess.Popen(
        [str(venv_python), "main.py"],
        cwd=str(project_root),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return jsonify({"status": "started"})


# ── Email outreach ────────────────────────────────────────────────────────────

@app.route("/api/jobs/<int:target_id>/generate-email", methods=["POST"])
def api_generate_email(target_id):
    """Generate email subject + body for a job using the AI model cascade."""
    conn = get_db()
    row = conn.execute("""
        SELECT t.id AS target_id,
               n.title, n.company, n.location_city, n.location_state,
               n.work_mode, n.experience_min, n.experience_max,
               n.skills, n.recruiter_email, n.recruiter_name,
               n.recruiter_designation, n.recruiter_current_company,
               n.email_subject_format, n.email_required_fields,
               r.post_content
        FROM target_jobs t
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN raw_posts r        ON r.id = t.raw_post_id
        WHERE t.id = ?
    """, (target_id,)).fetchone()
    conn.close()

    if not row:
        return jsonify({"error": "Job not found"}), 404

    job = dict(row)
    if not job.get("recruiter_email"):
        return jsonify({"error": "No recruiter email for this job"}), 400

    try:
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from pipeline.outreach.builder import build_email
        result = build_email(job)
        return jsonify({
            "subject":        result["subject"],
            "body":           result["body"],
            "to_email":       job["recruiter_email"],
            "model_used":     result.get("model_used"),
            "missing_fields": result.get("missing_fields", []),
        })
    except Exception as e:
        app.logger.error("Email generation failed for job %d: %s", target_id, e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/jobs/<int:target_id>/send-email", methods=["POST"])
def api_send_email(target_id):
    """Send the email (subject + body from request body) to the recruiter."""
    body = request.get_json(silent=True) or {}
    subject    = (body.get("subject") or "").strip()
    email_body = (body.get("body") or "").strip()
    to_email   = (body.get("to_email") or "").strip()

    if not subject or not email_body or not to_email:
        return jsonify({"error": "subject, body, and to_email are required"}), 400

    try:
        from pipeline.outreach.sender import send_email
        send_email(to_email=to_email, subject=subject, body=email_body)

        now = datetime.now().isoformat(timespec="seconds")
        conn = get_db()
        conn.execute("""
            INSERT INTO email_outreach
              (target_job_id, to_email, subject, body_text, sent_at, status, model_used)
            VALUES (?, ?, ?, ?, ?, 'sent', ?)
        """, (target_id, to_email, subject, email_body, now, body.get("model_used")))

        # Auto-mark as applied in tracker
        conn.execute("""
            INSERT INTO job_tracker (target_job_id, status, notes, updated_at)
            VALUES (?, 'applied', 'Auto-set after email sent', ?)
            ON CONFLICT(target_job_id) DO UPDATE SET
                status     = 'applied',
                updated_at = excluded.updated_at
        """, (target_id, now))
        conn.commit()
        conn.close()

        return jsonify({"status": "sent", "sent_at": now})

    except Exception as e:
        app.logger.error("Email send failed for job %d: %s", target_id, e)
        conn = get_db()
        conn.execute("""
            INSERT INTO email_outreach
              (target_job_id, to_email, subject, body_text, status, error)
            VALUES (?, ?, ?, ?, 'failed', ?)
        """, (target_id, to_email, subject, email_body, str(e)))
        conn.commit()
        conn.close()
        return jsonify({"error": str(e)}), 500


@app.route("/api/outreach")
def api_outreach():
    """Sent-email history joined with the job each email targeted."""
    conn = get_db()
    rows = conn.execute("""
        SELECT e.id, e.target_job_id, e.to_email, e.subject, e.sent_at,
               e.status, e.error, e.model_used,
               n.title, n.company, n.recruiter_name,
               s.final_ats_score
        FROM email_outreach e
        LEFT JOIN target_jobs t      ON t.id = e.target_job_id
        LEFT JOIN normalized_posts n ON n.id = t.norm_post_id
        LEFT JOIN ats_scores s       ON s.target_job_id = t.id
        ORDER BY e.id DESC
    """).fetchall()

    sent   = sum(1 for r in rows if r["status"] == "sent")
    failed = sum(1 for r in rows if r["status"] == "failed")
    conn.close()
    return jsonify({
        "total": len(rows),
        "sent": sent,
        "failed": failed,
        "rows": [dict(r) for r in rows],
    })


@app.route("/api/missing-fields")
def api_missing_fields():
    """Return accumulated missing fields from candidate_info.txt across all email generations."""
    missing_path = Path(__file__).parent.parent / "data" / "missing_fields.json"
    if not missing_path.exists():
        return jsonify({"fields": {}, "total_unique": 0})
    try:
        data = json.loads(missing_path.read_text())
    except (json.JSONDecodeError, OSError):
        return jsonify({"fields": {}, "total_unique": 0})
    sorted_fields = dict(sorted(data.items(), key=lambda x: x[1]["count"], reverse=True))
    return jsonify({"fields": sorted_fields, "total_unique": len(sorted_fields)})


if __name__ == "__main__":
    print("Job Hunter Dashboard → http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=True)
