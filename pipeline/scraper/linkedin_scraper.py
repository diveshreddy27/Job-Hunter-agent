"""
LinkedIn Scraper — standalone, JSONL output, no DB.
Scrapes BOTH:
  1. Posts tab  — recruiter posts announcing hiring (extracts emails)
  2. Jobs tab   — structured job listings

Search pattern:
  Query : "Data Engineer" and "hiring" and "aws"   (configurable in settings.py)
  Filter: Posts | Top Match | Past 24 hours        (enforced via URL + UI click)

Each post that passes all filters is appended as one JSON object to
`output/linkedin_posts.jsonl`. Dedup is in-memory only (a seen-set within the
run). Re-running the script re-appends — downstream consumers should dedup on
`source_url` if needed.
"""

import re
import json
import time
import random
import logging
import pathlib
from typing import Optional
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

import settings as cfg
from pipeline.scraper.location_utils import (
    extract_location, extract_experience, extract_salary,
    extract_recruiter_email, detect_work_mode, detect_company_type,
    detect_apply_via, is_contract_role, is_india_job,
    experience_in_range, parse_posted_hours,
)
from db import database as db

log = logging.getLogger("scraper.linkedin")

COOKIE_FILE = pathlib.Path(__file__).parent.parent.parent / "config" / "linkedin_cookies.json"


def _is_wsl() -> bool:
    try:
        return "microsoft" in pathlib.Path("/proc/version").read_text().lower()
    except Exception:
        return False


_WSL_ARGS = [
    "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--disable-setuid-sandbox",
]
_STEALTH_ARGS = ["--disable-blink-features=AutomationControlled"]


def _launch_browser(p, headless: bool = None):
    if headless is None:
        headless = cfg.SCRAPE_HEADLESS
    args = _STEALTH_ARGS + (_WSL_ARGS if _is_wsl() else [])
    return p.chromium.launch(
        headless=headless,
        slow_mo=80 if not headless else 0,
        args=args,
    )


def _new_context(browser):
    ctx = browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 800},
    )
    return ctx


def _save_cookies(context) -> None:
    try:
        COOKIE_FILE.parent.mkdir(exist_ok=True)
        COOKIE_FILE.write_text(json.dumps(context.cookies()))
        log.info("[linkedin] Session cookies saved to %s", COOKIE_FILE)
    except Exception as e:
        log.warning("[linkedin] Could not save cookies: %s", e)


def _convert_cookies(raw: list) -> list:
    """Map Chrome-extension cookie format (sameSite=no_restriction) to Playwright format."""
    SAME_SITE_MAP = {"no_restriction": "None", "lax": "Lax", "strict": "Strict", "unspecified": "None"}
    out = []
    for c in raw:
        pw = {
            "name": c.get("name", ""), "value": c.get("value", ""),
            "domain": c.get("domain", ""), "path": c.get("path", "/"),
            "httpOnly": c.get("httpOnly", False), "secure": c.get("secure", False),
        }
        exp = c.get("expirationDate") or c.get("expires")
        if exp is not None:
            pw["expires"] = int(exp)
        ss = c.get("sameSite")
        pw["sameSite"] = SAME_SITE_MAP.get(str(ss).lower(), "None") if ss else "None"
        out.append(pw)
    return out


def _load_cookies(context) -> bool:
    if not COOKIE_FILE.exists():
        log.info("[linkedin] No cookie file at %s — fresh login required", COOKIE_FILE)
        return False
    try:
        raw = json.loads(COOKIE_FILE.read_text())
    except Exception as e:
        log.warning("[linkedin] Cookie file unreadable (%s) — fresh login", e)
        return False
    try:
        # Detect Chrome-extension format (has expirationDate key)
        if raw and "expirationDate" in raw[0]:
            context.add_cookies(_convert_cookies(raw))
        else:
            context.add_cookies(raw)
        log.info("[linkedin] Loaded saved session cookies (%d)", len(raw))
        return True
    except Exception as e:
        log.warning("[linkedin] add_cookies failed (%s) — fresh login", e)
        return False


def _is_logged_in(page) -> bool:
    """
    True when the current page is an authenticated LinkedIn page.

    Substring check on the full URL is unreliable because LinkedIn's login
    redirect carries the target path in `?session_redirect=...feed/` — so
    naive `"feed" in url` returns True on the login page itself. Inspect
    only the path component, and reject known unauthenticated paths first.
    """
    from urllib.parse import urlparse
    path = urlparse(page.url).path.lower()
    if any(p in path for p in
           ("/login", "/uas/", "/authwall", "/checkpoint", "/signup")):
        return False
    return any(path.startswith(p) for p in
               ("/feed", "/mynetwork", "/jobs", "/home", "/in/", "/search"))

