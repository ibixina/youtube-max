"use strict";

// ============================================================
// YouTube Turbo — Content Script (runs at document_start, MAIN world)
// Memory optimization + leak prevention
// ============================================================

(() => {
  if (window.__turbo_init) return;
  window.__turbo_init = true;

  let navCount = 0;
  // Deep closure leaks in YouTube cannot be fully fixed without a hard VM reset. 
  // Reloading every 4 clicks completely resets system/Context and ArrayBuffers.
  const MAX_NAVS_BEFORE_RELOAD = 4;

  // ================================================================
  // SECTION 1: Early interception (before YouTube code runs)
  // ================================================================

  // --- 1.0 Prevent Blob URI Leaks (MediaSource) ---
  // If YouTube leaks the Blob URI string in a closure, the browser NEVER frees the MediaSource memory!
  const origCreateObjectURL = URL.createObjectURL;
  const activeMediaSourceUrls = [];
  URL.createObjectURL = function (obj) {
    const url = origCreateObjectURL.apply(this, arguments);
    if (obj instanceof MediaSource) {
      activeMediaSourceUrls.push(url);
      if (activeMediaSourceUrls.length > 2) {
        // Keep 2 just in case it's doing a seamless transition, but revoke anything older!
        const oldUrl = activeMediaSourceUrls.shift();
        try { URL.revokeObjectURL(oldUrl); } catch (e) { }
      }
    }
    return url;
  };

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
    try {
      if (!indexedDB.databases) return;
      indexedDB.databases().then(dbs => {
        dbs.forEach(db => {
          if (db.name !== "yt-player-local-media") indexedDB.deleteDatabase(db.name);
        });
      }).catch(() => { });
    } catch (e) { }
  }
  purgeIndexedDB();

  // --- 1.3 Limit history.pushState ---
  let historyCount = 0;
  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    historyCount++;
    if (historyCount > 10) return history.replaceState(state, title, url);
    return origPushState(state, title, url);
  };

  // --- 1.4 Block telemetry ---
  const BLOCKED = [
    "/api/stats/", "/youtubei/v1/log_event", "/youtubei/v1/att/get",
    "/generate_204", "play.google.com", "doubleclick.net",
    "googlesyndication.com", "googleadservices.com", "google-analytics.com",
    "googletagmanager.com", "jnn-pa.googleapis.com", "adservice.google",
    "/ptracking", "/api/stats/watchtime", "/api/stats/atr",
  ];

  function isBlocked(url) {
    const s = String(url || "");
    for (const pattern of BLOCKED) {
      if (s.includes(pattern)) return true;
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
    return false;
  };

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

  // Kill video preview elements on sight (cheaper than intercepting createElement)
  const PREVIEW_SELECTORS = "ytd-video-preview,ytd-moving-thumbnail-renderer,#video-preview,#mouseover-overlay";

  function purgeDOM() {
    document.querySelectorAll(PURGE_SELECTORS).forEach(el => el.remove());
    document.querySelectorAll(PREVIEW_SELECTORS).forEach(el => el.remove());
  }

  // Intercept MediaSource to track SourceBuffers and trim old data
  // (heap showed 766MB in 16k JSArrayBufferData — unbounded MSE buffers)
  const MAX_RETAIN = 30; // aggressively trim to 30s buffer to fix ArrayBuffer leaks
  const trackedSBRefs = new Set();
  let activeMediaSource = null;

  const origAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    if (activeMediaSource !== this) {
      // User clicked a new video -> Purge massive ArrayBuffers from previously tracked MediaSources!
      for (const ref of trackedSBRefs) {
        const oldSb = ref.deref();
        if (oldSb) {
          try {
            if (oldSb.updating) oldSb.abort();
            oldSb.remove(0, Infinity);
          } catch (e) { }
        }
      }
      trackedSBRefs.clear();
      activeMediaSource = this;
    }

    const sb = origAddSB.call(this, mime);
    trackedSBRefs.add(new WeakRef(sb));
    return sb;
  };

  function trimSourceBuffers() {
    const video = document.querySelector("video.html5-main-video");
    if (!video || !video.currentTime) return;
    const ct = video.currentTime;
    const doTrim = () => {
      for (const ref of trackedSBRefs) {
        const sb = ref.deref();
        if (!sb) { trackedSBRefs.delete(ref); continue; }
        try {
          if (sb.updating || !sb.buffered.length) continue;
          const start = sb.buffered.start(0);
          // Only trim data behind the playhead, never ahead
          if (ct - start > MAX_RETAIN) {
            sb.remove(start, ct - MAX_RETAIN);
          }
        } catch { trackedSBRefs.delete(ref); }
      }
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(doTrim);
    else setTimeout(doTrim, 200);
  }

  function destroyStaleRenderers() {
    // Target hidden SPA pages holding onto massive DOM trees and closures
    document.querySelectorAll(
      "ytd-watch-flexy[hidden],ytd-browse[hidden],ytd-search[hidden],ytd-playlist[hidden]"
    ).forEach(el => {
      try {
        if (el.data) el.data = null;
        if (el.__data) el.__data = null;
        if (el.items) el.items = null;
        if (el.player) el.player = null;
      } catch { }
      // Nuke child nodes so ytd- elements can be GC'd (CSP-safe, no innerHTML)
      while (el.firstChild) el.firstChild.remove();
      el.remove();
    });
    document.querySelectorAll(
      "tp-yt-paper-tooltip,tp-yt-paper-dialog"
    ).forEach(el => el.remove());
  }

  // --- Image management via IntersectionObserver (zero layout thrashing) ---
  let imageIO;
  const observedImages = new Set();

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
  }

  function observeNewImages() {
    if (!imageIO) return;
    document.querySelectorAll("ytd-thumbnail img, ytd-playlist-thumbnail img").forEach(img => {
      if (!img._tio) {
        img._tio = true;
        observedImages.add(img);
        imageIO.observe(img);
      }
    });
  }

  function releaseHiddenData() {
    // General sweep for detached node data properties
    document.querySelectorAll("[hidden]").forEach(el => {
      if (el.data && typeof el.data === "object") el.data = null;
      if (el.__data) el.__data = null;
      if (el.items) el.items = null;
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

  let domDirty = false;
  let mutTimer = null;
  const mainObserver = new MutationObserver(() => {
    domDirty = true;
    clearTimeout(mutTimer);
    mutTimer = setTimeout(() => {
      observeNewImages();
      cleanup();
    }, 2000);
  });

  function cleanup() {
    if (!domDirty) return;
    domDirty = false;
    purgeDOM();
    releaseHiddenData();
    destroyStaleRenderers();
    trimSourceBuffers();

    // Release IntersectionObserver references for removed elements
    for (const img of observedImages) {
      if (!document.body.contains(img)) {
        imageIO.unobserve(img);
        observedImages.delete(img);
      }
    }
  }

  function onReady() {
    purgeDOM();
    capVideoQuality();
    disableAutoplay();
    setupImageObserver();
    observeNewImages();

    // Ensure memory is trimmed reliably even when DOM is totally static
    setInterval(trimSourceBuffers, 10000);
    setInterval(destroyStaleRenderers, 30000);

    mainObserver.observe(document.body, { childList: true, subtree: true });

    // SPA navigation handler
    document.addEventListener("yt-navigate-finish", () => {
      navCount++;

      // Flush massive SPA transition mutations
      mainObserver.disconnect();
      mainObserver.observe(document.body, { childList: true, subtree: true });

      if (navCount >= MAX_NAVS_BEFORE_RELOAD) {
        // Clear observers before reload to free memory faster
        mainObserver.disconnect();
        if (imageIO) imageIO.disconnect();
        window.location.reload();
        return;
      }
      setTimeout(() => {
        destroyStaleRenderers();
        purgeDOM();
        capVideoQuality();
        disableAutoplay();
        purgeIndexedDB(); // Replaces the 5min interval
      }, 500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }
})();
