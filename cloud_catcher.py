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

    # UPGRADE 1: Change memory to a dictionary so we can edit existing articles
    existing_articles = {article['id']: article for article in archive}
    new_articles = []

    for category, urls in FEEDS.items():
        for feed_info in urls:
            try:
                parsed = feedparser.parse(feed_info['url'])
                for entry in parsed.entries:
                    entry_id = getattr(entry, 'id', entry.link)
                    
                    # Check if this is a brand new article
                    if entry_id not in existing_articles:
                        content = ""
                        if hasattr(entry, 'content'): content = entry.content[0].value
                        elif hasattr(entry, 'summary'): content = entry.summary
                        
                        author = ""
                        if hasattr(entry, 'author'): author = entry.author
                        elif hasattr(entry, 'creator'): author = entry.creator
                        
                        try:
                            dt = datetime.fromtimestamp(mktime(entry.published_parsed))
                            pub_date = dt.isoformat()
                        except: pub_date = datetime.now().isoformat()

                        new_article = {
                            'id': entry_id,
                            'feed_name': feed_info['name'],
                            'title': entry.title,
                            'author': author,  
                            'link': entry.link,
                            'content': content,
                            'date': pub_date,
                            'category': category
                        }
                        new_articles.append(new_article)
                        existing_articles[entry_id] = new_article # Add to memory
                        
                    # UPGRADE 2: If the article exists, check if you moved its category!
                    else:
                        if existing_articles[entry_id]['category'] != category:
                            existing_articles[entry_id]['category'] = category
                            
            except Exception as e: print(f"Error fetching {feed_info['name']}: {e}")

    # Add the new articles to the archive
    archive.extend(new_articles)
    
    # Sort and cap the archive size
    archive.sort(key=lambda x: x['date'], reverse=True)
    archive = archive[:1000]

    with open(MASTER_FILE, 'w') as f: json.dump(archive, f, indent=2)
    print(f"Added {len(new_articles)} new articles. Total archive size: {len(archive)}.")

if __name__ == "__main__": main()
