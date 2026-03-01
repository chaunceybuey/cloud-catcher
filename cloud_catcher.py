import feedparser
import json
import os
from datetime import datetime
from time import mktime

MASTER_FILE = 'master_articles.json'
FEEDS_FILE = 'feeds.json'

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
    else: archive = []

    existing_ids = {article['id'] for article in archive}
    new_articles = []

    for category, urls in FEEDS.items():
        for feed_info in urls:
            try:
                parsed = feedparser.parse(feed_info['url'])
                for entry in parsed.entries:
                    entry_id = getattr(entry, 'id', entry.link)
                    
                    if entry_id not in existing_ids:
                        content = ""
                        if hasattr(entry, 'content'): content = entry.content[0].value
                        elif hasattr(entry, 'summary'): content = entry.summary
                        
                        # NEW: Grab the author!
                        author = ""
                        if hasattr(entry, 'author'): author = entry.author
                        elif hasattr(entry, 'creator'): author = entry.creator
                        
                        try:
                            dt = datetime.fromtimestamp(mktime(entry.published_parsed))
                            pub_date = dt.isoformat()
                        except: pub_date = datetime.now().isoformat()

                        new_articles.append({
                            'id': entry_id,
                            'feed_name': feed_info['name'],
                            'title': entry.title,
                            'author': author,  # Save it to the database
                            'link': entry.link,
                            'content': content,
                            'date': pub_date,
                            'category': category
                        })
                        existing_ids.add(entry_id)
            except Exception as e: print(f"Error fetching {feed_info['name']}: {e}")

    archive.extend(new_articles)
    archive.sort(key=lambda x: x['date'], reverse=True)
    archive = archive[:1000]

    with open(MASTER_FILE, 'w') as f: json.dump(archive, f, indent=2)
    print(f"Added {len(new_articles)} new articles. Total archive size: {len(archive)}.")

if __name__ == "__main__": main()
