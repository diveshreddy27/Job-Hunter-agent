"""
Extractor worker — runs alongside the scraper on its own thread.

Loop:
  1. Pull a batch of raw_posts WHERE extraction_status='pending'.
  2. Try local NER model first (when USE_LOCAL_MODEL=True in settings).
     Falls back to Gemini API when local model returns no job title.
  3. Write a normalized_posts row (and flip raw to 'done') — atomic.
  4. On exception, mark raw 'failed' with the error message.
  5. When queue empty AND stop_event is set, exit.
"""
import json
import logging
import threading

import requests

from db import database as db
import settings as cfg
from utils.model_tracker import get_tracker

log = logging.getLogger("extractor")

# Local NER model — loaded once on first use, only when USE_LOCAL_MODEL=True
_local_extractor = None

def _get_local_extractor():
    global _local_extractor
    if _local_extractor is None:
        from model.predict import LocalExtractor
        _local_extractor = LocalExtractor()
    return _local_extractor

BATCH_SIZE      = 5
POLL_INTERVAL   = 2.0
# gemini-3.1-flash-lite = 15 RPM → 60s/15 = 4s per request minimum; 4.5s gives headroom
REQUEST_DELAY   = 4.5

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/{model}:generateContent?key={key}"
)

_SYSTEM_PROMPT = (
    "You are a job-post parser for Indian recruiter posts. "
    "Return ONLY a valid JSON object. No markdown, no explanation."
)

_USER_TEMPLATE = """\
Parse this LinkedIn post and return a single JSON object.
Use null for any field not clearly present in the post.

AUTHOR: {author}
HEADLINE: {headline}
POST: {content}

JSON schema:
{{
  "title":                    "job title being hired for",
  "company":                  "HIRING company name — NOT the recruiter's own employer",
  "location_city":            "primary city (e.g. Hyderabad)",
  "location_state":           "Indian state (e.g. Telangana)",
  "is_remote":                1 if remote/WFH else 0,
  "work_mode":                "remote" | "hybrid" | "onsite",
  "experience_min":           minimum years as number,
  "experience_max":           maximum years as number,
  "skills":                   "comma-separated tech skills (e.g. AWS, Spark, Python)",
  "recruiter_email":          "email from post or headline",
  "recruiter_designation":    "recruiter's own title from headline",
  "recruiter_current_company":"recruiter's OWN employer from headline",
  "apply_via":                "email" | "linkedin_easy" | "website" | "personal_message",
  "apply_url":                "application link/URL found in post, or null",
  "email_subject_format":     "exact subject line format recruiter specified (e.g. 'Name | Role | Exp | CTC | NP'), or null",
  "email_required_fields":    "comma-separated list of fields recruiter explicitly asks for in the email, using ONLY these tokens: current_ctc, expected_ctc, notice_period, current_location, preferred_locations, experience, current_company, current_designation, open_to_relocation, pan_number, linkedin_url, github_url, availability, work_mode_preference, resume_link — or null if none asked"
}}

Rules:
- company: the company that has the opening, not the recruiter's agency
- recruiter_current_company: parse from HEADLINE only (e.g. "HR Manager at Infosys" → "Infosys")
- work_mode: "remote" if WFH/remote mentioned; "hybrid" if hybrid; else "onsite"
- apply_via priority (use the FIRST that matches):
    1. "email"            — recruiter_email is found
    2. "linkedin_easy"    — post mentions Easy Apply / Apply on LinkedIn
    3. "website"          — a URL or application link is present in the post
    4. "personal_message" — ONLY if post says DM / message me / inbox me / WhatsApp me and NONE of the above apply
    5. "website"          — default fallback
- apply_url: extract the actual URL from the post when apply_via is "website"; null otherwise
- experience: if post says "5+ years" return min=5, max=8; if "3-6 years" return min=3, max=6
- email_subject_format: copy the EXACT format string from the post if recruiter wrote "Subject:", "Sub:", "Mail subject:" etc. (e.g. "Name | Role | Exp | Current CTC | Expected CTC | NP | Location"). null if not specified
- email_required_fields: look for phrases like "share your CTC", "mention notice period", "send CTC/NP/location", "include your details" etc. Map each mentioned item to the closest token from the allowed list. null if recruiter asks for nothing specific\
"""


