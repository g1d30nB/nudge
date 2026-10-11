# nudge

Bookmarklet that lets you drag, resize and remove elements on a running page, then copies a batch of measurements and detected alignments for a coding agent to apply in source. Intent capture, not write-back: the agent maps measurements to CSS and markup.

Public repo: https://github.com/g1d30nB/nudge (MIT). Install page: https://g1d30nb.github.io/nudge/ (GitHub Pages from `/docs`). Machine-specific notes live in `CLAUDE.local.md`, which is gitignored.

## Files

- `nudge.js`: the whole tool. Vanilla JS, no build, no deps. The install bookmarklet loads it from jsDelivr pinned to a release tag (`cdn.jsdelivr.net/gh/g1d30nB/nudge@v1.2.1/nudge.js`); the development bookmarklet, used while building, loads it from 127.0.0.1:7357.
- `bookmarklet.txt`: both loaders, labelled.
- `docs/nudge-in-claude-code.gif`: the second README demo, nudge as a dot inside Claude Code's built-in browser (800px, 6fps, 64 colours, about 6.5MB; the 12MB original is on Gideon's Desktop).
- `docs/nudge-demo.gif`: the README demo. Recorded on a throwaway wireframe page that is not in the repo (kept locally in `demo/`, gitignored). Keep it under about 5MB.
- `docs/index.html`: install page with the draggable `javascript:` link and the paste-into-Claude-Code prompt for the in-project install, served by GitHub Pages. GitHub strips `javascript:` links from rendered READMEs, which is why this page exists.
- `LICENSE`: MIT.
- `CHANGELOG.md`: what changed in each release. Update it with every tag.
- `README.md`: usage and limits.
- `CONTRACT.md`: the v1 contract plus extensions: DONE, the 24 GOOD checks, test plan, outcomes.
- `tests/fixture.html`: reproduces both originating cases plus a link, a rotated element, Astro source attributes, below-fold content.
- `tests/nudge.spec.mjs`: one Playwright test per GOOD check. Serves the fixture at `https://nudge.test/` via `page.route`.
- `playwright.config.mjs`: Chromium, 1280×812, clipboard permissions.

## Run

For development, serve this folder and use the development bookmarklet from `bookmarklet.txt`:

```
python3 -m http.server 7357 --bind 127.0.0.1
```

## Publishing

Installed bookmarks load `cdn.jsdelivr.net/gh/g1d30nB/nudge@v1.2.1/nudge.js`, pinned to the `v1.2.1` tag. Bookmarks installed from earlier releases (v1.0.0, v1.1.0) stay on them until reinstalled. Pushes to `main` do not reach them. `main` still publishes the install page (GitHub Pages from `/docs`) and the README.

While building, use the development bookmarklet in `bookmarklet.txt`. It loads `nudge.js` from 127.0.0.1:7357, so serve this folder first.

Shipping a change was meant to mean moving the tag. That does not work with jsDelivr: its documentation says files at an exact version are stored permanently "with no option or way to update the contents of that file", and purging "will not work for static files". A moved `v1.0.0` tag never reaches installed bookmarks. With the loader pinned to an exact tag, shipping is: run `npm test`, tag a new version (`v1.0.1`), push the tag, point `docs/index.html`, `bookmarklet.txt` and the README install line at it, push `main`, and reinstall the bookmark. To ship without reinstalling, the loader would have to use a range such as `@1`, which resolves to the newest `v1.x.x` tag, is cached for 7 days and can be purged with `curl https://purge.jsdelivr.net/gh/g1d30nB/nudge@1/nudge.js`. Never move or delete a published tag either way.

## Test

```
npm test
```

Runs `node --check nudge.js` then the Playwright suite. 30/30 as of 15 Sep 2026, stable over `--repeat-each 3`. `window.__nudge._state` is a read-only test hook (selected, changes, candidates, drag, tool elements); it has no behavioural effect and stays in the shipped file.

## Design decisions (locked for v1)

