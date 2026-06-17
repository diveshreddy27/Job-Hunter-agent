"""
Capture full DOM of one LinkedIn search result page and dump:
  1. Full page HTML → data/sdui_page.html
  2. For each card found: all attributes + inner structure → data/sdui_cards.txt
  3. For card[0]: complete outerHTML → data/sdui_card0.html

Run: python scripts/adhoc/dump_sdui_dom.py
"""
import json, pathlib, sys, time, re
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from playwright.sync_api import sync_playwright
import settings as cfg

SEARCH_URL = (
    "https://www.linkedin.com/search/results/content/"
    "?keywords=%22Data%20Engineer%22%20and%20%22hiring%22%20and%20%22aws%22"
    "&datePosted=past-24h&sortBy=RELEVANCE"
)
COOKIES_PATH = pathlib.Path("config/linkedin_cookies.json")
OUT_DIR = pathlib.Path("data")
OUT_DIR.mkdir(exist_ok=True)

CARD_SELS = [
    'div[data-view-name="search-entity-result-universal-template"]',
    'div[role="listitem"][componentkey*="FeedType_FLAGSHIP_SEARCH"]',
    'div[data-view-name="search-content-type"]',
    "div.occludable-update",
    "li.reusable-search__result-container",
]

def load_cookies(ctx):
    if not COOKIES_PATH.exists():
        print("[!] No cookie file found")
        return False
    raw = json.loads(COOKIES_PATH.read_text())
    SAME_SITE = {"no_restriction": "None", "lax": "Lax", "strict": "Strict", "unspecified": "None"}
    if raw and "expirationDate" in raw[0]:
        out = []
        for c in raw:
            pw = {"name": c["name"], "value": c["value"], "domain": c["domain"],
                  "path": c.get("path", "/"), "httpOnly": c.get("httpOnly", False),
                  "secure": c.get("secure", False)}
            exp = c.get("expirationDate") or c.get("expires")
            if exp: pw["expires"] = int(exp)
            ss = c.get("sameSite")
            pw["sameSite"] = SAME_SITE.get(str(ss).lower(), "None") if ss else "None"
            out.append(pw)
        ctx.add_cookies(out)
    else:
        ctx.add_cookies(raw)
    print(f"[+] Loaded {len(raw)} cookies")
    return True

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, slow_mo=200)
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    )
    ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
    page = ctx.new_page()

    load_cookies(ctx)

    print(f"[+] Navigating to search URL...")
    page.goto(SEARCH_URL, timeout=60000, wait_until="domcontentloaded")
    time.sleep(5)
    print(f"[+] URL: {page.url}")

    # Scroll a bit to trigger content load
    vw = page.viewport_size
    page.mouse.move(vw["width"]//2, vw["height"]//2)
    for _ in range(3):
        page.mouse.wheel(0, 1200)
        time.sleep(1.5)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(4)

    # Save full page HTML
    html = page.content()
    (OUT_DIR / "sdui_page.html").write_text(html, encoding="utf-8")
    print(f"[+] Saved full page HTML ({len(html)//1024}KB) → data/sdui_page.html")

    # Find cards
    cards = []
    used_sel = None
    for sel in CARD_SELS:
        cards = page.query_selector_all(sel)
        if cards:
            used_sel = sel
            break
    print(f"[+] Found {len(cards)} cards using: {used_sel}")

    if not cards:
        print("[!] No cards found — check data/sdui_page.html")
        browser.close()
        sys.exit(1)

    # Save card[0] full outerHTML
    card0_html = page.evaluate("el => el.outerHTML", cards[0])
    (OUT_DIR / "sdui_card0.html").write_text(card0_html, encoding="utf-8")
    print(f"[+] Saved card[0] HTML ({len(card0_html)//1024}KB) → data/sdui_card0.html")

    # Deep analysis of each card
    report_lines = []

    for ci, card in enumerate(cards[:5]):  # analyse first 5 cards
        report_lines.append(f"\n{'='*80}")
        report_lines.append(f"CARD {ci}")
        report_lines.append(f"{'='*80}")

        # Card-level attributes
        card_attrs = page.evaluate("""el => {
            const attrs = {};
            for (const a of el.attributes) attrs[a.name] = a.value;
            return attrs;
        }""", card)
        report_lines.append(f"\n[card attributes]")
        for k, v in card_attrs.items():
            report_lines.append(f"  {k} = {v[:120]}")

        # Dump ALL elements with their tag, attributes, and text
        elements = page.evaluate("""el => {
            const result = [];
            function walk(node, depth) {
                if (depth > 8) return;
                if (node.nodeType !== 1) return;
                const attrs = {};
                for (const a of node.attributes) attrs[a.name] = a.value;
                const ownText = Array.from(node.childNodes)
                    .filter(n => n.nodeType === 3)
                    .map(n => n.textContent.trim())
                    .join(' ').trim();
                result.push({
                    depth, tag: node.tagName.toLowerCase(),
                    attrs, text: ownText.substring(0, 150)
                });
                for (const child of node.children) walk(child, depth + 1);
            }
            walk(el, 0);
            return result;
        }""", card)

        report_lines.append(f"\n[DOM tree — {len(elements)} elements]")
        for el in elements:
            indent = "  " * el["depth"]
            attr_str = " ".join(f'{k}="{v[:60]}"' for k, v in el["attrs"].items()
                                if k in ("data-view-name", "aria-label", "data-anonymize",
                                         "componentkey", "role", "class", "href",
                                         "datetime", "data-testid", "dir", "id"))
            text_str = f'  → "{el["text"]}"' if el["text"] else ""
            report_lines.append(f"{indent}<{el['tag']} {attr_str}>{text_str}")

        # Targeted probes: fields we care about
        report_lines.append(f"\n[targeted field probes]")

        probes = {
            "time[datetime]":                        lambda c: _probe_attr(page, c, "time[datetime]", "datetime"),
            "[aria-label*='ago']":                   lambda c: _probe_attr(page, c, "[aria-label*=' ago']", "aria-label"),
            "[aria-label*='hour']":                  lambda c: _probe_attr(page, c, "[aria-label*='hour']", "aria-label"),
            "[aria-label*='day']":                   lambda c: _probe_attr(page, c, "[aria-label*=' day']", "aria-label"),
            "feed-mini-update-actor-description":    lambda c: _probe_text(page, c, '[data-view-name="feed-mini-update-actor-description"]'),
            "feed-full-update-body":                 lambda c: _probe_text(page, c, '[data-view-name="feed-full-update-body"]'),
            "expandable-text-button":                lambda c: _probe_text(page, c, '[data-testid="expandable-text-button"]'),
            "data-anonymize=person-name":            lambda c: _probe_text(page, c, '[data-anonymize="person-name"]'),
            "span dir=ltr":                          lambda c: _probe_text(page, c, 'span[dir="ltr"]'),
        }
        for name, fn in probes.items():
            try:
                result = fn(card)
                report_lines.append(f"  {name:<45} → {result}")
            except Exception as e:
                report_lines.append(f"  {name:<45} → ERROR: {e}")

        # Dump ALL spans with text (to find time-like patterns)
        all_spans = page.evaluate("""el => {
            return Array.from(el.querySelectorAll('span, time, a')).map(s => ({
                tag: s.tagName.toLowerCase(),
                text: s.innerText?.trim().substring(0, 80) || '',
                ariaLabel: s.getAttribute('aria-label') || '',
                datetime: s.getAttribute('datetime') || '',
                dataView: s.getAttribute('data-view-name') || '',
                dataAnon: s.getAttribute('data-anonymize') || '',
            })).filter(s => s.text || s.ariaLabel || s.datetime);
        }""", card)

        report_lines.append(f"\n[all span/time/a text — {len(all_spans)} elements]")
        for s in all_spans:
            parts = []
            if s["text"]:       parts.append(f'text="{s["text"]}"')
            if s["ariaLabel"]:  parts.append(f'aria-label="{s["ariaLabel"]}"')
            if s["datetime"]:   parts.append(f'datetime="{s["datetime"]}"')
            if s["dataView"]:   parts.append(f'data-view-name="{s["dataView"]}"')
            if s["dataAnon"]:   parts.append(f'data-anonymize="{s["dataAnon"]}"')
            report_lines.append(f"  <{s['tag']}> {' | '.join(parts)}")

    report = "\n".join(report_lines)
    (OUT_DIR / "sdui_cards.txt").write_text(report, encoding="utf-8")
    print(f"[+] Saved card analysis → data/sdui_cards.txt")

    browser.close()
    print("\n[+] Done. Check data/sdui_cards.txt for DOM analysis.")


def _probe_attr(page, card, sel, attr):
    el = card.query_selector(sel)
    if not el: return "NOT FOUND"
    return el.get_attribute(attr) or "(attr empty)"

def _probe_text(page, card, sel):
    el = card.query_selector(sel)
    if not el: return "NOT FOUND"
    return (el.inner_text() or "").strip()[:100] or "(text empty)"