# Maps the `--days` arg → LinkedIn's own filter buckets. LinkedIn only exposes
# three Date Posted buckets in the UI; anything else gets rounded to one of
# these. Values per bucket:
#   posts_param      — `datePosted=` query param for content search
#   jobs_seconds     — `f_TPR=r<seconds>` on Jobs search (LinkedIn uses seconds)
#   ui_label         — the exact text on LinkedIn's filter button (for clicks)
#   ui_aria_keyword  — substring match for aria-label fallback
_DATE_FILTERS = {
    1:  {"posts_param": "past-24h",   "jobs_seconds": 86400,
         "ui_label": "Past 24 hours",  "ui_aria_keyword": "24 hour"},
    7:  {"posts_param": "past-week",  "jobs_seconds": 604800,
         "ui_label": "Past week",      "ui_aria_keyword": "past week"},
    30: {"posts_param": "past-month", "jobs_seconds": 2592000,
         "ui_label": "Past month",     "ui_aria_keyword": "past month"},
}
DEFAULT_DAYS = 1


def _resolve_days(days: Optional[int]) -> int:
    """Round any integer to the closest LinkedIn-supported bucket (1/7/30)."""
    if days is None:
        return DEFAULT_DAYS
    if days <= 1:
        return 1
    if days <= 7:
        return 7
    return 30


def _build_posts_url(query: str, days: int) -> str:
    f = _DATE_FILTERS[days]
    q = query.replace(" ", "%20").replace('"', "%22")
    return (f"https://www.linkedin.com/search/results/content/"
            f"?keywords={q}&datePosted={f['posts_param']}&sortBy=RELEVANCE")


def _build_jobs_url(query: str, days: int) -> str:
    f = _DATE_FILTERS[days]
    q = query.replace(" ", "%20").replace('"', "%22")
    return (f"https://www.linkedin.com/jobs/search/"
            f"?keywords={q}&f_TPR=r{f['jobs_seconds']}&sortBy=DD")


def _human_delay(lo=1.5, hi=3.5):
    time.sleep(random.uniform(lo, hi))


def _scroll_page(page, times=4):
    for _ in range(times):
        page.keyboard.press("End")
        _human_delay(0.8, 1.8)


# ── Post-card helpers (verified against real DOM in debug_linkedin_posts) ─────

def _first_line(s: str) -> str:
    """LinkedIn renders text twice: visible span + visually-hidden sr-only span.
    inner_text() concatenates them with \\n. Take only the first non-empty line."""
    if not s:
        return ""
    for line in s.splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _clean_headline(s: str) -> str:
    """Strip LinkedIn placeholder headlines like '--', '•', '...'.

    When a user has no headline set, LinkedIn renders a literal `--` (or a
    single bullet character) in the actor__description element. Treat any
    string of just punctuation/whitespace as empty.
    """
    if not s:
        return ""
    s = s.strip()
    if re.fullmatch(r"[\-\.•·…\s]+", s):
        return ""
    return s


# A post counts as a hiring post when its first ~400 chars contain a recognisable
# CTA. This filters out articles ("What Is the Difference Between Data
# Engineering...") that happen to mention "hiring" or "data engineer" further
# down the body.
_HIRING_CTA_RE = re.compile(
    r"\bhiring\s*(?:alert|now|[:\-–|]|!)"          # "Hiring:", "Hiring Alert"
    r"|\bwe['’]?(?:re|\s+are)\s+hiring\b"           # "We're hiring", "We are hiring"
    r"|\bjob\s+(?:alert|opening|opportunity|vacancy)"
    # "Looking for a talented X" / "Looking for an experienced Y" — require an
    # adjective. Bare `looking for a job` (job-seeker post) is intentionally
    # NOT matched.
    r"|\blooking\s+for\s+(?:an?\s+)?"
    r"(?:talented|skilled|passionate|experienced|qualified|motivated|seasoned|"
    r"dynamic|enthusiastic|senior|junior|lead|staff|principal)\b"
    r"|\bopen\s+(?:position|role)"
    r"|\bjoin\s+our\s+team"
    r"|\bapply\s+now\b"
    r"|\b(?:dm|send)\s+(?:your\s+)?(?:cv|resume)"
    r"|\bposition[s]?\s+available"
    r"|\bnow\s+hiring\b"
    r"|\b(?:urgent|immediate)\s+(?:hiring|opening)",
    re.IGNORECASE,
)


def _is_hiring_post(content: str) -> bool:
    """Heuristic: does the first chunk of the post read like a hiring CTA?

    400 chars is roughly the LinkedIn collapsed preview. Real hiring posts
    state their intent up front; articles that happen to mention `hiring`
    further down get dropped.
    """
    if not content:
        return False
    return bool(_HIRING_CTA_RE.search(content[:400]))


def _click_see_more(card) -> None:
    """Expand a truncated post so content_el returns the full body.
    The toggle has class `feed-shared-inline-show-more-text__see-more-less-toggle`."""
    try:
        btn = card.query_selector(
            ".feed-shared-inline-show-more-text__see-more-less-toggle, "
            "button.see-more"
        )
        if btn and btn.is_visible():
            btn.click()
            _human_delay(0.3, 0.6)
    except Exception:
        pass


