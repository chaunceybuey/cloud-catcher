// ═══════════════════════════════════════════════════════════════════════════
// RSS TRIAGE PWA
// ═══════════════════════════════════════════════════════════════════════════

// ── Firebase Config ──────────────────────────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyBvNjSGiWQofUd3omAcBvJ-pa2pAtG2KNs",
    authDomain: "rss-triage.firebaseapp.com",
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
    feedOrder: [],
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

// ═══ AUTH ═════════════════════════════════════════════════════════════════

function triggerGoogleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(err => {
        console.error("Popup login failed:", err);
        if (err.code === "auth/popup-blocked") {
            auth.signInWithRedirect(provider);
        } else {
            alert("Login failed: " + err.message);
        }
    });
}

window.triggerGoogleLogin = triggerGoogleLogin;
document.getElementById("login-btn")?.addEventListener("click", triggerGoogleLogin);

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
    }
});

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

        state.articles.unshift(article);
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

// ═══ DATA LOADING ════════════════════════════════════════════════════════

async function loadData() {
    showScreen("feed");
    document.getElementById("loading")?.classList.remove("hidden");
    const listEl = document.getElementById("article-list");
    if (listEl) listEl.innerHTML = "";

    try {
        const [articlesRes, newsletterRes, feedsRes, savedLinksSnap, orderSnap] = await Promise.all([
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/master_articles.json?t=${Date.now()}`),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/newsletter_articles.json?t=${Date.now()}`).catch(() => null),
            fetch(`https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/feeds.json?t=${Date.now()}`),
            db.ref("app_data/saved_links").once("value").catch(() => null),
            db.ref("app_data/feed_order").once("value").catch(() => null)
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

        state.articles = [...savedArticles, ...githubArticles];

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

        const [histSnap, bmSnap] = await Promise.all([
            db.ref("app_data/history").once("value"),
            db.ref("app_data/bookmarks").once("value"),
        ]);

        if (histSnap.val()) state.history = new Set(JSON.parse(histSnap.val()).map(String));
        if (bmSnap.val()) state.bookmarks = JSON.parse(bmSnap.val());

        db.ref("app_data/history").off();
        db.ref("app_data/history").on("value", snap => {
            if (snap.val()) state.history = new Set(JSON.parse(snap.val()).map(String));
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
    const includeArticle = (a) => activeFeedNames.has(a.feed_name) || isSpecial(a);

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
            <div class="card-feed">${article.feed_name || ""}</div>
            <div class="card-title">${article.title || "Untitled"}</div>
            <div class="card-meta">
                <span class="card-date">${formatDate(article.date)}</span>
                ${article.author ? `<span class="card-author">${article.author}</span>` : ""}
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
                card.classList.add("dismissed");
                setTimeout(() => archiveArticle(articleId), 300);
            } else if (e.deltaX > 120) {
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

    const bmBtn = document.getElementById("reader-bookmark");
    bmBtn?.classList.toggle("active-action", article.id in state.bookmarks);

    showScreen("reader");

    const contentEl = document.getElementById("reader-content");
    if (contentEl) {
        contentEl.innerHTML = '<div class="reader-pages"><p style="color:#5A5F67;">Loading...</p></div>';
    }

    const feedName = article.feed_name || "";
    const date = formatDate(article.date);
    const author = article.author ? `By ${article.author}` : "";
    const title = article.title || "Untitled";

    const headerHtml = `
        <div class="article-header-meta">${feedName} · ${date}</div>
        <div class="article-header-title">${title}</div>
        ${author ? `<div class="article-header-author">${author}</div>` : '<div class="article-header-divider"></div>'}
    `;

    const safeKey = md5(article.link || article.id);
    
    if (article.source === "newsletter" || article.source === "manual") {
        setupPagination(headerHtml + (article.content || ""));
        enterFullscreen();
        return;
    }
    
    db.ref(`app_data/articles/${safeKey}`).once("value").then(snap => {
        const cached = snap.val();
        if (cached && cached.length > 500 && !cached.includes("Sign in") && !cached.includes("to continue to Gmail")) {
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

document.getElementById("reader-back")?.addEventListener("click", () => {
    if (history.state?.screen === "reader") {
        history.back();
    } else {
        goBackToFeed();
    }
});

document.getElementById("reader-archive")?.addEventListener("click", () => {
    if (state.currentArticle) {
        archiveArticle(state.currentArticle.id);
        goBackToFeed();
    }
});

document.getElementById("reader-bookmark")?.addEventListener("click", () => {
    if (state.currentArticle) {
        const id = state.currentArticle.id;
        if (id in state.bookmarks) {
            delete state.bookmarks[id];
        } else {
            state.bookmarks[id] = 0;
        }
        db.ref("app_data/bookmarks").set(JSON.stringify(state.bookmarks));
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
    state.history.add(String(articleId));
    db.ref("app_data/history").set(JSON.stringify([...state.history]));
    renderArticles();
    if (isLargeScreen()) renderDrawerFeeds();
}

function bookmarkArticle(articleId) {
    state.bookmarks[articleId] = 0;
    db.ref("app_data/bookmarks").set(JSON.stringify(state.bookmarks));
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
        let archived = 0;
        state.readThisSession.forEach(id => {
            if (!(id in state.bookmarks)) {
                state.history.add(String(id));
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

    let edgeSwipeStartX = null;
    readerBody.addEventListener("touchstart", (e) => {
        const x = e.touches[0].clientX;
        edgeSwipeStartX = x < 25 ? x : null;
    }, { passive: true });

    readerBody.addEventListener("touchend", (e) => {
        if (edgeSwipeStartX !== null) {
            const endX = e.changedTouches[0].clientX;
            if (endX - edgeSwipeStartX > 80) {
                goBackToFeed();
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

    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

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
            goBackToFeed();
        } else if (key === "b") {
            document.getElementById("reader-bookmark")?.click();
        } else if (key === "r" || key === "c") {
            document.getElementById("reader-readwise")?.click();
        } else if (key === "w" || key === "enter") {
            const btn = document.getElementById("fetch-full-btn");
            if (btn) btn.click();
        } else if (key === "escape" || key === "backspace") {
            e.preventDefault();
            goBackToFeed();
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
    document.querySelectorAll(".drawer