import feedparser
import json
import os
from datetime import datetime
from time import mktime

# The feeds the Cloud Catcher will watch
FEEDS = {
    "News": [{"name": "NYT Top Stories", "url": "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"}],
    "Culture": [{"name": "Criterion Collection", "url": "https://www.criterion.com/current/rss"}]
}

MASTER_FILE = 'master_articles.json'

def main():
    # Load the existing archive if it exists
    if os.path.exists(MASTER_FILE):
        with open(MASTER_FILE, 'r') as f:
            try: archive = json.load(f)
            except: archive = []
    else:
        archive = []

    # Create a fast-lookup list of IDs we already have
    existing_ids = {article['id'] for article in archive}
    new_articles = []

    for category, urls in FEEDS.items():
        for feed_info in urls:
            parsed = feedparser.parse(feed_info['url'])
            for entry in parsed.entries:
                entry_id = getattr(entry, 'id', entry.link)
                
                # Only process if we haven't seen this article before
                if entry_id not in existing_ids:
                    content = ""
                    if hasattr(entry, 'content'): content = entry.content[0].value
                    elif hasattr(entry, 'summary'): content = entry.summary
                    
                    # Standardize the date format for JSON
                    try:
                        dt = datetime.fromtimestamp(mktime(entry.published_parsed))
                        pub_date = dt.isoformat()
                    except:
                        pub_date = datetime.now().isoformat()

                    new_articles.append({
                        'id': entry_id,
                        'feed_name': feed_info['name'],
                        'title': entry.title,
                        'link': entry.link,
                        'content': content,
                        'date': pub_date,
                        'category': category
                    })
                    existing_ids.add(entry_id)

    # Combine new articles with the old archive and sort by newest first
    archive.extend(new_articles)
    archive.sort(key=lambda x: x['date'], reverse=True)

    # Cap the file at 1,000 articles so it doesn't eventually consume too much memory
    archive = archive[:1000]

    # Save it back to the cloud
    with open(MASTER_FILE, 'w') as f:
        json.dump(archive, f, indent=2)

    print(f"Added {len(new_articles)} new articles. Total archive size: {len(archive)}.")

if __name__ == "__main__":
    main()
