"""
Compare score snapshots stored in data/scores_history.json.

Usage:
  python scripts/compare_scores.py            # compare last two snapshots
  python scripts/compare_scores.py --a v1 --b v2
  python scripts/compare_scores.py --list     # show available snapshots
"""
import argparse
import json
import pathlib
import sys

HISTORY_FILE = pathlib.Path(__file__).parent.parent / "data" / "scores_history.json"


def load():
    if not HISTORY_FILE.exists():
        print("No scores_history.json found. Run rescore.py first.")
        sys.exit(1)
    return json.loads(HISTORY_FILE.read_text())


def list_snapshots(h: dict):
    print(f"\n{'Label':<8}  {'Archived at':<30}  {'Count':>5}")
    print("-" * 50)
    for label, data in h.items():
        print(f"{label:<8}  {data['archived_at']:<30}  {data['count']:>5}")
    print()


def compare(h: dict, a: str, b: str):
    if a not in h:
        print(f"Snapshot '{a}' not found. Use --list to see available.")
        sys.exit(1)
    if b not in h:
        print(f"Snapshot '{b}' not found. Use --list to see available.")
        sys.exit(1)

    a_map = {r["target_job_id"]: r for r in h[a]["scores"]}
    b_map = {r["target_job_id"]: r for r in h[b]["scores"]}
    common = set(a_map) & set(b_map)

    rows = []
    for tid in common:
        ra = a_map[tid]
        rb = b_map[tid]
        delta = (rb["final_ats_score"] or 0) - (ra["final_ats_score"] or 0)
        rows.append({
            "id":       tid,
            "title":    (rb.get("title") or ra.get("title") or "")[:35],
            "company":  (rb.get("company") or ra.get("company") or "")[:20],
            f"{a}":     ra["final_ats_score"],
            f"{b}":     rb["final_ats_score"],
            "delta":    delta,
        })

    rows.sort(key=lambda r: -(r["delta"] or 0))

    improved = sum(1 for r in rows if (r["delta"] or 0) > 0)
    dropped  = sum(1 for r in rows if (r["delta"] or 0) < 0)
    same     = sum(1 for r in rows if (r["delta"] or 0) == 0)
    avg_a    = sum(r[a] or 0 for r in rows) / len(rows) if rows else 0
    avg_b    = sum(r[b] or 0 for r in rows) / len(rows) if rows else 0

    print(f"\nScore comparison: {a} → {b}  ({len(common)} jobs in common)\n")
    print(f"  Average score : {avg_a:.1f} → {avg_b:.1f}  ({avg_b-avg_a:+.1f})")
    print(f"  Improved      : {improved}")
    print(f"  Dropped       : {dropped}")
    print(f"  No change     : {same}")
    print()

    col_a = a[:6]
    col_b = b[:6]
    print(f"{'#':<5}  {'Title':<35}  {'Company':<20}  {col_a:>6}  {col_b:>6}  {'Delta':>6}")
    print("-" * 90)
    for i, r in enumerate(rows, 1):
        delta_str = f"{r['delta']:+d}" if r["delta"] != 0 else "  —"
        print(f"{i:<5}  {r['title']:<35}  {r['company']:<20}  "
              f"{r[a] or '?':>6}  {r[b] or '?':>6}  {delta_str:>6}")
    print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="List available snapshots")
    ap.add_argument("--a", default=None, help="First snapshot label")
    ap.add_argument("--b", default=None, help="Second snapshot label")
    args = ap.parse_args()

    h = load()

    if args.list or not h:
        list_snapshots(h)
        return

    labels = list(h.keys())
    a = args.a or labels[-2] if len(labels) >= 2 else labels[0]
    b = args.b or labels[-1]

    if a == b:
        print(f"Both labels are '{a}' — nothing to compare.")
        return

    compare(h, a, b)


if __name__ == "__main__":
    main()
