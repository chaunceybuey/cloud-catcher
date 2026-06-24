import feedparser
import json
import os
from datetime import datetime
from time import mktime

# Import rss_engine to safely access your Firebase bookmarks
try:
    import rss_engine
except ImportError:
    rss_engine = None
    print("Warning: rss_engine not found or dependencies missing. Bookmark protection disabled.")

MASTER_FILE = 'master_articles.json'
FEEDS_FILE = 'feeds.json'
MAX_ARTICLES = 2000
MAGIC_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

def main():
    if os.path.exists(FEEDS_FILE):
        with open(FEEDS_FILE, 'r') as f:
            try: FEEDS = json.load(f)
            except: FEEDS = {}
    else:
        print("No feeds.json found. Exiting.")
        return

    if os.path.exists(MASTER_FILE):
        with open(MASTER_FILE, 'r') as f:
            try: archive = json.load(f)
            except: archive = []
    else:
        archive = []

    # Work from a dict for fast lookup and in-place edits
    existing = {a['id']: a for a in archive}
    new_count = 0

    for category, urls in FEEDS.items():
        for feed_info in urls:
            try:
                parsed = feedparser.parse(feed_info['url'], agent=MAGIC_USER_AGENT)

                for entry in parsed.entries:
                    entry_id = getattr(entry, 'id', None) or getattr(entry, 'link', None)
                    if not entry_id:
                        continue

                    if entry_id not in existing:
                        content = ""
                        if hasattr(entry, 'content'):
                            content = entry.content[0].value
                        elif hasattr(entry, 'summary'):
                            content = entry.summary

                        author = ""
                        if hasattr(entry, 'author'):
                            author = entry.author
                        elif hasattr(entry, 'creator'):
                            author = entry.creator

                        try:
                            dt = datetime.fromtimestamp(mktime(entry.published_parsed))
                            pub_date = dt.isoformat()
                        except:
                            pub_date = datetime.now().isoformat()

                        existing[entry_id] = {
                            'id': entry_id,
                            'feed_name': feed_info['name'],
                            'title': getattr(entry, 'title', ''),
                            'author': author,
                            'link': getattr(entry, 'link', ''),
                            'content': content,
                            'date': pub_date,
                            'category': category,
                        }
                        new_count += 1

                    else:
                        # Sync category if the feed was moved
                        if existing[entry_id].get('category') != category:
                            existing[entry_id]['category'] = category

            except Exception as e:
                print(f"Error fetching {feed_info.get('name', feed_info)}: {e}")

    # ==========================================================
    # BOOKMARK VIP PROTECTION LOGIC
    # ==========================================================
    # 1. Sort the entire list of articles by date
    archive_sorted = sorted(existing.values(), key=lambda x: x.get('date', ''), reverse=True)

    # 2. Ask Firebase for the active VIP list
    starred_ids = set()
    if rss_engine:
        try:
            bookmarks = rss_engine.get_bookmarks()
            if bookmarks:
                starred_ids = set(bookmarks.keys())
                print(f"Protected {len(starred_ids)} starred articles from deletion.")
        except Exception as e:
            print(f"Error fetching bookmarks for protection: {e}")

    # 3. Separate the archive into two piles
    starred_articles = [a for a in archive_sorted if a['id'] in starred_ids]
    unstarred_articles = [a for a in archive_sorted if a['id'] not in starred_ids]

    # 4. Fill the master file with ALL starred articles, then pad the rest with unstarred articles
    spots_left = max(0, MAX_ARTICLES - len(starred_articles))
    final_archive = starred_articles + unstarred_articles[:spots_left]

    # 5. Re-sort the final combined list so the UI displays perfectly chronologically
    final_archive = sorted(final_archive, key=lambda x: x.get('date', ''), reverse=True)
    # ==========================================================

    with open(MASTER_FILE, 'w') as f:
        json.dump(final_archive, f, indent=2)

    print(f"Added {new_count} new articles. Total archive: {len(final_archive)}.")

if __name__ == "__main__":
    main()