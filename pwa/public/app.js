// ═══════════════════════════════════════════════════════════════════════════
// RSS TRIAGE PWA
// ═══════════════════════════════════════════════════════════════════════════

// ── Firebase Config ──────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyBvNjSGiWQofUd3omAcBvJ-pa2pAtG2KNs",
    // Use the domain the app is actually served from (both Firebase Hosting
    // domains serve /__/auth/handler), so redirect sign-in isn't broken by
    // browsers' third-party storage partitioning.
    authDomain: (location.hostname.endsWith(".web.app") || location.hostname.endsWith(".firebaseapp.com"))
        ? location.hostname
        : "rss-triage.firebaseapp.com",
    databaseURL: "https://rss-triage-default-rtdb.firebaseio.com",
    projectId: "rss-triage",
    storageBucket: "rss-triage.firebasestorage.app",
    messagingSenderId: "30387056427",
    appId: "1:30387056427:web:116cf9cfd171d14b05df6e"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();
const db = firebase.database();

// ── GitHub & Proxy Config ────────────────────────────────────────────────
const GITHUB_USER = "chaunceybuey";
const GITHUB_REPO = "cloud-catcher";
const PROXY_URL = "https://script.google.com/macros/s/AKfycbw2U9jgVSwbRSHicSuxYeGDs1z_xeGh4bQvreP4Vsim9uFGVMFSZi-2_jAY1XI7XThc/exec";

// ── App State ────────────────────────────────────────────────────────────
let state = {
    articles: [],
    feeds: [],
    feedOrder: [],          // sidebar order: keys like "feed:Name" / "cat:Name"
    hiddenFeeds: new Set(), // newsletter senders the user chose to hide
    reorderMode: false,
    history: new Set(),
    bookmarks: {},
    mode: "Unread",
    feedFilter: "All Feeds",
    currentArticle: null,
    currentHtml: null,
    pagination: null,
    readThisSession: new Set(),
    _selectedCardIdx: 0,
    _expandedCategories: {}
};

