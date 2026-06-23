"""
daily_briefing.py

Standalone daily briefing — no rss_engine dependency.
Fetches text only, no images, no Firebase.
"""

import os
import re
import datetime
import time
import random
import warnings
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from ebooklib import epub
import trafilatura

warnings.filterwarnings('ignore', message='Unverified HTTPS request')

# =====================================================================
# CONFIGURATION (DYNAMIC PATHS)
# =====================================================================

HOME_DIR = os.path.expanduser("~")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

NYT_LOCAL_FILE = os.path.join(HOME_DIR, "Downloads", "nyt_fully_loaded.html")

SUPERNOTE_SYNC_FOLDER = os.path.join(
    HOME_DIR,
    "Library", "CloudStorage",
    "GoogleDrive-slottaj@gmail.com", "My Drive", "Supernote", "Document", "Drive", "NYT"
)

SKIP_SECTION_NAMES = {'TODAYS FRONT PAGES', 'Site Index', 'Site Information Navigation'}

# =====================================================================
# HTTP SESSION — uses curl_cffi for TLS impersonation if available
# =====================================================================

try:
    from curl_cffi import requests as cffi_requests
    _SESSION = cffi_requests.Session(impersonate="chrome120")
except ImportError:
    import requests
    _SESSION = requests.Session()
    _SESSION.verify = False

_CACHED_COOKIES = None

def get_cookies():
    global _CACHED_COOKIES
    if _CACHED_COOKIES is not None:
        return _CACHED_COOKIES
    try:
        import browser_cookie3
        for browser_fn in [browser_cookie3.chrome, browser_cookie3.firefox, browser_cookie3.safari]:
            try:
                jar = browser_fn(domain_name='.nytimes.com')
                cookies = {c.name: c.value for c in jar}
                if cookies:
                    _CACHED_COOKIES = cookies
                    return _CACHED_COOKIES
            except Exception:
                continue
    except ImportError:
        pass
    _CACHED_COOKIES = {}
    return _CACHED_COOKIES

# =====================================================================
# STEP 1: PARSE LOCAL HTML → ORDERED ARTICLE LIST WITH SECTIONS
# =====================================================================

