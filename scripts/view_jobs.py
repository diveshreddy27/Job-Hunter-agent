import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from db import database as db

db.init_db()

with db.get_conn() as conn:
    rows = [dict(r) for r in conn.execute("""
        SELECT n.raw_post_id as id, n.title, n.company, n.location_city,
               n.location_state, n.work_mode, n.is_remote,
               n.experience_min, n.experience_max,
               n.recruiter_name, n.recruiter_designation,
               n.recruiter_current_company, n.recruiter_email,
               n.apply_via, n.apply_url, n.skills
        FROM normalized_posts n
        JOIN (
            SELECT MIN(id) as keep_id
            FROM normalized_posts
            GROUP BY recruiter_email, title
        ) d ON n.id = d.keep_id
        ORDER BY n.raw_post_id
    """).fetchall()]

if not rows:
    print("No records found.")
    sys.exit(0)

for i, r in enumerate(rows, 1):
    print(f"\n[{i:02d}/{len(rows)}] ── ID {r['id']} " + "─" * 50)
    print(f"  Title       : {r['title']}")
    print(f"  Company     : {r['company'] or '—'}")
    print(f"  Location    : {r['location_city'] or '—'}, {r['location_state'] or '—'}  |  {r['work_mode']}  |  {'remote' if r['is_remote'] else 'onsite'}")
    print(f"  Experience  : {r['experience_min'] or '?'} – {r['experience_max'] or '?'} yrs")
    print(f"  Recruiter   : {r['recruiter_name']}  ({r['recruiter_designation'] or '—'})")
    print(f"  Rec.Company : {r['recruiter_current_company'] or '—'}")
    print(f"  Email       : {r['recruiter_email']}")
    print(f"  Apply       : {r['apply_via']}  →  {r['apply_url']}")
    print(f"  Skills      : {r['skills'] or '—'}")

print(f"\n{'─' * 60}")
print(f"  Total: {len(rows)} unique records")
print(f"{'─' * 60}")