def _clean_post_text(s: str) -> str:
    """Strip LinkedIn UI artifacts that bleed into inner_text():
       - `\\nhashtag\\n#Foo` → ` #Foo`
       - trailing `…more` / `see more` (left over when see-more click failed)
       - collapse 3+ blank lines"""
    if not s:
        return ""
    s = re.sub(r"\n\s*hashtag\s*\n", " ", s)
    s = re.sub(r"\s*…\s*more\s*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s*\bsee more\s*$", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _extract_activity_urn(card) -> str:
    """Find `urn:li:activity:NNN` on the card or any descendant.
    Returns empty string if no activity URN is present."""
    try:
        return card.evaluate("""el => {
            const attrs = ['data-urn', 'data-chameleon-result-urn', 'data-id'];
            const nodes = [el, ...el.querySelectorAll(
                '[data-urn], [data-chameleon-result-urn], [data-id]')];
            for (const n of nodes) {
                for (const a of attrs) {
                    const v = n.getAttribute(a);
                    if (v && v.startsWith('urn:li:activity:')) return v;
                }
            }
            return '';
        }""")
    except Exception:
        return ""


def _fill_and_submit(page, email: str, password: str) -> bool:
    """Fill the login form and submit. Returns True if the form was found and submitted."""
    # LinkedIn now uses dynamically-generated IDs (:r0:, :r1:) — use stable attributes instead
    EMAIL_SELS = [
        "input[autocomplete='username']",
        "input[type='email']",
        "#username",
        "input[name='session_key']",
    ]
    PWD_SELS = [
        "input[autocomplete='current-password']",
        "input[type='password']",
        "#password",
        "input[name='session_password']",
    ]
    email_sel = pwd_sel = None
    for sel in EMAIL_SELS:
        try:
            el = page.wait_for_selector(sel, timeout=10000, state="visible")
            if el:
                email_sel = sel; break
        except Exception:
            pass
    if not email_sel:
        return False
    for sel in PWD_SELS:
        el = page.query_selector(sel)
        if el and el.is_visible():
            pwd_sel = sel; break
    if not pwd_sel:
        return False

    for selector in ["button[action-type='ACCEPT']", "button:has-text('Accept')",
                     "button:has-text('Allow')"]:
        try:
            btn = page.query_selector(selector)
            if btn and btn.is_visible():
                btn.click(); _human_delay(0.5, 1.0); break
        except Exception:
            pass

    page.fill(email_sel, email);   _human_delay(0.5, 1.0)
    page.fill(pwd_sel, password);  _human_delay(0.5, 1.0)
    page.click("button[type='submit']")
    return True


def _login(p, email: str, password: str):
    """
    Returns (page, context, browser) on success, or None on failure.

    Strategy:
      1. Load saved cookies → try headless resume (fast path, most runs)
      2. No cookies / expired → try headless fresh login (works if no checkpoint)
      3. Checkpoint detected → relaunch visible browser so user can solve it,
         then wait and save cookies for future runs.
    """
    IS_WSL = _is_wsl()

    # ── Step 1: headless with saved cookies (login always uses headless for speed)
    browser = _launch_browser(p, headless=True)
    ctx     = _new_context(browser)
    page    = ctx.new_page()
    page.add_init_script(
        "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
    )

    if _load_cookies(ctx):
        page.goto("https://www.linkedin.com/feed/", timeout=60000,
                  wait_until="domcontentloaded")
        _human_delay(2.0, 3.0)
        if _is_logged_in(page):
            log.info("[linkedin] Session resumed from saved cookies")
            return page, ctx, browser
        log.info("[linkedin] Saved cookies expired — fresh login needed")
        COOKIE_FILE.unlink(missing_ok=True)

    # ── Step 2: headless fresh login ──────────────────────────────────────────
    page.goto("https://www.linkedin.com/login", timeout=30000,
              wait_until="domcontentloaded")
    _human_delay(2.0, 3.0)
    _fill_and_submit(page, email, password)
    _human_delay(4.0, 6.0)

    if _is_logged_in(page):
        log.info("[linkedin] Headless login successful")
        _save_cookies(ctx)
        return page, ctx, browser

    current_url = page.url
    log.info("[linkedin] Post-login URL: %s", current_url)

    # ── Step 3: checkpoint — open visible browser for manual solve ────────────
    if any(x in current_url for x in
           ["checkpoint", "verification", "add-phone", "security", "challenge"]):
        browser.close()
        log.warning(
            "[linkedin] Security checkpoint detected — opening a visible browser.\n"
            "  Complete the verification in the browser window that opens, then\n"
            "  press ENTER here to continue."
        )
        # On WSL+WSLg, headless=False opens a real window on the Windows desktop
        browser2 = _launch_browser(p, headless=False)
        ctx2     = _new_context(browser2)
        page2    = ctx2.new_page()
        page2.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )
        page2.goto("https://www.linkedin.com/login", timeout=30000,
                   wait_until="domcontentloaded")
        _human_delay(2.0, 3.0)
        _fill_and_submit(page2, email, password)
        _human_delay(3.0, 4.0)

        print("\n  [LinkedIn] A browser window has opened. Complete the verification,")
        print("  then press ENTER here to continue...", flush=True)
        try:
            input()
        except EOFError:
            pass

        _human_delay(2.0, 3.0)
        if _is_logged_in(page2):
            log.info("[linkedin] Login successful after manual verification")
            _save_cookies(ctx2)
            return page2, ctx2, browser2
        else:
            log.error("[linkedin] Still not logged in after manual step — check credentials")
            browser2.close()
            return None

    # ── Unknown failure ───────────────────────────────────────────────────────
    try:
        page.screenshot(path="/tmp/linkedin_login_fail.png")
    except Exception:
        pass
    log.error(
        "[linkedin] Login failed at: %s — screenshot: /tmp/linkedin_login_fail.png",
        current_url,
    )
    browser.close()
    return None


