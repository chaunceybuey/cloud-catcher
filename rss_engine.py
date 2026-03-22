import os
import json
import ssl
import base64
import time
from datetime import datetime
import requests
import firebase_admin
from firebase_admin import credentials, db

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))
except ImportError:
    pass

GITHUB_USERNAME = os.environ.get('GITHUB_USERNAME', '')
GITHUB_REPO     = os.environ.get('GITHUB_REPO',     '')
GITHUB_TOKEN    = os.environ.get('GITHUB_TOKEN',    '')

# --- FIREBASE SETUP ---
FIREBASE_DB_URL = os.environ.get('FIREBASE_DB_URL', '')
FIREBASE_CRED_PATH = os.environ.get('FIREBASE_CRED_PATH', 'firebase-credentials.json')
FIREBASE_CRED_JSON = os.environ.get('FIREBASE_CRED_JSON', '')

if not firebase_admin._apps and FIREBASE_DB_URL:
    try:
        # Check if we are on a cloud server using a string variable first
        if FIREBASE_CRED_JSON:
            cred_dict = json.loads(FIREBASE_CRED_JSON)
            cred = credentials.Certificate(cred_dict)
        else:
            # Fallback to local file if we are running on your laptop
            cred = credentials.Certificate(FIREBASE_CRED_PATH)
            
        firebase_admin.initialize_app(cred, {
            'databaseURL': FIREBASE_DB_URL
        })
    except Exception as e:
        print(f"Firebase init error: {e}")

# --- MISSING SESSIONS AND CACHE RESTORED ---
_SSL_CONTEXT = ssl.create_default_context()
_REQ_SESSION = requests.Session()
_ARTICLE_SESSION = requests.Session()
_ARTICLE_SESSION.verify = False

ARTICLE_CACHE_MAX = 100

CACHE = {
    'feeds': {'data': [], 'expires': 0},
    'master': {'data': [], 'expires': 0},
    'articles': {} 
}

def force_sync():
    CACHE['feeds']['expires'] = 0
    CACHE['master']['expires'] = 0

# --- CLOUD HISTORY & BOOKMARKS ---
# We store these as JSON strings to bypass Firebase's strict key character limits (no '.' or '/')

def get_history() -> set:
    if not FIREBASE_DB_URL: return set()
    try:
        data_str = db.reference('app_data/history').get()
        if data_str:
            return set(json.loads(data_str))
    except Exception as e:
        print(f"Error reading history from Firebase: {e}")
    return set()

def save_history(history: set) -> None:
    if not FIREBASE_DB_URL: return
    try:
        db.reference('app_data/history').set(json.dumps(list(history)))
    except Exception as e:
        print(f"Error saving history to Firebase: {e}")

def mark_read(article_id: str) -> None:
    h = get_history()
    h.add(article_id)
    save_history(h)

def mark_unread(article_id: str) -> None:
    h = get_history()
    h.discard(article_id)
    save_history(h)

def mark_many_read(ids: list) -> None:
    h = get_history()
    h.update(ids)
    save_history(h)

def get_bookmarks() -> dict:
    if not FIREBASE_DB_URL: return {}
    try:
        data_str = db.reference('app_data/bookmarks').get()
        if data_str:
            return json.loads(data_str)
    except Exception as e:
        print(f"Error reading bookmarks from Firebase: {e}")
    return {}

def save_bookmarks(bookmarks: dict) -> None:
    if not FIREBASE_DB_URL: return
    try:
        db.reference('app_data/bookmarks').set(json.dumps(bookmarks))
    except Exception as e:
        print(f"Error saving bookmarks to Firebase: {e}")


# --- GITHUB API ---
def _gh_headers() -> dict:
    return {'Authorization': f'token {GITHUB_TOKEN}', 'Accept': 'application/vnd.github.v3+json'}

def fetch_feeds_config() -> list:
    if time.time() < CACHE['feeds']['expires']:
        return CACHE['feeds']['data']
        
    url = f'https://api.github.com/repos/{GITHUB_USERNAME}/{GITHUB_REPO}/contents/feeds.json'
    try:
        res = _REQ_SESSION.get(url, headers=_gh_headers(), timeout=10)
        if res.status_code == 200:
            raw = base64.b64decode(res.json()['content']).decode('utf-8')
            parsed = json.loads(raw)
            feeds = []
            for category, feed_list in parsed.items():
                for feed in feed_list:
                    feeds.append({**feed, '_category': category})
            CACHE['feeds'] = {'data': feeds, 'expires': time.time() + 300}
            return feeds
    except Exception:
        pass
    return []

def update_feeds_on_github(payload) -> tuple[bool, str]:
    api_url = f'https://api.github.com/repos/{GITHUB_USERNAME}/{GITHUB_REPO}/contents/feeds.json'
    try:
        res = _REQ_SESSION.get(api_url, headers=_gh_headers(), timeout=10)
        sha = res.json().get('sha') if res.status_code == 200 else None
        if not sha:
            return False, 'Could not fetch current file SHA from GitHub.'

        if isinstance(payload, dict):
            content = {cat: [{'name': f['name'], 'url': f['url']} for f in feeds]
                       for cat, feeds in payload.items()}
        else:
            content = {}
            for f in payload:
                cat = f.get('_category', 'My Feeds')
                content.setdefault(cat, []).append({'name': f['name'], 'url': f['url']})

        put_payload = {
            'message': 'Updated feeds via RSS Triage app',
            'content': base64.b64encode(json.dumps(content, indent=2).encode('utf-8')).decode('utf-8'),
            'sha': sha,
        }
        put_res = _REQ_SESSION.put(api_url, headers=_gh_headers(), json=put_payload, timeout=10)
        
        if put_res.status_code in (200, 201):
            CACHE['feeds']['expires'] = 0 
            dispatch_url = f'https://api.github.com/repos/{GITHUB_USERNAME}/{GITHUB_REPO}/actions/workflows/catcher.yml/dispatches'
            dispatch_payload = {'ref': 'main'}
            try:
                _REQ_SESSION.post(dispatch_url, headers=_gh_headers(), json=dispatch_payload, timeout=5)
            except Exception as e:
                print(f"Action trigger failed silently: {e}")
            return True, 'OK'
        return False, put_res.text
    except Exception as e:
        return False, str(e)