- Mouse-up is not commit. Changes persist on the page; copy is the commit. Batch per section, not per page.
- Copy marks changes as sent (dimmed row, tick, status "Sent. Clear the preview once your agent has applied it.") and never reverts, because a failed paste needs the preview to copy again. The primary button becomes Clear preview, which reverts sent changes through `undo`. Re-copy repeats the latest batch. Copy sends only unsent changes so the agent never receives a change twice.
- The primary button is locked for 900ms after a copy and reads "Copied". Without it a double-click copies and then clears the preview before the paste.
- Editing a sent element (drag, resize, arrows, Backspace) clears its sent change and starts a fresh record from the live page, with a status notice; its old baseline no longer exists in the code. Drags wait for real pointer movement before doing this, so clicking a sent element does not clear it.
- Stylesheet reload detection is a `MutationObserver` on `document.head`. It counts replaced `<style>` text, removed style elements, added or removed stylesheet links and `href` changes; it ignores pure additions of `<style>` elements or rules, which CSS-in-JS does on every mount. The warning shows only when a sent change predates the reload (a reload counter, not a clock, because tests freeze the clock). It never clears automatically.
- A computed max-width that is not a whole pixel is reported as computed ("capped at 725px by a computed max-width, check the source for the rule"). Whole-pixel and non-pixel values are quoted as before.
- The cap note is only printed when the max-width was actually holding the width down. When a record is created, `heldByMaxWidth` sets `max-width: none !important` inline, reads the computed width, and restores the previous inline value and priority in the same task, so no frame is painted in between.
- The footer prints only what the batch needs. "Do not add inline styles." is on the always-printed first line because it applies to every batch, not only removals.
- The key handler lets panel text fields swallow keys but not panel buttons: buttons keep focus after a click because page mousedowns are cancelled, and blocking keys on them left shortcuts dead after any panel click.
- Panel rows are built with `textContent`, never `innerHTML`, so page text containing markup renders as text.
- Text editing: double-click a selected element. Refused, with the reason in the status line, when the element has child elements. Comment nodes are allowed (React inserts `<!-- -->` inside text). `contentEditable="plaintext-only"` plus guards on Enter, `format*` and structural input types, paste (plain text, whitespace collapsed) and drop. Escape or any mousedown outside the element commits; mousedowns inside are left native so the caret works. While editing, the key handler passes every key through except Escape and Enter. Original child nodes are cloned when editing starts and restored by undo, Reset and Clear preview.
- Text lines use the descriptor truncation (first 26 and last 22 characters). When that makes old and new identical, both are shown as a window around the first difference instead.
- Type controls: size, line height, letter spacing, weight, shown only when the selected element has its own text. No font family: nudge cannot see installed or loaded fonts. Arrows 1, Shift 10, Alt 0.1 (weight 100 / 100 / 10). Plain and Shift steps snap to other visible text elements within tolerance and never to the value being left; Alt never snaps, so fine control next to a match stays possible. Same-tag elements win ties. Batch lines are one per property with before and after, plus `(now matches .lede)`; line height also gives the ratio to font size because computed line height is always px. Font size and letter spacing get a separate following line with the rem equivalent (at the page's actual root font size) and the em equivalent (against the element's font size at that point), because computed values are px even when the source is rem, em or clamp(). A clamp() itself cannot be recovered.
- Type candidates are collected once per selection. Base values are read on the first type change for the record, all four at once, because a unitless line height changes in px when font size changes.
- Page mousedowns blur any focused panel field before selecting, otherwise arrows keep stepping type after the user has clicked a different element.
- A field's change event that does not change the value must not re-render: rebuilding rows under the pointer swallows the click that caused the blur.
- Colour: chips for text colour (own text only) and background colour (existing background only). Palette opens from a chip: colour tokens declared on `:root`, resolved on the live page, compared as sRGB bytes via a one-pixel canvas; picker below as fallback. Batch reports token names, `var(--a) or var(--b)` when tokens share a value, and `(no token matched this value, check whether one should exist)` for a raw value. The palette DOM is only rebuilt when a different palette opens, so the native picker is not torn down while in use. With the palette open the panel is about 410px tall on a 900px screen; merged as is by decision on 15 Sep 2026, closing to about 290px.
- Width and height fields, with the same steppers and snapping as a drag, sit in their own row shown for every selected element, images included; the type and colour section stays hidden for images and wrappers.
- Type fields have stepper arrows, shown only on hover or focus. Arrows keys and steppers share `stepType`, so step sizes and snapping cannot drift apart. Steppers call `preventDefault` on mousedown to keep focus in the field, and repeat after 400ms at 70ms intervals while held.
- Dormant mode: `document.currentScript` carrying `data-nudge-dormant` is the script-tag path. It is the only distinguishing signal, since the bookmarklet also injects a script element. Dormant: mount a dot only, run only on localhost, 127.0.0.1, ::1, `*.localhost` or `*.local`, otherwise one `console.warn` and nothing else. No attribute: unchanged, no dot, no guard. The guard is a backstop; the framework dev flag in the snippet is the real protection.
- Wake and sleep, not mount and destroy. Page listeners are attached on wake and removed on sleep, so an asleep page has links, right-click and keys working normally. Sleep reverts previews, as close always did, so nothing invisible masks the real page. Close on a dormant instance sleeps; on a bookmarklet instance it destroys. A bookmarklet click on a dormant page toggles. Loading the file twice does nothing.
- The dot: bottom left (the panel and most chat widgets and cookie banners are bottom right), 10px, the panel blue, half opacity at rest, a white ring and dark halo for light and dark pages, no transition under reduced motion. Option-click hides it until reload. Hidden while the panel is open.
- z-index is 2147483646 for the overlay and 2147483647 for the panel and dot, the maximum. A page's own maximum only ties, and ties go to the later node in the document; nudge's nodes are the last children of `<html>`. The top layer (`dialog.showModal()`, popovers) still paints above and cannot be beaten.
- Route changes: `history.pushState` and `replaceState` are wrapped and `popstate` observed; each triggers `reconcile`, which drops records whose elements have left the document, clears a detached selection, re-observes a replaced `<head>`, and re-appends nudge's nodes if a framework removed them from `<html>` (a childList observer on `<html>` does this too). Records on elements a framework re-renders without a route change are not dropped; that path is untested.
- Mount waits for `DOMContentLoaded` when there is no `<body>` yet, so a script tag in `<head>` works. `window.__nudge` is defined immediately regardless.
- Panel width is `min(360px, calc(100vw - 32px))` so it stays on screen in narrow panes. The width itself in narrow viewports is an open issue.
- The panel collapses on a header click to its header and buttons, with a change-count badge. Only the user toggles it; nothing collapses or expands the panel on its own. Collapsed state persists across sleep and wake within a page load. The reload warning stays visible when collapsed.
- The panel is anchored to the bottom, so any element appearing inside it moves everything above it upward. Anything that toggles near a control the pointer may be on (the type match line) must reserve its space and toggle `visibility`, not `display`.
- `window.__nudge.take()` is Copy without the clipboard: returns the unsent batch and marks it sent, for callers that read the page from outside (the Claude Code mod through the browser's JavaScript tool, where the clipboard is unavailable). Null when nothing is unsent.
- Breakpoints are read from `document.styleSheets`, width queries only (`min-width`, `max-width`, `width >= 48rem` and the other range forms; em and rem resolve against the root font size). `min-width: 768px` and `max-width: 767px` both mean 768: the first width at which rules change. A `.98px` hack rounds the same way. `@media` inside `@supports` and `@layer`, `@import` with media and `<link media>` are walked; container queries are not viewport breakpoints and are skipped. A cross-origin sheet throws on `cssRules`; it is counted as unreadable and the badge and batch say so. The list is cached per page load and dropped when the head observer sees a stylesheet reload or the panel wakes.
- The per-element responsive line comes from `el.matches()` against every selector inside a media block whose range excludes the current width. "below N" uses the highest such ceiling plus one, "from N" the lowest such floor. It is advice about where to put the rule, so the footer line that goes with it says to change the rule for the measured range.
- The viewport badge is a button in the header; it stops propagation so it does not collapse the panel. Breakpoint lines live on their own overlay layer, drawn fresh on every resize and hidden on sleep. The line sits at x = breakpoint − 1 so it marks the last pixel column of the narrower range.
- Verify: `remember()` runs inside `copy()` and `take()` and stores, per record, a selector path (nearest id, then nth-child steps), the descriptor as a sanity check, and the measurements taken with the preview in place: width, height, document-space left and top for the axes that moved, collapsed text, and the computed values of changed type and colour properties. Stored in `sessionStorage` under `nudge:expect`, keyed to the pathname and search, 30 minutes. `verify()` re-measures with 1.5px tolerance for geometry and 0.6px for type; a removed element passes when the path finds nothing or a different descriptor. Runs after `load` plus 250ms on any mount with a stored batch for the URL (both modes: the bookmarklet is re-run by hand after a reload), and inside Clear preview, where the previews have just been undone. A fully applied batch deletes the stored expectation; a partial one keeps it, superseded per element by the next batch. The verdict box sits under the reload warning and hides when a new record starts.
- Crumbs: the status line holds the selection's ancestry as clickable spans with ' > ' between them, so its text still reads as the descriptor (check 64 asserts it). Any status message replaces the crumbs; select() restores them.
- Hover tag: a child of the hover box, above it, inside it when the box touches the top of the viewport. X-ray outlines containers only (elements with element children), at most 600, redrawn on scroll through one animation frame.
- Component names: React fibers (`__reactFiber$…`, older `__reactInternalInstance$…`) walked by `.return`, Vue 3 `__vueParentComponent` by `.parent`, Vue 2 `__vue__` by `.$parent`; the nearest named function, class, memo or forwardRef wins; host tags, fragments, providers and anonymous functions are skipped. Svelte and Astro leave nothing readable. Printed as `in <Name>` after the descriptor.
- Rulers: Option-hover with a selection draws the gap on the axis where the two boxes do not overlap, or the four insets when one contains the other. Rulers clear on any move without Option, on scroll, and on reselect.
- Pin and match: `p` pins the selection (amber dashed box), `m` on another element calls the ordinary setters with the pin's values, under `state.matching` so they keep `r.matched`. Text elements (p, headings, spans, links, list items and the like, with their own text) take type and colour only; anything else takes width and height too. The batch gets one `make this match …: props` line before the ordinary lines, and the match footer.
- Siblings: `a` adds `r.also`, the siblings sharing tag and class list, each with a snapshot of its inline values for the properties nudge sets. `syncSiblings` copies the element's inline value for every property the record changes and restores the snapshot for the rest; undo and prune release them. Moves and text edits are never replicated.
- Guardrails run in the status and the batch: contrast against the nearest background with alpha ≥ 50% (WCAG AA 4.5:1, 3:1 for 24px or bold 18.66px text) after a colour change, and a font size under 12px after a type change. Measured, not advisory: the line states the ratio.
- Gap drag: Option-mousedown on an element that is not the selection or its ancestor, with one selected, starts a `gap` drag whose record is on the dragged element. `gapSource` picks the parent's row-gap or column-gap when both are children of a flex or grid parent, else the larger of the two facing margins, else the dragged element's facing margin with a note. The preview sets that one inline property on that one element; the record's dx and dy stay 0, so the batch has a gap line and no move line. The ruler redraws during the drag. Verify measures the gap between the two paths after a reload.
- `history()` returns every batch sent this page load; `state.recopies` counts Re-copy presses since the last batch and the second one explains how to paste.
- Copy serialises final state only, not history. One line per touched element.
- Snap detection runs during drag (guides) and again on release with 1px tolerance to record relationships. Relationships are the point: "bottom aligned with X" beats "moved 412px".
- The batch text instructs the agent: aligned moves become layout rules (align-self, margin auto, grid), unaligned moves become margin/gap, no transforms, no inline styles, keep widths responsive.
- Astro dev source attributes (`data-astro-source-file`, `data-astro-source-loc`) are used when present. Batch resolution has been used in anger on Astro and is unproven on other stacks; see the open issue. Whether Astro 7 still injects the attributes is unconfirmed.
- Eight resize handles. A start edge (west, north) changes size and position; the batch reports the size line and a move line. `fitSize(origin, size, axis, tol, side)`: `origin` is the fixed edge, `side` says which edge moves, `d` is always the size correction. Command-drag resizes from the centre (no snapping); Option or Control locks the ratio; Shift on a move locks the dominant axis. Every drag waits for 3px before recording, so clicking a handle records nothing.
- Tool DOM is marked `data-nudge` and excluded from selection, snapping and event capture.
- Snap scoring: distance plus a 2px penalty for cross-edge matches, ties to the smaller element. Pure nearest-wins picked a paragraph's bottom-to-top match over the intended bottom-to-bottom match in the fixture.
- Relationships are recorded only on the axis that moved. A vertical drag does not report the left-edge alignment with its own parent.
- Shift held at release suppresses relationship detection as well as guides. Shift means "exactly here".
- Move transform is `translate(dx, dy)` followed by the element's existing computed transform, so the move is in the parent's frame and a rotated element moves straight down when dragged straight down.
- Resize snapping (`fitSize`): the moving edge snaps to candidate edges, the size snaps to candidate sizes, nearer correction wins, the other survives only if it still holds at 1px. Match box is drawn from the matched element's live rect because a resize can reflow the page. Candidates are recollected on release for the same reason.
- Aspect lock on resize: Option or Control (Command resizes from the centre since v1.3.0). Control was the requested key but is the macOS secondary click, so it may never arrive as a drag; Option is the documented one and `contextmenu` is suppressed while active to give Control a chance. Ratio is taken at drag start, not from the original, so locking after a distortion keeps the current shape. On the corner the larger movement drives.
- Replaced elements (`IMG|VIDEO|CANVAS|IFRAME|SVG|PICTURE`) get a distortion line in the batch when resized off their ratio. Found on a real Astro site: a logo strip exported as one PNG with an inline height, so an unmodified width drag described a stretched image to the agent.
- Selection is the deepest element under the pointer. Option+ArrowUp selects the parent (never body or html) and Option+ArrowDown retraces; a fresh click clears the path. Inside a selection, a mouse-down primes a move but nothing is recorded until the pointer has moved 3px; a release before that selects the element under the pointer. So a click selects and a drag moves, and descendants of a selected element can be selected without pressing Escape first.

## Known gaps

- A hot reload that rebuilds an element drops its preview (a CSS-only reload keeps it, and the panel warns). Could persist a report draft to sessionStorage.
- Verify compares geometry in document space, so an agent's change elsewhere on the page that shifts the element reports a move as not applied even when the rule landed. Verify after a text edit compares `innerText`, so a change the agent made in a translation file that is not loaded reads as not applied.
- Breakpoints are only those the browser can read. Tailwind's CDN build and any cross-origin stylesheet are invisible; the badge and batch say how many sheets were unreadable.
- Reload detection is a heuristic. A dev server that injects CSS by appending new `<style>` elements without removing old ones would not trigger the warning.
- No multi-select.
- Batch resolution on non-Astro stacks is unverified. Without source attributes the agent gets a selector path and a text snippet; whether that is precise enough to find the right file has only been tested on Astro.
- Control as the aspect-lock key is unverified in a real macOS browser; Playwright's synthetic events cannot reproduce the OS-level Control-click to right-click conversion. Option is known good.
- S-handle snapping against elements below the resized one is a feedback loop: growing the height pushes those elements down as you chase them. Edge snap on the y axis is therefore only reliable against elements beside, not beneath. Size match is unaffected.
- Move on inline elements applies transform but snapping is unreliable for inline boxes.

## Style

British English in all copy. No em dashes.