def _scrape_posts(
    page, query: str,
    staging_writer,
    limit: Optional[int] = None,
    days: int = DEFAULT_DAYS,
) -> int:
    """
    Scrape LinkedIn Posts and write raw posts to staging files.

    Pre-filtering is intentionally minimal: only URN presence and non-empty
    content are checked here. All business-logic filters (India, experience,
    contract, email) run in the processor AFTER Gemini normalisation so we
    never lose a post due to a regex mismatch on raw text.

    Args:
      staging_writer: StagingWriter instance — buffers posts and flushes to files.
      limit:          Stop after N posts written to staging (None = end of feed).
      days:           LinkedIn Date Posted window — 1, 7, or 30.

    Returns: total posts written to staging this run (including within-run dedups
    from the seen_urns set).
    """
    from datetime import datetime, timezone
    staged  = 0
    days    = _resolve_days(days)
    url     = _build_posts_url(query, days)

    skipped = {"no_urn": 0, "no_content": 0, "seen_this_run": 0}

    try:
        log.info(f"[linkedin] Scraping posts: {url}")
        page.goto(url, timeout=30000, wait_until="domcontentloaded")
        _human_delay(3.0, 4.0)

        # Handle "Choose an account" redirect (content search requires re-auth)
        if "uas/login" in page.url or "authwall" in page.url:
            log.info("[linkedin] Account picker for content search — selecting scraping account")
            email_prefix = cfg.SCRAPE_LINKEDIN_EMAIL.split("@")[0].lower()
            try:
                btns = page.locator("button.member-profile-block").all()
                clicked = False
                for btn in btns:
                    if email_prefix in btn.inner_text().lower():
                        btn.click(); _human_delay(3.0, 4.0); clicked = True; break
                if not clicked and btns:
                    btns[0].click(); _human_delay(3.0, 4.0)
            except Exception as e:
                log.warning(f"[linkedin] Account click failed: {e}")

        # Password verification step (floe-profile checkpoint)
        if "floe-profile" in page.url or ("checkpoint" in page.url and "login" not in page.url):
            log.info("[linkedin] Password verification — submitting")
            try:
                pwd = page.locator("input[type='password']").first
                pwd.wait_for(state="visible", timeout=5000)
                pwd.fill(cfg.SCRAPE_LINKEDIN_PASSWORD)
                _human_delay(0.5, 1.0)
                page.locator("button[type='submit']").first.click()
                _human_delay(4.0, 6.0)
            except Exception as e:
                log.warning(f"[linkedin] Password fill failed: {e}")

        # Click "Posts" filter if not already selected
        try:
            posts_btn = page.query_selector("button:has-text('Posts')")
            if posts_btn:
                posts_btn.click()
                _human_delay(1.5, 2.5)
        except Exception:
            pass

        # Apply filters via UI — each filter is a 3-step interaction:
        #   1. open dropdown  2. select option (checkbox label)  3. click "Show results"
        # "Show results" (aria='Apply current filter to show results') is what
        # actually closes the panel and reloads the feed with the filter applied.
        date_label   = _DATE_FILTERS[days]["ui_label"]        # e.g. "Past 24 hours"
        date_keyword = _DATE_FILTERS[days]["ui_aria_keyword"] # e.g. "24 hour"

        def _apply_filter(open_sels, opt_sels, filter_name):
            """Open a filter dropdown, select an option, click Show results."""
            try:
                opened = False
                for sel in open_sels:
                    btn = page.query_selector(sel)
                    if btn and btn.is_visible():
                        btn.click()
                        _human_delay(0.8, 1.5)
                        opened = True
                        log.info("[linkedin] Opened '%s' dropdown", filter_name)
                        break
                if not opened:
                    log.warning("[linkedin] Could not open '%s' dropdown — filter skipped", filter_name)
                    return

                selected = False
                for sel in opt_sels:
                    opt = page.query_selector(sel)
                    if opt and opt.is_visible():
                        opt.click()
                        _human_delay(0.8, 1.2)
                        selected = True
                        log.info("[linkedin] Selected option in '%s'", filter_name)
                        break
                if not selected:
                    log.warning("[linkedin] Could not select option in '%s'", filter_name)
                    return

                # Click "Show results" to apply the filter and reload the feed.
                # All 4 filter panels share the same aria-label — query_selector
                # returns the first in DOM order which is often hidden. Walk all
                # matches and click the first one that is actually visible.
                clicked_show = False
                for sel in [
                    "button[aria-label='Apply current filter to show results']",
                    "button:has-text('Show results')",
                ]:
                    for btn in page.query_selector_all(sel):
                        if btn.is_visible():
                            btn.click()
                            _human_delay(2.5, 3.5)
                            log.info("[linkedin] Clicked 'Show results' for '%s'", filter_name)
                            clicked_show = True
                            break
                    if clicked_show:
                        break
                if not clicked_show:
                    log.warning("[linkedin] 'Show results' button not found for '%s'", filter_name)

            except Exception as e:
                log.warning("[linkedin] Filter '%s' failed: %s", filter_name, e)

        # Date posted filter
        _apply_filter(
            open_sels=[
                "button[aria-label*='Date posted']",
                "button[aria-label*='date posted']",
                "button:has-text('Date posted')",
            ],
            opt_sels=[
                f"label:has-text('{date_label}')",
                f"li:has-text('{date_label}') label",
                f"li:has-text('{date_label}') input",
                f"button:has-text('{date_label}')",
            ],
            filter_name="Date posted",
        )

        # Sort by: Top match
        _apply_filter(
            open_sels=[
                "button[aria-label*='Sort by']",
                "button[aria-label*='sort by']",
                "button:has-text('Sort by')",
            ],
            opt_sels=[
                "label:has-text('Top match')",
                "li:has-text('Top match') label",
                "li:has-text('Top match') input",
                "button:has-text('Top match')",
            ],
            filter_name="Sort by",
        )

        # `div.occludable-update` is the canonical card on the content search page
        # (verified via debug script). The other selectors are kept as fallbacks
        # for cases where LinkedIn ships a layout change.
        POST_CARD_SELS = [
            "div.occludable-update",
            "li.reusable-search__result-container",
            "div[data-chameleon-result-urn]",
            "div.search-results__list li",
        ]

        seen_urns: set = set()
        max_scroll_rounds  = getattr(cfg, "SCRAPE_POSTS_MAX_ROUNDS", None)
        end_of_feed_rounds = getattr(cfg, "POSTS_END_OF_FEED_ROUNDS", 3)
        if max_scroll_rounds is None:
            import itertools as _it
            round_iter = _it.count(0)
        else:
            round_iter = range(max_scroll_rounds)
        consecutive_no_new = 0

        for scroll_round in round_iter:
            _scroll_page(page, times=3)
            _human_delay(1.5, 2.5)

            cards = []
            for sel in POST_CARD_SELS:
                cards = page.query_selector_all(sel)
                if cards:
                    break

            round_staged = 0
            for card in cards:
                try:
                    # 1. URN — required for dedup; skip card if absent
                    urn = _extract_activity_urn(card)
                    if not urn:
                        skipped["no_urn"] += 1
                        continue
                    if urn in seen_urns:
                        skipped["seen_this_run"] += 1
                        continue
                    seen_urns.add(urn)

                    activity_id = urn.split(":")[-1]
                    post_url = (
                        f"https://www.linkedin.com/feed/update/"
                        f"urn:li:activity:{activity_id}/"
                    )

                    # 2. Expand truncated content
                    _click_see_more(card)

                    # 3. Author / recruiter DOM fields
                    author_el = card.query_selector(
                        ".update-components-actor__name, .feed-shared-actor__name, "
                        "a[class*='actor'] span[aria-hidden='true'], "
                        "span[class*='actor__name']"
                    )
                    author = _first_line(author_el.inner_text()) if author_el else ""

                    headline_el = card.query_selector(
                        ".update-components-actor__description, "
                        ".feed-shared-actor__description, "
                        "span[class*='actor__description']"
                    )
                    author_headline = _clean_headline(
                        _first_line(headline_el.inner_text()) if headline_el else ""
                    )

                    profile_el = card.query_selector(
                        "a[href*='/in/'].app-aware-link, a[href*='/in/']"
                    )
                    recruiter_li = profile_el.get_attribute("href") if profile_el else ""
                    if recruiter_li and "?" in recruiter_li:
                        recruiter_li = recruiter_li.split("?")[0]

                    # 3b. Post age — LinkedIn shows "X hours/days ago" in the
                    #     actor sub-description. Convert to absolute posted_at so
                    #     we can filter by actual post time, not scrape time.
                    from datetime import timedelta
                    posted_at = None
                    time_el = card.query_selector(
                        "span.update-components-actor__sub-description, "
                        "span[class*='actor__sub-description'], "
                        ".feed-shared-actor__sub-description, "
                        "a[class*='actor__sub-description-link'] span"
                    )
                    if time_el:
                        time_text = time_el.inner_text().strip()
                        hours_ago = parse_posted_hours(time_text)
                        if hours_ago is not None:
                            scrape_now = datetime.now(timezone.utc)
                            posted_at = (scrape_now - timedelta(hours=hours_ago)).isoformat()

                    # 4. Post content — skip only if truly empty
                    content_el = card.query_selector(
                        ".update-components-text, "
                        ".feed-shared-update-v2__description, "
                        ".feed-shared-text, span[class*='break-words']"
                    )
                    raw_text = content_el.inner_text() if content_el else ""
                    content  = _clean_post_text(raw_text)
                    if not content:
                        skipped["no_content"] += 1
                        continue

                    # 5. Write to staging — NO business-logic filters here.
                    #    India / experience / contract / email checks all run
                    #    in the processor AFTER Gemini normalisation.
                    staging_writer.add({
                        "activity_urn":    urn,
                        "post_url":        post_url,
                        "post_content":    content,
                        "post_author":     author,
                        "author_headline": author_headline,
                        "profile_url":     recruiter_li,
                        "days_filter":     days,
                        "scraped_at":      datetime.now(timezone.utc).isoformat(),
                        "posted_at":       posted_at,
                    })
                    staged += 1
                    round_staged += 1
                    log.info("[linkedin] staged  urn=...%s  author=%r", urn[-12:], author)

                    if limit is not None and staged >= limit:
                        log.info("[linkedin] Hit limit=%d — stopping early", limit)
                        return staged

                except Exception as e:
                    log.debug("[linkedin] Card error: %s", e)

            log.info(
                "[linkedin] Round %d: %d cards  staged=%d  "
                "(total_staged=%d  skipped: no_urn=%d no_content=%d seen=%d)",
                scroll_round + 1, len(cards), round_staged,
                staged,
                skipped["no_urn"], skipped["no_content"], skipped["seen_this_run"],
            )

            if round_staged == 0:
                consecutive_no_new += 1
                if consecutive_no_new >= end_of_feed_rounds:
                    log.info(
                        "[linkedin] No new posts in %d consecutive rounds — end of feed",
                        end_of_feed_rounds,
                    )
                    break
            else:
                consecutive_no_new = 0

    except Exception as e:
        log.error("[linkedin] Posts scrape error: %s", e)

    log.info("[linkedin] Posts done — staged=%d  skipped=%s", staged, skipped)
    return staged


