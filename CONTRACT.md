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
| 16 | Copy | Click Copy → clipboard text equals `window.__nudge.report()`; button reads "Copied" (amended 15 Sep 2026: it then becomes "Clear preview", see 25) |
| 17 | Astro source attr | Element with `data-astro-source-file="/abs/path/src/pages/index.astro"` and `data-astro-source-loc="46:13"` → report line contains `(src/pages/index.astro:46:13)` |
| 18 | Report footer | Amended 15 Sep 2026. Footer is the first line plus only what the batch needs: resize only → apply + widths; unaligned move → apply + spacing; removal only → apply + removals; aligned move → apply + aligned; all together → all five in order. The first line always carries "Do not add inline styles." |
| 19 | Resize edge snap | Drag E handle of `.card-a` until its right edge is within 4px of `.card-b`'s right edge → `abs(a.right − b.right) ≤ 1`; vertical guide visible at the last drag step; report contains `right edge aligned with right edge of` + card-b's descriptor; no `matches` line |
| 20 | Resize width match | Drag E handle until width is within 4px of `.card-b`'s width → `abs(a.width − b.width) ≤ 1`; dashed match box visible over card-b (live rect within 1px) at the last step; report contains `width matches width of` + descriptor, then the label's snippet, then `(520px)`; no `aligned` line |
| 21 | Shift disables resize snap | Same drag as 20 with Shift → width exactly as dragged; no guide or match box at any step; no `aligned` or `matches` line |
| 22 | Aspect lock, E handle | Alt-drag E handle of a 320×80 image +120px → final `width/height` within 0.05 of 4.0; report matches `aspect ratio kept, scaled to N%`; no `distorts` line. Repeat with Control after Reset → ratio still within 0.05 |
| 23 | Aspect lock, corner | Alt-drag SE handle by (160, 10) → width grew more than 100px (the dominant axis drove) and ratio within 0.05 of 4.0 |
| 24 | Distortion warning | Same E drag with no modifier → height unchanged, ratio above 4.2, report matches `aspect ratio changed from 4.00:1 to N.NN:1; this distorts the image`; no `aspect ratio kept` line |
| 25 | Sent state | Resize, Copy → button reads "Copied" and ignores clicks, then "Clear preview"; status is exactly "Sent. Clear the preview once your agent has applied it."; element's inline styles unchanged; its row has `data-sent`, a ✓ and opacity below 1; Re-copy visible. Clear preview → `style.cssText` equals the original, list reads "No changes yet.", Re-copy hidden, button reads "Copy for Claude Code" |
| 26 | Re-copy and new changes | After Copy, overwrite the clipboard, press Re-copy → clipboard equals the first copy (fixed clock). A new change makes the button "Copy for Claude Code" again, and that copy contains only the new element |
| 27 | Editing a sent element | Move `figure` 40px with Shift, Copy. Mouse down and up on it without moving → still sent with dy 40. Drag 20px with Shift → exactly one record, `{dy: 20, sent: false}`, computed translate ≈ 20, status contains "Cleared the sent preview for this element; this change starts from the live page." Copy, then ArrowDown → `{dy: 1, sent: false}` with the same status |
| 28 | Reload warning | Replacing head `<style>` text before Copy shows no warning, before or after copying. Appending a new `<style>` and a text node to it (CSS-in-JS) shows no warning. Replacing style text after Copy → `#nudge-reload` visible with text "The page reloaded. Clear the preview to see the real result." and inline styles unchanged. Clear preview hides it. Adding a `<link rel=stylesheet>` after a later Copy shows it |
| 29 | Computed max-width | Element with `max-width: clamp(200px, 33.37vw, 900px)` (computed as a fractional px) resized +100 → report contains `width Npx → N+100px (the element was capped at Npx by a computed max-width, check the source for the rule)` and no `was capped by max-width:` |
| 30 | Keys after panel clicks | Click a row's undo, select an element, ArrowRight → dx 1. Click Reset, select, Escape → nothing selected |
| 31 | Edit text | Double-click a plain-text element → contentEditable, status "Editing text. Escape or click elsewhere to finish."; select all, type, Escape → attribute removed, text replaced, report contains `text "old" → "new"`, footer is apply + text line, row reads "text edited" |
| 32 | Refuse mixed content | Double-click text inside an element with a child element → not editable, no record, status "Cannot edit text: this element contains other elements (strong); double-click the innermost text instead." |
| 33 | Plain text only | While editing, Enter, Cmd/Ctrl+B and a paste carrying HTML leave zero child elements and no newline; pasted text arrives as plain text with whitespace collapsed |
| 34 | Commit and undo | Edit an element containing a React-style comment node, click another element → committed and reported; row undo → `innerHTML` identical to the original, including the comment |
| 35 | Keys while editing | Backspace deletes a character, arrows move the caret; no move or removal is recorded. After Escape, ArrowDown nudges again |
| 36 | Middle change | A one-word change in the middle of a long string, where head-and-tail truncation would print identical strings, is reported as two different windows around the change, each within the truncation budget |
| 37 | Type controls relevance | The type row is hidden with nothing selected, visible for an element with its own text, hidden for an image and for a wrapper whose text is all in child elements |
| 38 | Populated from computed style | Fields show computed size, line height (px, or `normal`), letter spacing (px, or `normal`) and weight |
| 39 | Step and snap | ArrowUp from 17px passes a 20px heading without sticking and lands on 21px matching `.type-lede`: computed 21px, match line "size matches .type-lede", match box over the lede, batch line `font size 17px → 21px (now matches .type-lede)`, footer apply + type. One more step clears the match. The element never moves |
| 40 | Modifiers and lines | Shift+ArrowUp +10; Alt+ArrowDown −0.1 without snapping; letter spacing Alt+ArrowUp from normal to 0.1; weight ArrowUp 400 → 500. Each changed property is its own batch line with before and after |
| 41 | Typed value and undo | Typing 30 in line height + Enter → computed 30px, batch `line height 25.5px → 30px, 1.5 → 1.76 × font size (now matches .type-lede)` (same-tag preference on ties). Typing weight 700 matches `.type-title`. Clicking the row's undo straight after restores `style.cssText` exactly |
| 42 | Focus returns to the page | After stepping a field, clicking another element and pressing ArrowDown moves that element and does not change type |
| 49 | Type steppers | Stepper arrows are hidden at rest and appear on hover or focus. Clicking up four times from 17px snaps through 20px to 21px with the match line; Shift-click +10; Alt-click −0.1. Clicking a stepper keeps focus in a focused field and ArrowUp still steps. Holding a stepper repeats. The element never moves |

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

