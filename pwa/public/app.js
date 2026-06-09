// ═══════════════════════════════════════════════════════════════════════════
// RSS TRIAGE PWA
// ═══════════════════════════════════════════════════════════════════════════

// ── Firebase Config ──────────────────────────────────────────────────────
// PASTE YOUR FIREBASE CONFIG HERE (Firebase Console → Project Settings → Web App)
const firebaseConfig = {
    apiKey: "AIzaSyBvNjSGiWQofUd3omAcBvJ-pa2pAtG2KNs",
    authDomain: "rss-triage.firebaseapp.com",
    databaseURL: "https://rss-triage-default-rtdb.firebaseio.com",
    projectId: "rss-triage",
    storageBucket: "rss-triage.firebasestorage.app",
    messagingSenderId: "30387056427",
    appId: "1:30387056427:web:116cf9cfd171d14b05df6e"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// ── GitHub Config ────────────────────────────────────────────────────────
const GITHUB_USER = "chaunceybuey";
const GITHUB_REPO = "cloud-catcher";

// ── Proxy for full-text fetching ──────────────────────────────────────────
const PROXY_URL = "https://script.google.com/macros/s/AKfycbw2U9jgVSwbRSHicSuxYeGDs1z_xeGh4bQvreP4Vsim9uFGVMFSZi-2_jAY1XI7XThc/exec";

function extractArticle(html, url) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    // Remove non-content elements — aggressive list for cleaner output
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
    
    // Remove tiny images (icons, avatars, tracking pixels)
    doc.querySelectorAll("img").forEach(img => {
        const w = parseInt(img.getAttribute("width")) || 0;
        const h = parseInt(img.getAttribute("height")) || 0;
        if ((w > 0 && w < 80) || (h > 0 && h < 80)) img.remove();
    });
    
    // Find main content area
    const main = doc.querySelector("article") || doc.querySelector("[role='main']") || doc.querySelector("main") || doc.querySelector(".post-content, .article-body, .entry-content, .story-body, .article__body") || doc.body;
    
    // Second pass — strip remaining junk from within the content area
    main.querySelectorAll("svg, [class*='icon'], [class*='share'], [class*='social']").forEach(el => el.remove());
    
    // Fix relative URLs
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

document.getElementById("paste-link-btn").addEventListener("click", async () => {
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
        // Fetch raw HTML first to get metadata
        const res = await fetch(PROXY_URL + "?url=" + encodeURIComponent(url));
        if (!res.ok) throw new Error("Proxy returned " + res.status);
        const rawHtml = await res.text();
        if (rawHtml.startsWith("ERROR:")) throw new Error(rawHtml);
        if (rawHtml.length < 200) throw new Error("Response too short");

        // Extract title from page metadata
        const metaDoc = new DOMParser().parseFromString(rawHtml, "text/html");
        const ogTitle = metaDoc.querySelector('meta[property="og:title"]')?.getAttribute("content");
        const pageTitle = metaDoc.querySelector("title")?.textContent;
        const title = ogTitle || pageTitle || url;

        // Extract site name
        const ogSite = metaDoc.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
        const hostname = new URL(url).hostname.replace("www.", "");
        const siteName = ogSite || hostname;

        // Extract article body
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

        // Save full text to Firebase
        const safeKey = md5(url);
        await db.ref(`app_data/articles/${safeKey}`).set(fullHtml);

        // Add to local state and render
        state.articles.unshift(article);
        // Auto-bookmark pasted articles
        state.bookmarks[article.id] = 0;
        db.ref("app_data/bookmarks").set(JSON.stringify(state.bookmarks));
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

// ── App State ────────────────────────────────────────────────────────────
let state = {
    articles: [],
    feeds: [],
    history: new Set(),
    bookmarks: {},
    audioBin: {},
    mode: "Unread",
    feedFilter: "All Feeds",
    currentArticle: null,
    pagination: null,
    readThisSession: new Set(),  // Articles opened — archived on return to feed
};

// ═══ AUTH ═════════════════════════════════════════════════════════════════

document.getElementById("login-btn").addEventListener("click", () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => {
        console.error("Login failed:", err);
        alert("Login failed: " + err.message);
    });
});

auth.onAuthStateChanged(user => {
    if (user) {
        document.getElementById("login-screen").classList.add("hidden");
        loadData();
        // Show drawer immediately on large screens
        if (isLargeScreen()) {
            const drawer = document.getElementById("drawer");
            drawer.classList.remove("hidden");
            drawer.classList.add("open");
        }
    } else {
        document.getElementById("login-screen").classList.remove("hidden");
        document.getElementById("feed-screen").classList.add("hidden");
    }
});

// ═══ DATA LOADING ════════════════════════════════════════════════════════

async function loadData() {
    showScreen("feed");
    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("article-list").innerHTML = "";

    try {
        // Fetch articles, newsletters, and feeds from GitHub (parallel)
        const [articlesRes, newsletterRes, feedsRes] = await Promise.all([
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/master_articles.json?t=${Date.now()}`),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/newsletter_articles.json?t=${Date.now()}`).catch(() => null),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/feeds.json?t=${Date.now()}`)
        ]);

        if (articlesRes.ok) {
            state.articles = await articlesRes.json();
        }
        // Merge newsletters into articles
        if (newsletterRes && newsletterRes.ok) {
            try {
                const newsletters = await newsletterRes.json();
                // Add newsletters, avoiding duplicates
                const existingIds = new Set(state.articles.map(a => a.id));
                newsletters.forEach(n => {
                    if (!existingIds.has(n.id)) state.articles.push(n);
                });
            } catch(e) {}
        }
        if (feedsRes.ok) {
            const feedsData = await feedsRes.json();
            // Flatten categories into feed list
            state.feeds = [];
            for (const [category, feedList] of Object.entries(feedsData)) {
                for (const feed of feedList) {
                    state.feeds.push({ ...feed, _category: category });
                }
            }
            populateFeedFilter();
        }

        // Fetch history, bookmarks, audio bin from Firebase
        const [histSnap, bmSnap, audioSnap] = await Promise.all([
            db.ref("app_data/history").once("value"),
            db.ref("app_data/bookmarks").once("value"),
            db.ref("app_data/audio_bin").once("value"),
        ]);

        if (histSnap.val()) {
            state.history = new Set(JSON.parse(histSnap.val()));
        }
        if (bmSnap.val()) {
            state.bookmarks = JSON.parse(bmSnap.val());
        }
        if (audioSnap.val()) {
            state.audioBin = JSON.parse(audioSnap.val());
        }

        // Listen for real-time updates
        db.ref("app_data/history").on("value", snap => {
            if (snap.val()) state.history = new Set(JSON.parse(snap.val()));
            if (document.getElementById("feed-screen").classList.contains("hidden") === false) {
                renderArticles();
            }
        });

    } catch (err) {
        console.error("Failed to load data:", err);
    }

    document.getElementById("loading").classList.add("hidden");
    renderArticles();

    // On large screens, populate the persistent sidebar
    if (isLargeScreen()) {
        renderDrawerFeeds();
        updateDrawerModes();
    }
}

function populateFeedFilter() {
    // Now handled by drawer — see renderDrawerFeeds()
}

// ═══ ARTICLE RENDERING ═══════════════════════════════════════════════════

function getFilteredArticles() {
    const activeFeedNames = new Set(state.feeds.map(f => f.name));
    const isNewsletter = (a) => a.source === "newsletter";
    const isManual = (a) => a.source === "manual";
    const includeArticle = (a) => activeFeedNames.has(a.feed_name) || isNewsletter(a) || isManual(a);
    let base;

    if (state.mode === "Unread") {
        base = state.articles.filter(a => !state.history.has(a.id) && includeArticle(a));
    } else if (state.mode === "Bookmarks") {
        base = state.articles.filter(a => a.id in state.bookmarks && includeArticle(a));
    } else if (state.mode === "AudioBin") {
        base = state.articles.filter(a => a.id in state.audioBin && includeArticle(a));
    } else {
        base = state.articles.filter(a => state.history.has(a.id) && includeArticle(a));
    }

    if (state.feedFilter.startsWith("category:")) {
        const catName = state.feedFilter.slice(9);
        if (catName === "Newsletters") {
            base = base.filter(a => a.source === "newsletter");
        } else {
            const catFeeds = new Set(state.feeds.filter(f => f._category === catName).map(f => f.name));
            base = base.filter(a => catFeeds.has(a.feed_name));
        }
    } else if (state.feedFilter !== "All Feeds") {
        base = base.filter(a => a.feed_name === state.feedFilter);
    }

    base.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return base;
}

function formatDate(raw) {
    if (!raw) return "";
    try {
        const dt = new Date(raw);
        return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase();
    } catch {
        return raw.slice(0, 10);
    }
}

function renderArticles() {
    const list = document.getElementById("article-list");
    const empty = document.getElementById("empty-state");
    const filtered = getFilteredArticles();

    if (filtered.length === 0) {
        list.innerHTML = "";
        empty.classList.remove("hidden");
        return;
    }
    empty.classList.add("hidden");

    list.innerHTML = filtered.map((article, idx) => `
        <div class="article-card" data-id="${article.id}" data-idx="${idx}">
            <span class="card-swipe-label left">Archive</span>
            <span class="card-swipe-label right">Save</span>
            <div class="card-feed">${article.feed_name || ""}</div>
            <div class="card-title">${article.title || "Untitled"}</div>
            <div class="card-meta">
                <span class="card-date">${formatDate(article.date)}</span>
                ${article.author ? `<span class="card-author">${article.author}</span>` : ""}
            </div>
        </div>
    `).join("");

    // Attach tap and swipe handlers
    list.querySelectorAll(".article-card").forEach(card => {
        const articleId = card.dataset.id;
        const article = filtered[parseInt(card.dataset.idx)];

        // Tap to open
        card.addEventListener("click", (e) => {
            if (card.classList.contains("swiping")) return;
            openArticle(article);
        });

        // Swipe gestures
        const hammer = new Hammer(card, { threshold: 50 });
        hammer.on("panstart", () => card.classList.add("swiping"));
        hammer.on("panmove", (e) => {
            card.style.transform = `translateX(${e.deltaX}px)`;
            card.style.opacity = Math.max(0.3, 1 - Math.abs(e.deltaX) / 300);
            // Show swipe labels
            const leftLabel = card.querySelector(".card-swipe-label.left");
            const rightLabel = card.querySelector(".card-swipe-label.right");
            leftLabel.style.opacity = e.deltaX < -30 ? Math.min(1, (-e.deltaX - 30) / 80) : 0;
            rightLabel.style.opacity = e.deltaX > 30 ? Math.min(1, (e.deltaX - 30) / 80) : 0;
        });
        hammer.on("panend", (e) => {
            if (e.deltaX < -120) {
                // Swipe left → Archive
                card.classList.add("dismissed");
                setTimeout(() => archiveArticle(articleId), 300);
            } else if (e.deltaX > 120) {
                // Swipe right → Bookmark
                bookmarkArticle(articleId);
                card.style.transform = "";
                card.style.opacity = "";
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
    requestWakeLock();

    const bmBtn = document.getElementById("reader-bookmark");
    bmBtn.classList.toggle("active-action", article.id in state.bookmarks);

    showScreen("reader");

    const contentEl = document.getElementById("reader-content");
    contentEl.innerHTML = '<div class="reader-pages"><p style="color:#5A5F67;">Loading...</p></div>';

    // Build article header
    const feedName = article.feed_name || "";
    const date = formatDate(article.date);
    const author = article.author ? `By ${article.author}` : "";
    const title = article.title || "Untitled";

    const headerHtml = `
        <div class="article-header-meta">${feedName} · ${date}</div>
        <div class="article-header-title">${title}</div>
        ${author ? `<div class="article-header-author">${author}</div>` : '<div style="margin-bottom:1.5rem;padding-bottom:1rem;border-bottom:1px solid #1a1a1a;"></div>'}
    `;

    // Check Firebase for cached full text first
    const safeKey = md5(article.link || article.id);
    
    // Newsletters and manual articles already have full content — show directly
    if (article.source === "newsletter" || article.source === "manual") {
        let content = article.content || '';
        // Clean up email HTML — strip tracking pixels, empty elements, email junk
        if (article.source === "newsletter") {
            const parser = new DOMParser();
            const emailDoc = parser.parseFromString(content, "text/html");
            // Remove tracking pixels and tiny images
            emailDoc.querySelectorAll("img").forEach(img => {
                const w = parseInt(img.getAttribute("width")) || img.naturalWidth || 0;
                const h = parseInt(img.getAttribute("height")) || img.naturalHeight || 0;
                if ((w > 0 && w < 10) || (h > 0 && h < 10)) img.remove();
            });
            // Remove style tags, scripts, hidden elements
            emailDoc.querySelectorAll("style, script, [style*='display:none'], [style*='display: none'], [hidden]").forEach(el => el.remove());
            // Remove empty elements
            emailDoc.querySelectorAll("div, p, span, td, tr, table").forEach(el => {
                if (!el.textContent.trim() && !el.querySelector("img")) el.remove();
            });
            // Remove email footer/unsubscribe sections
            emailDoc.querySelectorAll("[class*='footer'], [class*='unsubscribe'], [class*='Footer'], [class*='Unsubscribe']").forEach(el => el.remove());
            content = emailDoc.body ? emailDoc.body.innerHTML : content;
        }
        setupPagination(headerHtml + content);
        enterFullscreen();
        return;
    }
    
    db.ref(`app_data/articles/${safeKey}`).once("value").then(snap => {
        const cached = snap.val();
        // Check that cached content isn't a login/error page
        if (cached && cached.length > 500 && !cached.includes("Sign in") && !cached.includes("to continue to Gmail")) {
            // Full text available — show it directly
            setupPagination(headerHtml + cached);
            enterFullscreen();
        } else {
            // Show RSS summary with "Read Full Article" button
            const summary = article.content || '<p style="color:#5A5F67;font-style:italic;">No summary available.</p>';
            const fetchButton = `
                <div style="text-align:center;margin:3rem 0 2rem;">
                    <button id="fetch-full-btn" style="background:#1a1a1a;color:#D94A00;border:1px solid #333;
                        padding:0.8rem 2rem;border-radius:0.5rem;font-size:0.95rem;font-weight:700;
                        text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;">
                        Read
                    </button>
                </div>
            `;
            setupPagination(headerHtml + summary + fetchButton);

            // Attach the fetch handler after pagination renders
            setTimeout(() => {
                const btn = document.getElementById("fetch-full-btn");
                if (btn) {
                    btn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        btn.textContent = "Fetching...";
                        btn.style.color = "#5A5F67";

                        fetchFullText(article.link).then(fullHtml => {
                            // Cache in Firebase for next time
                            db.ref(`app_data/articles/${safeKey}`).set(fullHtml).catch(() => {});
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
    setTimeout(() => {
        const body = document.getElementById("reader-content");
        
        // Compute actual padding from CSS
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
        // Inner clip wrapper prevents column bleed into padding area on large screens
        body.innerHTML = `<div id="reader-clip" style="overflow:hidden;height:100%;position:relative;">
            <div class="reader-pages" id="reader-pages">${html}</div></div>`;
        const pages = document.getElementById("reader-pages");

        // Clean up excessive whitespace
        pages.querySelectorAll("p, div, span").forEach(el => {
            if (!el.children.length && !el.textContent.trim()) el.remove();
        });
        pages.querySelectorAll("br").forEach(br => {
            if (br.nextElementSibling && br.nextElementSibling.tagName === "BR") br.remove();
        });

        // Strip inline color/font styles (fixes newsletter email HTML)
        pages.querySelectorAll("[style]").forEach(el => {
            const s = el.style;
            s.removeProperty("color");
            s.removeProperty("background-color");
            s.removeProperty("background");
            s.removeProperty("font-family");
            s.removeProperty("font-size");
            // Remove the style attribute entirely if empty
            if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
        });

        pages.querySelectorAll("img, figure, video").forEach(el => {
            el.style.maxHeight = (availableHeight - 60) + "px";
            el.style.objectFit = "contain";
        });

        pages.style.height = availableHeight + "px";
        pages.style.columnWidth = (availableWidth - 4) + "px";
        pages.style.columnGap = "40px";

        setTimeout(() => {
            const totalWidth = pages.scrollWidth;
            const step = availableWidth + 40;
            const totalPages = Math.max(1, Math.ceil(totalWidth / step));
            // Use exact step from browser to prevent cumulative drift
            const exactStep = totalPages > 1 ? totalWidth / totalPages : step;

            state.pagination = { el: pages, current: 0, total: totalPages, step: exactStep };
            updatePageIndicator();
            // Restore saved reading position (stored as percentage)
            if (state.currentArticle) {
                db.ref(`app_data/positions/${state.currentArticle.id}`).once("value").then(snap => {
                    const saved = snap.val();
                    if (saved && saved > 0) {
                        // Convert percentage to page number for current screen
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

function goToPage(page) {
    const p = state.pagination;
    if (!p) return;
    page = Math.max(0, Math.min(page, p.total - 1));
    p.current = page;
    p.el.style.transform = `translateX(-${page * p.step}px)`;
    updatePageIndicator();
    // Save reading progress as percentage (works across screen sizes)
    if (state.currentArticle && p.total > 1) {
        const progress = page / (p.total - 1);
        try { db.ref(`app_data/positions/${state.currentArticle.id}`).set(progress); } catch(e) {}
    }
}

function updatePageIndicator() {
    const p = state.pagination;
    if (!p) return;
    document.getElementById("page-progress-bar").style.width = `${((p.current + 1) / p.total) * 100}%`;
}

document.getElementById("reader-back").addEventListener("click", () => {
    // If we have a reader entry in history, go back through it.
    // Otherwise go directly to feed.
    if (history.state?.screen === "reader") {
        history.back();
    } else {
        goBackToFeed();
    }
});

document.getElementById("reader-archive").addEventListener("click", () => {
    if (state.currentArticle) {
        archiveArticle(state.currentArticle.id);
        goBackToFeed();
    }
});

document.getElementById("reader-bookmark").addEventListener("click", () => {
    if (state.currentArticle) {
        const id = state.currentArticle.id;
        if (id in state.bookmarks) {
            delete state.bookmarks[id];
        } else {
            state.bookmarks[id] = 0;
        }
        db.ref("app_data/bookmarks").set(JSON.stringify(state.bookmarks));
        document.getElementById("reader-bookmark").classList.toggle("active-action", id in state.bookmarks);
    }
});

// Open original article in browser
document.getElementById("reader-readwise").addEventListener("click", () => {
    if (state.currentArticle?.link) {
        window.open(state.currentArticle.link, "_blank");
    }
});

// ═══ FULLSCREEN & WAKE LOCK ══════════════════════════════════════════════

let _wakeLock = null;

async function requestWakeLock() {
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

// Re-request wake lock when returning to the app while reading
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.currentArticle) {
        requestWakeLock();
    }
});

function enterFullscreen() {
    // Only go fullscreen on mobile — desktop doesn't need it
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
    state.history.add(articleId);
    db.ref("app_data/history").set(JSON.stringify([...state.history]));
    renderArticles();
}

function bookmarkArticle(articleId) {
    state.bookmarks[articleId] = 0;
    db.ref("app_data/bookmarks").set(JSON.stringify(state.bookmarks));
}

// ═══ AUDIO BIN ═══════════════════════════════════════════════════════════

function renderAudioBin() {
    const list = document.getElementById("audio-list");
    const entries = Object.entries(state.audioBin);

    if (entries.length === 0) {
        list.innerHTML = '<div class="empty-state">No audio queued.</div>';
        return;
    }

    // Match audio bin entries to article metadata
    list.innerHTML = entries.map(([id, data]) => {
        const article = state.articles.find(a => a.id === id);
        const title = article ? article.title : "Unknown Article";
        const feed = article ? article.feed_name : "";

        let statusHtml = "";
        if (data.status === "ready" && data.path) {
            statusHtml = `<audio controls class="audio-player"><source src="" type="audio/wav"></audio>
                          <p style="color:#5A5F67;font-size:0.7rem;margin-top:0.5rem;">Audio available on desktop. Drive sync coming soon.</p>`;
        } else if (data.status === "generating") {
            statusHtml = '<div class="audio-card-status generating">Generating...</div>';
        } else if (data.status === "error") {
            statusHtml = '<div class="audio-card-status error">Failed</div>';
        } else {
            statusHtml = '<div class="audio-card-status pending">Queued</div>';
        }

        return `
            <div class="audio-card">
                <div class="audio-card-feed">${feed}</div>
                <div class="audio-card-title">${title}</div>
                ${statusHtml}
            </div>
        `;
    }).join("");
}

// ═══ NAVIGATION ══════════════════════════════════════════════════════════

function showScreen(name, pushHistory = true) {
    document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
    document.getElementById(`${name}-screen`).classList.remove("hidden");

    if (pushHistory && name !== "feed") {
        // Only push ONE history entry per screen type.
        // If we're already in this screen, replace instead of stacking.
        if (history.state?.screen === name) {
            history.replaceState({ screen: name }, "");
        } else {
            history.pushState({ screen: name }, "");
        }
    }
}

function goBackToFeed() {
    // Archive read articles (except bookmarked ones)
    if (state.readThisSession.size > 0 && state.mode === "Unread") {
        let archived = 0;
        state.readThisSession.forEach(id => {
            if (!(id in state.bookmarks)) {
                state.history.add(id);
                archived++;
            }
        });
        if (archived > 0) {
            db.ref("app_data/history").set(JSON.stringify([...state.history]));
            setTimeout(() => {
                const toast = document.createElement("div");
                toast.style.cssText = "position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:#E5E7EB;color:#0a0a0a;padding:0.6rem 1.2rem;border-radius:0.5rem;font-size:0.85rem;font-weight:700;z-index:200;transition:opacity 0.3s;";
                toast.textContent = `${archived} article${archived > 1 ? 's' : ''} archived`;
                document.body.appendChild(toast);
                setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 2500);
            }, 100);
        }
    }
    state.readThisSession.clear();
    state.currentArticle = null;
    exitFullscreen();
    releaseWakeLock();
    showScreen("feed", false);
    renderArticles();
}

// Handle system back button / back gesture
window.addEventListener("popstate", (e) => {
    const targetScreen = e.state?.screen || "feed";
    if (targetScreen === "feed") {
        goBackToFeed();
    } else {
        showScreen(targetScreen, false);
    }
});

// Set initial history state
history.replaceState({ screen: "feed" }, "");

// Mode and feed filter changes — now handled by drawer
// (old dropdown handlers removed)

// ═══ PAGE TURNING IN READER ══════════════════════════════════════════════

(function setupReaderGestures() {
    const readerBody = document.getElementById("reader-content");
    
    // Enable all directions for swipe detection
    const hammer = new Hammer(readerBody, {
        threshold: 40,
    });
    hammer.get('swipe').set({ direction: Hammer.DIRECTION_ALL });

    // Horizontal swipes → turn pages
    hammer.on("swipeleft", () => {
        if (state.pagination) goToPage(state.pagination.current + 1);
    });

    hammer.on("swiperight", () => {
        if (state.pagination) goToPage(state.pagination.current - 1);
    });

    // Vertical swipes → next/previous article
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

    // Tap left/right halves to turn pages
    readerBody.addEventListener("click", (e) => {
        if (!state.pagination) return;
        const x = e.clientX;
        const width = window.innerWidth;
        if (x < width * 0.3) {
            goToPage(state.pagination.current - 1);
        } else if (x > width * 0.7) {
            goToPage(state.pagination.current + 1);
        }
    });

    // Edge-swipe from left side → go back to feed
    let edgeSwipeStartX = null;
    readerBody.addEventListener("touchstart", (e) => {
        const x = e.touches[0].clientX;
        if (x < 25) edgeSwipeStartX = x;
        else edgeSwipeStartX = null;
    }, { passive: true });

    readerBody.addEventListener("touchend", (e) => {
        if (edgeSwipeStartX !== null) {
            const endX = e.changedTouches[0].clientX;
            if (endX - edgeSwipeStartX > 80) {
                // Edge swipe detected → go back to feed
                goBackToFeed();
            }
        }
        edgeSwipeStartX = null;
    }, { passive: true });
})();

// ═══ KEYBOARD SHORTCUTS ══════════════════════════════════════════════════

document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const onFeed = !document.getElementById("feed-screen").classList.contains("hidden");
    const onReader = !document.getElementById("reader-screen").classList.contains("hidden");

    // Don't capture if typing in an input
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    if (onFeed) {
        // Feed view shortcuts
        const filtered = getFilteredArticles();
        const cards = document.querySelectorAll(".article-card");
        const selectedIdx = state._selectedCardIdx || 0;

        if (key === "j" && cards.length > 0) {
            // Next article in list
            e.preventDefault();
            state._selectedCardIdx = Math.min(selectedIdx + 1, cards.length - 1);
            cards[state._selectedCardIdx].scrollIntoView({ block: "nearest" });
            cards.forEach(c => c.style.borderLeft = "");
            cards[state._selectedCardIdx].style.borderLeft = "3px solid #D94A00";
        } else if (key === "k" && cards.length > 0) {
            // Previous article in list
            e.preventDefault();
            state._selectedCardIdx = Math.max(selectedIdx - 1, 0);
            cards[state._selectedCardIdx].scrollIntoView({ block: "nearest" });
            cards.forEach(c => c.style.borderLeft = "");
            cards[state._selectedCardIdx].style.borderLeft = "3px solid #D94A00";
        } else if (key === "enter" && cards.length > 0) {
            // Open selected article
            e.preventDefault();
            const article = filtered[state._selectedCardIdx || 0];
            if (article) openArticle(article);
        } else if (key === "a" && cards.length > 0) {
            // Archive selected
            e.preventDefault();
            const article = filtered[state._selectedCardIdx || 0];
            if (article) {
                archiveArticle(article.id);
                renderArticles();
            }
        } else if (key === "s" && cards.length > 0) {
            // Skip (next without archiving)
            e.preventDefault();
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
            // Next page
            e.preventDefault();
            if (state.pagination) goToPage(state.pagination.current + 1);
        } else if (key === "arrowleft" || (key === " " && e.shiftKey)) {
            // Previous page
            e.preventDefault();
            if (state.pagination) goToPage(state.pagination.current - 1);
        } else if (key === "j" || key === "arrowdown") {
            // Next article
            e.preventDefault();
            const filtered = getFilteredArticles();
            const idx = filtered.findIndex(a => a.id === state.currentArticle?.id);
            if (idx < filtered.length - 1) openArticle(filtered[idx + 1]);
        } else if (key === "k" || key === "arrowup") {
            // Previous article
            e.preventDefault();
            const filtered = getFilteredArticles();
            const idx = filtered.findIndex(a => a.id === state.currentArticle?.id);
            if (idx > 0) openArticle(filtered[idx - 1]);
        } else if (key === "a") {
            // Archive and go back
            if (state.currentArticle) archiveArticle(state.currentArticle.id);
            goBackToFeed();
        } else if (key === "b") {
            // Toggle bookmark
            document.getElementById("reader-bookmark").click();
        } else if (key === "l") {
            // Queue audio
            document.getElementById("reader-audio").click();
        } else if (key === "r") {
            // Open in browser
            document.getElementById("reader-readwise").click();
        } else if (key === "w" || key === "enter") {
            // Fetch full text
            const btn = document.getElementById("fetch-full-btn");
            if (btn) btn.click();
        } else if (key === "c") {
            // Open original article in new tab
            if (state.currentArticle?.link) {
                window.open(state.currentArticle.link, "_blank");
            }
        } else if (key === "escape" || key === "backspace") {
            // Back to feed
            e.preventDefault();
            goBackToFeed();
        }
    }
});

// ═══ UTILITIES ═══════════════════════════════════════════════════════════

// Simple MD5 for Firebase article keys (matches Python hashlib.md5)
function md5(str) {
    // Minimal MD5 for key generation — not for security
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

    let k, AA, BB, CC, DD, a, b, c, d;
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

        // Round 1
        for (let i = 0; i < 16; i++) {
            const div = Math.floor(i / 4);
            a = transform(f, a, b, c, d, x[i], S[i % 4], T[i]);
            [a, b, c, d] = [d, a, b, c];
        }
        // Round 2
        for (let i = 0; i < 16; i++) {
            a = transform(g, a, b, c, d, x[(5*i + 1) % 16], S[4 + (i % 4)], T[16 + i]);
            [a, b, c, d] = [d, a, b, c];
        }
        // Round 3
        for (let i = 0; i < 16; i++) {
            a = transform(h, a, b, c, d, x[(3*i + 5) % 16], S[8 + (i % 4)], T[32 + i]);
            [a, b, c, d] = [d, a, b, c];
        }
        // Round 4
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
        // On large screens, drawer stays visible — just update it
        renderDrawerFeeds();
        return;
    }
    const drawer = document.getElementById("drawer");
    const overlay = document.getElementById("drawer-overlay");
    drawer.classList.remove("open");
    overlay.classList.remove("open");
    setTimeout(() => {
        drawer.classList.add("hidden");
        overlay.classList.add("hidden");
    }, 300);
}

function updateDrawerModes() {
    document.querySelectorAll(".drawer-mode").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.mode === state.mode);
    });
}

function renderDrawerFeeds() {
    const container = document.getElementById("drawer-feeds");
    const filtered = getFilteredArticles();
    const activeFeedNames = new Set(state.feeds.map(f => f.name));

    // Count articles per feed (for current mode)
    const allArticles = state.articles;
    const isSpecial = (a) => a.source === "newsletter" || a.source === "manual";
    const include = (a) => activeFeedNames.has(a.feed_name) || isSpecial(a);
    let base;
    if (state.mode === "Unread") {
        base = allArticles.filter(a => !state.history.has(a.id) && include(a));
    } else if (state.mode === "Bookmarks") {
        base = allArticles.filter(a => a.id in state.bookmarks && include(a));
    } else if (state.mode === "AudioBin") {
        base = allArticles.filter(a => a.id in state.audioBin && include(a));
    } else {
        base = allArticles.filter(a => state.history.has(a.id) && include(a));
    }

    const feedCounts = {};
    base.forEach(a => { feedCounts[a.feed_name] = (feedCounts[a.feed_name] || 0) + 1; });
    const totalCount = base.length;

    // Group feeds by category
    const categories = {};
    state.feeds.forEach(f => {
        const cat = f._category || "My Feeds";
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(f);
    });

    // Add newsletter senders as their own category (from all articles, not just current mode)
    const allNewsletterSenders = [...new Set(state.articles.filter(a => a.source === "newsletter").map(a => a.feed_name))];
    if (allNewsletterSenders.length > 0) {
        categories["Newsletters"] = allNewsletterSenders.map(name => ({ name: name, url: "", _category: "Newsletters" }));
    }

    let html = `<div class="drawer-feed-item all-feeds ${state.feedFilter === 'All Feeds' ? 'active' : ''}" data-feed="All Feeds">
        <span>All Feeds</span><span class="drawer-feed-count">${totalCount}</span></div>`;

    // Newsletters at the top
    if (categories["Newsletters"]) {
        const nlFeeds = categories["Newsletters"];
        const nlCount = nlFeeds.reduce((sum, f) => sum + (feedCounts[f.name] || 0), 0);
        const isExpanded = state._expandedCategories?.["Newsletters"] === true;
        const isCatActive = state.feedFilter === "category:Newsletters";
        html += `<div class="drawer-category ${isCatActive ? 'active-cat' : ''}" data-category="Newsletters">
            <span class="drawer-cat-toggle" data-cat-toggle="Newsletters">${isExpanded ? '▾' : '▸'}</span>
            <span class="drawer-cat-name" data-cat-filter="Newsletters">Newsletters</span>
            <span class="drawer-category-count">${nlCount}</span>
        </div>`;
        html += `<div class="drawer-category-feeds ${isExpanded ? '' : 'collapsed'}" data-cat-feeds="Newsletters">`;
        for (const feed of nlFeeds) {
            const count = feedCounts[feed.name] || 0;
            const isActive = state.feedFilter === feed.name;
            html += `<div class="drawer-feed-item ${isActive ? 'active' : ''}" data-feed="${feed.name}">
                <span class="drawer-feed-name-text">${feed.name}</span>
                <span class="drawer-feed-right">
                    <span class="drawer-feed-count">${count}</span>
                </span></div>`;
        }
        html += `</div>`;
        delete categories["Newsletters"];
    }

    // Uncategorized feeds show inline (not under a category header)
    const uncatKeys = Object.keys(categories).filter(k => 
        !k || k.toLowerCase() === "uncategorized" || k.toLowerCase() === "my feeds"
    );
    const uncategorized = uncatKeys.flatMap(k => categories[k] || []);
    uncatKeys.forEach(k => delete categories[k]);
    
    for (const feed of uncategorized) {
        const count = feedCounts[feed.name] || 0;
        const isActive = state.feedFilter === feed.name;
        html += `<div class="drawer-feed-item ${isActive ? 'active' : ''}" data-feed="${feed.name}">
            <span class="drawer-feed-name-text">${feed.name}</span>
            <span class="drawer-feed-right">
                <span class="drawer-feed-edit" data-edit-feed="${feed.name}" data-edit-cat="Uncategorized">⋯</span>
                <span class="drawer-feed-count">${count}</span>
            </span></div>`;
    }

    for (const [cat, feeds] of Object.entries(categories)) {
        const catCount = feeds.reduce((sum, f) => sum + (feedCounts[f.name] || 0), 0);
        // Categories collapsed by default
        const isExpanded = state._expandedCategories?.[cat] === true;

        const isCatActive = state.feedFilter === "category:" + cat;
        html += `<div class="drawer-category ${isCatActive ? 'active-cat' : ''}" data-category="${cat}">
            <span class="drawer-cat-toggle" data-cat-toggle="${cat}">${isExpanded ? '▾' : '▸'}</span>
            <span class="drawer-cat-name" data-cat-filter="${cat}">${cat}</span>
            <span class="drawer-category-count">${catCount}</span>
        </div>`;
        html += `<div class="drawer-category-feeds ${isExpanded ? '' : 'collapsed'}" data-cat-feeds="${cat}">`;
        for (const feed of feeds) {
            const count = feedCounts[feed.name] || 0;
            const isActive = state.feedFilter === feed.name;
            html += `<div class="drawer-feed-item ${isActive ? 'active' : ''}" data-feed="${feed.name}">
                <span class="drawer-feed-name-text">${feed.name}</span>
                <span class="drawer-feed-right">
                    <span class="drawer-feed-count">${count}</span>
                    <span class="drawer-feed-edit" data-edit-feed="${feed.name}" data-edit-cat="${cat}">⋯</span>
                </span></div>`;
        }
        html += `</div>`;
    }

    container.innerHTML = html;

    // Attach handlers
    container.querySelectorAll(".drawer-feed-item").forEach(item => {
        item.addEventListener("click", () => {
            state.feedFilter = item.dataset.feed;
            closeDrawer();
            updateFeedHeader();
            renderArticles();
        });
    });

    container.querySelectorAll(".drawer-feed-edit").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const feedName = btn.dataset.editFeed;
            const currentCat = btn.dataset.editCat;
            const categories = [...new Set(state.feeds.map(f => f._category || "My Feeds"))];

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
            if (!state._expandedCategories) state._expandedCategories = {};
            const feeds = container.querySelector(`[data-cat-feeds="${catName}"]`);
            const isCollapsed = feeds.classList.contains("collapsed");
            feeds.classList.toggle("collapsed");
            state._expandedCategories[catName] = isCollapsed;
            toggle.textContent = isCollapsed ? '▾' : '▸';
        });
    });

    container.querySelectorAll(".drawer-cat-name").forEach(name => {
        name.addEventListener("click", (e) => {
            e.stopPropagation();
            state.feedFilter = "category:" + name.dataset.catFilter;
            closeDrawer();
            updateFeedHeader();
            renderArticles();
        });
    });
}

function updateFeedHeader() {
    const title = document.getElementById("feed-title");
    const count = document.getElementById("feed-count");
    const filtered = getFilteredArticles();

    let label = state.mode === "Bookmarks" ? "Saved" : state.mode === "AudioBin" ? "Audio" : state.mode;
    if (state.feedFilter.startsWith("category:")) {
        label = state.feedFilter.slice(9);
    } else if (state.feedFilter !== "All Feeds") {
        label = state.feedFilter;
    }
    title.textContent = label;
    count.textContent = filtered.length;
}

// Hamburger button
document.getElementById("hamburger-btn").addEventListener("click", () => {
    const drawer = document.getElementById("drawer");
    if (drawer.classList.contains("open")) {
        closeDrawer();
    } else {
        openDrawer();
    }
});
document.getElementById("drawer-overlay").addEventListener("click", closeDrawer);

// Mode tabs in drawer
document.querySelectorAll(".drawer-mode").forEach(btn => {
    btn.addEventListener("click", () => {
        state.mode = btn.dataset.mode;
        state.feedFilter = "All Feeds";
        updateDrawerModes();
        renderDrawerFeeds();
        closeDrawer();
        updateFeedHeader();
        renderArticles();
    });
});

// Clear filter
document.getElementById("drawer-clear-filter").addEventListener("click", () => {
    state.feedFilter = "All Feeds";
    closeDrawer();
    updateFeedHeader();
    renderArticles();
});

// Font size slider
document.getElementById("font-size-slider").addEventListener("input", (e) => {
    const size = e.target.value;
    document.documentElement.style.setProperty("--reader-font-size", size + "px");
    try { localStorage.setItem("rss-font-size", size); } catch(e) {}
});

// Restore saved font size
try {
    const savedSize = localStorage.getItem("rss-font-size");
    if (savedSize) {
        document.getElementById("font-size-slider").value = savedSize;
        document.documentElement.style.setProperty("--reader-font-size", savedSize + "px");
    }
} catch(e) {}

// E-ink mode toggle
document.getElementById("eink-toggle").addEventListener("click", () => {
    const isEink = document.body.classList.toggle("eink");
    const toggle = document.getElementById("eink-toggle");
    toggle.textContent = isEink ? "On" : "Off";
    toggle.classList.toggle("active", isEink);
    try { localStorage.setItem("rss-eink", isEink ? "1" : "0"); } catch(e) {}
});

// Restore e-ink preference
try {
    if (localStorage.getItem("rss-eink") === "1") {
        document.body.classList.add("eink");
        const toggle = document.getElementById("eink-toggle");
        toggle.textContent = "On";
        toggle.classList.add("active");
    }
} catch(e) {}

// Settings toggle
document.getElementById("settings-toggle").addEventListener("click", () => {
    const content = document.getElementById("settings-content");
    const label = document.querySelector("#settings-toggle .drawer-section-label");
    const isHidden = content.classList.toggle("hidden");
    label.textContent = isHidden ? "▸ Settings" : "▾ Settings";
});

// Mark all read
document.getElementById("drawer-mark-all").addEventListener("click", () => {
    if (state.mode !== "Unread") return;
    const filtered = getFilteredArticles();
    if (filtered.length === 0) return;
    if (!confirm(`Archive ${filtered.length} articles?`)) return;
    filtered.forEach(a => state.history.add(a.id));
    db.ref("app_data/history").set(JSON.stringify([...state.history]));
    closeDrawer();
    renderArticles();
    updateFeedHeader();
});

// Sync
document.getElementById("drawer-sync").addEventListener("click", () => {
    closeDrawer();
    loadData();
});

// ── Add Feed ─────────────────────────────────────────────────────────────

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

document.getElementById("add-feed-toggle").addEventListener("click", () => {
    const form = document.getElementById("add-feed-form");
    const isHidden = form.classList.contains("hidden");
    form.classList.toggle("hidden");
    if (isHidden) {
        // Populate category dropdown
        const select = document.getElementById("add-feed-category");
        const categories = [...new Set(state.feeds.map(f => f._category || "My Feeds"))];
        select.innerHTML = categories.map(c => `<option value="${c}">${c}</option>`).join("")
            + '<option value="__new__">+ New Category</option>';
        document.getElementById("add-feed-name").value = "";
        document.getElementById("add-feed-url").value = "";
        document.getElementById("add-feed-status").textContent = "";
    }
});

document.getElementById("add-feed-cancel").addEventListener("click", () => {
    document.getElementById("add-feed-form").classList.add("hidden");
});

document.getElementById("add-feed-submit").addEventListener("click", async () => {
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
            document.getElementById("add-feed-form").classList.add("hidden");
            // Reload feeds
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

// Update header whenever articles render
const _origRenderArticles = renderArticles;
renderArticles = function() {
    _origRenderArticles();
    updateFeedHeader();
};

// ═══ SERVICE WORKER ══════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(err => {
        console.log("SW registration failed:", err);
    });
}