_JOB_CARD_SELS = [
    "li[data-occludable-job-id]",
    "li.scaffold-layout__list-item",
    "div.job-card-container",
    "li.jobs-search-results__list-item",
    "div.job-search-card",
    "div[data-job-id]",
]
_JOB_TITLE_SELS = (
    "a.job-card-list__title--link, a[class*='job-card-list__title'], "
    "h3.base-search-card__title, h3.job-search-card__title, "
    "strong.job-card-search__title, a[class*='job-title']"
)
_JOB_COMPANY_SELS = (
    "span.job-card-container__primary-description, "
    "h4.base-search-card__subtitle, h4.job-search-card__company-name, "
    "a.job-card-container__company-name, a[class*='base-search-card__subtitle']"
)
_JOB_LOC_SELS = (
    "li.job-card-container__metadata-item, "
    "span.job-search-card__location, .base-search-card__metadata span"
)
_JOB_LINK_SELS = (
    "a.job-card-list__title--link, a[class*='job-card-list__title'], "
    "a.base-card__full-link, a[href*='/jobs/view']"
)
_JD_SELS = (
    ".jobs-description__content .jobs-description-content__text, "
    ".jobs-description__content, "
    ".show-more-less-html__markup, "
    ".jobs-box__html-content, "
    "#job-details"
)


