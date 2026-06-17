"""
Standalone location utility.
Extracts city and normalises Indian state from any raw location string.
Kept separate so it can be updated independently.
"""
import re
import sys
import os
from typing import Optional
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

import settings as cfg


# Tokens in INDIA_STATES that are state-only / non-city — they must never
# end up in the `city` field of the returned dict.
_STATE_ONLY = {
    "telangana", "karnataka", "maharashtra", "delhi",
    "west bengal", "tamil nadu", "gujarat", "rajasthan",
    "odisha", "kerala", "punjab", "uttar pradesh",
    "madhya pradesh", "andhra pradesh", "haryana",
    "remote", "pan india", "india", "bharat",
}


def extract_location(raw: str) -> dict:
    """
    Input:  any raw location string, e.g. "Hyderabad, Telangana, India",
            "Bangalore (Hybrid)", "Remote - India", "Pune/Mumbai", or
            "Hyderabad and Bangalore".
    Output: {"city": str|None, "state": str, "country": str, "is_remote": bool}
    """
    if not raw:
        return {"city": None, "state": None, "country": "India", "is_remote": False}

    text  = raw.lower().strip()
    # Split on commas/slashes/dashes/pipes/parens AND the word " and " so
    # multi-city posts ("Hyderabad and Bangalore") don't dump both names into
    # one part.
    parts = re.split(r"[,/|&–\-\(\)]+|\band\b", text)
    parts = [p.strip() for p in parts if p.strip()]

    is_remote = any(w in text for w in ("remote", "work from home", "wfh"))

    city  = None
    state = None

    for part in parts:
        if part in cfg.INDIA_STATES:
            matched_state = cfg.INDIA_STATES[part]
            if state is None:
                state = matched_state
            # Only treat as city when the token isn't a state-only name AND
            # we haven't already locked in a city. Without the second clause
            # we'd let later parts ("Bangalore" in "Hyderabad, Bangalore")
            # overwrite the first.
            if part not in _STATE_ONLY and city is None:
                city = part.title()

    # No city captured via the state map — fall back to the first non-state
    # token. Skip state-only tokens here too so we don't return "Telangana"
    # as a city.
    if not city and parts:
        for p in parts:
            if p not in _STATE_ONLY:
                city = p.title()
                break

    if not state and city:
        state = cfg.INDIA_STATES.get(city.lower())

    if is_remote and not state:
        state = "Remote"

    return {
        "city":      city,
        "state":     state or "Unknown",
        "country":   "India",
        "is_remote": is_remote,
    }


def extract_experience(text: str) -> tuple:
    """Extract (min, max) years of experience from JD / post text.

    Tried in order of confidence — the first match wins:
      1. Explicit ranges:   "1-5 years", "3 to 7 Years", "3+ to 7 Years", "2-5 yoe"
      2. Labelled values:   "Experience: 5+ Years", "Exp - 5 yrs",
                            "experience of 5 years", "YoE: 5"
      3. Trailing label:    "5+ years experience", "5 yrs of experience"
      4. Adjective + years: "5+ relevant years", "4+ total years in X"
      5. Minimum markers:   "Min 3 years", "Minimum. 3 yrs", "Min. 3 yrs exp"
      6. Bare year counts:  "5+ Years", "8+ years", "5 yoe" (last resort)

    When only a single number is found, we return (n, n+3) as the upper
    bound — that's the typical industry spread for a `5+ years` ad.
    The text is normalised to ASCII-equivalent first so bold-unicode
    labels (`𝗘𝘅𝗽𝗲𝗿𝗶𝗲𝗻𝗰𝗲`) still match.
    """
    if not text:
        return None, None
    norm = _normalize_text(text)
    patterns = [
        # Range: "1-5 years", "3 to 7 Years", "3+ to 7 Years", "2-5 yoe"
        r"(\d+)\+?\s*(?:[-–]|to)\s*(\d+)\+?\s*(?:years?|yrs?|yoe)",
        # Labelled: "Experience: 5+ Years", "Exp - 5 yrs", "YoE: 5"
        r"\b(?:exp(?:erience)?|yoe)\s*[:\-–]?\s*(?:of\s+)?(\d+)\+?\s*(?:years?|yrs?)?",
        # Trailing label: "5+ years experience"
        r"(\d+)\+?\s*(?:years?|yrs?|yoe)\s+(?:of\s+\w+\s+)?(?:relevant\s+)?exp(?:erience)?",
        # Adjective before years: "5+ relevant years", "4+ total years in X"
        r"(\d+)\+?\s*(?:relevant|total|plus)\s+(?:years?|yrs?)\b",
        # Min/Minimum: "Min 3 yrs", "Minimum. 3 years"
        r"\bmin(?:imum)?\.?\s+(\d+)\+?\s*(?:years?|yrs?|yoe)",
        # Bare: "5+ Years", "5 yoe" — `+` OR explicit "yoe" suffix required
        # to avoid grabbing random numbers like "5 vacancies".
        r"\b(\d+)\+\s*(?:years?|yrs?)\b|\b(\d+)\+?\s*yoe\b",
    ]
    for pat in patterns:
        m = re.search(pat, norm, re.IGNORECASE)
        if m:
            g = [x for x in m.groups() if x is not None]
            if len(g) >= 2:
                return float(g[0]), float(g[1])
            if g:
                return float(g[0]), float(g[0]) + 3
    return None, None


