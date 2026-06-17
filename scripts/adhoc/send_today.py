"""
One-off: send outreach emails to today's 17 unique jobs (deduped by recruiter email).
Target IDs: 161,148,151,157,147,150,154,165,149,159,155,160,162,153,158,166,164
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from db import database as db
from scripts.send_outreach import fetch_jobs, send

TARGET_IDS = (161, 151, 155)

db.init_db()

# Fetch these 3 IDs directly — bypass fetch_jobs dedup
import sqlite3
with db.get_conn() as conn:
    jobs = [dict(r) for r in conn.execute(f"""
        SELECT t.id AS target_id, t.clouds_required, t.cloud_fit,
               n.title, n.company, n.location_city, n.location_state, n.is_remote, n.work_mode,
               n.experience_min, n.experience_max, n.skills,
               n.recruiter_name, n.recruiter_email, n.recruiter_designation, n.recruiter_current_company,
               n.apply_via, n.apply_url, n.email_subject_format, n.email_required_fields,
               s.final_ats_score, s.keyword_match_score, s.semantic_alignment_score,
               s.technical_skills_score, s.experience_relevance_score, s.project_alignment_score,
               s.impact_score, s.ats_structure_score, s.recruiter_readability_score,
               s.seniority_fit_score, s.domain_fit_score, s.tailoring_readiness_score,
               s.ats_pass_probability, s.shortlist_probability, s.interview_probability, s.rejection_probability,
               s.matched_skills, s.critical_gap_skills, s.resume_strengths, s.resume_weaknesses,
               s.priority_changes, s.keyword_injections, s.model_used, s.scored_at,
               r.post_content, r.post_url, r.scraped_at, r.posted_at
        FROM target_jobs t
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN raw_posts r ON r.id = t.raw_post_id
        JOIN ats_scores s ON s.target_job_id = t.id
        WHERE t.id IN ({','.join('?' for _ in TARGET_IDS)})
        ORDER BY s.final_ats_score DESC
    """, TARGET_IDS).fetchall()]

# Safety check — show what we're about to send
print(f"\n  Sending to {len(jobs)} jobs:\n")
for j in jobs:
    print(f"    ID={j['target_id']:<4} [{j['final_ats_score']:>3}]  {str(j['title'] or '?')[:45]}  →  {j['recruiter_email']}")

print(f"\n  Starting auto-send...\n")

sent = failed = 0
for i, job in enumerate(jobs, 1):
    print(f"\n  [{i}/{len(jobs)}] {job['title'] or '?'}  →  {job['recruiter_email']}")
    if send(job, auto=True):
        sent += 1
    else:
        failed += 1

print(f"\n  Done — sent={sent}  failed={failed}")
