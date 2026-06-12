"""
LinkedIn Job Scraper — entry point.

  python main.py                       # past 24 h, headless
  python main.py --days 7              # past week
  python main.py --days 30 --limit 50  # past month, capped at 50
  python main.py --visible             # show the browser

Architecture (all 4 stages run concurrently):

  Stage 1  Scraper (main thread)
           Playwright login → search → scroll; writes raw posts to
           staging/raw/*.json batches.

  Stage 2  Extractor (daemon thread, starts before scraper)
           Reads staging/raw/*.json → calls Gemini / local NER →
           writes every post to normalized_posts regardless of filter outcome.

  Stage 3  Filter loop (background thread, starts before scraper)
           Polls every FILTER_POLL_SECS for new normalized_posts not yet
           in target_jobs; applies location + exp + contract + email rules.
           Runs a final pass after the extractor drains, then signals done.

  Stage 4  Scorer workers (3 background threads, start before scraper)
           Continuously pull unscored target_jobs added by Stage 3 and run
           the unified model cascade. Exit when Stage 3 signals done and no
           unscored jobs remain.
"""
import argparse
import logging
import pathlib
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s — %(message)s",
)
log = logging.getLogger("main")

FILTER_POLL_SECS = 15   # how often the filter loop checks for new normalized posts


def main() -> int:
    ap = argparse.ArgumentParser(description="LinkedIn job-post scraper")
    ap.add_argument("--limit", type=int, default=None,
                    help="Stop after N posts staged (default: end of feed).")
    ap.add_argument("--days", type=int, default=1, choices=[1, 7, 30],
                    help="LinkedIn 'Date Posted' filter — 1 / 7 / 30.")
    ap.add_argument("--visible", action="store_true",
                    help="Show the browser window.")
    args = ap.parse_args()

    import settings as cfg
    if args.visible:
        cfg.SCRAPE_HEADLESS = False

    from db import database as db
    from pipeline.scraper import linkedin_scraper
    from pipeline.staging.writer import StagingWriter
    from pipeline.staging.processor import processor_worker
    from pipeline.ats.filter import run_filter
    from pipeline.ats.scorer import run_scorer

    db.init_db()

    staging_dir    = pathlib.Path(cfg.STAGING_DIR)
    staging_writer = StagingWriter(staging_dir, batch_size=cfg.STAGING_BATCH_SIZE)

    date_label = linkedin_scraper._DATE_FILTERS[args.days]["ui_label"]
    log.info("LinkedIn scraper starting — fully concurrent pipeline")
    log.info("  query:        %s", cfg.LINKEDIN_SEARCH_QUERY)
    log.info("  date:         %s (--days %d)", date_label, args.days)
    log.info("  limit:        %s", args.limit or "unbounded")
    log.info("  headless:     %s", cfg.SCRAPE_HEADLESS)
    log.info("  staging_dir:  %s", staging_dir.resolve())
    log.info("  batch_size:   %d", cfg.STAGING_BATCH_SIZE)
    log.info("  db:           %s", db.DB_PATH)

    # ── Events ────────────────────────────────────────────────────────────────
    # scraper_done:  set after scraper finishes + extractor has fully drained
    # filter_done:   set after filter loop does its final pass
    scraper_done = threading.Event()
    filter_done  = threading.Event()

    # ── Stage 2: Extractor (daemon) ───────────────────────────────────────────
    stop_extractor = threading.Event()
    extractor = threading.Thread(
        target=processor_worker,
        args=(stop_extractor, staging_dir),
        daemon=True,
        name="extractor",
    )
    extractor.start()
    log.info("[main] Stage 2 — extractor started")

    # ── Stage 3: Filter polling loop ──────────────────────────────────────────
    filter_total = {"added": 0}

    def filter_loop() -> None:
        while True:
            added, skipped = run_filter()
            if added:
                filter_total["added"] += added
                log.info("[filter] %d new target(s) queued  (skipped=%d)", added, skipped)
            if scraper_done.is_set():
                break
            time.sleep(FILTER_POLL_SECS)
        # Final pass: catch anything the extractor wrote in the last window
        added_final, skipped_final = run_filter()
        if added_final:
            filter_total["added"] += added_final
            log.info("[filter] Final pass: %d target(s) added  (skipped=%d)",
                     added_final, skipped_final)
        filter_done.set()
        log.info("[filter] Loop done — total targets added=%d", filter_total["added"])

    filter_thread = threading.Thread(
        target=filter_loop, daemon=True, name="filter"
    )
    filter_thread.start()
    log.info("[main] Stage 3 — filter loop started (polling every %ds)", FILTER_POLL_SECS)

    # ── Stage 4: Scorer (3 continuous workers) ────────────────────────────────
    scored_count = {"n": 0}

    def scorer_thread_fn() -> None:
        scored_count["n"] = run_scorer(done_event=filter_done)

    scorer_thread = threading.Thread(
        target=scorer_thread_fn, daemon=True, name="scorer"
    )
    scorer_thread.start()
    log.info("[main] Stage 4 — scorer started (3 workers, continuous mode)")

    # ── Stage 1: Scraper (main thread) ────────────────────────────────────────
    staged = 0
    try:
        staged = linkedin_scraper.scrape_linkedin(
            staging_writer,
            limit=args.limit,
            days=args.days,
        )
    finally:
        flushed = staging_writer.flush()
        if flushed:
            log.info("[main] Flushed %d buffered post(s) to staging", flushed)

        log.info("[main] Scraper done — waiting for extractor to drain…")
        stop_extractor.set()
        extractor.join(timeout=3600)
        if extractor.is_alive():
            log.warning("[main] Extractor still running after 60 min — leaving as daemon")

        # All staging files drained → tell filter loop to do its final pass
        scraper_done.set()

    # ── Wait for downstream stages to finish ──────────────────────────────────
    log.info("[main] Waiting for filter loop to finish…")
    filter_thread.join()

    log.info("[main] Waiting for scorer to drain…")
    scorer_thread.join()

    # ── Final stats ───────────────────────────────────────────────────────────
    final = db.stats()
    log.info("─── Final DB stats ────────────────────────────")
    log.info("  staged this run:  %d", staged)
    log.info("  raw_total:        %d", final["raw_total"])
    log.info("  raw_done:         %d", final["raw_done"])
    log.info("  raw_pending:      %d", final["raw_pending"])
    log.info("  raw_failed:       %d", final["raw_failed"])
    log.info("  normalized:       %d", final["normalized"])
    log.info("  filter added:     %d", filter_total["added"])
    log.info("  scored:           %d", scored_count["n"])
    log.info("───────────────────────────────────────────────")
    return 0


if __name__ == "__main__":
    sys.exit(main())
