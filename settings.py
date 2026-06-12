# ============================================================
#  LinkedIn Job Scraper — CONFIG
#  Non-secret settings live here.
#  Secrets (API keys, passwords) are loaded from .env — copy
#  .env.example → .env and fill in your values.
# ============================================================
import os as _os
try:
    from dotenv import load_dotenv as _load
    _load()
except ImportError:
    pass  # python-dotenv not installed; export env vars manually

# ── LinkedIn — scraping account ──────────────────────────────
# Use a dummy account (separate from your main one) so scraping
# activity doesn't get your real LinkedIn profile flagged.
SCRAPE_LINKEDIN_EMAIL    = _os.getenv("SCRAPE_LINKEDIN_EMAIL", "")
SCRAPE_LINKEDIN_PASSWORD = _os.getenv("SCRAPE_LINKEDIN_PASSWORD", "")

# ── Search ───────────────────────────────────────────────────
TARGET_ROLE           = "Data Engineer"
LINKEDIN_SEARCH_QUERY = '"Data Engineer" and "hiring" and "aws"'

# Cities/locations we want jobs in. Used by the location normaliser to
# resolve raw strings like "Hyderabad, Telangana, India" → state="Telangana".
SEARCH_LOCATIONS = [
    "Hyderabad", "Pune", "Mumbai", "Bengaluru",
    "Bangalore", "Kolkata", "Delhi", "Noida",
    "Andhra Pradesh", "Remote",
]

# Keywords that disqualify a post outright (contract, foreign-only, etc.)
EXCLUDE_KEYWORDS = [
    "contract", "c2h", "freelance", "internship",
    "usa only", "us only", "uk only", "canada only",
    "10+ years", "15 years", "mainframe",
]

# Candidate experience window — posts whose stated years range can't
# overlap with this are dropped pre-write. Posts without an explicit
# year count are kept (unknown → defer to downstream filtering).
CANDIDATE_EXPERIENCE_MIN = 2.0
CANDIDATE_EXPERIENCE_MAX = 4.0

# ── Indian state lookup (used by scraper.location_utils) ─────
# Map any city / state alias (lowercased) to its canonical state name.
INDIA_STATES = {
    "hyderabad": "Telangana", "secunderabad": "Telangana",
    "warangal": "Telangana", "telangana": "Telangana",
    "bangalore": "Karnataka", "bengaluru": "Karnataka",
    "mysore": "Karnataka", "mangalore": "Karnataka", "hubli": "Karnataka",
    "karnataka": "Karnataka",
    "mumbai": "Maharashtra", "pune": "Maharashtra",
    "nashik": "Maharashtra", "nagpur": "Maharashtra",
    "thane": "Maharashtra", "navi mumbai": "Maharashtra",
    "maharashtra": "Maharashtra",
    "delhi": "Delhi", "new delhi": "Delhi",
    "noida": "Uttar Pradesh", "greater noida": "Uttar Pradesh",
    "gurgaon": "Haryana", "gurugram": "Haryana", "faridabad": "Haryana",
    "kolkata": "West Bengal", "west bengal": "West Bengal",
    "chennai": "Tamil Nadu", "coimbatore": "Tamil Nadu",
    "madurai": "Tamil Nadu", "tamil nadu": "Tamil Nadu",
    "ahmedabad": "Gujarat", "surat": "Gujarat",
    "vadodara": "Gujarat", "gandhinagar": "Gujarat", "gujarat": "Gujarat",
    "jaipur": "Rajasthan", "udaipur": "Rajasthan", "rajasthan": "Rajasthan",
    "bhubaneswar": "Odisha", "bhubaneshwar": "Odisha", "odisha": "Odisha",
    "kochi": "Kerala", "cochin": "Kerala",
    "thiruvananthapuram": "Kerala", "trivandrum": "Kerala", "kerala": "Kerala",
    "chandigarh": "Chandigarh", "mohali": "Punjab", "punjab": "Punjab",
    "lucknow": "Uttar Pradesh", "kanpur": "Uttar Pradesh",
    "uttar pradesh": "Uttar Pradesh",
    "bhopal": "Madhya Pradesh", "indore": "Madhya Pradesh",
    "madhya pradesh": "Madhya Pradesh",
    "andhra pradesh": "Andhra Pradesh", "visakhapatnam": "Andhra Pradesh",
    "vizag": "Andhra Pradesh", "vijayawada": "Andhra Pradesh",
    "tirupati": "Andhra Pradesh", "guntur": "Andhra Pradesh",
    "patna": "Bihar", "bihar": "Bihar",
    "ranchi": "Jharkhand", "jamshedpur": "Jharkhand", "jharkhand": "Jharkhand",
    "dehradun": "Uttarakhand", "uttarakhand": "Uttarakhand",
    "goa": "Goa", "panaji": "Goa",
    "haryana": "Haryana",
    "remote": "Remote", "pan india": "Pan India", "india": "Pan India",
    "bharat": "Pan India",
}

