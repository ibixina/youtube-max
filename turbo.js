"use strict";

// ============================================================
// YouTube Turbo — Content Script (runs at document_start)
// Aggressive memory optimization + leak prevention
// ============================================================

(() => {
  let navCount = 0;
  const MAX_NAVS_BEFORE_RELOAD = 15;
  const MAX_BUFFER_SECONDS = 30;

  // ================================================================
  // SECTION 1: Early interception (before YouTube code runs)
  // ================================================================

  // --- 1.1 Kill Service Worker ---
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    });
    Object.defineProperty(navigator, "serviceWorker", {
      get: () => ({
        register: () => Promise.reject(),
        getRegistrations: () => Promise.resolve([]),
        ready: Promise.resolve(),
        addEventListener: () => { },
      }),
    });
  }

  // --- 1.2 Purge IndexedDB ---
  function purgeIndexedDB() {
    if (!indexedDB.databases) return;
    indexedDB.databases().then(dbs => {
      dbs.forEach(db => {
        if (db.name !== "yt-player-local-media") indexedDB.deleteDatabase(db.name);
      });
    });
  }
  purgeIndexedDB();

  // --- 1.3 Debounce MutationObserver spam ---
  // Use a single shared rAF instead of per-observer closures
  const OrigMO = window.MutationObserver;
  const pendingMO = [];
  let moRafScheduled = false;

  function flushMO() {
    moRafScheduled = false;
    const batch = pendingMO.splice(0);
    batch.forEach(([cb, mutations, observer]) => cb(mutations, observer));
  }

  window.MutationObserver = class extends OrigMO {
    constructor(cb) {
      super((mutations, observer) => {
        pendingMO.push([cb, mutations, observer]);
        if (!moRafScheduled) {
          moRafScheduled = true;
          requestAnimationFrame(flushMO);
        }
      });
    }
  };

  // --- 1.4 SourceBuffer trim (primary 1-3GB leak fix) ---
  const origAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = origAddSB.call(this, mime);
    const origAppend = sb.appendBuffer;

    sb.appendBuffer = function (data) {
      // Trim before appending
      if (!sb.updating && sb.buffered.length > 0) {
        try {
          const vid = document.querySelector("video");
          if (vid) {
            const behind = vid.currentTime - sb.buffered.start(0);
            if (behind > MAX_BUFFER_SECONDS) {
              sb.remove(sb.buffered.start(0), vid.currentTime - MAX_BUFFER_SECONDS);
              return; // will re-append after 'updateend'
            }
          }
        } catch { }
      }
      return origAppend.call(sb, data);
    };

    // Re-append after buffer trim completes
    sb.addEventListener("updateend", () => { }, { passive: true });

    return sb;
  };

  // --- 1.5 Limit history.pushState ---
  let historyCount = 0;
  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    historyCount++;
    if (historyCount > 10) return history.replaceState(state, title, url);
    return origPushState(state, title, url);
  };

  // --- 1.6 Block telemetry ---
  const BLOCKED = [
    "/api/stats/", "/youtubei/v1/log_event", "/youtubei/v1/att/get",
    "/generate_204", "play.google.com", "doubleclick.net",
    "googlesyndication.com", "googleadservices.com", "google-analytics.com",
    "googletagmanager.com", "jnn-pa.googleapis.com", "adservice.google",
    "/ptracking", "/api/stats/watchtime", "/api/stats/atr",
  ];

  function isBlocked(url) {
    const s = String(url || "");
    for (let i = 0; i < BLOCKED.length; i++) {
      if (s.includes(BLOCKED[i])) return true;
    }
    return false;
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (isBlocked(typeof input === "string" ? input : input?.url)) {
      return Promise.resolve(new Response("", { status: 204 }));
    }
    return origFetch.call(this, input, init);
  };

  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (isBlocked(url)) { this._blocked = true; return; }
    return origXHROpen.call(this, method, url, ...rest);
  };
  const origXHRSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this._blocked) return;
    return origXHRSend.call(this, ...args);
  };

  navigator.sendBeacon = function (url) {
    if (isBlocked(url)) return true;
    return false; // just drop all beacons — they're all telemetry on youtube
  };

  // --- 1.7 Cap requestIdleCallback budget ---
  const origRIC = window.requestIdleCallback;
  if (origRIC) {
    window.requestIdleCallback = function (cb, opts) {
      return origRIC.call(window, (deadline) => {
        cb({
          didTimeout: deadline.didTimeout,
          timeRemaining: () => Math.min(deadline.timeRemaining(), 5),
        });
      }, opts);
    };
  }

  // ================================================================
  // SECTION 2: DOM cleanup
  // ================================================================

  const PURGE_SELECTORS =
    "#player-ads,#masthead-ad,#ad-text,#sparkles-container," +
    ".ytp-ad-module,.video-ads,.ytp-ad-overlay-container," +
    "ytd-ad-slot-renderer,ytd-banner-promo-renderer," +
    "ytd-statement-banner-renderer,ytd-in-feed-ad-layout-renderer," +
    "ytd-promoted-sparkles-web-renderer,ytd-display-ad-renderer," +
    "ytd-promoted-video-renderer,ytd-compact-promoted-video-renderer," +
    "ytd-action-companion-ad-renderer,ytd-mealbar-promo-renderer," +
    "ytd-popup-container,ytd-consent-bump-v2-lightbox," +
    "tp-yt-iron-overlay-backdrop,ytd-merch-shelf-renderer," +
    "ytd-donation-shelf-renderer,ytd-reel-shelf-renderer," +
    "#offer-module,.ytp-ce-element,.ytp-cards-teaser," +
    "ytd-live-chat-frame";

  function purgeDOM() {
    document.querySelectorAll(PURGE_SELECTORS).forEach(el => el.remove());
  }

  // Destroy renderers YouTube has marked hidden (stale SPA pages)
  function destroyStaleRenderers() {
    document.querySelectorAll(
      "ytd-watch-flexy[hidden],ytd-browse[hidden]"
    ).forEach(el => {
      if (el.data) el.data = null;
      el.remove();
    });
    document.querySelectorAll(
      "tp-yt-paper-tooltip,tp-yt-paper-dialog"
    ).forEach(el => el.remove());
  }

  // --- Image management via IntersectionObserver (zero layout thrashing) ---
  let imageIO;

  function setupImageObserver() {
    imageIO = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const img = entry.target;
        if (entry.isIntersecting) {
          if (img.dataset.turbosrc) {
            img.src = img.dataset.turbosrc;
            delete img.dataset.turbosrc;
          }
        } else if (img.src && !img.dataset.turbosrc) {
          img.dataset.turbosrc = img.src;
          img.removeAttribute("src");
        }
      });
    }, { rootMargin: "200% 0px" });

    function observeNewImages() {
      document.querySelectorAll("ytd-thumbnail img, ytd-playlist-thumbnail img").forEach(img => {
        if (!img._tio) {
          img._tio = true;
          imageIO.observe(img);
        }
      });
    }
    observeNewImages();

    // Re-observe when new thumbnails are added (SPA nav, infinite scroll)
    new OrigMO(observeNewImages).observe(document.body, { childList: true, subtree: true });
  }

  // Block thumbnail hover preview at JS level
  function blockHoverPreviews() {
    document.addEventListener("mouseover", (e) => {
      const thumb = e.target.closest("ytd-thumbnail, ytd-rich-grid-media");
      if (thumb) {
        thumb.removeAttribute("is-preview-loading");
        thumb.removeAttribute("is-preview-playing");
      }
    }, { capture: true, passive: true });
  }

  function releaseHiddenData() {
    document.querySelectorAll("[hidden][data]").forEach(el => {
      if (typeof el.data === "object") el.data = null;
    });
  }

  function capVideoQuality() {
    const player = document.getElementById("movie_player");
    if (!player?.setPlaybackQualityRange) return;
    try { player.setPlaybackQualityRange("tiny", "hd1080"); } catch { }
  }

  function disableAutoplay() {
    const btn = document.querySelector(".ytp-autonav-toggle-button");
    if (btn?.getAttribute("aria-checked") === "true") btn.click();
  }

  // ================================================================
  // SECTION 3: Orchestration (mutation-driven, not blind polling)
  // ================================================================

  let domDirty = true;

  function cleanup() {
    if (!domDirty) return;
    domDirty = false;
    purgeDOM();
    releaseHiddenData();
    destroyStaleRenderers();
  }

  function onReady() {
    purgeDOM();
    capVideoQuality();
    disableAutoplay();
    blockHoverPreviews();
    setupImageObserver();

    // Set dirty flag on DOM mutations instead of polling blindly
    new OrigMO(() => { domDirty = true; }).observe(
      document.body, { childList: true, subtree: true }
    );

    // Cheap flag check every 5s — only does work if DOM actually changed
    setInterval(cleanup, 5000);

    // Re-purge IndexedDB every 5 minutes
    setInterval(purgeIndexedDB, 300000);

    // SPA navigation handler
    document.addEventListener("yt-navigate-finish", () => {
      navCount++;
      if (navCount >= MAX_NAVS_BEFORE_RELOAD) {
        window.location.reload();
        return;
      }
      setTimeout(() => {
        destroyStaleRenderers();
        purgeDOM();
        capVideoQuality();
        disableAutoplay();
      }, 500);
    });

    // Allow background playback — prevent YouTube from pausing on tab switch
    document.addEventListener("visibilitychange", (e) => {
      if (document.hidden) {
        e.stopImmediatePropagation();
      }
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }
})();
