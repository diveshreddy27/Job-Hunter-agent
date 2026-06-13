"""
Rescore all target_jobs with the current resume.

Usage:
  python scripts/rescore.py            # archive v1, clear scores, rescore
  python scripts/rescore.py --label v3 # use a custom archive label

Saves a snapshot of the current scores into data/scores_history.json
BEFORE clearing, so nothing is lost.
"""
import argparse
import json
import logging
import pathlib
import sqlite3
import sys
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

import db.database as database
from pipeline.ats.scorer import run_scorer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("rescore")

HISTORY_FILE = ROOT / "data" / "scores_history.json"
DB_PATH      = ROOT / "data" / "linkedin_scraper.db"


def _load_history() -> dict:
    if HISTORY_FILE.exists():
        return json.loads(HISTORY_FILE.read_text())
    return {}


def _save_history(h: dict) -> None:
    HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_FILE.write_text(json.dumps(h, indent=2))


def snapshot_current_scores(label: str) -> int:
    """Read all current ats_scores from DB and store them in scores_history.json."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT
            s.target_job_id,
            s.final_ats_score,
            s.keyword_match_score,
            s.semantic_alignment_score,
            s.technical_skills_score,
            s.experience_relevance_score,
            s.project_alignment_score,
            s.impact_score,
            s.ats_structure_score,
            s.recruiter_readability_score,
            s.seniority_fit_score,
            s.domain_fit_score,
            s.tailoring_readiness_score,
            s.ats_pass_probability,
            s.shortlist_probability,
            s.interview_probability,
            s.rejection_probability,
            s.matched_skills,
            s.critical_gap_skills,
            s.model_used,
            s.scored_at,
            n.title,
            n.company
        FROM ats_scores s
        JOIN target_jobs t ON t.id = s.target_job_id
        JOIN normalized_posts n ON n.id = t.norm_post_id
    """).fetchall()
    conn.close()

    history = _load_history()
    history[label] = {
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "count": len(rows),
        "scores": [dict(r) for r in rows],
    }
    _save_history(history)
    return len(rows)


def clear_scores() -> int:
    conn = sqlite3.connect(DB_PATH)
    deleted = conn.execute("SELECT COUNT(*) FROM ats_scores").fetchone()[0]
    conn.execute("DELETE FROM ats_scores")
    conn.commit()
    conn.close()
    return deleted


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default=None,
                    help="Label for the archived snapshot (default: auto v1/v2/...)")
    args = ap.parse_args()

    database.init_db()

    # figure out next label
    history = _load_history()
    if args.label:
        label = args.label
    else:
        n = len(history) + 1
        label = f"v{n}"

    # 1. snapshot old scores
    log.info("Archiving current scores as '%s' → %s", label, HISTORY_FILE)
    saved = snapshot_current_scores(label)
    log.info("Archived %d scores.", saved)

    # 2. clear
    deleted = clear_scores()
    log.info("Cleared %d rows from ats_scores.", deleted)

    # 3. rescore
    log.info("Starting scorer — 3 workers, one-shot mode …")
    total = run_scorer(done_event=None)
    log.info("Done. Scored %d jobs.", total)


if __name__ == "__main__":
    main()
