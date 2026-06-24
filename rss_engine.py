import os
import json
import ssl
import base64
import time
from datetime import datetime
import requests
import firebase_admin
from firebase_admin import credentials, db

# Detect exactly where rss_engine.py is living dynamically
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(BASE_DIR, '.env'))
except ImportError:
    pass

GITHUB_USERNAME = os.environ.get('GITHUB_USERNAME', '')
GITHUB_REPO     = os.environ.get('GITHUB_REPO',     '')
GITHUB_TOKEN    = os.environ.get('GITHUB_TOKEN',    '')

# --- FIREBASE SETUP ---
FIREBASE_DB_URL = os.environ.get('FIREBASE_DB_URL', '')
# Bind the credentials path dynamically to the script's location
FIREBASE_CRED_PATH = os.path.join(BASE_DIR, 'firebase-credentials.json')

if not firebase_admin._apps and FIREBASE_DB_URL:
    try:
        cred = credentials.Certificate(FIREBASE_CRED_PATH)
        firebase_admin.initialize_app(cred, {
            'databaseURL': FIREBASE_DB_URL
        })
    except Exception as e:
        print(f"Firebase init error: {e}")

# --- SESSIONS AND CACHE ---
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

# --- AUDIO BIN MEMORY ---
def get_audio_bin() -> dict:
    if not FIREBASE_DB_URL: return {}
    try:
        data_str = db.reference('app_data/audio_bin').get()
        if data_str:
            return json.loads(data_str)
    except Exception as e:
        print(f"Error reading audio_bin from Firebase: {e}")
    return {}

def save_audio_bin(bin_data: dict) -> None:
    if not FIREBASE_DB_URL: return
    try:
        db.reference('app_data/audio_bin').set(json.dumps(bin_data))
    except Exception as e:
        print(f"Error saving audio_bin to Firebase: {e}")

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

READWISE_TOKEN = os.environ.get('READWISE_TOKEN', '')

