# nudge: Contract for v1

Agentic test-driven loop. Do not build until this contract is confirmed. Do not declare done until every GOOD check passes.

## What is being built

`nudge.js` (draft already in this folder) taken from untested first draft to verified v1. Two originating cases on a real Astro site:

1. Homepage hero: drag the tagline paragraph's right edge out to the portrait. Tagline is capped by `max-width: 540px` inside a flex column ~900px wide.
2. Work page: drag the phone `figure` in the right grid column down until its bottom edge aligns with the bottom of a paragraph in the middle column.

## Definition of DONE

1. `nudge.js` loads via `bookmarklet.txt`, toggles off on second click, and passes the full suite.
2. `tests/fixture.html` reproduces both cases plus: a link, an element with an existing `transform: rotate(3deg)`, an element with Astro source attributes, and enough height to need scrolling.
3. `tests/nudge.spec.mjs` runs under Playwright (Chromium, headless) from a `package.json` in this folder.
4. `README.md` and `CLAUDE.md` updated with the test command and any behaviour that changed.
5. Manual acceptance (outside automation): both gestures on a real Astro dev server, batch pasted into Claude Code, resulting CSS uses layout rules (align-self / margin / max-width), not transforms or inline styles.

## Definition of GOOD

All pass/fail. No subjective checks.

| # | Check | Pass condition |
|---|---|---|
| 1 | Syntax | `node --check nudge.js` exits 0 |
| 2 | Toggle | After first inject `window.__nudge` is an object; after second it is `undefined`; panel and overlay removed from DOM |
| 3 | No console errors | Zero `console.error` and zero `pageerror` events across every test |
| 4 | Resize | Drag E handle of `.tagline` +300px → record `w` within ±2px of `base.w + 300`; element computed width matches; report contains `width 540px → 840px (was capped by max-width: 540px)` |
| 5 | Move + snap | Drag `figure` down until its bottom is within 4px of target paragraph's bottom, release → `abs(fig.bottom − p.bottom) ≤ 1`; report contains `bottom edge aligned with bottom edge of` followed by the paragraph's descriptor |
| 6 | No false snap | Same drag with shift held → no guide visible during drag, no alignment line in report |
| 7 | Remove | Select `figure`, press Backspace → computed `display: none`; report contains `remove this element from the markup` |
| 8 | Arrow nudge | Select, ArrowDown ×3 → `dy === 3`; Shift+ArrowRight → `dx === 10` |
| 9 | Undo | Click row's undo → element `style.cssText` equals pre-tool value; row count decrements |
| 10 | Reset | After three changes, Reset → all three `style.cssText` equal originals; list shows "No changes yet." |
| 11 | Tool DOM excluded | `mousedown` on panel and on a handle never sets `selected` to a tool element; no `[data-nudge]` element appears in snap candidates |
| 12 | Navigation blocked | Click `<a href="/elsewhere">` while active → `page.url()` unchanged |
| 13 | Scroll | Scroll 400px, select an element below the fold, resize +100px → recorded width correct; selection box tracks element after further scroll |
| 14 | Existing transform | Move an element with `transform: rotate(3deg)` → computed transform still includes the rotation; undo restores exactly |
| 15 | Escape | Escape clears selection; selection box hidden |
| 16 | Copy | Click Copy → clipboard text equals `window.__nudge.report()`; button reads "Copied" |
| 17 | Astro source attr | Element with `data-astro-source-file="/abs/path/src/pages/index.astro"` and `data-astro-source-loc="46:13"` → report line contains `(src/pages/index.astro:46:13)` |
| 18 | Report footer | Report ends with the five instruction lines verbatim as written in `report()` |
| 19 | Resize edge snap | Drag E handle of `.card-a` until its right edge is within 4px of `.card-b`'s right edge → `abs(a.right − b.right) ≤ 1`; vertical guide visible at the last drag step; report contains `right edge aligned with right edge of` + card-b's descriptor; no `matches` line |
| 20 | Resize width match | Drag E handle until width is within 4px of `.card-b`'s width → `abs(a.width − b.width) ≤ 1`; dashed match box visible over card-b (live rect within 1px) at the last step; report contains `width matches width of` + descriptor, then the label's snippet, then `(520px)`; no `aligned` line |
| 21 | Shift disables resize snap | Same drag as 20 with Shift → width exactly as dragged; no guide or match box at any step; no `aligned` or `matches` line |
| 22 | Aspect lock, E handle | Alt-drag E handle of a 320×80 image +120px → final `width/height` within 0.05 of 4.0; report matches `aspect ratio kept, scaled to N%`; no `distorts` line. Repeat with Control after Reset → ratio still within 0.05 |
| 23 | Aspect lock, corner | Alt-drag SE handle by (160, 10) → width grew more than 100px (the dominant axis drove) and ratio within 0.05 of 4.0 |
| 24 | Distortion warning | Same E drag with no modifier → height unchanged, ratio above 4.2, report matches `aspect ratio changed from 4.00:1 to N.NN:1; this distorts the image`; no `aspect ratio kept` line |