## Copy as send, reload warning, computed values, conditional footer (added 15 Sep 2026, checks 25–30)

Four changes from using the published bookmarklet on a real Next.js and Tailwind site. Copy now marks changes as sent instead of leaving no trace, and Clear preview reverts them; the button is locked for 900ms after a copy so a double-click cannot copy and revert in one go. Copy sends only unsent changes, so a change is never sent twice; Re-copy repeats the latest batch. Editing a sent element, by drag or keyboard, clears its sent change and records afresh from the live page, but only once the pointer actually moves, so a click does not clear it. A stylesheet reload while changes are sent shows a warning and never clears. A fractional-pixel computed max-width is described as computed. The footer prints only the guidance the batch needs, and "Do not add inline styles." moved to the always-printed first line because it applies to every batch.

First run: check 18 failed as expected (it asserted five lines). Then 18, 26 and 27 failed together on a pre-existing bug: panel buttons keep focus after a click because page mousedowns are cancelled, and the key handler ignored keys while a button had focus, so arrows, Backspace and Escape went dead after any Copy, Reset or undo. Check 30 covers it. Panel rows also switched from `innerHTML` to `textContent`, so page text containing markup renders as text.

30/30, stable over `--repeat-each 3`.

## Text editing (added 15 Sep 2026, branch feat/edit-text, checks 31–36)

Double-click a selected element to edit its text in place. Only elements without child elements are editable; comment nodes are allowed because React server rendering inserts `<!-- -->` between text segments, and a strict text-nodes-only rule would refuse most text on Next.js pages. Editing uses `contentEditable="plaintext-only"` with guards for Enter, formatting input types, paste and drop. Undo restores cloned original nodes.

First run: two failures, both test mistakes. Chrome serialises an empty comment as `<!-- -->`, and the End key does not move the caret to the end on macOS. No existing test changed. 36/36, stable over `--repeat-each 3`.

## Type controls (added 15 Sep 2026, branch feat/type, checks 37–42)

Four fields (size, line height, letter spacing, weight) for a selected element with its own text. Font family is out of scope. Plain arrows step 1 (weight 100), Shift 10 (weight 100), Alt 0.1 (weight 10). Plain and Shift steps snap to another visible text element's value within tolerance (0.5px size and line height, 0.05px letter spacing, exact weight), never to the value being stepped away from; Alt steps land exactly. Ties go to an element with the same tag. Matches are named by the recognisable part of the selector (`.lede`) and outlined with the match box.

First run: three failures. Two were test assumptions (the fixture body sets line-height 1.5, so 17px text computes to 25.5px rather than `normal`; a click at the wrapper's corner hit its child). One was real: a typed value matched the first element in document order instead of preferring the same tag. A second real bug followed: the change event fired on blur re-rendered the rows under the pointer and swallowed the click on a row's undo; no-op changes no longer re-render. Line height lines also gained the ratio to font size, because computed line height is always in pixels even when the source is unitless. No existing test changed. 42/42, stable over `--repeat-each 3`.

Both branches were committed and merged before their contract and CLAUDE.md entries were written, because a shell chain stopped early; these entries were added afterwards on `docs/text-and-type`.

## Type steppers (added 15 Sep 2026, branch feat/type-steppers, check 49)

Small up and down arrows inside each type field, shown on hover or focus like a browser's own number field, so the panel at rest is unchanged. They share the arrow keys' step and snapping rules, repeat when held and keep focus in the field. Numbered 49 because the unmerged `feat/colour` branch uses 43–48.

First run failed on a real bug: when a step landed on a match, the match line appeared under the fields, and because the panel is anchored to the bottom the fields jumped up from under the pointer, so the next click missed and held repeats stopped. The match line now keeps its space and toggles visibility. No existing test changed. 43/43, stable over `--repeat-each 3`.

## Expected first failures

- Snap catching the wrong candidate in dense text (many edges within tolerance). Consider preferring same-edge matches and nearer elements.
- Selection outline lagging or detached after hot reload.
- Candidate collection cost on large pages.