def _get_cards(page) -> list:
    for sel in _JOB_CARD_SELS:
        try:
            page.wait_for_selector(sel, timeout=5000)
            cards = page.query_selector_all(sel)
            if cards:
                log.info(f"[linkedin] Cards via '{sel}': {len(cards)}")
                return cards
        except Exception:
            pass
    return []


def _expand_jd(page) -> None:
    """Click 'See more' in the JD panel so we get the full description."""
    for see_more in ["button.jobs-description__footer-button",
                     "button[aria-label*='See more']",
                     "button:has-text('Show more')",
                     "button:has-text('See more')"]:
        try:
            btn = page.query_selector(see_more)
            if btn and btn.is_visible():
                btn.click()
                _human_delay(0.5, 1.0)
                break
        except Exception:
            pass


def _extract_criteria(page) -> dict:
    """Extract structured job criteria (seniority, employment type) from the detail panel."""
    data = {}
    try:
        items = page.query_selector_all(".description__job-criteria-item")
        for item in items:
            header_el = item.query_selector(".description__job-criteria-subheader")
            value_el  = item.query_selector(".description__job-criteria-text")
            if header_el and value_el:
                key = header_el.inner_text().strip().lower()
                val = value_el.inner_text().strip()
                data[key] = val
    except Exception:
        pass
    return data


