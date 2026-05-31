from fastapi import FastAPI, Request, Response, Form
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import webbrowser
import threading
import traceback
import os
import rss_engine
from urllib.parse import quote

app = FastAPI()
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
templates.env.filters["urlquote"] = lambda s: quote(str(s), safe='')

templates.env.auto_reload = True
templates.env.cache = {}

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    tb = traceback.format_exc()
    print(f"\n{'='*60}\nERROR on {request.method} {request.url}\n{tb}{'='*60}\n")
    return PlainTextResponse(f"Internal Server Error:\n{tb}", status_code=500)

# ── Main UI state ─────────────────────────────────────────────────────────────
state = {
    "view_mode": "Unread",
    "active_feed_filter": "All Feeds",
    "active_category_filter": None,
    "current_idx": 0,
    "active_id": None,
    "full_fetch": False,
    "fetched_bodies": {},
    "undo_stack": [],
    "is_bookmarked": False,
    "saved_progress": 0,
    "audio_bin": rss_engine.get_audio_bin() # Tracking: {article_id: {"status": "generating"|"ready"|"error", "path": filepath}}
}

# ── Background Audio Queue Worker ─────────────────────────────────────────────
def _process_audio_queue(article_id: str, html_body: str):
    """Quietly bakes the audio in the background and saves it to the bin."""
    try:
        filepath = rss_engine.generate_audio(article_id, html_body)
        if filepath.startswith("ERROR:"):
            print(f"\n⚠️ Audio Engine Failed for {article_id}: {filepath}\n")
            state["audio_bin"][article_id] = {"status": "error", "path": ""}
        else:
            state["audio_bin"][article_id] = {"status": "ready", "path": filepath}
    except Exception as e:
        print(f"\n🛑 CRITICAL Audio Thread Crash: {str(e)}\n")
        state["audio_bin"][article_id] = {"status": "error", "path": ""}
    finally:
        # Save the updated bin to Firebase!
        rss_engine.save_audio_bin(state["audio_bin"])

# ── Helpers ───────────────────────────────────────────────────────────────────
def build_feed_groups(my_feeds):
    from collections import OrderedDict
    groups = OrderedDict()
    for f in my_feeds:
        cat = f.get('_category', 'My Feeds')
        groups.setdefault(cat, []).append(f)
    return groups

def get_filtered_articles():
    my_feeds = rss_engine.fetch_feeds_config()
    all_articles = rss_engine.fetch_master_archive()
    history = rss_engine.get_history()

    if state["view_mode"] == 'Unread':
        base = [a for a in all_articles if a['id'] not in history]
    elif state["view_mode"] == 'Bookmarks':
        bookmarks = rss_engine.get_bookmarks()
        base = [a for a in all_articles if a['id'] in bookmarks]
    elif state["view_mode"] == 'AudioBin':
        base = [a for a in all_articles if a['id'] in state["audio_bin"]]
    else:
        base = [a for a in all_articles if a['id'] in history]

    active_feed_names = [f.get('name') for f in my_feeds]
    valid = [a for a in base if a.get('feed_name') in active_feed_names]

    all_feeds_count = len(valid)
    feed_counts = {name: 0 for name in active_feed_names}
    for a in valid:
        feed_counts[a.get('feed_name')] += 1

    if state["active_feed_filter"] != 'All Feeds':
        candidates = [a for a in valid if a.get('feed_name') == state["active_feed_filter"]]
    elif state["active_category_filter"]:
        cat_feed_names = {f.get('name') for f in my_feeds if f.get('_category') == state["active_category_filter"]}
        candidates = [a for a in valid if a.get('feed_name') in cat_feed_names]
    else:
        candidates = valid

    candidates.sort(key=lambda x: x.get('date', '1970-01-01'), reverse=True)
    return candidates, my_feeds, feed_counts, all_feeds_count

def get_active_info(candidates=None):
    if candidates is None:
        candidates, _, _, _ = get_filtered_articles()
    if not candidates:
        return None, []

    if state["current_idx"] >= len(candidates):
        state["current_idx"] = max(0, len(candidates) - 1)

    active_article = candidates[state["current_idx"]]
    active_id = active_article['id']
    state["active_id"] = active_id

    if active_id in state["fetched_bodies"]:
        state["full_fetch"] = True
        html_body = state["fetched_bodies"][active_id]
    else:
        html_body = rss_engine.render_article_html(active_article, state["full_fetch"])
        if state["full_fetch"]:
            state["fetched_bodies"][active_id] = html_body

    active_article['html_body'] = html_body
    active_article['formatted_date'] = rss_engine._format_date(active_article.get('date'))

    bookmarks = rss_engine.get_bookmarks()
    state["is_bookmarked"] = active_id in bookmarks
    state["saved_progress"] = bookmarks.get(active_id, 0)

    return active_article, candidates

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    candidates, my_feeds, feed_counts, all_feeds_count = get_filtered_articles()
    return templates.TemplateResponse(
        request=request, 
        name="index.html", 
        context={
            "request": request,
            "state": state,
            "total_count": len(candidates),
            "my_feeds": my_feeds,
            "feed_groups": build_feed_groups(my_feeds),
            "feed_counts": feed_counts,
            "all_feeds_count": all_feeds_count,
            "active_category_filter": state["active_category_filter"],
            "is_htmx": False,
        }
    )