def send_to_readwise(url: str, html_content: str, title: str) -> str:
    if not READWISE_TOKEN:
        return "ERROR: READWISE_TOKEN missing in .env"
        
    headers = {
        "Authorization": f"Token {READWISE_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "url": url,
        "html": html_content,
        "title": title
    }
    try:
        res = requests.post("https://readwise.io/api/v3/save/", headers=headers, json=payload, timeout=10)
        if res.status_code in (200, 201, 204):
            return "Sent to Readwise!"
        else:
            return f"Readwise Error: {res.status_code}"
    except Exception as e:
        return f"ERROR: {str(e)}"
    
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
    
    cookies = None
    try:
        import browser_cookie3
        for browser_fn in [browser_cookie3.chrome, browser_cookie3.firefox]:
            try:
                cookies = browser_fn()
                if cookies:
                    break
            except Exception:
                continue
    except Exception as e:
        print(f"Cookie Error: {e}")

    try:
        res = _ARTICLE_SESSION.get(url, headers=headers, cookies=cookies, timeout=10)
        if res.status_code != 200:
            return f"<i>Request blocked (HTTP {res.status_code}).</i>"

        extracted = trafilatura.extract(res.text, url=url, include_comments=False, include_images=True, include_formatting=True, output_format='html')
        
        if extracted:
            extracted = extracted.replace('<p>Supported by</p>', '').replace('<span>Supported by</span>', '')
            
            from bs4 import BeautifulSoup
            from urllib.parse import urljoin
            
            # --- IMAGE RESCUE ---
            # Trafilatura strips most images. We rescue them from the raw HTML
            # and re-inject them into the extracted article.
            
            raw_soup = BeautifulSoup(res.text, 'html.parser')
            ext_soup = BeautifulSoup(extracted, 'html.parser')
            
            # 1. Fix any images trafilatura kept (resolve URLs, defeat lazy-loading)
            for img in ext_soup.find_all('img'):
                real_src = img.get('data-src') or img.get('data-lazy-src') or img.get('src')
                if real_src:
                    img['src'] = urljoin(url, real_src)
            
            # 2. Collect all content images from the raw page
            rescued_srcs = set()
            # Already-present images
            for img in ext_soup.find_all('img'):
                if img.get('src'):
                    rescued_srcs.add(img['src'])
            
            # Find images in common article containers
            content_imgs = []
            containers = raw_soup.find_all(['article', 'main']) or [raw_soup]
            # Words that indicate author photos, not article images
            author_patterns = {'author', 'avatar', 'byline', 'headshot', 'portrait', 'staff', 'columnist', 'bio', 'profile-photo'}
            
            for container in containers:
                for img in container.find_all('img'):
                    src = img.get('data-src') or img.get('data-lazy-src') or img.get('src')
                    # Fall back to first URL in srcset if no src found
                    if not src and img.get('srcset'):
                        src = img['srcset'].split(',')[0].strip().split()[0]
                    if not src:
                        continue
                    abs_src = urljoin(url, src)
                    # Skip tiny images (icons, tracking pixels)
                    width = img.get('width', '')
                    height = img.get('height', '')
                    try:
                        if (width and int(width) < 100) or (height and int(height) < 100):
                            continue
                    except ValueError:
                        pass
                    # Skip if already present or if it's a data URI / SVG
                    if abs_src in rescued_srcs or abs_src.startswith('data:') or '.svg' in abs_src:
                        continue
                    # Skip author photos — check img and ancestor classes/ids/src
                    img_context = ' '.join([
                        img.get('class', [''])[0] if isinstance(img.get('class'), list) else str(img.get('class', '')),
                        img.get('id', ''),
                        abs_src,
                        img.get('alt', ''),
                    ]).lower()
                    # Also check parent containers for author signals
                    for parent in img.parents:
                        if parent.name in ('div', 'span', 'section', 'header', 'a'):
                            parent_class = ' '.join(parent.get('class', [])) if isinstance(parent.get('class'), list) else str(parent.get('class', ''))
                            img_context += ' ' + parent_class.lower() + ' ' + parent.get('id', '').lower()
                        if parent.name == 'article':
                            break
                    if any(pattern in img_context for pattern in author_patterns):
                        continue
                    
                    alt = img.get('alt', '')
                    caption = ''
                    parent_fig = img.find_parent('figure')
                    if parent_fig:
                        cap = parent_fig.find('figcaption')
                        if cap:
                            caption = cap.get_text(strip=True)
                    content_imgs.append({'src': abs_src, 'alt': alt, 'caption': caption})
                    rescued_srcs.add(abs_src)
            
            # 3. Inject rescued images between paragraphs with captions attached
            caption_texts = set()
            if content_imgs:
                paragraphs = ext_soup.find_all(['p', 'h2', 'h3', 'h4'])
                # Space images evenly through the article
                spacing = max(1, len(paragraphs) // (len(content_imgs) + 1))
                injected = 0
                for i, img_data in enumerate(content_imgs):
                    insert_idx = spacing * (i + 1)
                    if insert_idx < len(paragraphs):
                        new_fig = ext_soup.new_tag('figure')
                        new_img = ext_soup.new_tag('img', src=img_data['src'], alt=img_data['alt'])
                        new_fig.append(new_img)
                        if img_data['caption']:
                            new_cap = ext_soup.new_tag('figcaption')
                            new_cap.string = img_data['caption']
                            new_fig.append(new_cap)
                            caption_texts.add(img_data['caption'])
                        paragraphs[insert_idx].insert_before(new_fig)
                        injected += 1
                print(f"[IMAGES] Rescued {injected} images, {len(rescued_srcs)} total")
            
            # 4. Strip orphaned caption text from the article body
            #    Trafilatura extracts captions as regular paragraphs — now that we've
            #    attached them to their images, remove the duplicates.
            if caption_texts:
                for p in ext_soup.find_all('p'):
                    p_text = p.get_text(strip=True)
                    if p_text and any(p_text in cap or cap in p_text for cap in caption_texts):
                        p.decompose()
            
            # 5. Hero image from og:image if nothing else at the top
            og_img = raw_soup.find('meta', property='og:image')
            if og_img and og_img.get('content'):
                hero_src = urljoin(url, og_img['content'])
                if hero_src not in rescued_srcs:
                    hero_tag = ext_soup.new_tag('img', src=hero_src, **{'class': 'hero-image'})
                    if ext_soup.contents:
                        ext_soup.contents[0].insert_before(hero_tag)
            
            extracted = str(ext_soup)
            # --- END IMAGE RESCUE ---

            if len(CACHE['articles']) >= ARTICLE_CACHE_MAX:
                oldest = next(iter(CACHE['articles']))
                del CACHE['articles'][oldest]
            CACHE['articles'][url] = extracted
            
            # Push full text to Firebase so the PWA can read it
            if FIREBASE_DB_URL:
                try:
                    import hashlib
                    safe_key = hashlib.md5(url.encode()).hexdigest()
                    db.reference(f'app_data/articles/{safe_key}').set(extracted)
                    print(f"[FIREBASE] Pushed full text for: {url[:60]}...")
                except Exception as e:
                    print(f"[FIREBASE] Push failed: {e}")
            
            return extracted
            
        return f"<i>HTTP {res.status_code} OK, but could not extract text.</i>"
        
    except Exception as e:
        return f"<i>Error fetching article: {e}</i>"

# --- AUDIO ENGINE (Gemini 2.5 Flash TTS) ---
def generate_audio(article_id: str, html_content: str) -> str:
    """Sends full article text to Gemini TTS for natural, multimodal audio generation."""
    try:
        import os
        import wave  
        import hashlib
        import time
        from bs4 import BeautifulSoup
        from google import genai
        from google.genai import types
        
        # 1. Scrub the text
        clean_text = BeautifulSoup(html_content, "html.parser").get_text(separator='\n')
        paragraphs = [p.strip() for p in clean_text.split('\n') if len(p.strip()) > 30]

        if not paragraphs:
            return "ERROR: Article text is too short. Try clicking 'Fetch Full Article' first!"

        if not os.environ.get("GEMINI_API_KEY"):
            return "ERROR: GEMINI_API_KEY missing in .env file."

        # 2. Smart Chunking (Group paragraphs to prevent AI pacing issues)
        text_batches = []
        current_batch = ""
        for p in paragraphs:
            if len(current_batch) + len(p) < 1500:
                current_batch += p + "\n\n"
            else:
                text_batches.append(current_batch.strip())
                current_batch = p + "\n\n"
        if current_batch:
            text_batches.append(current_batch.strip())

        client = genai.Client()
        master_audio = bytearray()
        
        # 3. The Unrestricted API Loop
        for i, batch in enumerate(text_batches):
            prompt = f"""
            You are a podcaster. 
            Read the following passage aloud in a clear, restrained, but still lively way. 
            Avoid any exaggerated marketing cliches or overly promotional tones.
            
            Passage: 
            {batch}
            """

            for attempt in range(3):
                chunk_success = False
                try:
                    # Build a brand new connection for every attempt to avoid dead sockets
                    client = genai.Client()
                    
                    response = client.models.generate_content(
                        model='gemini-2.5-flash-preview-tts',
                        contents=prompt,
                        config=types.GenerateContentConfig(
                            response_modalities=["AUDIO"],
                            speech_config=types.SpeechConfig(
                                voice_config=types.VoiceConfig(
                                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                        voice_name="Aoede"
                                    )
                                )
                            )
                        )
                    )

                    for part in response.candidates[0].content.parts:
                        if part.inline_data:
                            master_audio.extend(part.inline_data.data)
                            break
                    
                    chunk_success = True
                    break  # Success! Break out of the retry loop.

                except Exception as e:
                    if attempt < 2:
                        print(f"Connection hiccup on chunk {i+1}. Retrying... ({e})")
                        time.sleep(2)  # Give the network a second to breathe before retrying
                    else:
                        return f"ERROR: API dropped connection repeatedly on chunk {i+1}. Details: {str(e)}"

            if not chunk_success:
                return "ERROR: Failed to generate audio for a chunk after multiple attempts."
            
            # A tiny 0.5s pause between successful chunks to keep the connection stable
            if i < len(text_batches) - 1:
                time.sleep(0.5)

        if not master_audio:
             return "ERROR: No audio data returned by Gemini."
        
        # Build the static directory securely against the dynamic base path
        static_dir = os.path.join(BASE_DIR, "static")
        os.makedirs(static_dir, exist_ok=True)
        
        safe_id = hashlib.md5(article_id.encode()).hexdigest()[:15]
        
        # Keep the return path relative so the web player doesn't break, 
        # but use the absolute path for the actual disk save
        relative_filepath = f"static/audio_{safe_id}.wav"
        absolute_filepath = os.path.join(static_dir, f"audio_{safe_id}.wav")
        
        with wave.open(absolute_filepath, "wb") as wf:
            wf.setnchannels(1)       
            wf.setsampwidth(2)       
            wf.setframerate(24000)   
            wf.writeframes(master_audio)
            
        return relative_filepath
    except Exception as e:
        return f"ERROR: {str(e)}"
        
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
    
    # Extract base URL so relative image paths resolve correctly inside srcdoc iframe
    from urllib.parse import urlparse
    parsed = urlparse(article.get('link', ''))
    base_url = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else ""
    base_tag = f'<base href="{base_url}/" target="_blank">' if base_url else ""
    
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
    
    h2, h3, h4, figure { break-inside: avoid; page-break-inside: avoid; }
    p, ul, ol { margin-bottom: 1.2em; }
    ::-webkit-scrollbar { display: none; }
    a { color: #D94A00; text-decoration: none; }
    
    h1 { display: none; }
    
    h2, h3, h4 { color: #8A8F98; margin-top: 1.8em; margin-bottom: 0.8em; }
    figure { display: block; margin: 1.5em auto; max-width: 95%; overflow: hidden; }
    img, picture { max-width: 100%; max-height: 55vh; object-fit: contain; border-radius: 8px; margin: 1.2em auto; opacity: 0.85; display: block; }
    figure img { margin: 0 auto; }
    .hero-image { max-height: 50vh; margin: 1.2em auto; }
    figcaption { font-size: 13px; color: #5A5F67; text-align: center; padding: 0.5em 1em 0; font-style: italic; line-height: 1.4; }
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
    
    return f"""<!DOCTYPE html><html><head>{base_tag}{css}</head><body>
      <div class="zen-article-wrapper">
        <div class="article-content">{content}</div>
      </div>
      {js}
    </body></html>"""
