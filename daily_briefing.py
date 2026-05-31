"""
daily_briefing.py

Workflow:
  1. osascript /Users/jamesslotta/Documents/get_nyt.scpt
  2. python3 /Users/jamesslotta/Desktop/cloud-catcher/daily_briefing.py
"""

import os
import re
import datetime
import uuid
import time
import random
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from ebooklib import epub

import rss_engine

# =====================================================================
# CONFIGURATION
# =====================================================================

NYT_LOCAL_FILE = "/Users/jamesslotta/Downloads/nyt_fully_loaded.html"

SUPERNOTE_SYNC_FOLDER = (
    "/Users/jamesslotta/Library/CloudStorage/"
    "GoogleDrive-slottaj@gmail.com/My Drive/Supernote/Document/Drive"
)

# UI chrome h2s we never want to treat as section headers
SKIP_SECTION_NAMES = {'TODAYS FRONT PAGES', 'Site Index', 'Site Information Navigation'}

# =====================================================================
# STEP 1: PARSE LOCAL HTML → ORDERED ARTICLE LIST WITH SECTIONS
# =====================================================================

def load_todays_paper(local_path: str) -> list[dict]:
    """
    Returns a list of {section, title, url} dicts in page order.
    - Titles are clean (no byline bleed-through)
    - Duplicates: only the LAST occurrence is kept, so Highlights
      dupes are dropped in favour of the proper section version
    """
    if not os.path.exists(local_path):
        raise FileNotFoundError(
            f"Local file not found: {local_path}\n"
            "Run your AppleScript first: osascript /Users/jamesslotta/Documents/get_nyt.scpt"
        )

    print(f"📄 Reading local file: {local_path}")
    with open(local_path, "r", encoding="utf-8") as f:
        soup = BeautifulSoup(f, "html.parser")

    date_pattern = re.compile(r"/\d{4}/\d{2}/\d{2}/")
    current_section = "Uncategorized"
    raw_items = []

    for tag in soup.find_all(True):
        # Track section headers — real sections never carry the 'e1b0gigc0'
        # class (which marks article-title h2s). Works for any day's sections.
        if tag.name == "h2":
            classes = tag.get("class", [])
            text = tag.get_text(strip=True)
            if "e1b0gigc0" not in classes and text and text not in SKIP_SECTION_NAMES:
                current_section = text
                continue

        # Collect article links
        if tag.name == "a":
            href = tag.get("href", "")
            if not href or not date_pattern.search(href):
                continue
            if "#comments" in href or "interactive" in href:
                continue
            if not href.startswith("http"):
                href = urljoin("https://www.nytimes.com", href)

            # Clean title: only the first direct text/child of the <a>
            # so subtitle text that follows doesn't bleed in
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

    # Deduplicate: keep LAST occurrence of each URL (drops Highlights dupes)
    seen_urls = {}
    for item in raw_items:
        seen_urls[item["url"]] = item          # overwrite → last wins

    # Rebuild in original page order, skipping earlier dupes
    deduped = []
    kept_urls = set()
    for item in reversed(raw_items):           # iterate backwards
        if item["url"] not in kept_urls:
            deduped.append(item)
            kept_urls.add(item["url"])
    deduped.reverse()                          # restore forward order

    print(f"   Found {len(raw_items)} links → {len(deduped)} after deduplication.")
    return deduped

# =====================================================================
# STEP 2: FETCH FULL CONTENT
# =====================================================================

def fetch_articles(items: list[dict]) -> list[dict]:
    results = []
    failed  = 0

    for item in items:
        print(f"  [{item['section'][:12]:12}] {item['title'][:55]}...")
        time.sleep(random.uniform(1.5, 3.5))

        html = rss_engine.fetch_full_article(item["url"])

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



    all_chapters   = []   # flat list for spine
    toc_sections   = []   # nested TOC: [(section_chapter, [article_chapters])]
    current_section_chapter = None
    current_article_chapters = []
    current_section_name = None

    article_idx  = 0
    section_idx  = 0

    def close_section():
        nonlocal current_section_chapter, current_article_chapters, current_section_name
        if current_section_chapter is not None:
            toc_sections.append(
                epub.Section(current_section_name),
            )
            # We'll build proper nested TOC at the end
        current_section_chapter   = None
        current_article_chapters  = []
        current_section_name      = None

    # Group articles by section for TOC
    from itertools import groupby
    grouped = []
    for section, group in groupby(articles, key=lambda a: a["section"]):
        grouped.append((section, list(group)))

    for section_name, section_articles in grouped:
        # Section divider page
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

            # Strip images — Supernote doesn't render them anyway
            for img in soup.find_all("img"):
                img.decompose()

            chapter         = epub.EpubHtml(
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

    # Nested TOC: sections expand to show articles
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


if __name__ == "__main__":
    run()
