"use strict";

// ============================================================
// YouTube Turbo — Content Script (runs at document_start, MAIN world)
// Memory optimization + leak prevention
// ============================================================

(() => {
  if (window.__turbo_init) return;
  window.__turbo_init = true;



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

  // --- 1.3 Force hard navigation (flush all SPA garbage on every navigate) ---
  let navigating = false;

  // Primary: intercept link clicks in capture phase (before YouTube's Polymer handlers)
  document.addEventListener("click", (e) => {
    if (navigating) return;
    const anchor = e.target.closest("a[href]");
    if (!anchor) return;
    try {
      const url = new URL(anchor.href);
      if (!url.hostname.includes("youtube.com")) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      navigating = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.location.href = anchor.href;
    } catch { }
  }, true);

  // Fallback: catch any programmatic SPA navigations via pushState
  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    if (url && !navigating) {
      const next = new URL(url, location.href);
      if (next.pathname !== location.pathname || next.search !== location.search) {
        navigating = true;
        window.location.href = next.href;
        return;
      }
    }
    return origPushState(state, title, url);
  };

  window.addEventListener("popstate", () => window.location.reload());

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
    "ytd-rich-shelf-renderer[is-shorts]," +
    "yt-video-metadata-carousel-view-model," +
    "#offer-module,.ytp-ce-element,.ytp-cards-teaser," +
    "ytd-live-chat-frame";

  // Kill video preview elements on sight (cheaper than intercepting createElement)
  const PREVIEW_SELECTORS = "ytd-video-preview,ytd-moving-thumbnail-renderer,#video-preview,#mouseover-overlay";

  function purgeDOM() {
    document.querySelectorAll(PURGE_SELECTORS).forEach(el => el.remove());
    document.querySelectorAll(PREVIEW_SELECTORS).forEach(el => el.remove());

    // Kill any remaining Shorts and Mixes by targeting their links and deleting their containers
    document.querySelectorAll("a[href^='/shorts/'], a[href*='start_radio=1']").forEach(a => {
      const parentNode = a.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer");
      if (parentNode) parentNode.remove();
    });

    // Wipe engagement panels (Chapters, Transcript) unless they are the main description
    document.querySelectorAll("ytd-engagement-panel-section-list-renderer:not([target-id='engagement-panel-structured-description'])").forEach(el => {
      try {
        if (el.data) el.data = null;
        while (el.firstChild) el.firstChild.remove();
      } catch { }
      el.remove();
    });
  }

  // Intercept MediaSource to track SourceBuffers and trim old data
  // (heap showed 766MB in 16k JSArrayBufferData — unbounded MSE buffers)
  const MAX_RETAIN = 30; // aggressively trim to 30s buffer to fix ArrayBuffer leaks
  const trackedSBRefs = new Set();
  let activeMediaSource = null;

  const origAddSB = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
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
    if (btn && btn.getAttribute("aria-checked") === "true") {
      btn.click();
    }
    // Also try to hit the manager directly if accessible
    const manager = document.querySelector("yt-navigation-manager");
    if (manager && manager.setAutonavState) {
      try { manager.setAutonavState("AUTONAV_STATE_OFF"); } catch { }
    }
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

    mainObserver.observe(document.body, { childList: true, subtree: true });


  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
  } else {
    onReady();
  }
})();