# Map Unicode Mathematical Sans-Serif Bold / Italic letters (used by some
# recruiters as fake bold formatting) back to ASCII so regex hits them.
_UNICODE_BOLD_OFFSETS = (
    (0x1D400, 0x1D419, 0x41),  # bold uppercase A-Z   -> A-Z
    (0x1D41A, 0x1D433, 0x61),  # bold lowercase a-z   -> a-z
    (0x1D434, 0x1D44D, 0x41),  # italic uppercase
    (0x1D44E, 0x1D467, 0x61),  # italic lowercase
    (0x1D5D4, 0x1D5ED, 0x41),  # sans bold upper
    (0x1D5EE, 0x1D607, 0x61),  # sans bold lower
    (0x1D608, 0x1D621, 0x41),  # sans italic upper
    (0x1D622, 0x1D63B, 0x61),  # sans italic lower
)


def _normalize_text(s: str) -> str:
    out = []
    for ch in s:
        cp = ord(ch)
        for lo, hi, base in _UNICODE_BOLD_OFFSETS:
            if lo <= cp <= hi:
                out.append(chr(base + (cp - lo)))
                break
        else:
            out.append(ch)
    return "".join(out)


def extract_salary(text: str) -> tuple:
    """Extract (min, max) salary in LPA from JD text.

    Handles: `5-10 LPA`, `5 to 10 lakhs`, `₹5–10 L`, `up to 15 LPA`,
    `INR 8-12 lakhs per annum`. Returns (None, None) when no match.

    Note: the previous version used `[-–to]+` which was a CHARACTER CLASS
    (matching `-`, `–`, `t`, `o` individually, so `5tt10` would match!).
    Now uses a non-capturing group `(?:[-–]|to)`.
    """
    patterns = [
        # Range: "5-10 LPA" / "5 to 10 lakhs" / "5–10 L"
        r"(\d+(?:\.\d+)?)\s*(?:[-–]|to)\s*(\d+(?:\.\d+)?)\s*"
        r"(?:lpa|l\.p\.a|lakhs?|l(?:[\s.,]|$))",
        # Single-cap: "up to 15 LPA" / "max 20 lakhs"
        r"(?:upto|up to|max(?:imum)?)\s*(\d+(?:\.\d+)?)\s*(?:lpa|lakhs?|l\b)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            g = m.groups()
            if len(g) >= 2 and g[1]:
                return float(g[0]), float(g[1])
            return None, float(g[0])
    return None, None


def extract_recruiter_email(text: str) -> Optional[str]:
    """Extract email address from post/JD text. Strips trailing punctuation
    so `Apply at jane@acme.com.` returns `jane@acme.com`, not `…com.`."""
    if not text:
        return None
    m = re.search(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text)
    if not m:
        return None
    # Belt-and-suspenders: strip any straggling punctuation
    return m.group(0).rstrip(".,;:!?)]>")


def detect_work_mode(text: str) -> str:
    t = text.lower()
    if "work from home" in t or ("remote" in t and "hybrid" not in t):
        return "remote"
    if "hybrid" in t:
        return "hybrid"
    return "onsite"


def detect_company_type(text: str) -> str:
    t = text.lower()
    if any(w in t for w in ["product", "saas", "platform company"]):
        return "product"
    if any(w in t for w in ["startup", "series a", "series b", "seed"]):
        return "startup"
    if any(w in t for w in ["consulting", "consultant", "advisory"]):
        return "consulting"
    if any(w in t for w in ["tcs", "infosys", "wipro", "hcl", "tech mahindra",
                             "cognizant", "accenture", "capgemini"]):
        return "service"
    return None


def detect_apply_via(text: str, url: str = "") -> str:
    """Determine how to apply: website, email, linkedin_easy, naukri."""
    email = extract_recruiter_email(text or "")
    if email:
        return "email"
    u = (url or "").lower()
    if "linkedin.com/jobs" in u or "easy apply" in text.lower():
        return "linkedin_easy"
    if "naukri.com" in u:
        return "naukri"
    return "website"


def is_contract_role(text: str) -> bool:
    t = text.lower()
    return any(w in t for w in ["contract", "c2h", "c2c", "freelance",
                                  "contract to hire", "contingent"])


_FOREIGN_HARD = (
    "usa only", "us only", "uk only", "canada only", "australia only",
    "singapore only", "must be in us", "must reside in",
    "h1b sponsorship", "h-1b sponsorship",
    # Regional abbreviations GeoText doesn't resolve
    "latam", "latin america", "mena region", "gcc region",
    "apac region", "emea region",
)


# Generic markers in INDIA_STATES that are NOT unique India signals
# (`remote` matches `#RemoteJobs` on a USA post; `pan india` is ambiguous).
_GENERIC_LOCATION_KEYS = {"remote", "pan india"}


def _india_keyword_present(text: str) -> bool:
    """Curated, case-insensitive India check.

    GeoText is case-sensitive, so lowercase Indian-city hashtags
    (`#hyderabad`, `#bengaluru`) slip through it. This covers those.

    Skips generic markers (`remote`, `pan india`) that occur on foreign posts
    too — those are not by themselves India signals.
    """
    if not text:
        return False
    t = text.lower()
    keys = (set(cfg.INDIA_STATES.keys()) - _GENERIC_LOCATION_KEYS) | {"india", "bharat"}
    for k in keys:
        if re.search(rf"\b{re.escape(k)}\b", t):
            return True
    return False


def extract_locations(text: str) -> dict:
    """
    Pull every place name out of the text and map it back to a country code.

    Returns:
        {
          "cities":         [str],   # case-sensitive matches found by GeoText
          "countries":      [str],   # full country names found in text
          "country_codes":  {cc: n}, # ISO-2 country -> mention count (cities + countries)
          "has_india":      bool,    # True if India is referenced (curated OR GeoText)
          "foreign_countries": [str],# ISO-2 codes other than IN
        }
    """
    from geotext import GeoText
    g = GeoText(text or "")
    codes = dict(g.country_mentions)
    has_india = ("IN" in codes) or _india_keyword_present(text)
    foreign = [c for c in codes if c != "IN"]
    return {
        "cities":            list(g.cities),
        "countries":         list(g.countries),
        "country_codes":     codes,
        "has_india":         has_india,
        "foreign_countries": foreign,
    }


def parse_posted_hours(time_text: str) -> Optional[float]:
    """Parse post-age text → float hours elapsed.

    Handles both full words ('2 hours ago', '1 day ago') and
    LinkedIn SDUI abbreviated format ('2h', '23h', '1d', '2w').
    Returns None when unparseable — caller should not drop the post.
    """
    if not time_text:
        return None
    t = time_text.lower().strip()
    # strip bullet / separator suffix: "2h • LinkedIn" → "2h"
    t = re.sub(r'\s*[•·|].*$', '', t).strip()

    if any(p in t for p in ("just now", "moment", "few hour", "few minute", "today")):
        return 1.0

    # Full-word format: "2 hours ago", "1 day ago", "3 weeks ago"
    m = re.search(r'(\d+)\s*(minute|hour|day|week|month)', t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        if unit.startswith("minute"): return n / 60.0
        if unit.startswith("hour"):   return float(n)
        if unit.startswith("day"):    return float(n * 24)
        if unit.startswith("week"):   return float(n * 24 * 7)
        if unit.startswith("month"):  return float(n * 24 * 30)

    # Abbreviated SDUI format: "2h", "23h", "1d", "2w", "30m"
    m = re.match(r'^(\d+)\s*([mhdw])$', t)
    if m:
        n, unit = int(m.group(1)), m.group(2)
        if unit == 'm': return n / 60.0
        if unit == 'h': return float(n)
        if unit == 'd': return float(n * 24)
        if unit == 'w': return float(n * 24 * 7)

    return None


def experience_in_range(
    exp_min,
    exp_max,
    target_min: float,
    target_max: float,
) -> bool:
    """True when a post's experience range plausibly overlaps the candidate's.

    Semantics:
      - If BOTH bounds are None (regex couldn't extract anything) → True.
        We don't know what the post asks for; let the ATS scorer decide.
      - Otherwise treat a missing bound as open (0 for min, 99 for max)
        and accept when the two ranges intersect.
    """
    if exp_min is None and exp_max is None:
        return True
    post_lo = 0.0  if exp_min is None else float(exp_min)
    post_hi = 99.0 if exp_max is None else float(exp_max)
    return post_lo <= target_max and post_hi >= target_min


def is_india_job(text: str, location: str = "") -> bool:
    """
    True when the post/job is plausibly for India.

    Strategy:
      1. Hard reject: explicit `X only` markers.
      2. Use GeoText to extract every place name and resolve it to a country
         (handles `Charlotte, North Carolina` -> US, `Mumbai` -> IN, ...).
      3. Layer on a curated India-keyword check so lowercase hashtags like
         `#hyderabad` still register as India even though GeoText needs caps.
      4. Reject only when foreign country signals exist AND no India signal
         is found. If no countries are detectable at all, accept (post is
         ambiguous, let downstream filtering handle it).
    """
    combined  = f"{text} {location}"
    lower     = combined.lower()

    if any(w in lower for w in _FOREIGN_HARD):
        return False

    info = extract_locations(combined)
    if info["foreign_countries"] and not info["has_india"]:
        return False
    return True
