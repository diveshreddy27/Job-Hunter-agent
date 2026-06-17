"""
Backfill location_country for existing target_jobs posts that have no country extracted.

Calls Gemini with a lightweight single-field prompt — only for posts already in
target_jobs (not all 914 normalized_posts).  Run once after upgrading to the version
that adds location_country to the extraction schema.

Usage:
    python scripts/backfill_country.py           # dry-run: show what would change
    python scripts/backfill_country.py --apply   # write updates to DB
"""
import argparse
import json
import sys
import time
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

import requests
from db import database as db
import settings as cfg

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/{model}:generateContent?key={key}"
)

_COUNTRY_PROMPT = """\
Read the following LinkedIn post and answer ONE question:
What country are the job opportunities in this post targeting?

Reply with ONLY a JSON object like: {{"country": "India"}}
Use the full English country name (e.g. "India", "United States", "United Kingdom").
If the post is ambiguous or doesn't specify any country, use {{"country": "unknown"}}.

POST:
{content}
"""


def _ask_country(content: str) -> str:
    model = cfg.GEMINI_EXTRACT_MODEL
    url = _GEMINI_URL.format(model=model, key=cfg.GEMINI_API_KEY)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": _COUNTRY_PROMPT.format(content=content[:3000])}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }
    for attempt in range(4):
        resp = requests.post(url, json=payload, timeout=20)
        if resp.status_code == 429:
            wait = 65 * (attempt + 1)
            print(f"      rate-limited — waiting {wait}s …", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code == 503:
            time.sleep(10)
            continue
        resp.raise_for_status()
        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text).get("country", "unknown")
    raise RuntimeError("exhausted retries")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write country to DB (default: dry-run)")
    args = parser.parse_args()

    db.init_db()
    with db.get_conn() as conn:
        rows = conn.execute("""
            SELECT n.id AS norm_id, n.company, n.title, n.location_country,
                   r.post_content
            FROM target_jobs t
            JOIN normalized_posts n ON n.id = t.norm_post_id
            JOIN raw_posts r ON r.id = t.raw_post_id
            WHERE n.location_country IS NULL
            ORDER BY t.id
        """).fetchall()

    print(f"Target jobs missing location_country: {len(rows)}")
    if not rows:
        print("Nothing to backfill.")
        return

    for i, row in enumerate(rows, 1):
        try:
            country = _ask_country(row["post_content"] or "")
        except Exception as e:
            print(f"  [{i}/{len(rows)}] norm_id={row['norm_id']} ERROR: {e}")
            time.sleep(4.5)
            continue

        label = "FOREIGN" if country.lower() not in ("india", "unknown") else country
        print(f"  [{i}/{len(rows)}] norm_id={row['norm_id']}  {row['company']} — {label!r}")

        if args.apply:
            with db.get_conn() as conn:
                conn.execute(
                    "UPDATE normalized_posts SET location_country = ? WHERE id = ?",
                    (country, row["norm_id"]),
                )
        time.sleep(4.5)  # respect RPM limit

    if not args.apply:
        print("\nDry-run complete. Re-run with --apply to write to DB.")
    else:
        print("\nDone. Run the filter again to remove foreign posts from target_jobs:")
        print("  python pipeline/ats/filter.py")


if __name__ == "__main__":
    main()