@app.get("/load-article", response_class=HTMLResponse)
async def load_article(request: Request):
    candidates, _, _, _ = get_filtered_articles()
    active_article, candidates = get_active_info(candidates)
    return templates.TemplateResponse(
        request=request, 
        name="article_partial.html", 
        context={
            "request": request,
            "state": state,
            "active_article": active_article,
            "total_count": len(candidates) if candidates else 0,
            "is_htmx": False,
            "toast_msg": "",
        }
    )

@app.post("/audio-status/{article_id}", response_class=HTMLResponse)
async def audio_status(article_id: str):
    """Called by HTMX via POST to bypass browser caching."""
    audio_data = state["audio_bin"].get(article_id)
    
    if not audio_data:
        return HTMLResponse('<div></div>')
        
    if audio_data["status"] == "generating":
        return HTMLResponse(f"""
        <div id="audio-section" hx-post="/audio-status/{article_id}" hx-trigger="every 2s" hx-swap="outerHTML"
             class="w-fit px-3 py-1 bg-[#1a1a1a] border border-[#333] rounded text-[10px] font-bold text-[#5A5F67] uppercase tracking-widest animate-pulse mt-3">
            Baking in background…
        </div>""")
    elif audio_data["status"] == "ready":
        # Added the Drop button here!
        return HTMLResponse(f"""
        <div id="audio-section" class="mt-3 flex items-center gap-3">
            <audio controls class="w-full max-w-md h-8 outline-none rounded opacity-80 hover:opacity-100 transition-opacity">
                <source src="/{audio_data["path"]}" type="audio/wav">
            </audio>
            <button hx-post="/action/remove_audio" hx-target="#article-view" hx-swap="outerHTML" 
                    class="px-2 py-1 bg-[#1a1a1a] hover:bg-[#331111] border border-[#333] hover:border-[#ff4444] rounded text-[10px] font-bold text-[#5A5F67] hover:text-[#ff4444] uppercase tracking-widest transition-colors flex-shrink-0" title="Delete MP3 from Hard Drive">
                ✕ Drop
            </button>
        </div>""")
    else:
        # Added the Clear button for failed audio!
        return HTMLResponse(f"""
        <div id="audio-section" class="mt-3 flex items-center gap-3">
            <span class="text-[11px] text-red-400 font-mono bg-[#331111] px-2 py-1 rounded border border-[#ff4444]">Audio Failed.</span>
            <button hx-post="/action/remove_audio" hx-target="#article-view" hx-swap="outerHTML" 
                    class="px-2 py-1 bg-[#1a1a1a] hover:bg-[#222] border border-[#333] hover:border-[#8A8F98] rounded text-[10px] font-bold text-[#8A8F98] uppercase tracking-widest transition-colors">
                ✕ Clear
            </button>
        </div>""")

@app.get("/sync")
async def sync_queue():
    rss_engine.force_sync()
    state["current_idx"] = 0
    state["full_fetch"] = False
    state["active_category_filter"] = None
    state["fetched_bodies"].clear()
    return RedirectResponse(url="/")

@app.post("/action/mark_all")
async def mark_all_read():
    candidates, _, _, _ = get_filtered_articles()
    if candidates and state["view_mode"] == "Unread":
        ids = [c['id'] for c in candidates]
        rss_engine.mark_many_read(ids)
        state["current_idx"] = 0
        state["active_id"] = None
        state["full_fetch"] = False
    resp = Response(status_code=200)
    resp.headers["HX-Redirect"] = "/"
    return resp

@app.post("/feeds/update")
async def update_feeds(request: Request):
    data = await request.json()
    success, msg = rss_engine.update_feeds_on_github(data)
    if success:
        state["active_feed_filter"] = "All Feeds"
    resp = Response(status_code=200)
    resp.headers["HX-Redirect"] = "/"
    return resp

@app.get("/filter-category/{cat_name}")
async def filter_category(cat_name: str):
    state["active_category_filter"] = cat_name
    state["active_feed_filter"] = "All Feeds"
    state["current_idx"] = 0
    state["full_fetch"] = False
    return RedirectResponse(url="/")

@app.get("/filter/{feed_name}")
async def filter_feed(feed_name: str):
    state["active_feed_filter"] = feed_name
    state["active_category_filter"] = None
    state["current_idx"] = 0
    state["full_fetch"] = False
    return RedirectResponse(url="/")

