"""
Filter normalized_posts → target_jobs (Stage 3).

All business-logic filters live here.  The processor (Stage 2) now ingests
every normalised post unconditionally, so this is the single gate that
decides which posts are worth ATS-scoring.

Rules applied (all must pass):
  1. Location  — city in ATS_TARGET_CITIES, OR state in ATS_TARGET_STATES,
                 OR remote, OR both city+state null (ATS_INCLUDE_NULL_LOCATION)
  2. Experience — candidate window overlaps post range (null range → keep)
  3. Contract  — role_type != 'contract' AND no contract keywords in raw text
  4. Email     — recruiter_email present (when REQUIRE_EMAIL_FOR_INGESTION=True)

Run standalone:
    python ats/filter.py
"""
import logging
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from db import database as db
from pipeline.scraper.location_utils import is_contract_role
import settings as cfg

log = logging.getLogger("ats.filter")


def _location_ok(city: str, state: str, is_remote: int) -> bool:
    if cfg.ATS_INCLUDE_REMOTE and is_remote:
        return True
    if not city and not state:
        return cfg.ATS_INCLUDE_NULL_LOCATION
    if city:
        cities = {c.strip().lower() for c in city.split(",")}
        if cities & cfg.ATS_TARGET_CITIES:
            return True
    if state and state.lower() in cfg.ATS_TARGET_STATES:
        return True
    return False


def _experience_ok(exp_min, exp_max) -> bool:
    if exp_min is None and exp_max is None:
        return True
    lo = float(exp_min) if exp_min is not None else 0.0
    hi = float(exp_max) if exp_max is not None else 99.0
    return lo <= cfg.ATS_CANDIDATE_EXP_MAX and hi >= cfg.ATS_CANDIDATE_EXP_MIN


def run_filter() -> tuple[int, int]:
    """
    Read normalized_posts not yet in target_jobs, apply all filters,
    insert passing rows. Returns (added, skipped).
    """
    with db.get_conn() as conn:
        rows = conn.execute("""
            SELECT n.id AS norm_id, n.raw_post_id,
                   n.location_city, n.location_state, n.is_remote,
                   n.experience_min, n.experience_max,
                   n.title, n.company,
                   n.role_type, n.recruiter_email,
                   r.post_content
            FROM normalized_posts n
            JOIN raw_posts r ON r.id = n.raw_post_id
            LEFT JOIN target_jobs t ON t.norm_post_id = n.id
            WHERE t.id IS NULL
        """).fetchall()

    added = skipped = 0
    for r in rows:
        reasons = []

        if not _location_ok(r["location_city"], r["location_state"], r["is_remote"]):
            reasons.append(f"location city={r['location_city']}|state={r['location_state']}")

        if not _experience_ok(r["experience_min"], r["experience_max"]):
            reasons.append(f"exp={r['experience_min']}-{r['experience_max']}")

        if r["role_type"] == "contract" or is_contract_role(r["post_content"] or ""):
            reasons.append("contract/freelance role")

        if getattr(cfg, "REQUIRE_EMAIL_FOR_INGESTION", True) and not r["recruiter_email"]:
            reasons.append("no recruiter email")

        if not reasons:
            db.insert_target_job(r["norm_id"], r["raw_post_id"])
            added += 1
            log.info("[filter] PASS  norm_id=%-3d  %s @ %s",
                     r["norm_id"], r["title"] or "?", r["company"] or "?")
        else:
            skipped += 1
            log.info("[filter] SKIP  norm_id=%-3d  %s — %s",
                     r["norm_id"], r["title"] or "?", "  |  ".join(reasons))

    log.info("[filter] Done — added=%d  skipped=%d", added, skipped)
    return added, skipped


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s  %(levelname)-7s  %(message)s")
    db.init_db()
    added, skipped = run_filter()
    with db.get_conn() as conn:
        total = conn.execute("SELECT COUNT(*) FROM target_jobs").fetchone()[0]
    print(f"\nAdded: {added}  |  Skipped: {skipped}  |  Total in target_jobs: {total}")
