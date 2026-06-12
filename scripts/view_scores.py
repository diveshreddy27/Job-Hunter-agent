import sys
import pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from db import database as db

db.init_db()

with db.get_conn() as conn:
    rows = [dict(r) for r in conn.execute("""
        SELECT
            t.id          AS target_id,
            n.title, n.company, n.location_city, n.location_state,
            n.work_mode, n.experience_min, n.experience_max,
            n.recruiter_name, n.recruiter_email, n.apply_url,
            a.final_ats_score,
            a.keyword_match_score, a.semantic_alignment_score,
            a.technical_skills_score, a.experience_relevance_score,
            a.project_alignment_score, a.impact_score,
            a.ats_structure_score, a.recruiter_readability_score,
            a.seniority_fit_score, a.domain_fit_score,
            a.tailoring_readiness_score,
            a.ats_pass_probability, a.shortlist_probability,
            a.interview_probability, a.rejection_probability,
            a.matched_skills, a.critical_gap_skills,
            a.resume_strengths, a.resume_weaknesses,
            a.priority_changes, a.keyword_injections,
            a.model_used, a.scored_at,
            r.post_content AS raw_jd, r.post_url
        FROM target_jobs t
        JOIN normalized_posts n ON n.id = t.norm_post_id
        JOIN ats_scores a       ON a.target_job_id = t.id
        JOIN raw_posts r        ON r.id = t.raw_post_id
        WHERE a.final_ats_score > 60
        ORDER BY a.final_ats_score DESC
    """).fetchall()]

if not rows:
    print("No scored records found yet.")
    sys.exit(0)

import json

def fmt_list(val):
    if not val:
        return "—"
    try:
        items = json.loads(val) if isinstance(val, str) else val
        if isinstance(items, list):
            return "\n              ".join(f"• {i}" for i in items) if items else "—"
    except Exception:
        pass
    return val or "—"

def pct(val):
    if val is None:
        return "—"
    v = float(val)
    return f"{v:.0%}" if v <= 1 else f"{v:.0f}%"

for i, r in enumerate(rows, 1):
    score = r["final_ats_score"] or 0
    bar   = "█" * (score // 5) + "░" * (20 - score // 5)

    print(f"\n{'='*70}")
    print(f"  [{i:02d}/{len(rows)}]  Target ID: {r['target_id']}   ATS Score: {score}/100")
    print(f"  {bar}  {score}%")
    print(f"{'='*70}")

    print(f"\n  JOB")
    print(f"  {'Title':<22}: {r['title'] or '—'}")
    print(f"  {'Company':<22}: {r['company'] or '—'}")
    print(f"  {'Location':<22}: {r['location_city'] or '—'}, {r['location_state'] or '—'}  |  {r['work_mode'] or '—'}")
    print(f"  {'Experience':<22}: {r['experience_min'] or '?'} – {r['experience_max'] or '?'} yrs")

    print(f"\n  RECRUITER")
    print(f"  {'Name':<22}: {r['recruiter_name'] or '—'}")
    print(f"  {'Email':<22}: {r['recruiter_email'] or '—'}")
    print(f"  {'Apply URL':<22}: {r['apply_url'] or '—'}")

    print(f"\n  SCORE BREAKDOWN")
    print(f"  {'Keyword Match':<28}: {r['keyword_match_score']}")
    print(f"  {'Semantic Alignment':<28}: {r['semantic_alignment_score']}")
    print(f"  {'Technical Skills':<28}: {r['technical_skills_score']}")
    print(f"  {'Experience Relevance':<28}: {r['experience_relevance_score']}")
    print(f"  {'Project Alignment':<28}: {r['project_alignment_score']}")
    print(f"  {'Impact':<28}: {r['impact_score']}")
    print(f"  {'ATS Structure':<28}: {r['ats_structure_score']}")
    print(f"  {'Recruiter Readability':<28}: {r['recruiter_readability_score']}")
    print(f"  {'Seniority Fit':<28}: {r['seniority_fit_score']}")
    print(f"  {'Domain Fit':<28}: {r['domain_fit_score']}")
    print(f"  {'Tailoring Readiness':<28}: {r['tailoring_readiness_score']}")

    print(f"\n  PREDICTIONS")
    print(f"  {'ATS Pass':<22}: {pct(r['ats_pass_probability'])}")
    print(f"  {'Shortlist':<22}: {pct(r['shortlist_probability'])}")
    print(f"  {'Interview':<22}: {pct(r['interview_probability'])}")
    print(f"  {'Rejection':<22}: {pct(r['rejection_probability'])}")

    print(f"\n  MATCHED SKILLS")
    print(f"  {fmt_list(r['matched_skills'])}")

    print(f"\n  CRITICAL GAPS")
    print(f"  {fmt_list(r['critical_gap_skills'])}")

    print(f"\n  RESUME STRENGTHS")
    print(f"  {fmt_list(r['resume_strengths'])}")

    print(f"\n  RESUME WEAKNESSES")
    print(f"  {fmt_list(r['resume_weaknesses'])}")

    print(f"\n  PRIORITY CHANGES")
    print(f"  {fmt_list(r['priority_changes'])}")

    print(f"\n  KEYWORD INJECTIONS")
    print(f"  {fmt_list(r['keyword_injections'])}")

    print(f"\n  RAW JOB DESCRIPTION")
    print(f"  Post URL : {r['post_url'] or '—'}")
    raw = (r["raw_jd"] or "").strip()
    print(f"  {raw[:1500]}" + (" ..." if len(raw) > 1500 else ""))

    print(f"\n  Scored by : {r['model_used']}  |  {r['scored_at'][:19]}")

print(f"\n{'='*70}")
print(f"  Showing: {len(rows)} jobs with ATS score > 60  |  Sorted highest first")
print(f"{'='*70}\n")
