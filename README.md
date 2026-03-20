# YouTube Turbo

Strip YouTube down to bare metal for maximum performance. This extension kills bloat, forces hard navigations to eliminate native SPA memory leaks, and drastically reduces CPU and memory usage.

## Features
- **Forces hard navigations:** Resets the JS context and purges ArrayBuffers/closures on every click instead of using YouTube's leaky SPA router.
- **Aggressive DOM purging:** Nukes Shorts shelves, Mixes, hidden engagement panels, and ads immediately.
- **Telemetry blocking:** Stops analytics pings (`/api/stats`, `/youtubei/log_event`, etc.) at the network level using `declarativeNetRequest`.
- **Memory limiters:** Periodically trims `MediaSource` buffers to 30s and routinely purges IndexedDB caches.
- **Zero layout thrashing:** CSS overrides kill all site-wide animations, hover effects, and transitions. Uses `IntersectionObserver` for lazy image rendering.

## Benchmarks
Comparison testing a standard video click (baseline SPA vs extension hard-nav):

| Metric | Vanilla YouTube | YouTube Turbo | Change |
| --- | --- | --- | --- |
| **Memory (JS Heap)** | 146.9 MB | 88.5 MB | **-40%** |
| **DOM Nodes** | 11,125 | 4,488 | **-60%** |
| **Data Bound Elements** | 2,026 | 500 | **-75%** |
| **Network Requests** | 28 | 10 | **-64%** |
| **Iframes** | 6 | 1 | **-83%** |

*(Benchmarks run on homepage and post-navigation; above stats reflect a typical video watch page).*