## Test Plan

```
npm init -y
npm i -D @playwright/test
npx playwright install --with-deps chromium

node --check nudge.js
npx playwright test --reporter=list
```

Each spec loads `tests/fixture.html` from `https://nudge.test/` (a `page.route` that fulfils from disk; `file://` has no origin for clipboard permission grants and `http://` is not a secure context so `navigator.clipboard` is undefined), injects `nudge.js` with `page.addScriptTag`, drives it with `page.mouse` and `page.keyboard`, reads state via `window.__nudge.report()` and a test-only `window.__nudge._state` hook (exposes `selected` and `changes`; no behavioural effect). Console and page errors collected per test and asserted empty in `afterEach`. Clipboard test grants `clipboard-read`/`clipboard-write` permissions in the Playwright context and freezes the clock with `page.clock.setFixedTime` so `report()` is byte-stable across the comparison.

## Loop

Act → run suite → read failures → fix `nudge.js` → re-run. Repeat until 18/18. Then manual acceptance (DONE item 5) on the real site.

## Outcome (13 Sep 2026)

18/18, stable over `--repeat-each 3`. First run was 14/18. Failures and fixes, in order:

1. Checks 5 and 6: nearest-wins snapping chose a cross-edge (top to bottom) match 1px away over the intended bottom-to-bottom match 3px away. Fixed with a 2px cross-edge penalty and smaller-element tie-break. Check 6 also showed release-time relationship detection ignored shift; now shift at release records nothing.
2. Check 16: `http://` origin is not a secure context, `navigator.clipboard` undefined. Fixture now served from `https://nudge.test/`.
3. Checks 9, 10, 13, 14: fixture geometry. Elements the tests clicked were below the fold. The `select` helper now scrolls into view when needed.
4. Sample output showed `img img "alt"` for image elements. Snippet no longer repeats the tag.

Also changed while building: translate now precedes the element's existing transform; relationships are recorded only on the axis that moved.

## Resize snapping (added 13 Sep 2026, checks 19–21)

Requested after manual use: resizing was blind, alignment only ran on move. Miro's two behaviours copied: the moving edge snaps to other edges (guide line), and the size snaps to another element's size (dashed box over the matched element). Both recorded in the batch; Shift disables both. 21/21, stable over `--repeat-each 3`.

First failures: the match box was drawn from coordinates captured at drag start, and the resize reflowed the card's text so the matched element moved 24px. Box now drawn from the live rect; candidates recollected on release so relationships reflect the reflowed page. Check 20's assertion also mis-specified the label (it forgot the text snippet between descriptor and px); amended above.

## Aspect ratio lock (added 13 Sep 2026, checks 22–24)

Requested after manual use: a single image (one PNG of four logos with an inline height) needed to get bigger without stretching. Resizing it in nudge set width alone and left the inline height, so the preview and the batch both described a distorted image. The lock was the requested feature; the distortion warning is the bug that request uncovered.

Keys are Option, Command **and** Control, all meaning lock. Control alone was the requested key but is the macOS secondary click, so it may never reach the tool as a drag; Playwright's synthetic events cannot reproduce that OS-level conversion, so check 22 proves the code path accepts `ctrlKey` and nothing more. Real-browser behaviour on macOS is unverified and Option is the documented key. `contextmenu` is suppressed while the tool is active to give Control-drag a chance and to stop the menu covering the page.

On the corner handle the larger of the two movements drives and the other dimension follows. The ratio is taken at drag start, not from the original element, so locking after a deliberate distortion preserves the current shape, as in Figma and Sketch.

24/24, no failures on the first run, stable over `--repeat-each 3`.

## Expected first failures

- Snap catching the wrong candidate in dense text (many edges within tolerance). Consider preferring same-edge matches and nearer elements.
- Selection outline lagging or detached after hot reload.
- Candidate collection cost on large pages.
