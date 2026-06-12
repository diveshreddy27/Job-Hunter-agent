"""
Email builder — fills EMAIL_BUILDER_PROMPT with job data + resume,
calls AI model cascade, returns {subject, body}.
"""
import json
import logging
import re
import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import settings as cfg

log = logging.getLogger("email_builder")

_PROJECT_ROOT = Path(__file__).parent.parent.parent
_PROMPT_PATH  = _PROJECT_ROOT / "prompts" / "email_builder_prompt.txt"
_RESUME_DIR   = _PROJECT_ROOT / "resume"

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/{model}:generateContent?key={key}"
)
_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Model cascade for email generation — best quality first
_MODELS = [
    {"id": "gemini-3.5-flash",      "api": "gemini"},
    {"id": "gemini-2.5-flash",      "api": "gemini"},
    {"id": "llama-3.3-70b-versatile","api": "groq"},
    {"id": "gemini-3.1-flash-lite", "api": "gemini"},
    {"id": "gemini-2.5-flash-lite", "api": "gemini"},
    {"id": "gemma-4-31b-it",        "api": "gemini"},
]

# Cached resume text
_resume_cache = None  # type: str


def _extract_resume_text() -> str:
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


def _format_experience(job: dict) -> str:
    mn, mx = job.get("experience_min"), job.get("experience_max")
    if mn is not None and mx is not None:
        return f"{mn}–{mx} years"
    if mn is not None:
        return f"{mn}+ years"
    if mx is not None:
        return f"Up to {mx} years"
    return "Not specified"


def _build_prompt(job: dict) -> str:
    template = _PROMPT_PATH.read_text(encoding="utf-8")

    location = ", ".join(filter(None, [
        job.get("location_city"), job.get("location_state")
    ])) or job.get("location") or "Not specified"

    job_section = (
        f"Role: {job.get('title') or 'Not specified'}\n"
        f"Company: {job.get('company') or 'Not specified'}\n"
        f"Location: {location}\n"
        f"Work Mode: {job.get('work_mode') or 'Not specified'}\n"
        f"Experience Required: {_format_experience(job)}\n"
        f"Required Skills: {job.get('skills') or 'Not specified'}\n\n"
        f"Full Post:\n{job.get('post_content') or ''}"
    )

    resume_text = _extract_resume_text()

    # Replace contact-info placeholders with actual values
    sender_email = getattr(cfg, "SENDER_EMAIL", "diveshreddy2427@gmail.com")
    sender_phone = getattr(cfg, "SENDER_PHONE", "")
    template = template.replace("[Email Address]", sender_email)
    template = template.replace("[Phone Number]", sender_phone)

    # Replace job post and resume placeholders
    template = template.replace("[PASTE LINKEDIN JOB POST]", job_section)
    template = template.replace("[PASTE MY RESUME]", resume_text)

    # Append JSON output instruction
    template += (
        "\n\n---\n"
        "IMPORTANT — OUTPUT FORMAT:\n"
        "Return ONLY a valid JSON object with exactly two keys, nothing else:\n"
        '{"subject": "<email subject line>", "body": "<full email body — use \\n for line breaks>"}'
    )
    return template


def _parse_response(text: str) -> dict:
    """Extract JSON from model response — handles wrapped/prefixed output."""
    text = text.strip()
    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Extract first {...} block
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    raise ValueError(f"Could not parse JSON from model response: {text[:300]}")


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
    """Generate email subject + body for the given job dict.

    Returns: {"subject": str, "body": str}
    Raises:  RuntimeError if all models fail.
    """
    prompt = _build_prompt(job)

    last_error = None
    for m in _MODELS:
        try:
            if m["api"] == "gemini":
                result = _call_gemini(m["id"], prompt)
            else:
                result = _call_groq(m["id"], prompt)

            if not result.get("subject") or not result.get("body"):
                raise ValueError("Response missing subject or body")

            log.info("[email_builder] Generated via %s for job=%s", m["id"], job.get("target_id"))
            return {"subject": result["subject"], "body": result["body"], "model_used": m["id"]}

        except Exception as e:
            log.warning("[email_builder] %s failed: %s", m["id"], e)
            last_error = e
            continue

    raise RuntimeError(f"All models failed to generate email. Last error: {last_error}")