def load_todays_paper(local_path: str) -> list[dict]:
    if not os.path.exists(local_path):
        script_path = os.path.join(BASE_DIR, "get_nyt.scpt")
        raise FileNotFoundError(
            f"Local file not found: {local_path}\n"
            f"Run your AppleScript first: osascript '{script_path}'"
        )

    print(f"📄 Reading local file: {local_path}")
    with open(local_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    date_pattern = re.compile(r"/\d{4}/\d{2}/\d{2}/")
    current_section = "Uncategorized"
    raw_items = []

    for tag in soup.find_all(True):
        if tag.name == "h2":
            classes = tag.get("class", [])
            text = tag.get_text(strip=True)
            if "e1b0gigc0" not in classes and text and text not in SKIP_SECTION_NAMES:
                current_section = text
                continue

        if tag.name == "a":
            href = tag.get("href", "")
            if not href or not date_pattern.search(href):
                continue
            if "#comments" in href or "interactive" in href:
                continue
            if not href.startswith("http"):
                href = urljoin("https://www.nytimes.com", href)

            title = ""
            for child in tag.children:
                if isinstance(child, str) and child.strip():
                    title = child.strip()
                    break
                if hasattr(child, "get_text"):
                    t = child.get_text(strip=True)
                    if t:
                        title = t
                        break

            if title and len(title) > 3:
                raw_items.append({
                    "section": current_section,
                    "title":   title,
                    "url":     href,
                })

    # Deduplicate: keep LAST occurrence (drops Highlights dupes)
    seen_urls = {}
    for item in raw_items:
        seen_urls[item["url"]] = item

    deduped = []
    kept_urls = set()
    for item in reversed(raw_items):
        if item["url"] not in kept_urls:
            deduped.append(item)
            kept_urls.add(item["url"])
    deduped.reverse()

    print(f"   Found {len(raw_items)} links → {len(deduped)} after deduplication.")
    return deduped

# =====================================================================
# STEP 2: FETCH FULL CONTENT (text only, no images, no Firebase)
# =====================================================================

def fetch_full_article(url: str) -> str:
    """Bulletproof fetch: Routing through your personal Google Apps Script proxy."""
    import requests
    import urllib.parse
    
    # Your exact proxy URL from the PWA
    PROXY_URL = "https://script.google.com/macros/s/AKfycbw2U9jgVSwbRSHicSuxYeGDs1z_xeGh4bQvreP4Vsim9uFGVMFSZi-2_jAY1XI7XThc/exec"
    
    fetch_url = url
    if "?" not in fetch_url:
        fetch_url = fetch_url + "?partner=rss&emc=rss"
        
    proxy_request_url = f"{PROXY_URL}?url={urllib.parse.quote(fetch_url)}"

    try:
        # Simple GET request to your Google Proxy (gave it 25s timeout to allow for the double-hop)
        res = requests.get(proxy_request_url, timeout=25) 
        
        if res.status_code != 200:
            return f"<i>Proxy error (HTTP {res.status_code}).</i>"
            
        html_content = res.text
        if html_content.startswith("ERROR:"):
            return f"<i>Proxy returned error: {html_content}</i>"

        # Extract text from the clean HTML provided by Google
        extracted = trafilatura.extract(
            html_content, url=url,
            include_comments=False,
            include_images=False,
            output_format='html'
        )
        if extracted:
            extracted = extracted.replace('<p>Supported by</p>', '').replace('<span>Supported by</span>', '')
            return extracted

        return f"<i>HTTP OK from proxy, but could not extract text.</i>"
    except Exception as e:
        return f"<i>Error fetching article via proxy: {e}</i>"

def fetch_articles(items: list[dict]) -> list[dict]:
    results = []
    failed  = 0

    for item in items:
        print(f"  [{item['section'][:12]:12}] {item['title'][:55]}...")
        time.sleep(random.uniform(6.0, 11.5))

        html = fetch_full_article(item["url"])

        if html.startswith("<i>"):
            print(f"     ✗ {html[:80]}")
            failed += 1
            continue

        results.append({
            "section": item["section"],
            "title":   item["title"],
            "content": html,
        })

    print(f"\n   Fetched {len(results)} articles, {failed} failed.")
    return results

# =====================================================================
# STEP 3: BIND EPUB WITH SECTION NAVIGATION
# =====================================================================

def create_epub(articles: list[dict], output_path: str) -> str:
    book = epub.EpubBook()
    book.set_identifier(f"daily_briefing_{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}")
    book.set_title(f"Daily Briefing — {datetime.datetime.now().strftime('%b %d, %Y')}")
    book.set_language("en")
    book.add_author("RSS Triage Automation")

    all_chapters   = []
    toc_sections   = []

    article_idx  = 0
    section_idx  = 0

    from itertools import groupby
    grouped = []
    for section, group in groupby(articles, key=lambda a: a["section"]):
        grouped.append((section, list(group)))

    for section_name, section_articles in grouped:
        section_chapter = epub.EpubHtml(
            title     = section_name,
            file_name = f"section_{section_idx}.xhtml",
            lang      = "en",
        )
        section_chapter.content = (
            f"<html><body>"
            f"<h1 style='font-family:serif; margin-top:40%; text-align:center;'>"
            f"{section_name}</h1>"
            f"</body></html>"
        )
        book.add_item(section_chapter)
        all_chapters.append(section_chapter)
        section_idx += 1

        article_chapters_in_section = []

        for article in section_articles:
            title        = article["title"]
            html_content = article["content"]
            soup         = BeautifulSoup(html_content, "html.parser")

            # Strip any remaining image tags
            for img in soup.find_all("img"):
                img.decompose()

            chapter = epub.EpubHtml(
                title     = title,
                file_name = f"article_{article_idx}.xhtml",
                lang      = "en",
            )
            chapter.content = str(soup)
            book.add_item(chapter)
            all_chapters.append(chapter)
            article_chapters_in_section.append(chapter)
            article_idx += 1

        toc_sections.append((
            epub.Section(section_name, href=section_chapter.file_name),
            article_chapters_in_section,
        ))

    book.toc   = tuple(toc_sections)
    book.spine = ["nav"] + all_chapters
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())

    epub.write_epub(output_path, book, {})
    return output_path

# =====================================================================
# MAIN
# =====================================================================

def run():
    print(f"\n[{datetime.datetime.now().strftime('%H:%M:%S')}] Daily Briefing starting...\n")

    items = load_todays_paper(NYT_LOCAL_FILE)
    if not items:
        print("No articles found. Did the AppleScript run?")
        return

    print(f"\nFetching full content for {len(items)} articles...")
    articles = fetch_articles(items)
    if not articles:
        print("All fetches failed — try running on a hotspot.")
        return

    today_str   = datetime.datetime.now().strftime("%Y-%m-%d")
    output_path = os.path.join(SUPERNOTE_SYNC_FOLDER, f"Daily_Briefing_{today_str}.epub")
    os.makedirs(SUPERNOTE_SYNC_FOLDER, exist_ok=True)

    print(f"Binding {len(articles)} articles into EPUB...")
    create_epub(articles, output_path)
    print(f"\n✅ Done!  →  {output_path}\n")

    # Wake up Google Drive to force sync
    os.system("osascript -e 'tell application \"Google Drive\" to activate'")


if __name__ == "__main__":
    run()
