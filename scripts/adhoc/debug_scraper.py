"""
Quick diagnostic: open LinkedIn search in visible browser, check what's on the page.
Run:  python scripts/adhoc/debug_scraper.py
"""
import json, pathlib, sys, time
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from playwright.sync_api import sync_playwright
import settings as cfg

SEARCH_URL = (
    "https://www.linkedin.com/search/results/content/"
    "?keywords=%22Data%20Engineer%22%20and%20%22hiring%22%20and%20%22aws%22"
    "&datePosted=past-24h&sortBy=RELEVANCE"
)

CARD_SELS = [
    "div.occludable-update",
    "li.reusable-search__result-container",
    "div[data-chameleon-result-urn]",
    "div.search-results__list li",
]

COOKIES_PATH = pathlib.Path("config/linkedin_cookies.json")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, slow_mo=300)
    ctx     = browser.new_context(viewport={"width": 1280, "height": 900})
    page    = ctx.new_page()

    # Load saved cookies
    if COOKIES_PATH.exists():
        cookies = json.loads(COOKIES_PATH.read_text())
        ctx.add_cookies(cookies)
        print(f"[diag] Loaded {len(cookies)} cookies")
    else:
        print("[diag] No saved cookies — will need to log in manually")

    print(f"[diag] Navigating to: {SEARCH_URL}")
    page.goto(SEARCH_URL, timeout=30000, wait_until="domcontentloaded")
    time.sleep(4)

    print(f"[diag] Current URL : {page.url}")
    print(f"[diag] Page title  : {page.title()}")

    # Check each card selector
    for sel in CARD_SELS:
        count = len(page.query_selector_all(sel))
        print(f"[diag] Selector '{sel}' → {count} elements")

    # Scroll once and recheck
    print("[diag] Scrolling...")
    page.evaluate("window.scrollBy(0, 2000)")
    time.sleep(3)
    page.evaluate("window.scrollBy(0, 2000)")
    time.sleep(3)

    print("[diag] After scroll:")
    for sel in CARD_SELS:
        count = len(page.query_selector_all(sel))
        print(f"[diag] Selector '{sel}' → {count} elements")

    # Wait longer for dynamic content
    print("[diag] Waiting 8s for dynamic content...")
    time.sleep(8)

    print("[diag] After 8s wait:")
    for sel in CARD_SELS:
        count = len(page.query_selector_all(sel))
        print(f"[diag] Selector '{sel}' → {count} elements")

    # Look for any element with a urn:li: attribute
    urn_els = page.evaluate("""
        () => {
            const all = document.querySelectorAll('*');
            const found = [];
            for (const el of all) {
                for (const attr of el.attributes) {
                    if (attr.value.includes('urn:li:')) {
                        found.push({
                            tag: el.tagName,
                            attr: attr.name,
                            val: attr.value.substring(0, 80),
                            cls: el.className.substring(0, 60)
                        });
                        if (found.length >= 10) break;
                    }
                }
                if (found.length >= 10) break;
            }
            return found;
        }
    """)
    print(f"\n[diag] Elements with urn:li: attributes ({len(urn_els)} found):")
    for e in urn_els:
        print(f"  <{e['tag']} {e['attr']}=\"{e['val']}\" class=\"{e['cls']}\">")

    # Dump more HTML — look for the main content area
    main_html = page.evaluate("""
        () => {
            const main = document.querySelector('main') ||
                         document.querySelector('[role="main"]') ||
                         document.querySelector('.search-results-container') ||
                         document.body;
            return main.innerHTML.substring(0, 6000);
        }
    """)
    print(f"\n[diag] --- main content innerHTML (first 6000 chars) ---\n{main_html}\n---")

    # Save screenshot
    ss_path = pathlib.Path("data/debug_screenshot.png")
    ss_path.parent.mkdir(exist_ok=True)
    page.screenshot(path=str(ss_path), full_page=False)
    print(f"[diag] Screenshot saved to {ss_path}")

    browser.close()
    print("[diag] Done.")