def _scrape_jobs(page, query: str, days: int = DEFAULT_DAYS) -> list:
    """Scrape LinkedIn Jobs tab across multiple pages.

    `days` is the LinkedIn Date Posted window — 1, 7, or 30.
    """
    results      = []
    days         = _resolve_days(days)
    base_url     = _build_jobs_url(query, days)
    max_pages    = getattr(cfg, "SCRAPE_MAX_PAGES", 3)
    seen_links   = set()

    consecutive_empty = 0
    for page_num in range(max_pages):
        offset  = page_num * 25
        url     = base_url + (f"&start={offset}" if offset else "")

        try:
            log.info(f"[linkedin] Jobs page {page_num + 1}: {url}")
            page.goto(url, timeout=30000, wait_until="domcontentloaded")
            _human_delay(3.0, 4.0)

            # One-click sign-in if redirected to guest view
            if "guest-upsells" in page.content()[:5000]:
                try:
                    btn = page.locator(".guest-upsells button").first
                    btn.wait_for(state="visible", timeout=5000)
                    btn.click()
                    _human_delay(4.0, 5.0)
                except Exception:
                    pass

            # On the first page, reinforce the chosen Date Posted bucket via
            # the UI dropdown. The URL already carries `f_TPR=` but LinkedIn
            # can drop it on redirect.
            if page_num == 0:
                date_label = _DATE_FILTERS[days]["ui_label"]
                try:
                    for open_sel in [
                        "button[aria-label*='Date posted']",
                        "button:has-text('Date posted')",
                    ]:
                        open_btn = page.query_selector(open_sel)
                        if open_btn and open_btn.is_visible():
                            open_btn.click()
                            _human_delay(0.8, 1.5)
                            for opt_sel in [
                                f"label:has-text('{date_label}')",
                                f"span:has-text('{date_label}')",
                                f"li:has-text('{date_label}')",
                            ]:
                                opt = page.query_selector(opt_sel)
                                if opt and opt.is_visible():
                                    opt.click()
                                    _human_delay(1.5, 2.5)
                                    log.info(f"[linkedin] Clicked '{date_label}' date filter (Jobs)")
                                    break
                            break
                except Exception:
                    pass

            _scroll_page(page, times=4)
            cards = _get_cards(page)
            if not cards:
                log.info(f"[linkedin] No cards on page {page_num + 1} — stopping")
                break

            page_results = 0
            for card in cards:
                try:
                    title_el = card.query_selector(_JOB_TITLE_SELS)
                    link_el  = card.query_selector(_JOB_LINK_SELS)

                    # Title: LinkedIn puts an sr-only "with verification" span inside the
                    # title link — take only the first line to strip that noise.
                    raw_title = title_el.inner_text().strip() if title_el else ""
                    title     = raw_title.split("\n")[0].strip()

                    link = link_el.get_attribute("href") if link_el else ""

                    if not title or not link:
                        continue
                    if not link.startswith("http"):
                        link = "https://www.linkedin.com" + link
                    link = link.split("?")[0]

                    if link in seen_links:
                        continue
                    seen_links.add(link)

                    if is_contract_role(title):
                        continue

                    # Click card → load detail panel
                    jd_text  = ""
                    criteria = {}
                    company  = ""
                    loc_raw  = ""
                    try:
                        card.click()
                        _human_delay(2.0, 3.0)  # give panel time to load
                        _expand_jd(page)

                        desc_el = page.query_selector(_JD_SELS)
                        if desc_el:
                            jd_text = desc_el.inner_text().strip()
                        criteria = _extract_criteria(page)

                        # Company — try detail panel selectors (more reliable than card)
                        for csel in [
                            ".jobs-unified-top-card__company-name a",
                            ".jobs-unified-top-card__company-name",
                            ".job-details-jobs-unified-top-card__company-name-link",
                            ".job-details-jobs-unified-top-card__company-name",
                            "a[href*='/company/'].app-aware-link",
                            ".artdeco-entity-lockup__subtitle span",
                        ]:
                            el = page.query_selector(csel)
                            if el:
                                txt = el.inner_text().strip().split("\n")[0].strip()
                                if txt:
                                    company = txt
                                    break

                        # Location — card aria-label is fastest ("Title at Company in City")
                        card_label = card.get_attribute("aria-label") or ""
                        m_loc = re.search(r"\bin\s+([A-Za-z][A-Za-z\s,]+?)(?:\s*\(|\s*\·|\s*$)",
                                          card_label)
                        if m_loc:
                            loc_raw = m_loc.group(1).strip()

                        # JavaScript traversal: walk primary-description container, skip
                        # the company <a> link, skip "· / ago" text nodes
                        if not loc_raw:
                            try:
                                loc_raw = page.evaluate("""() => {
                                    const timeRe = /\\d+\\s+(second|minute|hour|day|week|month)s?\\s+ago/i;
                                    const skip = new Set(['Hybrid','Remote','On-site','Full-time',
                                                          'Part-time','Contract','·','']);
                                    const containers = [
                                        '.jobs-unified-top-card__primary-description-container',
                                        '.job-details-jobs-unified-top-card__primary-description',
                                        '.jobs-unified-top-card__subtitle',
                                    ];
                                    for (const sel of containers) {
                                        const el = document.querySelector(sel);
                                        if (!el) continue;
                                        for (const child of el.querySelectorAll('span,li')) {
                                            const t = child.textContent.trim()
                                                          .replace(/^\\s*·\\s*/,'').trim();
                                            if (t && !skip.has(t) && !timeRe.test(t)
                                                    && child.tagName !== 'A'
                                                    && !child.querySelector('a')) {
                                                return t;
                                            }
                                        }
                                    }
                                    return '';
                                }""")
                            except Exception:
                                pass

                    except Exception as e:
                        log.debug(f"[linkedin] JD click error: {e}")

                    # Fallback: try card-level selectors for company/location
                    if not company:
                        comp_el = card.query_selector(_JOB_COMPANY_SELS)
                        if comp_el:
                            company = comp_el.inner_text().strip().split("\n")[0].strip()
                    if not loc_raw:
                        loc_el = card.query_selector(_JOB_LOC_SELS)
                        if loc_el:
                            loc_raw = loc_el.inner_text().strip().split("\n")[0].strip()

                    # LinkedIn encodes location in company display name: "Accenture in India"
                    if not loc_raw and company and " in " in company:
                        parts = company.rsplit(" in ", 1)
                        company = parts[0].strip()
                        loc_raw = parts[1].strip()
                    elif company and " in " in company:
                        # loc already set but clean company name anyway
                        company = company.rsplit(" in ", 1)[0].strip()

                    full_text = f"{title} {company} {jd_text}"

                    if is_contract_role(full_text):
                        continue
                    if not is_india_job(full_text, loc_raw):
                        continue

                    easy_apply = bool(page.query_selector(
                        "button.jobs-apply-button[aria-label*='Easy Apply'], "
                        ".jobs-apply-button:has-text('Easy Apply')"
                    ))

                    email        = extract_recruiter_email(jd_text)
                    loc_info     = extract_location(loc_raw)
                    exp_min, exp_max = extract_experience(jd_text)
                    sal_min, sal_max = extract_salary(jd_text)
                    work_mode    = detect_work_mode(full_text)
                    company_type = detect_company_type(full_text)
                    apply_via    = "email" if email else ("linkedin_easy" if easy_apply else "website")

                    # Use seniority from criteria panel to refine experience if regex missed it
                    if exp_min is None and "seniority level" in criteria:
                        seniority_exp = {
                            "entry level": (0, 2), "associate": (1, 3),
                            "mid-senior level": (3, 7), "director": (8, 15),
                        }
                        for key, (lo, hi) in seniority_exp.items():
                            if key in criteria["seniority level"].lower():
                                exp_min, exp_max = lo, hi
                                break

                    results.append({
                        "source":         "linkedin_jobs",
                        "source_url":     link,
                        "title":          title,
                        "company":        company,
                        "jd_text":        jd_text or title,
                        "location_raw":   loc_raw,
                        "location_city":  loc_info["city"],
                        "location_state": loc_info["state"],
                        "is_remote":      loc_info["is_remote"] or work_mode == "remote",
                        "work_mode":      work_mode,
                        "company_type":   company_type,
                        "experience_min": exp_min,
                        "experience_max": exp_max,
                        "salary_min":     sal_min,
                        "salary_max":     sal_max,
                        "recruiter_email": email,
                        "apply_via":      apply_via,
                        "apply_url":      link,
                        "role_type":      "fulltime",
                    })
                    page_results += 1
                    _human_delay(0.5, 1.0)

                except Exception as e:
                    log.debug(f"[linkedin] Job card error: {e}")

            log.info(f"[linkedin] Page {page_num + 1}: extracted {page_results} jobs")

            # Stop when LinkedIn returns no new cards (end of results)
            if not cards:
                break
            if page_results == 0:
                consecutive_empty += 1
                if consecutive_empty >= 2:
                    log.info("[linkedin] Two empty pages in a row — end of results")
                    break
            else:
                consecutive_empty = 0

        except Exception as e:
            log.error(f"[linkedin] Jobs page {page_num + 1} error: {e}")
            break

    return results



