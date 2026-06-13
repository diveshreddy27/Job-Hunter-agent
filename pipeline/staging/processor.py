"""
Processor worker — reads batch files from staging/raw/, normalises each
post with Gemini (or local NER), and writes ALL posts unconditionally into
raw_posts + normalized_posts.

Business-logic filtering (location, experience, contract, email) is handled
exclusively by Stage 3 (ats/filter.py) which reads normalized_posts and
decides what goes into target_jobs.  This processor has no filter opinion —
every normalised post is preserved in the DB so nothing is lost for training
or future re-filtering.

NER training lifecycle:
  normalized_posts.is_trained defaults to 'not_trained'.
  POST /api/train-ner (or python model/train.py) trains the local spaCy
  model on all 'not_trained' rows and marks them 'trained' afterwards.

Flow per batch file:
  for each post:
    1. Gemini / NER  → normalised fields
    2. Insert raw_posts + normalized_posts  (ALL posts, no filter gate)
  delete file — data is in DB, file is no longer needed
"""
import json
import logging
import pathlib
import threading

from db import database as db
from pipeline.scraper.extractor import _normalize

log = logging.getLogger("staging.processor")


def _ingest(raw: dict, norm: dict) -> bool:
    """Insert raw post + normalized fields into DB. Returns False on dedup."""
    raw_id = db.insert_raw_post(
        activity_urn=raw["activity_urn"],
        post_url=raw.get("post_url", ""),
        post_content=raw.get("post_content", ""),
        post_author=raw.get("post_author"),
        author_headline=raw.get("author_headline"),
        profile_url=raw.get("profile_url"),
        days_filter=raw.get("days_filter", 1),
        scraped_at=raw.get("scraped_at"),
        posted_at=raw.get("posted_at"),
    )
    if raw_id is None:
        # Duplicate URN — skip re-extraction but backfill posted_at if we have it
        # and the existing row doesn't yet (handles first run after posted_at was added).
        db.backfill_posted_at(raw["activity_urn"], raw.get("posted_at"))
        return False
    db.insert_normalized_post(raw_id, norm)
    return True

POLL_INTERVAL = 2.0   # seconds between empty-queue polls


def processor_worker(
    stop_event: threading.Event,
    staging_dir,
) -> None:
    """
    Long-running daemon.
    Exits when stop_event is set AND staging/raw/ has no more JSON files.
    """
    staging_dir   = pathlib.Path(staging_dir)
    raw_dir       = staging_dir / "raw"

    total_seen = total_ingested = total_dedup = total_failed = 0

    log.info("[processor] Started — watching %s  batch_poll=%.1fs", raw_dir, POLL_INTERVAL)

    while True:
        batch_files = sorted(raw_dir.glob("*.json"))

        if not batch_files:
            if stop_event.is_set():
                log.info(
                    "[processor] Queue drained — done  "
                    "seen=%d  ingested=%d  dedup=%d  failed=%d",
                    total_seen, total_ingested, total_dedup, total_failed,
                )
                return
            stop_event.wait(POLL_INTERVAL)
            continue

        for batch_file in batch_files:
            try:
                posts = json.loads(batch_file.read_text(encoding="utf-8"))
            except Exception as e:
                log.error("[processor] Cannot read %s: %s — skipping", batch_file.name, e)
                batch_file.unlink()
                continue

            b_ingested = b_dedup = b_failed = 0

            for raw in posts:
                urn   = raw.get("activity_urn", "?")
                short = urn[-12:]
                total_seen += 1

                # Dedup: all posts now go into raw_posts so a single DB check suffices
                try:
                    with db.get_conn() as conn:
                        exists = conn.execute(
                            "SELECT 1 FROM raw_posts WHERE activity_urn = ?", (urn,)
                        ).fetchone()
                    if exists:
                        b_dedup += 1
                        total_dedup += 1
                        log.info("[processor] DEDUP  %s  (already in DB — skipping Gemini)", short)
                        continue
                except Exception:
                    pass

                try:
                    norm = _normalize(raw)
                    if _ingest(raw, norm):
                        b_ingested += 1
                        total_ingested += 1
                        log.info(
                            "[processor] INGEST  %s  title=%r  company=%r  email=%r",
                            short,
                            norm.get("title"),
                            norm.get("company"),
                            norm.get("recruiter_email"),
                        )
                    else:
                        b_dedup += 1
                        total_dedup += 1
                except Exception as e:
                    b_failed += 1
                    total_failed += 1
                    log.error("[processor] ERROR   %s: %s", short, e)

            log.info(
                "[processor] %s — %d posts  ingested=%d  dedup=%d  failed=%d",
                batch_file.name, len(posts),
                b_ingested, b_dedup, b_failed,
            )

            batch_file.unlink()
