# Exceptional session-list row windowing

`EntityList.windowing` is opt-in; only SessionList enables it when its **already paged** logical rows exceed 200. Ordinary 50-session pagination and the 100-result search cap stay unchanged. Do not split families or virtualize the logical selection/navigation model.

Keep group containers/headers, measured variable row heights, full spacer-backed group extents, selected/keyboard/menu anchors and row accessibility positions. The viewport is an ancestor ref: attach the scroll/ResizeObserver subscription in the passive effect, after that ref mounts. Preserve the first visible row when heights/reorders above it change; release observers, frames, DOM refs and removed-key caches. Never add a global/session-history cache.

Tests: `bun test apps/electron/src/renderer/components/ui/__tests__/windowed-list-layout.test.ts`. Actual interaction fixture: `scripts/fixtures/session-metadata/profile-browser.ts ... 'count=1000&history=1000&richSize=4&shell=0&family=1' window-check` (see fixture README for setup/limitations).
