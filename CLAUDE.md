# nudge

Bookmarklet that lets you drag, resize and remove elements on a running page, then copies a batch of measurements and detected alignments for a coding agent to apply in source. Intent capture, not write-back: the agent maps measurements to CSS and markup.

Public repo: https://github.com/g1d30nB/nudge (MIT). Install page: https://g1d30nb.github.io/nudge/ (GitHub Pages from `/docs`). Machine-specific notes live in `CLAUDE.local.md`, which is gitignored.

## Files

- `nudge.js`: the whole tool. Vanilla JS, no build, no deps. The install bookmarklet loads it from jsDelivr (`cdn.jsdelivr.net/gh/g1d30nB/nudge@main/nudge.js`); the development bookmarklet loads it from 127.0.0.1:7357.
- `bookmarklet.txt`: both loaders, labelled.
- `docs/nudge-demo.gif`: the README demo. Recorded on a throwaway wireframe page that is not in the repo (kept locally in `demo/`, gitignored). Keep it under about 5MB.
- `docs/index.html`: install page with the draggable `javascript:` link, served by GitHub Pages. GitHub strips `javascript:` links from rendered READMEs, which is why this page exists.
- `LICENSE`: MIT.
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

`main` is live the moment it is pushed: jsDelivr serves `@main`, and every installed bookmark loads it. jsDelivr caches branch references for up to 12 hours; purge with `curl https://purge.jsdelivr.net/gh/g1d30nB/nudge@main/nudge.js` after a push that matters. Run `npm test` before every push to `main`.

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
- The footer prints only what the batch needs. "Do not add inline styles." is on the always-printed first line because it applies to every batch, not only removals.
- The key handler lets panel text fields swallow keys but not panel buttons: buttons keep focus after a click because page mousedowns are cancelled, and blocking keys on them left shortcuts dead after any panel click.
- Panel rows are built with `textContent`, never `innerHTML`, so page text containing markup renders as text.
- Copy serialises final state only, not history. One line per touched element.
- Snap detection runs during drag (guides) and again on release with 1px tolerance to record relationships. Relationships are the point: "bottom aligned with X" beats "moved 412px".
- The batch text instructs the agent: aligned moves become layout rules (align-self, margin auto, grid), unaligned moves become margin/gap, no transforms, no inline styles, keep widths responsive.
- Astro dev source attributes (`data-astro-source-file`, `data-astro-source-loc`) are used when present. Batch resolution has been used in anger on Astro and is unproven on other stacks; see the open issue. Whether Astro 7 still injects the attributes is unconfirmed.
- Resize handles E, S, SE only. W and N handles imply move+resize and were cut from v1.
- Tool DOM is marked `data-nudge` and excluded from selection, snapping and event capture.
- Snap scoring: distance plus a 2px penalty for cross-edge matches, ties to the smaller element. Pure nearest-wins picked a paragraph's bottom-to-top match over the intended bottom-to-bottom match in the fixture.
- Relationships are recorded only on the axis that moved. A vertical drag does not report the left-edge alignment with its own parent.
- Shift held at release suppresses relationship detection as well as guides. Shift means "exactly here".
- Move transform is `translate(dx, dy)` followed by the element's existing computed transform, so the move is in the parent's frame and a rotated element moves straight down when dragged straight down.
- Resize snapping (`fitSize`): the moving edge snaps to candidate edges, the size snaps to candidate sizes, nearer correction wins, the other survives only if it still holds at 1px. Match box is drawn from the matched element's live rect because a resize can reflow the page. Candidates are recollected on release for the same reason.
- Aspect lock on resize: Option, Command or Control. Control was the requested key but is the macOS secondary click, so it may never arrive as a drag; Option is the documented one and `contextmenu` is suppressed while active to give Control a chance. Ratio is taken at drag start, not from the original, so locking after a distortion keeps the current shape. On the corner the larger movement drives.
- Replaced elements (`IMG|VIDEO|CANVAS|IFRAME|SVG|PICTURE`) get a distortion line in the batch when resized off their ratio. Found on a real Astro site: a logo strip exported as one PNG with an inline height, so an unmodified width drag described a stretched image to the agent.
- Selection is the deepest element under the pointer. No select-parent key in v1; click a `figure`'s padding to get the figure rather than its image.

## Known gaps

- A hot reload that rebuilds an element drops its preview (a CSS-only reload keeps it, and the panel warns). Could persist a report draft to sessionStorage.
- "Was capped by max-width" is printed whenever the computed max-width is not `none`, even if the element was narrower than the cap. It should compare the element's width with the cap first.
- Reload detection is a heuristic. A dev server that injects CSS by appending new `<style>` elements without removing old ones would not trigger the warning.
- Text edits (change copy inline) not supported. design-loop has this; consider adding.
- No multi-select.
- No select-parent gesture; a padded wrapper can only be selected by clicking its padding.
- Resize handles are E, S and SE only. W and N handles imply a move as well as a resize, so the batch would need to describe both.
- Batch resolution on non-Astro stacks is unverified. Without source attributes the agent gets a selector path and a text snippet; whether that is precise enough to find the right file has only been tested on Astro.
- Control as the aspect-lock key is unverified in a real macOS browser; Playwright's synthetic events cannot reproduce the OS-level Control-click to right-click conversion. Option is known good.
- S-handle snapping against elements below the resized one is a feedback loop: growing the height pushes those elements down as you chase them. Edge snap on the y axis is therefore only reliable against elements beside, not beneath. Size match is unaffected.
- Move on inline elements applies transform but snapping is unreliable for inline boxes.

## Style

British English in all copy. No em dashes.
