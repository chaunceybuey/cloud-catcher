import os
import re
import hashlib
import time
import urllib.request
import json
from bs4 import BeautifulSoup
from ebooklib import epub
import rss_engine

# =====================================================================
# SYSTEM PATHS
# =====================================================================
HOME_DIR = os.path.expanduser("~")
SUPERNOTE_SYNC_FOLDER = os.path.join(
    HOME_DIR, 
    "Library", "CloudStorage", 
    "GoogleDrive-slottaj@gmail.com", "My Drive", "Supernote", "Document", "Drive", "SavedArticles"
)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_PATH = os.path.join(BASE_DIR, "sync_history.json")

def clean_filename(title):
    safe = re.sub(r'[\\/*?:"<>|]', "", title)
    return safe.strip()[:100]

def load_ledger():
    if os.path.exists(LEDGER_PATH):
        try:
            with open(LEDGER_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_ledger(ledger):
    try:
        with open(LEDGER_PATH, "w", encoding="utf-8") as f:
            json.dump(ledger, f, indent=4)
    except Exception as e:
        print(f"[EPUB SYNC] Warning: Could not save sync ledger: {e}")

def create_article_epub(article_dict, output_path):
    book = epub.EpubBook()
    book.set_identifier(article_dict.get('id', 'unknown'))
    book.set_title(article_dict.get('title', 'Untitled'))
    book.set_language("en")
    
    if article_dict.get('author'):
        book.add_author(article_dict['author'])

    soup = BeautifulSoup(article_dict.get('content', ''), "html.parser")
    for img in soup.find_all("img"):
        img.decompose()

    chapter = epub.EpubHtml(title=article_dict.get('title', 'Untitled'), file_name="article.xhtml", lang="en")
    
    header_html = f"<h1 style='font-family:serif;'>{article_dict.get('title', 'Untitled')}</h1>"
    if article_dict.get('author'):
        header_html += f"<p><i>By {article_dict['author']}</i></p>"
    header_html += f"<p><b>{article_dict.get('feed_name', 'Unknown Source')}</b></p><hr/>"
    
    chapter.content = header_html + str(soup)
    book.add_item(chapter)
    book.spine = ["nav", chapter]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    epub.write_epub(output_path, book, {})

def sync_bookmarks_to_epub():
    os.makedirs(SUPERNOTE_SYNC_FOLDER, exist_ok=True)
    
    # ==========================================================
    # PHASE 1: TWO-WAY SYNC (The ONLY place stars are deleted)
    # ==========================================================
    ledger = load_ledger()
    keys_to_remove = []
    
    if ledger:
        print("[EPUB SYNC] Auditing Supernote folder for deleted files...")
        for b_id, filename in ledger.items():
            filepath = os.path.join(SUPERNOTE_SYNC_FOLDER, filename)
            if not os.path.exists(filepath):
                print(f"  -> Detected deletion: {filename}. Un-starring from database...")
                try:
                    bm_ref = rss_engine.db.reference('app_data/bookmarks')
                    bm_data = bm_ref.get()
                    if isinstance(bm_data, str):
                        bm_dict = json.loads(bm_data)
                        if b_id in bm_dict:
                            del bm_dict[b_id]
                            bm_ref.set(json.dumps(bm_dict))
                    elif isinstance(bm_data, dict):
                        if b_id in bm_data:
                            del bm_data[b_id]
                            bm_ref.set(bm_data)
                    keys_to_remove.append(b_id)
                except Exception as e:
                    print(f"  -> Error syncing deletion to Firebase: {e}")
        
        for k in keys_to_remove:
            del ledger[k]
        if keys_to_remove:
            save_ledger(ledger)

    # ==========================================================
    # PHASE 2: FETCH & BUILD
    # ==========================================================
    bookmarks = rss_engine.get_bookmarks()
    if not bookmarks:
        print("[EPUB SYNC] No saved articles found in your Bookmarks.")
        return

    print(f"[EPUB SYNC] Found {len(bookmarks)} saved articles. Building metadata dictionary...")

    archive_dict = {}
    
    try:
        with open(os.path.join(BASE_DIR, "master_articles.json"), "r", encoding="utf-8") as f:
            master = json.load(f)
            for a in master: 
                archive_dict[a['id']] = a
    except Exception: pass

    try:
        with open(os.path.join(BASE_DIR, "newsletter_articles.json"), "r", encoding="utf-8") as f:
            newsletters = json.load(f)
            for n in newsletters: 
                archive_dict[n['id']] = n
    except Exception: pass
        
    try:
        saved_links = rss_engine.db.reference('app_data/saved_links').get() or {}
        if isinstance(saved_links, dict):
            for key, data in saved_links.items():
                item_id = data.get('id', key)
                archive_dict[item_id] = data
    except Exception: pass

    new_files_created = False

    for b_id in bookmarks.keys():
        article = archive_dict.get(b_id)
        
        # ==========================================================
        # NON-DESTRUCTIVE FALLBACK (No more database deletion here)
        # ==========================================================
        if not article:
            possible_keys = [b_id, b_id.replace("manual_", "")]
            rescued_html = None
            
            for p_key in possible_keys:
                try:
                    rescued_html = rss_engine.db.reference(f'app_data/articles/{p_key}').get()
                    if rescued_html: break
                except Exception: pass
            
            if not rescued_html:
                # It's a ghost, but we leave it completely alone.
                print(f"[EPUB SYNC] ID {b_id[:8]} missing metadata. Skipping gracefully.")
                continue
                
            soup = BeautifulSoup(rescued_html, "html.parser")
            title_tag = soup.find("title") or soup.find("h1") or soup.find("h2")
            rescued_title = title_tag.get_text(strip=True) if title_tag else f"Rescued_Article_{b_id[:8]}"
            
            article = {
                'id': b_id,
                'title': rescued_title,
                'feed_name': 'Rescued Bookmark',
                'content': rescued_html,
                'link': ''
            }
        # ==========================================================
        
        title = article.get('title', 'Untitled')
        safe_title = clean_filename(title) or "Untitled_Article"
        filename = f"{safe_title}.epub"
        filepath = os.path.join(SUPERNOTE_SYNC_FOLDER, filename)
        
        if os.path.exists(filepath):
            if b_id not in ledger:
                ledger[b_id] = filename
                save_ledger(ledger)
            continue
        
        print(f"[EPUB SYNC] Generating new EPUB: {title}")
        
        link = article.get('link', '')
        full_text = None
        
        if link:
            safe_key = hashlib.md5(link.encode()).hexdigest()
            if rss_engine.FIREBASE_DB_URL:
                try: full_text = rss_engine.db.reference(f'app_data/articles/{safe_key}').get()
                except Exception: pass
            
            if not full_text:
                full_text = rss_engine.fetch_full_article(link)
        
        if not full_text or full_text.startswith("<i>"):
            full_text = article.get('content', '')
            
        article_to_render = article.copy()
        article_to_render['content'] = full_text
        
        try:
            create_article_epub(article_to_render, filepath)
            print(f"  -> Saved to Google Drive: {filepath}")
            
            ledger[b_id] = filename
            save_ledger(ledger)
            new_files_created = True
        except Exception as e:
            print(f"  -> Error generating EPUB: {e}")

    if new_files_created:
        print("[EPUB SYNC] Waking up Google Drive to force sync...")
        os.system("osascript -e 'tell application \"Google Drive\" to activate'")

if __name__ == "__main__":
    sync_bookmarks_to_epub()