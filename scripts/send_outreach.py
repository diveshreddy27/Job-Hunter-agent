"""
Interactive outreach sender.

Filters: posted_at past 24 hours | cloud_fit = aws_match | ATS score >= 50
Shows every detail about each job. Type y to generate + send email,
n to skip, q to quit.

Usage:
    python scripts/send_outreach.py
    python scripts/send_outreach.py --min-score 60
    python scripts/send_outreach.py --hours 24
"""
import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from db import database as db


# ── helpers ──────────────────────────────────────────────────────────────────

def pct(v):
    if v is None: return "—"
    v = float(v)
    return f"{v:.0%}" if v <= 1 else f"{v:.0f}%"

def fmt_list(val, bullet="•"):
    if not val: return "  —"
    try:
        items = json.loads(val) if isinstance(val, str) else val
        if isinstance(items, list):
            return "\n".join(f"  {bullet} {i}" for i in items) if items else "  —"
    except Exception:
        pass
    return f"  {val}"

def bar(score, width=20):
    score = score or 0
    filled = int(score / 100 * width)
    return "█" * filled + "░" * (width - filled)

def sep(char="─", width=70):
    print(char * width)

def hdr(text):
    sep("═")
    print(f"  {text}")
    sep("═")

def section(label):
    print(f"\n  ── {label} {'─' * (50 - len(label))}")


# ── fetch ─────────────────────────────────────────────────────────────────────

def fetch_jobs(min_score: int, hours: int) -> list:
    with db.get_conn() as conn:
        rows = [dict(r) for r in conn.execute("""
            SELECT
                t.id AS target_id,
                t.clouds_required, t.cloud_fit,
                n.title, n.company,
                n.location_city, n.location_state, n.is_remote, n.work_mode,
                n.experience_min, n.experience_max,
                n.skills,
                n.recruiter_name, n.recruiter_email,
                n.recruiter_designation, n.recruiter_current_company,
                n.apply_via, n.apply_url,
                n.email_subject_format, n.email_required_fields,
                s.final_ats_score,
                s.keyword_match_score, s.semantic_alignment_score,
                s.technical_skills_score, s.experience_relevance_score,
                s.project_alignment_score, s.impact_score,
                s.ats_structure_score, s.recruiter_readability_score,
                s.seniority_fit_score, s.domain_fit_score,
                s.tailoring_readiness_score,
                s.ats_pass_probability, s.shortlist_probability,
                s.interview_probability, s.rejection_probability,
                s.matched_skills, s.critical_gap_skills,
                s.resume_strengths, s.resume_weaknesses,
                s.priority_changes, s.keyword_injections,
                s.model_used, s.scored_at,
                r.post_content, r.post_url, r.scraped_at,
                r.posted_at
            FROM target_jobs t
            JOIN normalized_posts n ON n.id = t.norm_post_id
            JOIN raw_posts r        ON r.id = t.raw_post_id
            JOIN ats_scores s       ON s.target_job_id = t.id
            WHERE r.posted_at IS NOT NULL
              AND r.posted_at >= datetime('now', ? || ' hours')
              AND s.final_ats_score >= ?
              AND t.cloud_fit = 'aws_match'
              AND t.id NOT IN (
                  SELECT target_job_id FROM email_outreach
                  WHERE status = 'sent'
              )
            ORDER BY r.posted_at DESC, s.final_ats_score DESC
        """, (f"-{hours}", min_score)).fetchall()]

    # Dedup by recruiter email — keep highest-scoring job per recruiter
    seen_emails: set = set()
    deduped = []
    for job in rows:
        email = (job.get("recruiter_email") or "").strip().lower()
        if not email or email not in seen_emails:
            if email:
                seen_emails.add(email)
            deduped.append(job)
    return deduped


# ── display ───────────────────────────────────────────────────────────────────

