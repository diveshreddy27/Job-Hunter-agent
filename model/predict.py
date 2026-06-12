"""
Local extraction using the trained spaCy NER model.

NER model handles  : JOB_TITLE, COMPANY, SKILL
Regex utils handle : email, experience, location, work_mode, apply_via

Same return shape as _normalize_with_gemini() in scraper/extractor.py so
the two are drop-in replacements for each other.
"""
import re
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

import spacy

from pipeline.scraper.location_utils import (
    extract_experience,
    extract_recruiter_email,
    detect_work_mode,
    extract_location,
)

MODEL_DIR = pathlib.Path(__file__).parent / "linkedin_ner"

_URL_RE = re.compile(r"https?://\S+")
_DM_RE  = re.compile(r"\b(dm\s+me|message\s+me|inbox\s+me|whatsapp\s+me|ping\s+me)\b", re.IGNORECASE)


class LocalExtractor:
    """Load once, call .extract() per post."""

    def __init__(self):
        if not MODEL_DIR.exists():
            raise FileNotFoundError(
                f"Trained model not found at {MODEL_DIR}.\n"
                "Run:  python model/train.py"
            )
        self.nlp = spacy.load(MODEL_DIR)

    def extract(self, raw: dict) -> dict:
        content  = raw["post_content"]  or ""
        headline = raw["author_headline"] or ""
        author   = raw["post_author"]   or ""
        post_url = raw["post_url"]

        # Same text layout the model was trained on
        text = f"{author}\n{headline}\n{content}"
        doc  = self.nlp(text)

        title   = None
        company = None
        skills  = []

        for ent in doc.ents:
            if ent.label_ == "JOB_TITLE" and title is None:
                title = ent.text.strip()
            elif ent.label_ == "COMPANY" and company is None:
                company = ent.text.strip()
            elif ent.label_ == "SKILL":
                s = ent.text.strip()
                if s and s not in skills:
                    skills.append(s)

        # Regex-backed fields
        exp_min, exp_max = extract_experience(content)
        email     = extract_recruiter_email(content) or extract_recruiter_email(headline)
        work_mode = detect_work_mode(content)
        loc       = extract_location(content)

        # apply_via priority: email > easy apply > URL > DM > default
        url_match = _URL_RE.search(content)
        if email:
            apply_via = "email"
            apply_url = post_url
        elif "easy apply" in content.lower():
            apply_via = "linkedin_easy"
            apply_url = post_url
        elif url_match:
            apply_via = "website"
            apply_url = url_match.group(0).rstrip(".,)>")
        elif _DM_RE.search(content):
            apply_via = "personal_message"
            apply_url = post_url
        else:
            apply_via = "website"
            apply_url = post_url

        return {
            "title":                     title,
            "company":                   company,
            "location_city":             loc.get("city"),
            "location_state":            loc.get("state"),
            "is_remote":                 1 if work_mode == "remote" else 0,
            "work_mode":                 work_mode,
            "experience_min":            exp_min,
            "experience_max":            exp_max,
            "skills":                    ", ".join(skills) if skills else None,
            "recruiter_email":           email,
            "recruiter_name":            author,
            "recruiter_designation":     None,
            "recruiter_current_company": None,
            "apply_via":                 apply_via,
            "apply_url":                 apply_url,
            "extracted_by":              "local_ner",
            "role_type":                 "fulltime",
        }