function cleanFeedName(name) {
    if (!name) return "Untitled Feed";
    return String(name).replace(/["<>]/g, "").trim() || "Untitled Feed";
}

function escapeAttr(str) {
    return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Plain text going into innerHTML (titles, feed names, authors)
const escapeHtml = escapeAttr;

// Article / newsletter HTML: strip scripts, event handlers, javascript: links.
// Uses DOMPurify when it loaded; falls back to a basic DOM scrub otherwise.
function sanitizeHtml(html) {
    if (window.DOMPurify) {
        return DOMPurify.sanitize(html, {
            FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "object", "embed"],
            ADD_ATTR: ["target"]
        });
    }
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    doc.querySelectorAll("script, iframe, object, embed, form, style, link, meta, base").forEach(el => el.remove());
    doc.querySelectorAll("*").forEach(el => {
        [...el.attributes].forEach(attr => {
            const name = attr.name.toLowerCase();
            const val = attr.value.trim().toLowerCase();
            if (name.startsWith("on")) el.removeAttribute(attr.name);
            else if ((name === "href" || name === "src" || name === "xlink:href" || name === "action")
                     && (val.startsWith("javascript:") || val.startsWith("vbscript:") || val.startsWith("data:text/html"))) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return doc.body.innerHTML;
}

if (window.DOMPurify) {
    // Links in articles open in a new tab instead of navigating away from the app
    DOMPurify.addHook("afterSanitizeAttributes", node => {
        if (node.tagName === "A" && node.getAttribute("href") && !node.getAttribute("href").startsWith("#")) {
            node.setAttribute("target", "_blank");
            node.setAttribute("rel", "noopener noreferrer");
        }
    });
}

function parseDate(raw) {
    const t = Date.parse(raw || "");
    return isNaN(t) ? 0 : t;
}

// ═══ AUTH ═════════════════════════════════════════════════════════════════

function isStandalone() {
    return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function triggerGoogleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    // Popups are unreliable in installed PWAs (especially iOS) — use redirect there.
    if (isStandalone()) {
        auth.signInWithRedirect(provider);
        return;
    }
    auth.signInWithPopup(provider).catch(err => {
        console.error("Popup login failed:", err);
        if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
            auth.signInWithRedirect(provider);
        } else if (err.code === "auth/popup-closed-by-user" || err.code === "auth/cancelled-popup-request") {
            // User closed the popup or a second click replaced it — not an error worth alerting
        } else {
            alert("Login failed: " + err.message);
        }
    });
}

document.getElementById("login-btn")?.addEventListener("click", triggerGoogleLogin);

// Surface errors from a redirect sign-in (otherwise they fail silently)
auth.getRedirectResult().catch(err => {
    console.error("Redirect login failed:", err);
    alert("Login failed: " + err.message);
});

auth.onAuthStateChanged(user => {
    if (user) {
        document.getElementById("login-screen")?.classList.add("hidden");
        loadData();
        if (isLargeScreen()) {
            const drawer = document.getElementById("drawer");
            drawer?.classList.remove("hidden");
            drawer?.classList.add("open");
        }
    } else {
        document.getElementById("login-screen")?.classList.remove("hidden");
        document.getElementById("feed-screen")?.classList.add("hidden");
        document.getElementById("reader-screen")?.classList.add("hidden");
        document.getElementById("drawer")?.classList.add("hidden");
    }
});

// ═══ SYNCED STATE (history / bookmarks) ══════════════════════════════════
// Stored as JSON strings (the Python scripts read this format). Writes go
// through transactions that merge with the server copy, so two devices
// archiving at the same time no longer wipe each other's changes.

function parseJsonSafe(str, fallback) {
    try { return JSON.parse(str); } catch(e) { return fallback; }
}

// Saves used to fail silently (console only), which looks like "it doesn't
// stick" after a reload. Show the reason on screen instead.
function reportSaveError(what, err) {
    console.error(`Saving ${what} failed:`, err);
    const reason = err?.code || err?.message || String(err);
    const hint = /permission/i.test(reason) ? " — check the Realtime Database rules" : "";
    showToast(`Couldn't save ${what} (${reason})${hint}`, 6000);
}

function addToHistory(ids) {
    const list = [...ids].map(String);
    list.forEach(id => state.history.add(id));
    return db.ref("app_data/history").transaction(current => {
        const merged = new Set(parseJsonSafe(current, []).map(String));
        list.forEach(id => merged.add(id));
        return JSON.stringify([...merged]);
    }).catch(err => reportSaveError("read/archived state", err));
}

function setBookmark(id, on) {
    id = String(id);
    if (on) state.bookmarks[id] = state.bookmarks[id] ?? 0;
    else delete state.bookmarks[id];
    return db.ref("app_data/bookmarks").transaction(current => {
        const bms = parseJsonSafe(current, {}) || {};
        if (on) bms[id] = bms[id] ?? 0;
        else delete bms[id];
        return JSON.stringify(bms);
    }).catch(err => reportSaveError("saved articles", err));
}

// ═══ ARTICLE EXTRACTION ══════════════════════════════════════════════════

function extractArticle(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    doc.querySelectorAll("table, img, div, td").forEach(el => {
        el.removeAttribute("width");
        el.removeAttribute("height");
        if (el.tagName === "IMG") {
            el.style.maxWidth = "100%";
            el.style.height = "auto";
        }
    });
    
    doc.querySelectorAll([
        "script", "style", "nav", "footer", "header", "aside", "noscript", "iframe",
        "svg", "canvas", "form", "input", "button", "select", "textarea",
        ".sidebar", ".comments", ".ad", ".social", ".related", ".share", ".sharing",
        ".newsletter", ".subscribe", ".popup", ".modal", ".overlay", ".banner",
        ".nav", ".menu", ".toolbar", ".breadcrumb", ".pagination",
        ".author-bio", ".author-info", ".byline-section",
        "[role='navigation']", "[role='banner']", "[role='complementary']",
        "[aria-hidden='true']",
        "[class*='social']", "[class*='share']", "[class*='icon']",
        "[class*='newsletter']", "[class*='subscribe']", "[class*='promo']",
        "[class*='advert']", "[class*='sponsor']", "[class*='widget']",
        "[class*='cookie']", "[class*='consent']",
        "[id*='social']", "[id*='share']", "[id*='newsletter']",
    ].join(", ")).forEach(el => el.remove());
    
    doc.querySelectorAll("img").forEach(img => {
        const w = parseInt(img.getAttribute("width")) || 0;
        const h = parseInt(img.getAttribute("height")) || 0;
        if ((w > 0 && w < 80) || (h > 0 && h < 80)) img.remove();
    });
    
    const main = doc.querySelector("article") || doc.querySelector("[role='main']") || doc.querySelector("main") || doc.querySelector(".post-content, .article-body, .entry-content, .story-body, .article__body") || doc.body;
    
    main.querySelectorAll("svg, [class*='icon'], [class*='share'], [class*='social']").forEach(el => el.remove());
    
    try {
        const base = new URL(url);
        main.querySelectorAll("img").forEach(img => {
            const src = img.getAttribute("data-src") || img.getAttribute("src");
            if (src && !src.startsWith("http") && !src.startsWith("data:")) {
                img.src = new URL(src, base).href;
            } else if (src) {
                img.src = src;
            }
        });
        main.querySelectorAll("a").forEach(a => {
            const href = a.getAttribute("href");
            if (href && !href.startsWith("http") && !href.startsWith("#")) {
                a.href = new URL(href, base).href;
            }
        });
    } catch(e) {}
    
    return main.innerHTML;
}

async function fetchFullText(url) {
    const res = await fetch(PROXY_URL + "?url=" + encodeURIComponent(url));
    if (!res.ok) throw new Error("Proxy returned " + res.status);
    const html = await res.text();
    if (html.startsWith("ERROR:")) throw new Error(html);
    if (html.length < 200) throw new Error("Response too short (" + html.length + " chars)");
    return extractArticle(html, url);
}

// ── Paste a Link ─────────────────────────────────────────────────────────

document.getElementById("paste-link-btn")?.addEventListener("click", async () => {
    const input = document.getElementById("paste-link-input");
    const status = document.getElementById("paste-link-status");
    const url = input.value.trim();

    if (!url || !url.startsWith("http")) {
        status.textContent = "Paste a valid URL";
        status.style.color = "#ff4444";
        return;
    }

    status.textContent = "Fetching...";
    status.style.color = "#5A5F67";

    try {
        const res = await fetch(PROXY_URL + "?url=" + encodeURIComponent(url));
        if (!res.ok) throw new Error("Proxy returned " + res.status);
        const rawHtml = await res.text();
        if (rawHtml.startsWith("ERROR:")) throw new Error(rawHtml);
        if (rawHtml.length < 200) throw new Error("Response too short");

        const metaDoc = new DOMParser().parseFromString(rawHtml, "text/html");
        const ogTitle = metaDoc.querySelector('meta[property="og:title"]')?.getAttribute("content");
        const pageTitle = metaDoc.querySelector("title")?.textContent;
        const title = ogTitle || pageTitle || url;

        const ogSite = metaDoc.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
        const hostname = new URL(url).hostname.replace("www.", "");
        const siteName = cleanFeedName(ogSite || hostname);

        const fullHtml = extractArticle(rawHtml, url);

        const article = {
            id: "manual_" + md5(url),
            title: title.trim(),
            content: fullHtml,
            link: url,
            feed_name: siteName,
            author: "",
            date: new Date().toISOString(),
            source: "manual"
        };

        const safeKey = md5(url);
        await db.ref(`app_data/articles/${safeKey}`).set(fullHtml);
        // Save the article itself too, so it still exists after a reload
        // (content stays in app_data/articles and is loaded when opened).
        const { content, ...meta } = article;
        await db.ref(`app_data/manual_articles/${safeKey}`).set(meta);

        state.articles = state.articles.filter(a => a.id !== article.id);
        state.articles.unshift(article);
        setBookmark(article.id, true);
        input.value = "";
        status.textContent = "Added!";
        status.style.color = "#00A870";
        closeDrawer();
        renderArticles();
    } catch(err) {
        status.textContent = "Failed: " + err.message;
        status.style.color = "#ff4444";
    }
});

// ═══ DATA LOADING ════════════════════════════════════════════════════════

async function loadData() {
    showScreen("feed");
    document.getElementById("loading")?.classList.remove("hidden");
    const listEl = document.getElementById("article-list");
    if (listEl) listEl.innerHTML = "";

    try {
        const [articlesRes, newsletterRes, feedsRes, savedLinksSnap, orderSnap, manualSnap] = await Promise.all([
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/master_articles.json?t=${Date.now()}`).catch(() => null),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/newsletter_articles.json?t=${Date.now()}`).catch(() => null),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/feeds.json?t=${Date.now()}`).catch(() => null),
            db.ref("app_data/saved_links").once("value").catch(() => null),
            db.ref("app_data/feed_order").once("value").catch(() => null),
            db.ref("app_data/manual_articles").once("value").catch(() => null)
        ]);

        if (orderSnap && orderSnap.val()) {
            try { state.feedOrder = JSON.parse(orderSnap.val()); } catch(e) { state.feedOrder = []; }
        }

        let githubArticles = [];
        if (articlesRes && articlesRes.ok) {
            githubArticles = await articlesRes.json();
        }

        let savedArticles = [];
        if (savedLinksSnap && savedLinksSnap.val()) {
            try {
                const savedData = savedLinksSnap.val();
                savedArticles = Object.values(savedData).map(item => ({
                    id: String(item.id || "saved_" + md5(item.link || item.title || "")),
                    title: item.title,
                    link: item.link,
                    feed_name: "Saved Articles",
                    author: "Mobile Bookmarklet",
                    date: item.date || new Date().toISOString(),
                    source: "mobile_catch"
                }));
            } catch (e) {
                console.error("Failed to parse saved links", e);
            }
        }

        let manualArticles = [];
        if (manualSnap && manualSnap.val()) {
            manualArticles = Object.values(manualSnap.val())
                .filter(m => m && m.id)
                .map(m => ({ ...m, source: "manual" }));
        }

        state.articles = [...manualArticles, ...savedArticles, ...(Array.isArray(githubArticles) ? githubArticles : [])];

        if (newsletterRes && newsletterRes.ok) {
            try {
                const newsletters = await newsletterRes.json();
                const existingIds = new Set(state.articles.map(a => String(a.id)));
                newsletters.forEach(n => {
                    if (n && (n.title || n.content)) {
                        const nid = String(n.id || md5((n.link || "") + (n.title || "")));
                        if (!existingIds.has(nid)) {
                            state.articles.push({ ...n, id: nid });
                            existingIds.add(nid);
                        }
                    }
                });
            } catch(e) {}
        }

        // Normalize all article feed_names and ensure valid string IDs so nothing gets orphaned
        state.articles = state.articles.filter(a => a && (a.title || a.content)).map(a => ({
            ...a,
            id: String(a.id || md5((a.link || "") + (a.title || ""))),
            feed_name: cleanFeedName(a.feed_name)
        }));
        
        if (feedsRes && feedsRes.ok) {
            const feedsData = await feedsRes.json();
            state.feeds = [];
            for (const [category, feedList] of Object.entries(feedsData)) {
                for (const feed of feedList) {
                    state.feeds.push({
                        ...feed,
                        name: cleanFeedName(feed.name),
                        _category: category
                    });
                }
            }
            
            if (savedArticles.length > 0) {
                state.feeds.push({
                    name: "Saved Articles",
                    url: "",
                    _category: "Uncategorized",
                    _isVirtual: true
                });
            }
        }

        // Register newsletter senders directly as top-level uncategorized feeds
        const allNewsletterSenders = [...new Set(state.articles.filter(a => a.source === "newsletter").map(a => a.feed_name))];
        allNewsletterSenders.forEach(senderName => {
            if (senderName && !state.feeds.some(f => f.name === senderName)) {
                state.feeds.push({ name: senderName, url: "", _category: "Uncategorized", _isVirtual: true });
            }
        });

        const [histSnap, bmSnap, hiddenSnap] = await Promise.all([
            db.ref("app_data/history").once("value"),
            db.ref("app_data/bookmarks").once("value"),
            db.ref("app_data/hidden_feeds").once("value").catch(() => null),
        ]);

        if (histSnap.val()) state.history = new Set(parseJsonSafe(histSnap.val(), []).map(String));
        if (bmSnap.val()) state.bookmarks = parseJsonSafe(bmSnap.val(), {}) || {};
        state.hiddenFeeds = new Set(hiddenSnap?.val() ? parseJsonSafe(hiddenSnap.val(), []) : []);
        normalizeFeedOrder();

        db.ref("app_data/history").off();
        db.ref("app_data/history").on("value", snap => {
            if (snap.val()) state.history = new Set(parseJsonSafe(snap.val(), []).map(String));
            if (!document.getElementById("feed-screen")?.classList.contains("hidden")) {
                renderArticles();
            }
        });

    } catch (err) {
        console.error("Failed to load data:", err);
    }

    document.getElementById("loading")?.classList.add("hidden");
    renderArticles();

    if (isLargeScreen()) {
        renderDrawerFeeds();
        updateDrawerModes();
    }
}

// ═══ ARTICLE RENDERING ═══════════════════════════════════════════════════

function getBaseArticlesForMode() {
    const activeFeedNames = new Set(state.feeds.map(f => f.name));
    const isSpecial = (a) => a.source === "newsletter" || a.source === "manual" || a.source === "mobile_catch";
    const includeArticle = (a) => !state.hiddenFeeds.has(a.feed_name) && (activeFeedNames.has(a.feed_name) || isSpecial(a));

    if (state.mode === "Unread") {
        return state.articles.filter(a => !state.history.has(a.id) && includeArticle(a));
    } else if (state.mode === "Bookmarks") {
        return state.articles.filter(a => a.id in state.bookmarks && includeArticle(a));
    } else {
        return state.articles.filter(a => state.history.has(a.id) && includeArticle(a));
    }
}

function getFilteredArticles() {
    let base = getBaseArticlesForMode();

    if (state.feedFilter.startsWith("category:")) {
        const catName = state.feedFilter.slice(9);
        const catFeeds = new Set(state.feeds.filter(f => f._category === catName).map(f => f.name));
        base = base.filter(a => catFeeds.has(a.feed_name));
    } else if (state.feedFilter !== "All Feeds") {
        base = base.filter(a => a.feed_name === state.feedFilter);
    }

    // Parse dates rather than comparing strings: RSS often uses RFC 822
    // ("Mon, 03 Nov 2026 …"), which doesn't sort correctly as text.
    base.sort((a, b) => parseDate(b.date) - parseDate(a.date));
    return base;
}

function formatDate(raw) {
    if (!raw) return "";
    const dt = new Date(raw);
    if (isNaN(dt)) return String(raw).slice(0, 10);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
}

function renderArticles() {
    const list = document.getElementById("article-list");
    const empty = document.getElementById("empty-state");
    if (!list || !empty) return;

    const filtered = getFilteredArticles();
    state._selectedCardIdx = 0;

    updateFeedHeader(filtered.length);

    if (filtered.length === 0) {
        list.innerHTML = "";
        empty.classList.remove("hidden");
        return;
    }
    empty.classList.add("hidden");

    list.innerHTML = filtered.map((article, idx) => `
        <div class="article-card" data-id="${escapeAttr(article.id)}" data-idx="${idx}">
            <span class="card-swipe-label left">Archive</span>
            <span class="card-swipe-label right">Save</span>
            <div class="card-feed">${escapeHtml(article.feed_name)}</div>
            <div class="card-title">${escapeHtml(article.title || "Untitled")}</div>
            <div class="card-meta">
                <span class="card-date">${escapeHtml(formatDate(article.date))}</span>
                ${article.author ? `<span class="card-author">${escapeHtml(article.author)}</span>` : ""}
            </div>
        </div>
    `).join("");

    list.querySelectorAll(".article-card").forEach(card => {
        const articleId = card.dataset.id;
        const article = filtered[parseInt(card.dataset.idx)];

        card.addEventListener("click", () => {
            if (card.classList.contains("swiping")) return;
            openArticle(article);
        });

        if (typeof Hammer === "undefined") return;
        const hammer = new Hammer(card, { threshold: 50 });
        hammer.on("panstart", () => card.classList.add("swiping"));
        hammer.on("panmove", (e) => {
            card.style.transform = `translateX(${e.deltaX}px)`;
            card.style.opacity = Math.max(0.3, 1 - Math.abs(e.deltaX) / 300);
            const leftLabel = card.querySelector(".card-swipe-label.left");
            const rightLabel = card.querySelector(".card-swipe-label.right");
            leftLabel.style.opacity = e.deltaX < -30 ? Math.min(1, (-e.deltaX - 30) / 80) : 0;
            rightLabel.style.opacity = e.deltaX > 30 ? Math.min(1, (e.deltaX - 30) / 80) : 0;
        });
        hammer.on("panend", (e) => {
            if (e.deltaX < -120) {
                card.style.transform = "";
                card.style.opacity = "";
                card.classList.add("dismissed");
                setTimeout(() => archiveArticle(articleId), 300);
            } else if (e.deltaX > 120) {
                bookmarkArticle(articleId);
                card.style.transform = "";
                card.style.opacity = "";
                showToast("Saved");
            } else {
                card.style.transform = "";
                card.style.opacity = "";
            }
            card.querySelector(".card-swipe-label.left").style.opacity = 0;
            card.querySelector(".card-swipe-label.right").style.opacity = 0;
            setTimeout(() => card.classList.remove("swiping"), 50);
        });
    });
}

// ═══ ARTICLE READER ══════════════════════════════════════════════════════

function openArticle(article) {
    state.currentArticle = article;
    state.readThisSession.add(article.id);
    requestWakeLock();

    const bmBtn = document.getElementById("reader-bookmark");
    bmBtn?.classList.toggle("active-action", article.id in state.bookmarks);

    showScreen("reader");

    const contentEl = document.getElementById("reader-content");
    if (contentEl) {
        contentEl.innerHTML = '<div class="reader-pages"><p style="color:#5A5F67;">Loading...</p></div>';
    }

    const feedName = escapeHtml(article.feed_name);
    const date = escapeHtml(formatDate(article.date));
    const author = article.author ? `By ${escapeHtml(article.author)}` : "";
    const title = escapeHtml(article.title || "Untitled");

    const headerHtml = `
        <div class="article-header-meta">${feedName} · ${date}</div>
        <div class="article-header-title">${title}</div>
        ${author ? `<div class="article-header-author">${author}</div>` : '<div class="article-header-divider"></div>'}
    `;

    const safeKey = md5(article.link || article.id);
    
    // Newsletters (and pasted articles still in memory) carry their content inline.
    // Pasted articles reloaded from Firebase fall through to the cached copy below.
    if (article.source === "newsletter" || (article.source === "manual" && article.content)) {
        setupPagination(headerHtml + (article.content || ""));
        enterFullscreen();
        return;
    }

    db.ref(`app_data/articles/${safeKey}`).once("value").then(snap => {
        if (state.currentArticle !== article) return; // user already moved on
        const cached = snap.val();
        const isManual = article.source === "manual";
        if (cached && (isManual || (cached.length > 500 && !cached.includes("Sign in") && !cached.includes("to continue to Gmail")))) {
            setupPagination(headerHtml + cached);
            enterFullscreen();
        } else {
            const summary = article.content || '<p style="color:#5A5F67;font-style:italic;">No summary available.</p>';
            const fetchButton = `
                <div class="fetch-btn-wrapper">
                    <button id="fetch-full-btn">Read</button>
                </div>
            `;
            setupPagination(headerHtml + summary + fetchButton);

            setTimeout(() => {
                const btn = document.getElementById("fetch-full-btn");
                if (btn) {
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        btn.textContent = "Fetching...";
                        btn.style.color = "#5A5F67";

                        fetchFullText(article.link).then(fullHtml => {
                            db.ref(`app_data/articles/${safeKey}`).set(fullHtml).catch(() => {});
                            if (state.currentArticle !== article) return;
                            setupPagination(headerHtml + fullHtml);
                            enterFullscreen();
                        }).catch(err => {
                            btn.textContent = "Failed — try again";
                            btn.style.color = "#ff4444";
                            console.error("Full text fetch failed:", err);
                        });
                    });
                }
            }, 200);
        }
    });
}

function setupPagination(html) {
    html = sanitizeHtml(html);
    state.currentHtml = html;
    setTimeout(() => {
        const body = document.getElementById("reader-content");
        if (!body) return;
        
        const style = getComputedStyle(body);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingRight = parseFloat(style.paddingRight) || 0;
        const availableWidth = body.clientWidth - paddingLeft - paddingRight;
        const availableHeight = body.clientHeight;

        if (availableHeight < 100) {
            body.innerHTML = html;
            body.style.overflowY = "auto";
            return;
        }

        body.style.overflowY = "hidden";
        body.innerHTML = `<div id="reader-clip" style="overflow:hidden;height:100%;position:relative;">
            <div class="reader-pages" id="reader-pages">${html}</div></div>`;
        const pages = document.getElementById("reader-pages");

        // 1. Remove embedded <style>, <link>, and non-text junk
        pages.querySelectorAll([
            "style", "link[rel='stylesheet']", "meta", "title", "script", "svg", "iframe",
            "button:not(#fetch-full-btn)", "form", "input",
            ".subscription-widget-wrap", ".subscribe-widget", ".button-wrapper",
            ".post-ufi", ".post-header", ".email-header", ".preheader",
            "[class*='share']", "[class*='social']", "[class*='subscribe']"
        ].join(", ")).forEach(el => el.remove());

        // 2. Strip photos/images from newsletters
        if (state.currentArticle?.source === "newsletter") {
            pages.querySelectorAll("img, picture, figure, figcaption, video").forEach(el => el.remove());
        }

        // 3. Unwrap layout tables bottom-up into standard divs so CSS columns paginate smoothly
        Array.from(pages.querySelectorAll("table, thead, tbody, tfoot, tr, td, th, center"))
            .reverse()
            .forEach(el => {
                const div = document.createElement("div");
                while (el.firstChild) div.appendChild(el.firstChild);
                el.replaceWith(div);
            });

        // 4. Strip newsletter top boilerplate lines ("View in browser", "Read in app", etc.)
        pages.querySelectorAll("div, p, span, a").forEach(el => {
            if (el.children.length > 2) return;
            const txt = (el.textContent || "").trim().toLowerCase();
            if (
                txt === "view in browser" ||
                txt === "view this email in your browser" ||
                txt === "read in app" ||
                txt === "open in app" ||
                txt === "subscribe" ||
                txt === "share" ||
                txt === "leave a comment" ||
                txt === "restack"
            ) {
                el.remove();
            }
        });

        // 5. Clean up empty elements and double line breaks
        pages.querySelectorAll("p, div, span").forEach(el => {
            if (
                !el.classList.contains("article-header-divider") &&
                !el.children.length &&
                !el.textContent.trim()
            ) {
                el.remove();
            }
        });
        pages.querySelectorAll("br").forEach(br => {
            if (br.nextElementSibling && br.nextElementSibling.tagName === "BR") br.remove();
        });

        // 6. Strip legacy HTML attributes and inline box-model/color styles
        pages.querySelectorAll("*").forEach(el => {
            if (
                el.classList.contains("article-header-meta") ||
                el.classList.contains("article-header-title") ||
                el.classList.contains("article-header-author") ||
                el.classList.contains("article-header-divider") ||
                el.classList.contains("fetch-btn-wrapper") ||
                el.id === "fetch-full-btn"
            ) return;

            el.removeAttribute("bgcolor");
            el.removeAttribute("color");
            el.removeAttribute("width");
            el.removeAttribute("height");
            el.removeAttribute("align");
            el.removeAttribute("valign");
            el.removeAttribute("border");
            el.removeAttribute("cellpadding");
            el.removeAttribute("cellspacing");

            if (el.hasAttribute("style")) {
                const s = el.style;
                [
                    "color", "background", "background-color", "background-image",
                    "font-family", "font-size", "line-height",
                    "width", "max-width", "min-width",
                    "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
                    "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
                    "border", "border-top", "border-bottom", "border-left", "border-right",
                    "box-shadow", "border-radius"
                ].forEach(prop => s.removeProperty(prop));

                if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
            }
        });

        pages.querySelectorAll("img, figure, video").forEach(el => {
            el.style.maxHeight = (availableHeight - 60) + "px";
            el.style.objectFit = "contain";
        });

        pages.style.height = availableHeight + "px";
        pages.style.columnWidth = availableWidth + "px";
        pages.style.columnGap = "0px";

        setTimeout(() => {
            const step = pages.getBoundingClientRect().width;
            const totalWidth = pages.scrollWidth;
            const totalPages = Math.max(1, Math.round(totalWidth / step));

            state.pagination = { el: pages, current: 0, total: totalPages, step: step };
            updatePageIndicator();

            if (state.currentArticle) {
                db.ref(`app_data/positions/${state.currentArticle.id}`).once("value").then(snap => {
                    const saved = snap.val();
                    if (saved && saved > 0) {
                        const targetPage = Math.round(saved * (totalPages - 1));
                        if (targetPage > 0 && targetPage < totalPages) {
                            goToPage(targetPage);
                        }
                    }
                }).catch(() => {});
            }
        }, 50);
    }, 50);
}

let _resizeTimer = null;
window.addEventListener("resize", () => {
    if (!state.currentArticle || !state.currentHtml) return;
    if (document.getElementById("reader-screen")?.classList.contains("hidden")) return;
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        setupPagination(state.currentHtml);
    }, 200);
});

function goToPage(page) {
    const p = state.pagination;
    if (!p) return;
    page = Math.max(0, Math.min(page, p.total - 1));
    p.current = page;
    p.el.style.transform = `translateX(-${page * p.step}px)`;
    updatePageIndicator();
    if (state.currentArticle && p.total > 1) {
        const progress = page / (p.total - 1);
        try { db.ref(`app_data/positions/${state.currentArticle.id}`).set(progress); } catch(e) {}
    }
}

function updatePageIndicator() {
    const p = state.pagination;
    if (!p) return;
    const bar = document.getElementById("page-progress-bar");
    if (bar) bar.style.width = `${((p.current + 1) / p.total) * 100}%`;
}

// Leave the reader through browser history when possible, so the history
// stack stays in sync (otherwise the next Back press lands somewhere odd).
function leaveReader() {
    if (history.state?.screen === "reader") {
        history.back(); // popstate → goBackToFeed()
    } else {
        goBackToFeed();
    }
}

document.getElementById("reader-back")?.addEventListener("click", leaveReader);

document.getElementById("reader-archive")?.addEventListener("click", () => {
    if (state.currentArticle) {
        archiveArticle(state.currentArticle.id);
        leaveReader();
    }
});

document.getElementById("reader-bookmark")?.addEventListener("click", () => {
    if (state.currentArticle) {
        const id = state.currentArticle.id;
        setBookmark(id, !(id in state.bookmarks));
        document.getElementById("reader-bookmark")?.classList.toggle("active-action", id in state.bookmarks);
    }
});

document.getElementById("reader-readwise")?.addEventListener("click", () => {
    if (state.currentArticle?.link) {
        window.open(state.currentArticle.link, "_blank");
    }
});

// ═══ FULLSCREEN & WAKE LOCK ══════════════════════════════════════════════

let _wakeLock = null;

async function requestWakeLock() {
    // Reuse a live lock instead of piling up a new one per article
    if (_wakeLock && !_wakeLock.released) return;
    try {
        if ("wakeLock" in navigator) {
            _wakeLock = await navigator.wakeLock.request("screen");
        }
    } catch(e) {}
}

function releaseWakeLock() {
    if (_wakeLock) {
        _wakeLock.release().catch(() => {});
        _wakeLock = null;
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.currentArticle) {
        requestWakeLock();
    }
});

function enterFullscreen() {
    if (window.innerWidth > 768) return;
    try {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } catch(e) {}
}

function exitFullscreen() {
    try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    } catch(e) {}
}

// ═══ ACTIONS ═════════════════════════════════════════════════════════════

function archiveArticle(articleId) {
    addToHistory([articleId]);
    renderArticles();
    if (isLargeScreen()) renderDrawerFeeds();
}

function bookmarkArticle(articleId) {
    setBookmark(articleId, true);
}

function showToast(message, duration = 2500) {
    const toast = document.createElement("div");
    toast.style.cssText = "position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:#E5E7EB;color:#0a0a0a;padding:0.6rem 1.2rem;border-radius:0.5rem;font-size:0.85rem;font-weight:700;z-index:1000;max-width:90vw;text-align:center;transition:opacity 0.3s;";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, duration);
}

// ═══ NAVIGATION ══════════════════════════════════════════════════════════

function showScreen(name, pushHistory = true) {
    document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(`${name}-screen`)?.classList.remove("hidden");

    if (pushHistory && name !== "feed") {
        if (history.state?.screen === name) {
            history.replaceState({ screen: name }, "");
        } else {
            history.pushState({ screen: name }, "");
        }
    }
}

function goBackToFeed() {
    if (state.readThisSession.size > 0 && state.mode === "Unread") {
        const toArchive = [...state.readThisSession]
            .map(String)
            .filter(id => !(id in state.bookmarks) && !state.history.has(id));
        if (toArchive.length > 0) {
            addToHistory(toArchive);
            const n = toArchive.length;
            setTimeout(() => showToast(`${n} article${n > 1 ? 's' : ''} archived`), 100);
        }
    }
    state.readThisSession.clear();
    state.currentArticle = null;
    state.currentHtml = null;
    exitFullscreen();
    releaseWakeLock();
    showScreen("feed", false);
    renderArticles();
    if (isLargeScreen()) renderDrawerFeeds();
}

window.addEventListener("popstate", (e) => {
    const targetScreen = e.state?.screen || "feed";
    if (targetScreen === "feed") {
        goBackToFeed();
    } else {
        showScreen(targetScreen, false);
    }
});

history.replaceState({ screen: "feed" }, "");

// ═══ PAGE TURNING IN READER ══════════════════════════════════════════════

(function setupReaderGestures() {
    const readerBody = document.getElementById("reader-content");
    if (!readerBody) return;

    // If the gesture library failed to load, keep taps and keyboard working
    // instead of letting one error stop the rest of app.js from running.
    if (typeof Hammer !== "undefined") {
    const hammer = new Hammer(readerBody, { threshold: 40 });
    hammer.get("swipe").set({ direction: Hammer.DIRECTION_ALL });

    hammer.on("swipeleft", () => {
        if (state.pagination) goToPage(state.pagination.current + 1);
    });

    hammer.on("swiperight", () => {
        if (state.pagination) goToPage(state.pagination.current - 1);
    });

    hammer.on("swipeup", () => {
        if (!state.currentArticle) return;
        const filtered = getFilteredArticles();
        const idx = filtered.findIndex(a => a.id === state.currentArticle.id);
        if (idx < filtered.length - 1) {
            openArticle(filtered[idx + 1]);
        }
    });

    hammer.on("swipedown", () => {
        if (!state.currentArticle) return;
        const filtered = getFilteredArticles();
        const idx = filtered.findIndex(a => a.id === state.currentArticle.id);
        if (idx > 0) {
            openArticle(filtered[idx - 1]);
        }
    });
    }

    readerBody.addEventListener("click", (e) => {
        if (!state.pagination) return;
        if (e.target.closest("a, button")) return; // tapping a link shouldn't also turn the page
        const x = e.clientX;
        const width = window.innerWidth;
        if (x < width * 0.3) {
            goToPage(state.pagination.current - 1);
        } else if (x > width * 0.7) {
            goToPage(state.pagination.current + 1);
        }
    });

    let edgeSwipeStartX = null;
    readerBody.addEventListener("touchstart", (e) => {
        const x = e.touches[0].clientX;
        edgeSwipeStartX = x < 25 ? x : null;
    }, { passive: true });

    readerBody.addEventListener("touchend", (e) => {
        if (edgeSwipeStartX !== null) {
            const endX = e.changedTouches[0].clientX;
            if (endX - edgeSwipeStartX > 80) {
                leaveReader();
            }
        }
        edgeSwipeStartX = null;
    }, { passive: true });
})();

// ═══ KEYBOARD SHORTCUTS ══════════════════════════════════════════════════

document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const onFeed = !document.getElementById("feed-screen")?.classList.contains("hidden");
    const onReader = !document.getElementById("reader-screen")?.classList.contains("hidden");

    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;

    if (onFeed) {
        const filtered = getFilteredArticles();
        const cards = document.querySelectorAll(".article-card");
        const selectedIdx = state._selectedCardIdx || 0;

        if (key === "j" && cards.length > 0) {
            e.preventDefault();
            state._selectedCardIdx = Math.min(selectedIdx + 1, cards.length - 1);
            cards[state._selectedCardIdx].scrollIntoView({ block: "nearest" });
            cards.forEach(c => c.style.borderLeft = "");
            cards[state._selectedCardIdx].style.borderLeft = "3px solid #D94A00";
        } else if (key === "k" && cards.length > 0) {
            e.preventDefault();
            state._selectedCardIdx = Math.max(selectedIdx - 1, 0);
            cards[state._selectedCardIdx].scrollIntoView({ block: "nearest" });
            cards.forEach(c => c.style.borderLeft = "");
            cards[state._selectedCardIdx].style.borderLeft = "3px solid #D94A00";
        } else if (key === "enter" && cards.length > 0) {
            e.preventDefault();
            const article = filtered[state._selectedCardIdx || 0];
            if (article) openArticle(article);
        } else if (key === "a" && cards.length > 0) {
            e.preventDefault();
            const article = filtered[state._selectedCardIdx || 0];
            if (article) archiveArticle(article.id);
        } else if (key === "s" && cards.length > 0) {
            // Save the selected article, then move to the next one
            e.preventDefault();
            const article = filtered[state._selectedCardIdx || 0];
            if (article) {
                bookmarkArticle(article.id);
                showToast("Saved");
            }
            state._selectedCardIdx = Math.min((state._selectedCardIdx || 0) + 1, cards.length - 1);
            cards.forEach(c => c.style.borderLeft = "");
            if (cards[state._selectedCardIdx]) {
                cards[state._selectedCardIdx].style.borderLeft = "3px solid #D94A00";
                cards[state._selectedCardIdx].scrollIntoView({ block: "nearest" });
            }
        }
    }

    if (onReader) {
        if (key === "arrowright" || (key === " " && !e.shiftKey)) {
            e.preventDefault();
            if (state.pagination) goToPage(state.pagination.current + 1);
        } else if (key === "arrowleft" || (key === " " && e.shiftKey)) {
            e.preventDefault();
            if (state.pagination) goToPage(state.pagination.current - 1);
        } else if (key === "j" || key === "arrowdown") {
            e.preventDefault();
            const filtered = getFilteredArticles();
            const idx = filtered.findIndex(a => a.id === state.currentArticle?.id);
            if (idx < filtered.length - 1) openArticle(filtered[idx + 1]);
        } else if (key === "k" || key === "arrowup") {
            e.preventDefault();
            const filtered = getFilteredArticles();
            const idx = filtered.findIndex(a => a.id === state.currentArticle?.id);
            if (idx > 0) openArticle(filtered[idx - 1]);
        } else if (key === "a") {
            if (state.currentArticle) archiveArticle(state.currentArticle.id);
            leaveReader();
        } else if (key === "b") {
            document.getElementById("reader-bookmark")?.click();
        } else if (key === "r" || key === "c") {
            document.getElementById("reader-readwise")?.click();
        } else if (key === "w" || key === "enter") {
            const btn = document.getElementById("fetch-full-btn");
            if (btn) btn.click();
        } else if (key === "escape" || key === "backspace") {
            e.preventDefault();
            leaveReader();
        }
    }
});

// ═══ UTILITIES ═══════════════════════════════════════════════════════════

function md5(str) {
    function rotateLeft(val, shift) { return (val << shift) | (val >>> (32 - shift)); }
    function addUnsigned(a, b) { return ((a & 0x7FFFFFFF) + (b & 0x7FFFFFFF)) ^ (a & 0x80000000) ^ (b & 0x80000000); }
    function f(x, y, z) { return (x & y) | (~x & z); }
    function g(x, y, z) { return (x & z) | (y & ~z); }
    function h(x, y, z) { return x ^ y ^ z; }
    function ii(x, y, z) { return y ^ (x | ~z); }
    function transform(func, a, b, c, d, x, s, ac) {
        a = addUnsigned(a, addUnsigned(addUnsigned(func(b, c, d), x), ac));
        return addUnsigned(rotateLeft(a, s), b);
    }

    let AA, BB, CC, DD, a, b, c, d;
    const S = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21];
    const words = [];
    const msg = unescape(encodeURIComponent(str));
    const msgLen = msg.length;
    const bytes = [];
    for (let i = 0; i < msgLen; i++) bytes.push(msg.charCodeAt(i));
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const bitLen = msgLen * 8;
    bytes.push(bitLen & 0xff, (bitLen >> 8) & 0xff, (bitLen >> 16) & 0xff, (bitLen >> 24) & 0xff, 0, 0, 0, 0);

    for (let i = 0; i < bytes.length; i += 4) {
        words.push(bytes[i] | (bytes[i+1] << 8) | (bytes[i+2] << 16) | (bytes[i+3] << 24));
    }

    a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;

    const T = [];
    for (let i = 1; i <= 64; i++) T.push(Math.floor(Math.abs(Math.sin(i)) * 0x100000000));

    for (let block = 0; block < words.length; block += 16) {
        const x = words.slice(block, block + 16);
        AA = a; BB = b; CC = c; DD = d;

        for (let i = 0; i < 16; i++) {
            a = transform(f, a, b, c, d, x[i], S[i % 4], T[i]);
            [a, b, c, d] = [d, a, b, c];
        }
        for (let i = 0; i < 16; i++) {
            a = transform(g, a, b, c, d, x[(5*i + 1) % 16], S[4 + (i % 4)], T[16 + i]);
            [a, b, c, d] = [d, a, b, c];
        }
        for (let i = 0; i < 16; i++) {
            a = transform(h, a, b, c, d, x[(3*i + 5) % 16], S[8 + (i % 4)], T[32 + i]);
            [a, b, c, d] = [d, a, b, c];
        }
        for (let i = 0; i < 16; i++) {
            a = transform(ii, a, b, c, d, x[(7*i) % 16], S[12 + (i % 4)], T[48 + i]);
            [a, b, c, d] = [d, a, b, c];
        }
        a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
    }

    function toHex(n) {
        let s = "";
        for (let i = 0; i < 4; i++) s += ("0" + ((n >> (i * 8)) & 0xff).toString(16)).slice(-2);
        return s;
    }
    return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

// ═══ DRAWER ══════════════════════════════════════════════════════════════

function isLargeScreen() { return window.innerWidth >= 1100; }

function openDrawer() {
    const drawer = document.getElementById("drawer");
    const overlay = document.getElementById("drawer-overlay");
    if (!drawer || !overlay) return;
    drawer.classList.remove("hidden");
    if (!isLargeScreen()) {
        overlay.classList.remove("hidden");
    }
    drawer.offsetHeight;
    drawer.classList.add("open");
    overlay.classList.add("open");
    renderDrawerFeeds();
    updateDrawerModes();
}

function closeDrawer() {
    if (isLargeScreen()) {
        renderDrawerFeeds();
        return;
    }
    state.reorderMode = false;
    const drawer = document.getElementById("drawer");
    const overlay = document.getElementById("drawer-overlay");
    drawer?.classList.remove("open");
    overlay?.classList.remove("open");
    setTimeout(() => {
        drawer?.classList.add("hidden");
        overlay?.classList.add("hidden");
    }, 300);
}

function updateDrawerModes() {
    document.querySelectorAll(".drawer-mode").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === state.mode);
    });
}

// ── Sidebar order ───────────────────────────────────────────────────────
// state.feedOrder is a list of keys ("feed:<name>" or "cat:<name>").
// Anything not in the list keeps its original position, after the ordered ones.

const feedKey = name => "feed:" + name;
const catKey = name => "cat:" + name;

function normalizeFeedOrder() {
    // Older saved orders may be plain names — map them to prefixed keys
    const cats = new Set(state.feeds.map(f => f._category || "Uncategorized"));
    state.feedOrder = (Array.isArray(state.feedOrder) ? state.feedOrder : [])
        .filter(k => typeof k === "string")
        .map(k => (k.startsWith("feed:") || k.startsWith("cat:")) ? k : (cats.has(k) ? catKey(k) : feedKey(k)));
}

function sortByOrder(items, keyOf) {
    const rank = key => { const i = state.feedOrder.indexOf(key); return i === -1 ? Infinity : i; };
    return items
        .map((item, i) => ({ item, i }))
        .sort((a, b) => (rank(keyOf(a.item)) - rank(keyOf(b.item))) || (a.i - b.i))
        .map(x => x.item);
}

function isUncategorized(cat) {
    return !cat || cat.toLowerCase() === "uncategorized" || cat.toLowerCase() === "my feeds";
}

// The sidebar as an ordered tree: top-level entries are loose feeds and
// categories (which can be interleaved); categories hold their own feeds.
function buildSidebarModel() {
    const categories = {};
    const loose = [];
    state.feeds.forEach(f => {
        if (state.hiddenFeeds.has(f.name)) return;
        const cat = f._category || "Uncategorized";
        if (isUncategorized(cat)) {
            if (!loose.some(x => x.name === f.name)) loose.push(f);
        } else {
            (categories[cat] = categories[cat] || []).push(f);
        }
    });

    const top = [
        ...loose.map(feed => ({ type: "feed", key: feedKey(feed.name), feed })),
        ...Object.entries(categories).map(([name, feeds]) => ({
            type: "cat", key: catKey(name), name,
            feeds: sortByOrder(feeds, f => feedKey(f.name))
        }))
    ];
    return sortByOrder(top, x => x.key);
}

function flattenSidebarModel(model) {
    const keys = [];
    model.forEach(entry => {
        keys.push(entry.key);
        if (entry.type === "cat") entry.feeds.forEach(f => keys.push(feedKey(f.name)));
    });
    return keys;
}

function moveSidebarItem(key, dir) {
    const model = buildSidebarModel();
    const swap = (list, keyOf) => {
        const i = list.findIndex(x => keyOf(x) === key);
        if (i === -1) return false;
        const j = i + dir;
        if (j < 0 || j >= list.length) return true; // already at the edge
        [list[i], list[j]] = [list[j], list[i]];
        return true;
    };
    if (!swap(model, x => x.key)) {
        model.filter(e => e.type === "cat").some(cat => swap(cat.feeds, f => feedKey(f.name)));
    }
    state.feedOrder = flattenSidebarModel(model);
    state._orderSave = db.ref("app_data/feed_order").set(JSON.stringify(state.feedOrder))
        .then(() => true)
        .catch(err => { reportSaveError("feed order", err); return false; });
    renderDrawerFeeds();
}

function hideFeed(name) {
    state.hiddenFeeds.add(name);
    if (state.feedFilter === name) state.feedFilter = "All Feeds";
    db.ref("app_data/hidden_feeds").transaction(current => {
        const list = new Set(parseJsonSafe(current, []) || []);
        list.add(name);
        return JSON.stringify([...list]);
    }).catch(err => reportSaveError("hidden feeds", err));
    renderDrawerFeeds();
    renderArticles();
}

function unhideFeed(name) {
    state.hiddenFeeds.delete(name);
    db.ref("app_data/hidden_feeds").transaction(current => {
        const list = new Set(parseJsonSafe(current, []) || []);
        list.delete(name);
        return JSON.stringify([...list]);
    }).catch(err => reportSaveError("hidden feeds", err));
    renderDrawerFeeds();
    renderArticles();
}

function renderDrawerFeeds() {
    const container = document.getElementById("drawer-feeds");
    if (!container) return;

    const allNewsletterSenders = [...new Set(state.articles.filter(a => a.source === "newsletter").map(a => a.feed_name))];
    allNewsletterSenders.forEach(senderName => {
        if (senderName && !state.feeds.some(f => f.name === senderName)) {
            state.feeds.push({ name: senderName, url: "", _category: "Uncategorized", _isVirtual: true });
        }
    });

    const base = getBaseArticlesForMode();
    const feedCounts = {};
    base.forEach(a => { feedCounts[a.feed_name] = (feedCounts[a.feed_name] || 0) + 1; });

    const reorder = state.reorderMode;
    container.classList.toggle("reordering", reorder);

    const arrows = key => `<span class="drawer-move-group">
            <span class="drawer-move" data-move="${escapeAttr(key)}" data-dir="-1" title="Move up">▲</span>
            <span class="drawer-move" data-move="${escapeAttr(key)}" data-dir="1" title="Move down">▼</span>
        </span>`;

    const feedRow = (feed, cat) => {
        const count = feedCounts[feed.name] || 0;
        const isActive = state.feedFilter === feed.name;
        const isVirtual = feed._isVirtual || !feed.url;
        const right = reorder
            ? arrows(feedKey(feed.name))
            : `<span class="drawer-feed-edit" data-edit-feed="${escapeAttr(feed.name)}" data-edit-cat="${escapeAttr(cat)}" data-virtual="${isVirtual ? 1 : 0}">⋯</span>
               <span class="drawer-feed-count">${count}</span>`;
        return `<div class="drawer-feed-item ${isActive ? 'active' : ''}" data-feed="${escapeAttr(feed.name)}">
            <span class="drawer-feed-name-text">${escapeHtml(feed.name)}</span>
            <span class="drawer-feed-right">${right}</span></div>`;
    };

    let html = reorder
        ? `<div class="drawer-reorder-hint">Use ▲▼ to move feeds and categories (empty ones are shown here too). Open a category to reorder the feeds inside it.</div>`
        : `<div class="drawer-feed-item all-feeds ${state.feedFilter === 'All Feeds' ? 'active' : ''}" data-feed="All Feeds">
            <span>All Feeds</span><span class="drawer-feed-count">${base.length}</span></div>`;

    // Outside reorder mode, feeds with nothing in the current view are hidden
    // (the highlighted one always stays visible). Reorder mode shows everything.
    const showFeed = feed => reorder || (feedCounts[feed.name] || 0) > 0 || state.feedFilter === feed.name;

    for (const entry of buildSidebarModel()) {
        if (entry.type === "feed") {
            if (showFeed(entry.feed)) html += feedRow(entry.feed, "Uncategorized");
            continue;
        }
        const cat = entry.name;
        const catAttr = escapeAttr(cat);
        const catCount = entry.feeds.reduce((sum, f) => sum + (feedCounts[f.name] || 0), 0);
        const isExpanded = state._expandedCategories?.[cat] === true;
        const isCatActive = state.feedFilter === "category:" + cat;
        const visibleFeeds = entry.feeds.filter(showFeed);
        if (!reorder && !isCatActive && visibleFeeds.length === 0) continue;

        html += `<div class="drawer-category ${isCatActive ? 'active-cat' : ''}" data-category="${catAttr}">
            <span class="drawer-cat-toggle" data-cat-toggle="${catAttr}">${isExpanded ? '▾' : '▸'}</span>
            <span class="drawer-cat-name" data-cat-filter="${catAttr}">${escapeHtml(cat)}</span>
            ${reorder ? arrows(entry.key) : `<span class="drawer-category-count">${catCount}</span>`}
        </div>`;
        html += `<div class="drawer-category-feeds ${isExpanded ? '' : 'collapsed'}" data-cat-feeds="${catAttr}">`;
        visibleFeeds.forEach(feed => { html += feedRow(feed, cat); });
        html += `</div>`;
    }

    container.innerHTML = html;

    // Reorder toggle label
    const reorderBtn = document.getElementById("drawer-reorder");
    if (reorderBtn) reorderBtn.textContent = reorder ? "Done" : "Reorder";

    container.querySelectorAll(".drawer-move").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            moveSidebarItem(btn.dataset.move, parseInt(btn.dataset.dir, 10));
        });
    });

    container.querySelectorAll(".drawer-feed-item").forEach(item => {
        item.addEventListener("click", () => {
            if (state.reorderMode) return;
            state.feedFilter = item.dataset.feed;
            closeDrawer();
            renderArticles();
        });
    });

    container.querySelectorAll(".drawer-feed-edit").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const feedName = btn.dataset.editFeed;
            const currentCat = btn.dataset.editCat;

            // Newsletter senders and other virtual feeds aren't in feeds.json,
            // so "removing" them means hiding them in the app.
            if (btn.dataset.virtual === "1") {
                if (confirm(`Hide "${feedName}"?\n\nIts items will no longer appear anywhere in the app, including future emails from this sender. You can bring it back under Settings → Unhide Feeds.`)) {
                    hideFeed(feedName);
                }
                return;
            }

            const categories = [...new Set(state.feeds.filter(f => !f._isVirtual).map(f => f._category || "Uncategorized"))];
            const action = prompt(
                `${feedName}\n\nType:\n  "delete" to remove this feed\n  A category name to move it\n\nCurrent: ${currentCat}\nCategories: ${categories.join(", ")}`
            );

            if (!action) return;

            if (action.toLowerCase() === "delete") {
                if (!confirm(`Delete "${feedName}" from ${currentCat}?`)) return;
                manageFeed("delete_feed", feedName, "", currentCat);
            } else {
                manageFeed("move_feed", feedName, action.trim(), currentCat);
            }
        });
    });

    container.querySelectorAll(".drawer-cat-toggle").forEach(toggle => {
        toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            const catName = toggle.dataset.catToggle;
            const feeds = container.querySelector(`[data-cat-feeds="${CSS.escape(catName)}"]`);
            if (!feeds) return;
            const isCollapsed = feeds.classList.contains("collapsed");
            feeds.classList.toggle("collapsed");
            state._expandedCategories[catName] = isCollapsed;
            toggle.textContent = isCollapsed ? '▾' : '▸';
        });
    });

    container.querySelectorAll(".drawer-cat-name").forEach(name => {
        name.addEventListener("click", (e) => {
            e.stopPropagation();
            if (state.reorderMode) return;
            state.feedFilter = "category:" + name.dataset.catFilter;
            closeDrawer();
            renderArticles();
        });
    });
}

function currentFilterLabel() {
    if (state.feedFilter.startsWith("category:")) return state.feedFilter.slice(9);
    if (state.feedFilter !== "All Feeds") return state.feedFilter;
    return state.mode === "Bookmarks" ? "Saved" : state.mode;
}

function updateFeedHeader(countVal) {
    const title = document.getElementById("feed-title");
    const count = document.getElementById("feed-count");
    if (!title || !count) return;
    const total = typeof countVal === "number" ? countVal : getFilteredArticles().length;

    title.textContent = currentFilterLabel();
    count.textContent = total;
}

document.getElementById("hamburger-btn")?.addEventListener("click", () => {
    const drawer = document.getElementById("drawer");
    if (drawer?.classList.contains("open")) {
        closeDrawer();
    } else {
        openDrawer();
    }
});
document.getElementById("drawer-overlay")?.addEventListener("click", closeDrawer);

document.querySelectorAll(".drawer-mode").forEach(btn => {
    btn.addEventListener("click", () => {
        state.mode = btn.dataset.mode;
        state.feedFilter = "All Feeds";
        updateDrawerModes();
        renderDrawerFeeds();
        closeDrawer();
        renderArticles();
    });
});

// Clear: mark everything unread in the highlighted feed / category as read.
// (With "All Feeds" highlighted, that's everything — the dialog says so.)
document.getElementById("drawer-clear-filter")?.addEventListener("click", () => {
    if (state.mode !== "Unread") {
        // Nothing to mark read in Saved / Archive — just reset the filter
        state.feedFilter = "All Feeds";
        renderDrawerFeeds();
        renderArticles();
        return;
    }
    const items = getFilteredArticles();
    const label = state.feedFilter === "All Feeds" ? "ALL feeds" : `"${currentFilterLabel()}"`;
    if (items.length === 0) {
        showToast(`Nothing unread in ${label}`);
        return;
    }
    const n = items.length;
    if (!confirm(`Mark ${n} unread article${n > 1 ? "s" : ""} in ${label} as read?`)) return;
    addToHistory(items.map(a => a.id));
    renderDrawerFeeds();
    renderArticles();
    showToast(`${n} article${n > 1 ? "s" : ""} marked as read`);
});

document.getElementById("drawer-reorder")?.addEventListener("click", async () => {
    const leaving = state.reorderMode;
    state.reorderMode = !state.reorderMode;
    renderDrawerFeeds();
    // Confirm the order actually reached Firebase when leaving reorder mode
    if (leaving && state._orderSave) {
        const saved = await state._orderSave;
        state._orderSave = null;
        if (saved) showToast("Order saved");
    }
});

document.getElementById("drawer-unhide")?.addEventListener("click", () => {
    const hidden = [...state.hiddenFeeds].sort();
    if (hidden.length === 0) {
        alert("No hidden feeds.");
        return;
    }
    const answer = prompt(
        `Hidden feeds:\n\n${hidden.map((n, i) => `${i + 1}. ${n}`).join("\n")}\n\nType a number to unhide it:`
    );
    const idx = parseInt(answer, 10) - 1;
    if (!isNaN(idx) && hidden[idx]) unhideFeed(hidden[idx]);
});

// ── Reading settings (saved per device in this browser) ─────────────────

// Re-flow the open article after a size or margin change so pages fit again
let _relayoutTimer = null;
function relayoutReader() {
    if (!state.currentHtml) return;
    if (document.getElementById("reader-screen")?.classList.contains("hidden")) return;
    clearTimeout(_relayoutTimer);
    _relayoutTimer = setTimeout(() => setupPagination(state.currentHtml), 250);
}

function saveSetting(key, value) {
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch(e) {}
}

function loadSetting(key) {
    try { return localStorage.getItem(key); } catch(e) { return null; }
}

const rootStyle = document.documentElement.style;

// Text size
function applyFontSize(size) {
    rootStyle.setProperty("--reader-font-size", size + "px");
}
document.getElementById("font-size-slider")?.addEventListener("input", (e) => {
    applyFontSize(e.target.value);
    saveSetting("rss-font-size", e.target.value);
    relayoutReader();
});

// Text brightness: one gray level for all article text
function applyBrightness(level) {
    rootStyle.setProperty("--reader-text", `rgb(${level}, ${level}, ${level})`);
}
document.getElementById("brightness-slider")?.addEventListener("input", (e) => {
    applyBrightness(e.target.value);
    saveSetting("rss-brightness", e.target.value);
});

// Margins: percent of the reading area's width on each side.
// "Auto" uses the built-in defaults for phone / tablet / desktop.
function applyMargin(percent) {
    if (percent === null) rootStyle.removeProperty("--reader-margin");
    else rootStyle.setProperty("--reader-margin", `max(0.75rem, ${percent}%)`);
    document.getElementById("margin-auto")?.classList.toggle("active", percent === null);
}
document.getElementById("margin-slider")?.addEventListener("input", (e) => {
    applyMargin(e.target.value);
    saveSetting("rss-margin", e.target.value);
    relayoutReader();
});
document.getElementById("margin-auto")?.addEventListener("click", () => {
    applyMargin(null);
    saveSetting("rss-margin", null);
    relayoutReader();
});

// Restore this device's saved settings
(function restoreReadingSettings() {
    const size = loadSetting("rss-font-size");
    if (size) {
        const slider = document.getElementById("font-size-slider");
        if (slider) slider.value = size;
        applyFontSize(size);
    }
    const brightness = loadSetting("rss-brightness");
    if (brightness) {
        const slider = document.getElementById("brightness-slider");
        if (slider) slider.value = brightness;
        applyBrightness(brightness);
    }
    const margin = loadSetting("rss-margin");
    if (margin !== null && margin !== "") {
        const slider = document.getElementById("margin-slider");
        if (slider) slider.value = margin;
        applyMargin(margin);
    } else {
        applyMargin(null);
    }
})();

document.getElementById("eink-toggle")?.addEventListener("click", () => {
    const isEink = document.body.classList.toggle("eink");
    const toggle = document.getElementById("eink-toggle");
    if (toggle) {
        toggle.textContent = isEink ? "On" : "Off";
        toggle.classList.toggle("active", isEink);
    }
    try { localStorage.setItem("rss-eink", isEink ? "1" : "0"); } catch(e) {}
});

try {
    if (localStorage.getItem("rss-eink") === "1") {
        document.body.classList.add("eink");
        const toggle = document.getElementById("eink-toggle");
        if (toggle) {
            toggle.textContent = "On";
            toggle.classList.add("active");
        }
    }
} catch(e) {}

document.getElementById("settings-toggle")?.addEventListener("click", () => {
    const content = document.getElementById("settings-content");
    const label = document.querySelector("#settings-toggle .drawer-section-label");
    if (content && label) {
        const isHidden = content.classList.toggle("hidden");
        label.textContent = isHidden ? "▸ Settings" : "▾ Settings";
    }
});

document.getElementById("drawer-sync")?.addEventListener("click", () => {
    closeDrawer();
    loadData();
});

// ── Add / Manage Feeds ───────────────────────────────────────────────────

async function manageFeed(action, feedName, newCategory, currentCategory) {
    try {
        const res = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `action=${action}&name=${encodeURIComponent(feedName)}&category=${encodeURIComponent(newCategory)}&current_category=${encodeURIComponent(currentCategory)}`
        });
        const text = await res.text();
        if (text.includes("OK") || text.includes("Success")) {
            setTimeout(() => loadData(), 1000);
            renderDrawerFeeds();
        } else {
            alert("Error: " + text);
        }
    } catch(err) {
        alert("Failed: " + err.message);
    }
}

document.getElementById("add-feed-toggle")?.addEventListener("click", () => {
    const form = document.getElementById("add-feed-form");
    if (!form) return;
    const isHidden = form.classList.contains("hidden");
    form.classList.toggle("hidden");
    if (isHidden) {
        const select = document.getElementById("add-feed-category");
        const categories = [...new Set(state.feeds.filter(f => !f._isVirtual).map(f => f._category || "Uncategorized"))];
        if (select) {
            select.innerHTML = categories.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("")
                + '<option value="__new__">+ New Category</option>';
        }
        document.getElementById("add-feed-name").value = "";
        document.getElementById("add-feed-url").value = "";
        document.getElementById("add-feed-status").textContent = "";
    }
});

document.getElementById("add-feed-cancel")?.addEventListener("click", () => {
    document.getElementById("add-feed-form")?.classList.add("hidden");
});

document.getElementById("add-feed-submit")?.addEventListener("click", async () => {
    const name = document.getElementById("add-feed-name").value.trim();
    const url = document.getElementById("add-feed-url").value.trim();
    let category = document.getElementById("add-feed-category").value;
    const status = document.getElementById("add-feed-status");

    if (!name || !url) {
        status.textContent = "Name and URL required";
        status.style.color = "#ff4444";
        return;
    }

    if (category === "__new__") {
        category = prompt("New category name:");
        if (!category) return;
    }

    status.textContent = "Adding...";
    status.style.color = "#5A5F67";

    try {
        const res = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `action=add_feed&name=${encodeURIComponent(name)}&url=${encodeURIComponent(url)}&category=${encodeURIComponent(category)}`
        });
        const text = await res.text();
        if (text.includes("OK") || text.includes("Success")) {
            status.textContent = "Added! Syncing...";
            status.style.color = "#00A870";
            document.getElementById("add-feed-form")?.classList.add("hidden");
            setTimeout(() => loadData(), 1000);
        } else {
            status.textContent = "Error: " + text;
            status.style.color = "#ff4444";
        }
    } catch(err) {
        status.textContent = "Failed: " + err.message;
        status.style.color = "#ff4444";
    }
});

// ═══ SERVICE WORKER ══════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(err => {
        console.log("SW registration failed:", err);
    });
}