def display(job: dict, idx: int, total: int):
    score = job["final_ats_score"] or 0
    hdr(f"[{idx}/{total}]  ATS {score}/100   {bar(score)}")

    section("JOB")
    print(f"  Title          : {job['title'] or '—'}")
    print(f"  Company        : {job['company'] or '—'}")
    loc = ", ".join(filter(None, [job["location_city"], job["location_state"]]))
    print(f"  Location       : {loc or '—'}  ({job['work_mode'] or '?'}{'  · remote' if job['is_remote'] else ''})")
    exp_lo = job["experience_min"]
    exp_hi = job["experience_max"]
    exp_str = (
        f"{exp_lo}–{exp_hi} yrs" if exp_lo is not None and exp_hi is not None
        else f"{exp_lo}+ yrs" if exp_lo is not None
        else "not stated"
    )
    print(f"  Experience     : {exp_str}")
    print(f"  Skills         : {job['skills'] or '—'}")
    print(f"  Clouds         : {job['clouds_required'] or '—'}  [{job['cloud_fit']}]")
    posted = (job.get("posted_at") or "")[:16]
    scraped = (job["scraped_at"] or "")[:16]
    time_str = f"Posted: {posted}" if posted else f"Scraped: {scraped}"
    print(f"  {time_str}  |  Post: {job['post_url'] or '—'}")

    section("RECRUITER")
    print(f"  Name           : {job['recruiter_name'] or '—'}")
    print(f"  Email          : {job['recruiter_email'] or '—'}")
    print(f"  Designation    : {job['recruiter_designation'] or '—'}")
    print(f"  Company        : {job['recruiter_current_company'] or '—'}")
    print(f"  Apply via      : {job['apply_via'] or '—'}")
    if job["apply_url"] and job["apply_url"] != job["post_url"]:
        print(f"  Apply URL      : {job['apply_url']}")

    section("EMAIL HINTS  (extracted from post)")
    print(f"  Subject format : {job['email_subject_format'] or '(none specified)'}")
    print(f"  Required fields: {job['email_required_fields'] or '(none asked)'}")

    section("ATS SCORE BREAKDOWN")
    sub_scores = [
        ("Keyword Match",          job["keyword_match_score"]),
        ("Semantic Alignment",     job["semantic_alignment_score"]),
        ("Technical Skills",       job["technical_skills_score"]),
        ("Experience Relevance",   job["experience_relevance_score"]),
        ("Project Alignment",      job["project_alignment_score"]),
        ("Impact",                 job["impact_score"]),
        ("ATS Structure",          job["ats_structure_score"]),
        ("Recruiter Readability",  job["recruiter_readability_score"]),
        ("Seniority Fit",          job["seniority_fit_score"]),
        ("Domain Fit",             job["domain_fit_score"]),
        ("Tailoring Readiness",    job["tailoring_readiness_score"]),
    ]
    for label, val in sub_scores:
        b = "█" * int((val or 0) // 10) + "░" * (10 - int((val or 0) // 10))
        print(f"  {label:<26}: {b} {val or 0}")

    section("PREDICTIONS")
    print(f"  ATS Pass       : {pct(job['ats_pass_probability'])}")
    print(f"  Shortlist      : {pct(job['shortlist_probability'])}")
    print(f"  Interview      : {pct(job['interview_probability'])}")
    print(f"  Rejection      : {pct(job['rejection_probability'])}")

    section("MATCHED SKILLS")
    print(fmt_list(job["matched_skills"]))

    section("CRITICAL GAPS")
    print(fmt_list(job["critical_gap_skills"]))

    section("RESUME STRENGTHS")
    print(fmt_list(job["resume_strengths"]))

    section("RESUME WEAKNESSES")
    print(fmt_list(job["resume_weaknesses"]))

    section("PRIORITY CHANGES")
    print(fmt_list(job["priority_changes"]))

    section("KEYWORD INJECTIONS (add to resume)")
    print(fmt_list(job["keyword_injections"]))

    section("RAW JOB POST")
    raw = (job["post_content"] or "").strip()
    print(f"  {raw[:2000]}" + ("\n  [... truncated]" if len(raw) > 2000 else ""))

    print(f"\n  Scored by: {job['model_used']}  |  {(job['scored_at'] or '')[:16]}")
    sep()


# ── send ──────────────────────────────────────────────────────────────────────

def _log_outreach(target_id: int, to_email: str, subject: str,
                   body: str, model: str, status: str, error: str = None):
    """Write to email_outreach and, on success, mark tracker applied."""
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db.get_conn() as conn:
        conn.execute("""
            INSERT INTO email_outreach
              (target_job_id, to_email, subject, body_text, sent_at, status, error, model_used)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (target_id, to_email, subject, body, now if status == "sent" else None,
              status, error, model))
        if status == "sent":
            conn.execute("""
                INSERT INTO job_tracker (target_job_id, status, notes, updated_at)
                VALUES (?, 'applied', 'Auto-set after email sent via CLI', ?)
                ON CONFLICT(target_job_id) DO UPDATE SET
                    status     = 'applied',
                    updated_at = excluded.updated_at
            """, (target_id, now))


def send(job: dict, auto: bool = False) -> bool:
    from pipeline.outreach.builder import build_email
    from pipeline.outreach.sender import send_email

    print("\n  ⏳  Generating email via AI cascade...")
    try:
        result = build_email(job)
    except Exception as e:
        print(f"  ✗  Email generation failed: {e}")
        _log_outreach(job["target_id"], job["recruiter_email"] or "",
                      "", "", "", "failed", str(e))
        return False

    print(f"\n  Subject : {result['subject']}")
    print(f"  Model   : {result['model_used']}")
    if result.get("missing_fields"):
        print(f"  Missing : {', '.join(result['missing_fields'])}")
    print(f"\n  Body preview:\n")
    for line in result["body"].split("\n")[:12]:
        print(f"    {line}")
    if result["body"].count("\n") > 12:
        print("    [...]")

    if not auto:
        confirm = input("\n  Confirm send? [y/n]: ").strip().lower()
        if confirm != "y":
            print("  Skipped — email not sent.")
            return False

    try:
        send_email(
            to_email=job["recruiter_email"],
            subject=result["subject"],
            body=result["body"],
        )
        _log_outreach(job["target_id"], job["recruiter_email"],
                      result["subject"], result["body"],
                      result["model_used"], "sent")
        print(f"  ✓  Sent to {job['recruiter_email']}")
        return True
    except Exception as e:
        _log_outreach(job["target_id"], job["recruiter_email"] or "",
                      result["subject"], result["body"],
                      result["model_used"], "failed", str(e))
        print(f"  ✗  Send failed: {e}")
        return False


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-score",  type=int, default=50,    help="Minimum ATS score (default 50)")
    parser.add_argument("--hours",      type=int, default=24,    help="Lookback window in hours (default 24)")
    parser.add_argument("--auto-send",  action="store_true",     help="Skip y/n prompts — generate and send all matched jobs automatically")
    args = parser.parse_args()

    db.init_db()
    jobs = fetch_jobs(args.min_score, args.hours)

    if not jobs:
        print(f"No jobs found — ATS ≥ {args.min_score}, cloud=aws_match, past {args.hours}h")
        return

    print(f"\n  {len(jobs)} jobs matched  (ATS ≥ {args.min_score} | aws_match | past {args.hours}h)")
    if args.auto_send:
        print("  AUTO-SEND mode — generating and sending all jobs\n")
    else:
        print("  Commands: y = send email   n = skip   q = quit\n")

    sent = skipped = 0
    for i, job in enumerate(jobs, 1):
        display(job, i, len(jobs))

        if args.auto_send:
            if send(job, auto=True):
                sent += 1
            else:
                skipped += 1
            continue

        while True:
            choice = input(f"\n  [{i}/{len(jobs)}] Send email to {job['recruiter_email'] or '—'}? [y/n/q]: ").strip().lower()
            if choice in ("y", "n", "q"):
                break
            print("  Type y, n, or q.")

        if choice == "q":
            print("\n  Quit.")
            break
        elif choice == "y":
            if send(job, auto=False):
                sent += 1
            else:
                skipped += 1
        else:
            skipped += 1
            print("  Skipped.\n")

    sep("═")
    print(f"  Done — sent: {sent}  |  skipped: {skipped}")
    sep("═")


if __name__ == "__main__":
    main()