def fetch_master_archive() -> list:
    if time.time() < CACHE['master']['expires']:
        return CACHE['master']['data']
        
    cache_buster = int(time.time())
    url = f'https://raw.githubusercontent.com/{GITHUB_USERNAME}/{GITHUB_REPO}/main/master_articles.json?t={cache_buster}'
    
    try:
        res = _REQ_SESSION.get(url, headers={'Authorization': f'token {GITHUB_TOKEN}'}, timeout=10)
        if res.status_code == 200:
            data = res.json()
            CACHE['master'] = {'data': data, 'expires': time.time() + 900}
            return data
    except Exception:
        pass
    return []

# --- ARTICLE FETCHER ---
def fetch_full_article(url: str) -> str:
    if url in CACHE['articles']:
        return CACHE['articles'][url]
        
    try:
        import trafilatura
    except ImportError:
        return "<i>trafilatura not installed. Run: pip install trafilatura</i>"

    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/',
    }
    
    # Grab the manual NYT VIP pass from Render
    request_cookies = {}
    nyt_cookie_val = os.environ.get('NYT_COOKIE', '')
    if nyt_cookie_val and 'nytimes.com' in url:
        request_cookies['nyt-s'] = nyt_cookie_val

    try:
        res = _ARTICLE_SESSION.get(url, headers=headers, cookies=request_cookies, timeout=10)
        if res.status_code != 200:
            return f"<i>Request blocked (HTTP {res.status_code}).</i>"

        extracted = trafilatura.extract(res.text, url=url, include_comments=False, include_images=True, output_format='html')
        if extracted:
            extracted = extracted.replace('<p>Supported by</p>', '').replace('<span>Supported by</span>', '')
            if len(CACHE['articles']) >= ARTICLE_CACHE_MAX:
                oldest = next(iter(CACHE['articles']))
                del CACHE['articles'][oldest]
            CACHE['articles'][url] = extracted
            return extracted
        return f"<i>HTTP {res.status_code} OK, but could not extract text.</i>"
    except Exception as e:
        return f"<i>Error fetching article: {e}</i>"

# --- HTML RENDERER ---
def _format_date(raw: str) -> str:
    if not raw: return ''
    try:
        dt = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return dt.strftime('%b %d').upper()
    except Exception:
        return raw[:10]

def render_article_html(article: dict, full_fetch: bool) -> str:
    content = fetch_full_article(article.get('link', '#')) if full_fetch else article.get('content', 'No description available.')
    
    css = """
    <style>
    :root { 
        color-scheme: dark; 
        --max-width: 720px;
        --gap: max(80px, calc(100vw - var(--max-width)));
        --pad: max(40px, calc((100vw - var(--max-width)) / 2));
        --font-size: 20px;
        --line-height: 1.7;
    }
    
    body { background-color: #050505 !important; color: #7A7A7A; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: var(--font-size); line-height: var(--line-height); margin: 0; padding: 0; overflow-y: hidden; }
    
    .zen-article-wrapper { 
        column-width: var(--max-width); 
        column-gap: var(--gap); 
        height: 100vh; 
        padding: 40px var(--pad);
        box-sizing: border-box;
    }
    
    h2, h3, h4, img, figure { break-inside: avoid; page-break-inside: avoid; }
    p, ul, ol { margin-bottom: 1.2em; }
    ::-webkit-scrollbar { display: none; }
    a { color: #D94A00; text-decoration: none; }
    
    h1 { display: none; }
    
    h2, h3, h4 { color: #8A8F98; margin-top: 1.8em; margin-bottom: 0.8em; }
    img, picture, figure { max-width: 100%; height: auto; border-radius: 8px; margin: 1.5em auto; opacity: 0.85; display: block; }
    figcaption { font-size: 14px; color: #5A5F67; text-align: center; margin-top: 0.5em; font-style: italic; }
    </style>
    """
    
    js = """
    <script>
    function updateProgress() {
        const maxScroll = document.documentElement.scrollWidth - window.innerWidth;
        let progress = 100;
        if (maxScroll > 0) {
            progress = (window.scrollX / maxScroll) * 100;
        }
        window.parent.postMessage({ type: 'progress', value: progress }, '*');
    }
    window.addEventListener('scroll', updateProgress);
    window.addEventListener('resize', updateProgress);
    
    window.addEventListener('message', (e) => {
        if (e.data.type === 'applySettings') {
            document.documentElement.style.setProperty('--font-size', e.data.fontSize + 'px');
            document.documentElement.style.setProperty('--line-height', e.data.lineHeight);
            setTimeout(updateProgress, 50); 
        }
        if (e.data.type === 'restoreScroll' && e.data.value) {
            const maxScroll = document.documentElement.scrollWidth - window.innerWidth;
            if (maxScroll > 0) {
                window.scrollTo({ left: (e.data.value / 100) * maxScroll, behavior: 'instant' });
            }
        }
    });
    
    window.addEventListener('DOMContentLoaded', updateProgress);
    </script>
    """
    
    return f"""<!DOCTYPE html><html><head>{css}</head><body>
      <div class="zen-article-wrapper">
        <div class="article-content">{content}</div>
      </div>
      {js}
    </body></html>"""