# ── Google AI Studio — used by the extractor ─────────────────
# Get your free key at https://aistudio.google.com/app/apikey
GEMINI_API_KEY = _os.getenv("GEMINI_API_KEY", "")

# ── Groq — fast open-model inference (LPU hardware) ──────────
# Note: "gsk_" prefix = Groq (groq.com), NOT Grok/xAI ("xai-" prefix)
# Free tier: generous RPM on Llama 3.3, Mixtral, Gemma etc.
# Get your key at: console.groq.com/keys
GROQ_API_KEY = _os.getenv("GROQ_API_KEY", "")

# ── Model roster (all free-tier, verified against the API) ───────────────────
# IDs confirmed via GET /v1beta/models.
# RPM/RPD verified June 2026 — check aistudio.google.com/rate-limit for your project's live caps.
#
# Excluded:
#   gemini-2.0-flash / lite  — deprecated, shut down June 1 2026
#   gemini-3.0-flash         — does NOT exist (404)
#   gemini-3.1-pro-preview   — paid input/output tokens
#
# Model                    API ID                    RPM   RPD   Output   Source
# ────────────────────────────────────────────────────────────────────────────────
# Gemini 3.5 Flash         gemini-3.5-flash           30    20  65536   AI Studio (user-confirmed)
# Gemini 3.1 Flash-Lite    gemini-3.1-flash-lite      15  1000  65536   documented free tier
# Gemini 2.5 Flash         gemini-2.5-flash           10    20  65536   429 observed; slashed ~Apr 2026
# Gemini 2.5 Flash-Lite    gemini-2.5-flash-lite      15  1000  65536   documented free tier
# Gemma 4 31B              gemma-4-31b-it             15  1440  32768   open model; generous quota
# Gemma 4 26B A4B          gemma-4-26b-a4b-it         15  1440  32768   open model; generous quota

# Daily request limits per model (free tier).
# The cascade skips any model whose RPD has been reached today.
# On 429, the model is also immediately marked exhausted regardless of this count.
# Check your real limits at: aistudio.google.com/rate-limit
GEMINI_MODEL_LIMITS = {
    "gemini-3.5-flash":      {"rpd":   20, "rpm": 30},   # user-confirmed 20 RPD
    "gemini-3.1-flash-lite": {"rpd": 1000, "rpm": 15},   # 1000 RPD documented
    "gemini-2.5-flash":      {"rpd":   20, "rpm": 10},   # slashed to ~20 RPD; 429 confirmed
    "gemini-2.5-flash-lite": {"rpd": 1000, "rpm": 15},   # 1000 RPD documented
    "gemma-4-31b-it":        {"rpd": 1440, "rpm": 15},   # open model generous quota
    "gemma-4-26b-a4b-it":    {"rpd": 1440, "rpm": 15},   # open model generous quota
}

# Stage-specific model assignments
GEMINI_EXTRACT_MODEL = "gemini-3.1-flash-lite"   # 1000 RPD — primary extraction model