@app.get("/mode/{mode}")
async def switch_mode(mode: str):
    state["view_mode"] = mode
    state["current_idx"] = 0
    state["full_fetch"] = False
    state["active_feed_filter"] = "All Feeds"
    state["active_category_filter"] = None
    return RedirectResponse(url="/")

@app.post("/action/open")
async def open_web():
    active_article, _ = get_active_info()
    if active_article:
        webbrowser.open(active_article['link'])
    return HTMLResponse("")

@app.post("/action/{action}", response_class=HTMLResponse)
async def handle_action(request: Request, action: str):
    try:
        form_data = await request.form()
        safe_progress = float(form_data.get("progress", 0))
    except Exception:
        safe_progress = 0.0

    active_article, candidates = get_active_info()
    toast_msg = ""

    if candidates and active_article:
        if action == "next" and state["current_idx"] < len(candidates) - 1:
            state["current_idx"] += 1
            state["full_fetch"] = False
        elif action == "prev" and state["current_idx"] > 0:
            state["current_idx"] -= 1
            state["full_fetch"] = False
        elif action == "fetch":
            state["full_fetch"] = True
        elif action == "archive":
            rss_engine.mark_read(active_article['id'])
            state["undo_stack"].append({"id": active_article['id'], "type": "archive"})
            state["undo_stack"] = state["undo_stack"][-20:]
            state["full_fetch"] = False
            toast_msg = "Archived."
            bms = rss_engine.get_bookmarks()
            if active_article['id'] in bms:
                del bms[active_article['id']]
                rss_engine.save_bookmarks(bms)
        elif action == "skip":
            toast_msg = "Skipped."
            if state["current_idx"] < len(candidates) - 1:
                state["current_idx"] += 1
            state["full_fetch"] = False
        elif action == "bookmark":
            bms = rss_engine.get_bookmarks()
            bms[active_article['id']] = safe_progress
            rss_engine.save_bookmarks(bms)
            state["saved_progress"] = safe_progress
            toast_msg = "Spot saved!"
        elif action == "unbookmark":
            bms = rss_engine.get_bookmarks()
            aid = active_article['id']
            if aid in bms:
                del bms[aid]
                rss_engine.save_bookmarks(bms)
            toast_msg = "Bookmark removed."
        elif action == "readwise":
            toast_msg = rss_engine.send_to_readwise(
                active_article.get('link', ''),
                active_article.get('html_body', ''),
                active_article.get('title', 'Unknown Title')
            )
            
        elif action == "queue_audio":
            state["audio_bin"][active_article['id']] = {"status": "generating", "path": ""}
            toast_msg = "Sent to Audio Bin!"
            
            # Fire and forget the background thread
            t = threading.Thread(
                target=_process_audio_queue,
                args=(active_article['id'], active_article.get('html_body', '')),
                daemon=True,
            )
            t.start()
            
        # Added the removal logic to delete the physical file!
        elif action == "remove_audio":
            if active_article['id'] in state["audio_bin"]:
                audio_data = state["audio_bin"].pop(active_article['id'])
                rss_engine.save_audio_bin(state["audio_bin"])
                path = audio_data.get("path", "")
                if path and os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception:
                        pass
            toast_msg = "Audio file deleted."

    if action == "undo":
        if state["view_mode"] == "Archive" and active_article:
            rss_engine.mark_unread(active_article['id'])
            state["full_fetch"] = False
            toast_msg = "Unarchived."
        elif state["undo_stack"]:
            last = state["undo_stack"].pop()
            rss_engine.mark_unread(last["id"])
            candidates, _, _, _ = get_filtered_articles()
            ids = [c['id'] for c in candidates]
            if last["id"] in ids:
                state["current_idx"] = ids.index(last["id"])
            state["full_fetch"] = False
            toast_msg = "Undid archive."

    new_active, new_candidates = get_active_info()
    if action == "bookmark":
        state["saved_progress"] = safe_progress

    return templates.TemplateResponse(
        request=request, 
        name="article_partial.html", 
        context={
            "request": request,
            "state": state,
            "active_article": new_active,
            "total_count": len(new_candidates) if new_candidates else 0,
            "is_htmx": True,
            "toast_msg": toast_msg,
        }
    )

# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import webview

    def run_server():
        uvicorn.run(app, host="127.0.0.1", port=8088, log_level="warning")

    def prewarm_cache():
        import time
        time.sleep(1.5)
        rss_engine.fetch_feeds_config()
        rss_engine.fetch_master_archive()

    threading.Thread(target=run_server, daemon=True).start()
    threading.Thread(target=prewarm_cache, daemon=True).start()

    webview.create_window("RSS Triage", "http://127.0.0.1:8088/?nocache=1", width=1300, height=900)
    webview.start()

    os._exit(0)