def scrape_linkedin(
    staging_writer,
    limit: Optional[int] = None,
    days: int = DEFAULT_DAYS,
) -> int:
    """Drive the LinkedIn Posts scraper.

    Writes raw posts to staging files via staging_writer. A separate processor
    thread (started by main.py) picks up the files, normalises with Gemini,
    applies filters, and ingests passing posts into the DB.

    Args:
      staging_writer: StagingWriter instance — caller is responsible for
                      calling .flush() after this returns.
      limit:          stop after N posts staged (None = scrape to end of feed).
      days:           LinkedIn Date Posted window — 1, 7, or 30.

    Returns: total posts written to staging this run.
    """
    days     = _resolve_days(days)
    email    = cfg.SCRAPE_LINKEDIN_EMAIL
    password = cfg.SCRAPE_LINKEDIN_PASSWORD
    query    = cfg.LINKEDIN_SEARCH_QUERY

    if not email or not password:
        log.warning("[linkedin] No scrape credentials set — skipping LinkedIn")
        return 0

    with sync_playwright() as p:
        result = _login(p, email, password)
        if result is None:
            log.error("[linkedin] Login failed")
            return 0

        page, context, browser = result

        if not cfg.SCRAPE_HEADLESS:
            _save_cookies(context)
            browser.close()
            browser2 = _launch_browser(p, headless=False)
            ctx2     = _new_context(browser2)
            page     = ctx2.new_page()
            page.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
            )
            _load_cookies(ctx2)
            page.goto("https://www.linkedin.com/feed/", timeout=60000,
                      wait_until="domcontentloaded")
            _human_delay(2.0, 3.0)
            browser = browser2

        staged = 0
        if getattr(cfg, "LINKEDIN_SCRAPE_POSTS", True):
            staged = _scrape_posts(
                page, query, staging_writer,
                limit=limit, days=days,
            )
            _human_delay(2.0, 4.0)
        else:
            log.info("[linkedin] Posts tab disabled (LINKEDIN_SCRAPE_POSTS=False)")

        if getattr(cfg, "LINKEDIN_SCRAPE_JOBS", False):
            log.warning("[linkedin] LINKEDIN_SCRAPE_JOBS=True ignored — "
                        "Jobs tab not yet wired to staging pipeline")

        browser.close()

    log.info("[linkedin] Done — staged this run: %d", staged)
    return staged
