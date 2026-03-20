import feedparser
import json
import os
from datetime import datetime
from time import mktime

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

    # Rebuild from dict so both new articles AND category edits are captured.
    # Sort first, THEN cap — so new articles are never silently discarded
    # because they sorted below position MAX_ARTICLES before the cut.
    archive = sorted(existing.values(), key=lambda x: x.get('date', ''), reverse=True)
    archive = list(archive)[:MAX_ARTICLES]

    with open(MASTER_FILE, 'w') as f:
        json.dump(archive, f, indent=2)

    print(f"Added {new_count} new articles. Total archive: {len(archive)}.")

if __name__ == "__main__":
    main()