# ── ATS unified model cascade ────────────────────────────────
# All scoring models — Gemini and Groq — ordered best → worst quality.
# The scorer always starts from index 0 for each job, so better models are
# automatically preferred again once their rate-limit window resets.
# On 429: model is skipped until its reset window expires, then eligible again.
# Verify Groq model IDs at: console.groq.com/docs/models
ATS_UNIFIED_MODELS = [
    {"id": "gemini-3.5-flash",                          "api": "gemini"},  # best quality, 20 RPD
    {"id": "gemini-2.5-flash",                          "api": "gemini"},  # thinking model, 20 RPD
    {"id": "meta-llama/llama-4-scout-17b-16e-instruct", "api": "groq"},    # Llama 4, newest
    {"id": "llama-3.3-70b-versatile",                   "api": "groq"},    # 70B workhorse
    {"id": "gemini-3.1-flash-lite",                     "api": "gemini"},  # 1000 RPD workhorse
    {"id": "gemini-2.5-flash-lite",                     "api": "gemini"},  # 1000 RPD fallback
    {"id": "qwen/qwen3-32b",                            "api": "groq"},    # groq fallback
    {"id": "gemma-4-31b-it",                            "api": "gemini"},  # 1440 RPD
    {"id": "gemma-4-26b-a4b-it",                        "api": "gemini"},  # 1440 RPD
    {"id": "llama-3.1-8b-instant",                      "api": "groq"},    # smallest, last resort
]

# Proactive Groq token guard: mark model limited when remaining tokens < this.
# Each ATS call uses ~3500–5000 tokens; 4000 leaves one call of headroom.
GROQ_SCORE_MIN_TOK_REMAINING = 4_000

# ── ATS filter — which jobs to score ─────────────────────────
ATS_TARGET_CITIES = {
    "hyderabad", "mumbai", "navi mumbai", "thane",
    "pune", "chennai", "bengaluru", "bangalore", "kolkata",
}
ATS_TARGET_STATES = {
    "telangana", "maharashtra", "tamil nadu",
    "karnataka", "west bengal", "andhra pradesh",
}
ATS_INCLUDE_REMOTE       = True   # remote jobs always pass location filter
ATS_INCLUDE_NULL_LOCATION = True  # unknown location = keep (don't miss opportunities)
ATS_CANDIDATE_EXP_MIN    = 2.0
ATS_CANDIDATE_EXP_MAX    = 4.0

ATS_TAILORING_THRESHOLD = 75

# ── Local NER model ───────────────────────────────────────────
# Trained on your own scraped data (raw_post → normalized JSON pairs).
# Once you have 50+ posts in the DB, run:  python model/train.py
# Then flip USE_LOCAL_MODEL = True to stop using the Gemini API for extraction.
# Gemini API remains active as fallback when local model returns no title.
USE_LOCAL_MODEL = False

# ── Staging pipeline ─────────────────────────────────────────
# Scraper writes raw posts to files here; processor picks them up.
STAGING_DIR        = "data/queue"   # relative to project root
STAGING_BATCH_SIZE = 10          # posts per staging file

# When True the processor skips ingestion for posts with no recruiter email.
# Set False if you want to keep everything that passes location+exp filters.
REQUIRE_EMAIL_FOR_INGESTION = True

# ── Email outreach ───────────────────────────────────────────
# Used by email_outreach/sender.py to send cold outreach emails via Gmail SMTP.
#
# How to get an App Password:
#   1. Enable 2-Step Verification on your Google account
#   2. Go to myaccount.google.com → Security → App Passwords
#   3. Create an app password for "Mail" → paste it below (no spaces)
SENDER_EMAIL      = _os.getenv("SENDER_EMAIL", "")
SENDER_NAME       = "Divesh Reddy Bonaspuram"
SENDER_PHONE      = ""          # optional — fills [Phone Number] in prompt closing
SMTP_APP_PASSWORD = _os.getenv("SMTP_APP_PASSWORD", "")
SMTP_SERVER       = "smtp.gmail.com"
SMTP_PORT         = 587

# ── Scraper behaviour ────────────────────────────────────────
SCRAPE_HEADLESS = True     # False = watch the browser drive itself
SCRAPE_MAX_PAGES = 40      # Jobs tab safety ceiling (`?start=N` pagination)

# Posts feed is infinite-scroll. None = scroll until LinkedIn stops returning
# new posts for POSTS_END_OF_FEED_ROUNDS rounds. Set an int to enforce a cap.
SCRAPE_POSTS_MAX_ROUNDS  = None
POSTS_END_OF_FEED_ROUNDS = 3

# Two tabs inside LinkedIn — toggle independently. Default: posts only.
LINKEDIN_SCRAPE_POSTS = True
LINKEDIN_SCRAPE_JOBS  = False
