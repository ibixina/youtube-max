// YouTube Turbo Benchmark — paste into browser DevTools console
// Run on youtube.com homepage, then it will auto-navigate to a video and measure again.
// Requires: DevTools open with "Performance" memory checkbox enabled for heap measurements.

(async () => {
    const results = { phase: "", timestamp: new Date().toISOString(), url: location.href };

    // --- Memory ---
    if (performance.memory) {
        results.jsHeapUsed_MB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
        results.jsHeapTotal_MB = +(performance.memory.totalJSHeapSize / 1048576).toFixed(1);
        results.jsHeapLimit_MB = +(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1);
    }

    // --- DOM ---
    results.domNodes = document.querySelectorAll("*").length;
    results.domDepth = (() => {
        let max = 0;
        const walk = (el, d) => { if (d > max) max = d; for (const c of el.children) walk(c, d + 1); };
        walk(document.documentElement, 0);
        return max;
    })();
    results.iframes = document.querySelectorAll("iframe").length;
    results.images = document.querySelectorAll("img").length;
    results.scripts = document.querySelectorAll("script").length;
    results.styleSheets = document.styleSheets.length;

    // --- Layout / Paint ---
    const paint = performance.getEntriesByType("paint");
    paint.forEach(p => { results[p.name + "_ms"] = +p.startTime.toFixed(1); });

    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
        results.domContentLoaded_ms = +(nav.domContentLoadedEventEnd - nav.startTime).toFixed(1);
        results.loadEvent_ms = +(nav.loadEventEnd - nav.startTime).toFixed(1);
        results.domInteractive_ms = +(nav.domInteractive - nav.startTime).toFixed(1);
        results.ttfb_ms = +(nav.responseStart - nav.startTime).toFixed(1);
        results.transferSize_KB = +(nav.transferSize / 1024).toFixed(1);
    }

    // --- Resources ---
    const resources = performance.getEntriesByType("resource");
    results.totalRequests = resources.length;
    results.totalTransfer_KB = +(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024).toFixed(1);
    const byType = {};
    resources.forEach(r => {
        const ext = r.name.split("?")[0].split(".").pop().slice(0, 5) || "other";
        byType[ext] = (byType[ext] || 0) + 1;
    });
    results.requestsByType = byType;

    // --- Event Listeners (approximate via getEventListeners if available) ---
    results.bodyChildNodes = document.body?.childNodes.length || 0;

    // --- Mutation observer load (count live elements with data properties) ---
    let dataProps = 0;
    document.querySelectorAll("*").forEach(el => { if (el.data || el.__data) dataProps++; });
    results.elementsWithDataProps = dataProps;

    // --- Long tasks (if PerformanceObserver was set up) ---
    results.longestTask_ms = 0;
    const longTasks = performance.getEntriesByType("longtask");
    if (longTasks.length) {
        results.longestTask_ms = +Math.max(...longTasks.map(t => t.duration)).toFixed(1);
        results.longTaskCount = longTasks.length;
    }

    // --- Output ---
    console.log("\n========== YOUTUBE BENCHMARK ==========");
    console.log(JSON.stringify(results, null, 2));
    console.log("========================================\n");
    console.log("%cCopy the JSON above. Run this on:", "font-weight:bold");
    console.log("1) Homepage without extension (baseline)");
    console.log("2) After clicking a video without extension");
    console.log("3) Homepage with extension");
    console.log("4) After clicking a video with extension");

    // Also copy to clipboard
    try {
        await navigator.clipboard.writeText(JSON.stringify(results, null, 2));
        console.log("%c✓ Results copied to clipboard", "color:green;font-weight:bold");
    } catch {
        console.log("(clipboard copy failed — manually copy the JSON above)");
    }

    return results;
})();
