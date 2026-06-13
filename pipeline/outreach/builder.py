"""
Email builder — sends info file + resume + raw post to AI cascade.
AI handles greeting, subject format, required fields, and flags anything
missing from the info file.
"""
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import settings as cfg

log = logging.getLogger("email_builder")

_PROJECT_ROOT   = Path(__file__).parent.parent.parent
_PROMPT_PATH    = _PROJECT_ROOT / "prompts" / "email_builder_prompt.txt"
_RESUME_DIR     = _PROJECT_ROOT / "resume"
_INFO_PATH      = _PROJECT_ROOT / "config" / "candidate_info.txt"
_MISSING_PATH   = _PROJECT_ROOT / "data" / "missing_fields.json"

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/{model}:generateContent?key={key}"
)
_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

_MODELS = [
    {"id": "gemini-3.5-flash",        "api": "gemini"},
    {"id": "gemini-2.5-flash",        "api": "gemini"},
    {"id": "llama-3.3-70b-versatile", "api": "groq"},
    {"id": "gemini-3.1-flash-lite",   "api": "gemini"},
    {"id": "gemini-2.5-flash-lite",   "api": "gemini"},
    {"id": "gemma-4-31b-it",          "api": "gemini"},
]

_resume_cache = None  # type: str


def _read_info() -> str:
    if not _INFO_PATH.exists():
        raise FileNotFoundError(
            f"Candidate info file not found: {_INFO_PATH}\n"
            "Copy config/candidate_info.example.txt → config/candidate_info.txt and fill it in."
        )
    return _INFO_PATH.read_text(encoding="utf-8").strip()


def _read_resume() -> str:
    global _resume_cache
    if _resume_cache:
        return _resume_cache
    pdf_files = list(_RESUME_DIR.glob("*.pdf"))
    txt_files = list(_RESUME_DIR.glob("*.txt"))
    if pdf_files:
        from pdfminer.high_level import extract_text
        text = extract_text(str(pdf_files[0]))
    elif txt_files:
        text = txt_files[0].read_text(encoding="utf-8", errors="ignore")
    else:
        raise FileNotFoundError(f"No resume found in {_RESUME_DIR}")
    _resume_cache = text.strip()
    return _resume_cache


def _build_prompt(job: dict) -> str:
    template = _PROMPT_PATH.read_text(encoding="utf-8")
    template = template.replace("[MY_INFO]",   _read_info())
    template = template.replace("[MY_RESUME]", _read_resume())
    template = template.replace("[RAW_POST]",  job.get("post_content") or "")
    return template


def _record_missing_fields(fields: list, job_id) -> None:
    """Append newly seen missing fields to data/missing_fields.json."""
    if not fields:
        return
    _MISSING_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing = json.loads(_MISSING_PATH.read_text()) if _MISSING_PATH.exists() else {}
    except (json.JSONDecodeError, OSError):
        existing = {}

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for field in fields:
        field = field.strip().upper()
        if not field:
            continue
        if field not in existing:
            existing[field] = {"count": 0, "first_seen": today, "last_seen": today, "job_ids": []}
        entry = existing[field]
        entry["count"] += 1
        entry["last_seen"] = today
        if job_id and job_id not in entry["job_ids"]:
            entry["job_ids"].append(job_id)

    _MISSING_PATH.write_text(json.dumps(existing, indent=2))
    log.info("[email_builder] Missing fields recorded: %s", fields)


def _parse_response(text: str) -> dict:
    text = text.strip()
    # Strip ```json … ``` fences some models wrap around the JSON
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.DOTALL).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Could not parse JSON from model response: {text[:300]}")


def _normalize_body(body: str) -> str:
    """Models sometimes double-escape line breaks, returning literal '\\n'
    instead of real newlines. Convert any literal escape sequences back to
    real characters, then tidy paragraph spacing.

    Idempotent: real newlines carry no backslash, so already-correct bodies
    pass through unchanged.
    """
    if "\\n" in body or "\\t" in body or "\\r" in body:
        body = (body.replace("\\r\\n", "\n")
                    .replace("\\r", "\n")
                    .replace("\\n", "\n")
                    .replace("\\t", "\t"))
    # Normalize CRLF, collapse 3+ blank lines to a single blank line, trim edges
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    body = re.sub(r"\n{3,}", "\n\n", body)
    return body.strip()


def _call_gemini(model_id: str, prompt: str) -> dict:
    url = _GEMINI_URL.format(model=model_id, key=cfg.GEMINI_API_KEY)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4},
    }
    resp = requests.post(url, json=payload, timeout=60)
    if resp.status_code == 429:
        raise RuntimeError(f"429 on {model_id}")
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    return _parse_response(text)


def _call_groq(model_id: str, prompt: str) -> dict:
    headers = {
        "Authorization": f"Bearer {cfg.GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.4,
    }
    resp = requests.post(_GROQ_URL, json=payload, headers=headers, timeout=60)
    if resp.status_code == 429:
        raise RuntimeError(f"429 on {model_id}")
    resp.raise_for_status()
    text = resp.json()["choices"][0]["message"]["content"]
    return _parse_response(text)


def build_email(job: dict) -> dict:
    """Generate email for a job dict.

    Returns: {subject, body, model_used, missing_fields}
    missing_fields: list of field names from candidate_info.txt that the
                    recruiter asked for but were marked '(not provided)'.
    """
    prompt = _build_prompt(job)

    last_error = None
    for m in _MODELS:
        try:
            result = _call_gemini(m["id"], prompt) if m["api"] == "gemini" \
                     else _call_groq(m["id"], prompt)

            if not result.get("subject") or not result.get("body"):
                raise ValueError("Response missing subject or body")

            missing = [f for f in (result.get("missing_fields") or []) if f]
            _record_missing_fields(missing, job.get("target_id"))

            log.info("[email_builder] Generated via %s  job=%s  missing=%s",
                     m["id"], job.get("target_id"), missing or "none")

            return {
                "subject":        " ".join(result["subject"].split()),  # subjects are single-line
                "body":           _normalize_body(result["body"]),
                "model_used":     m["id"],
                "missing_fields": missing,
            }

        except Exception as e:
            log.warning("[email_builder] %s failed: %s", m["id"], e)
            last_error = e
            continue

    raise RuntimeError(f"All models failed. Last error: {last_error}")