def _call_gemini(prompt: str) -> dict:
    import time
    model   = cfg.GEMINI_EXTRACT_MODEL
    tracker = get_tracker()
    limits  = getattr(cfg, "GEMINI_MODEL_LIMITS", {})
    rpd     = limits.get(model, {}).get("rpd", 9999)

    if not tracker.is_available(model, rpd):
        raise RuntimeError(
            f"Extraction model {model} has reached its daily quota ({rpd} RPD). "
            "Update GEMINI_EXTRACT_MODEL in settings.py or wait until tomorrow."
        )

    url = _GEMINI_URL.format(model=model, key=cfg.GEMINI_API_KEY)
    payload = {
        "system_instruction": {"parts": [{"text": _SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
        },
    }
    resp = requests.post(url, json=payload, timeout=30)
    if resp.status_code == 429:
        tracker.mark_exhausted(model)
        resp.raise_for_status()
    resp.raise_for_status()
    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(text)
    # Gemini occasionally wraps the object in a list — unwrap it
    if isinstance(result, list):
        result = result[0] if result else {}
    tracker.record_call(model)
    time.sleep(REQUEST_DELAY)   # respect RPM limit
    return result


def _normalize(raw: dict) -> dict:
    """Route to local NER model or Gemini API based on settings."""
    if cfg.USE_LOCAL_MODEL:
        try:
            fields = _get_local_extractor().extract(raw)
            # Fall back to Gemini when local model couldn't find a job title
            if fields.get("title"):
                log.debug("[extractor] local_ner used for raw_id=%s", raw.get("id"))
                return fields
            log.debug("[extractor] local_ner found no title — falling back to Gemini")
        except Exception as e:
            log.warning("[extractor] local_ner error (%s) — falling back to Gemini", e)

    return _normalize_with_gemini(raw)


def _normalize_with_gemini(raw: dict) -> dict:
    content  = raw["post_content"] or ""
    headline = raw["author_headline"] or ""
    author   = raw["post_author"] or ""
    post_url = raw["post_url"]

    prompt = _USER_TEMPLATE.format(
        author=author,
        headline=headline,
        content=content,
    )

    parsed = _call_gemini(prompt)

    parsed["is_remote"]      = 1 if parsed.get("is_remote") else 0
    parsed["recruiter_name"] = author
    parsed["apply_url"]      = parsed.get("apply_url") or post_url
    parsed["extracted_by"]   = "gemini"
    parsed["role_type"]      = "fulltime"

    # ── Fix 1: derive location_state from city when Gemini left it null ──
    if not parsed.get("location_state") and parsed.get("location_city"):
        # Take the first city only (Gemini sometimes returns a comma list)
        first_city = parsed["location_city"].split(",")[0].strip().lower()
        parsed["location_state"] = cfg.INDIA_STATES.get(first_city)

    # ── Fix 2: experience_max fallback to regex when Gemini missed it ────
    if parsed.get("experience_min") is not None and parsed.get("experience_max") is None:
        from pipeline.scraper.location_utils import extract_experience
        _, regex_max = extract_experience(content)
        if regex_max is not None:
            parsed["experience_max"] = regex_max

    return parsed


def extract_worker(stop_event: threading.Event) -> int:
    """Long-running consumer. Returns total successful normalizations.

    Exits when stop_event is set AND the pending queue is empty.
    """
    total  = 0
    failed = 0
    log.info("[extractor] Started — model=%s batch_size=%d poll_interval=%.1fs",
             cfg.GEMINI_EXTRACT_MODEL, BATCH_SIZE, POLL_INTERVAL)

    while True:
        rows = db.get_pending_raw_posts(limit=BATCH_SIZE)

        if not rows:
            if stop_event.is_set():
                log.info("[extractor] Queue drained — done (total=%d, failed=%d)",
                         total, failed)
                return total
            if stop_event.wait(POLL_INTERVAL):
                continue
            continue

        batch_start = total
        for raw in rows:
            raw_id = raw["id"]
            try:
                fields = _normalize(dict(raw))
                db.insert_normalized_post(raw_id, fields)
                total += 1
                log.info("[extractor] raw_id=%d done  title=%r  company=%r  email=%r",
                         raw_id,
                         fields.get("title"),
                         fields.get("company"),
                         fields.get("recruiter_email"))
            except Exception as e:
                failed += 1
                log.error("[extractor] raw_id=%d failed: %s", raw_id, e)
                try:
                    db.mark_raw_failed(raw_id, str(e))
                except Exception as e2:
                    log.error("[extractor] raw_id=%d mark_failed also failed: %s", raw_id, e2)

        log.info("[extractor] Batch of %d processed  (+%d normalized, total=%d, failed=%d)",
                 len(rows), total - batch_start, total, failed)
