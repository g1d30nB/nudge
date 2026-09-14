# nudge

Drag on the running page, then paste the measurements into your coding agent.

![nudge widening a capped headline on a demo page, then Claude Code applying the batch to the source](docs/nudge-demo.gif)

## The problem

When you build a site with an agent, the last stretch is small visual corrections, and natural language is a bad instrument for them. You end up writing "the button on the right in the third section, the one with the pricing heading, move it under the button to its left and make it a little wider". That sentence takes longer to write than the change takes to make, and it is still ambiguous.

nudge replaces the sentence with measurements.

## How it works

You drag on the running page. nudge records what changed and what it lined up with. You copy a batch of plain text and paste it into your agent, and the agent edits the source.

nudge never writes to your files.

## Install

Go to the [install page](https://g1d30nb.github.io/nudge/) and drag the link to your bookmarks bar. That is all.

There is no clone, no server, no npm, and nothing is added to your project. The bookmark loads `nudge.js` from jsDelivr when you click it. If you would rather make the bookmark by hand, paste this line as its URL:

```
javascript:(function(){if(window.__nudge){window.__nudge.destroy();return}var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/gh/g1d30nB/nudge@main/nudge.js?t='+Date.now();document.documentElement.appendChild(s)})();
```

It works on any page in the browser, including a live site. The batch is only useful if you have the source to hand.

## Use it

- Click the bookmark to open nudge. Click it again to close it.
- Click an element to select it. Clicks select the deepest element under the pointer, so clicking an image selects the `img`, not its `figure`.
- Drag inside the selection to move it. Pink guides appear when an edge lines up with another element; release on a guide and the relationship is recorded.
- Drag the right, bottom or corner handle to resize. The moving edge snaps to other elements' edges, and the width or height snaps when it matches another element's; a dashed box appears over the element you now match.
- Hold **Option** while resizing to lock the aspect ratio, so the element scales instead of stretching. On the corner handle, whichever direction you move further drives the size and the other follows.
- Arrow keys nudge 1px, Shift and an arrow nudges 10px. Backspace removes. Esc deselects.
- Hold Shift while dragging to disable snapping. Release with Shift held and no alignment is recorded; the move is taken as exact.
- Changes stay on the page until you copy or reset. Each change has its own undo.
- **Copy for Claude Code** puts the batch on the clipboard. Paste it into your agent as the whole message.
- While nudge is open, links do not navigate and the right-click menu is suppressed. Close nudge before inspecting an element.

Work a section, copy, let the agent apply it, check the reload, then move to the next section. Do not touch a second section before the first has been applied: the reload rebuilds the page and uncommitted drags are lost.

## What it is good at

Precise small corrections, batched per section: a subhead capped too narrow, an image that should sit on the same baseline as the copy beside it, a card that should match its neighbour's width, an element that should not be there.

It does not design anything, and it does not replace the agent. It tells the agent exactly what you want, and the agent still has to work out how to express that in your code.

## What the batch contains

A batch from the demo page after widening the hero subhead and dragging the portrait image down to the bottom of its text column:

```
nudge batch · http://localhost:4321/ · viewport 1440×900 · 2026-09-14 10:00

1. div.wrap.hero-inner > div.hero-copy > p.hero-subhead (src/components/Hero.astro:14:7) "Turn scattered notes into … what moved by Friday."
   width 400px → 558px (was capped by max-width: 400px)
   right edge aligned with right edge of div.wrap.hero-inner > div.hero-copy > p.hero-eyebrow "PLANNING FOR SMALL TEAMS"
   width matches width of div.wrap.hero-inner > div.hero-copy > p.hero-eyebrow "PLANNING FOR SMALL TEAMS" (558px)

2. section#how > div.wrap.split-inner > div.split-media (src/components/Split.astro:17:5)
   moved down 116px
   bottom edge aligned with bottom edge of section#how > div.wrap.split-inner > div.split-copy (src/components/Split.astro:9:5) "Built for the meeting you …a report nobody opens."

Apply these in source CSS and markup, in the files named above where given.
A move that aligns with another element is a layout intent: express it with align-self, margin auto, grid placement or similar, never a transform or absolute offset.
A move with no alignment is a spacing intent: adjust margin or gap.
Widths were measured at this viewport; keep them responsive (max-width or percentage) unless a fixed width is clearly correct.
Removals delete the element from the markup. Do not add inline styles.
```

Each entry names the element by its selector path and a snippet of its text, then lists what changed and what it now lines up with. The closing lines tell the agent how to translate those into CSS.

nudge captures the same measurements and alignments on any page. It adds the source file and line only where the framework injects them into the page, which in practice means Astro in dev mode. Everywhere else the agent gets the selector path and the text snippet and has to find the file itself. That step has been used in anger on Astro and is unproven on other stacks.

The batch is plain text written for a coding agent. It has been used with Claude Code, which is why the button says so.

## How alignment is chosen

While you drag, any edge of the moving element within 5px of another element's edge snaps to it and shows a guide. Same-edge matches (bottom to bottom, left to left) win over cross-edge matches (top to bottom) unless the cross-edge one is more than 2px closer; ties go to the smaller element. On release the check runs again at 1px and only the axis you actually moved on is written to the batch, so a purely vertical drag never reports a left-edge alignment that was already true.

Resizing snaps too. The edge you are dragging snaps to other edges, and the size snaps to another element's size within 5px; the batch then says `width matches width of X (520px)`, which tells the agent the two belong together (a shared class, a shared max-width, the same grid column) rather than handing it a number. When an edge snap and a size snap disagree, the nearer wins and the other is kept only if it still holds.

Images, video, canvas, SVG and iframes have an intrinsic shape. Resize one off its ratio and the batch says so: `aspect ratio changed from 4.00:1 to 5.00:1; this distorts the image, set one dimension only`. Resize it with Option held and the batch says `aspect ratio kept, scaled to 125%`, which is the intent the agent needs: change one dimension and let the other follow, rather than pinning both.

## Limitations

- One viewport per batch. Every measurement is stamped with the viewport it was taken at; the agent decides whether the rule generalises.
- No write-back. nudge describes changes; it never edits files.
- Uncommitted changes do not survive a hot reload.
- Resize handles are right, bottom and corner only.
- No text editing.
- No multi-select.
- No gesture to select an element's parent.
- Pages with a Content-Security-Policy that blocks external scripts refuse the loader, and the bookmark does nothing.

## Contributing

Suggestions and pull requests are welcome. [Open issues](https://github.com/g1d30nB/nudge/issues) list the known gaps, and some are marked as good first issues.

The single most useful thing anyone can send is a report from a stack other than Astro: whether the batch was precise enough for your agent to find and edit the right file, and if not, what it got wrong. [This issue](https://github.com/g1d30nB/nudge/issues/6) collects those reports.

For code changes:

- Run `npm test` and keep it green.
- Add a case to `tests/fixture.html` and a spec to `tests/nudge.spec.mjs` for any new behaviour.
- Keep nudge to one file with no dependencies and no build step.

To work on nudge itself, serve this folder and use the development bookmarklet from `bookmarklet.txt`, which loads your local copy instead of the published one. It only works on http pages such as localhost, because browsers block an http script on an https page.

```
python3 -m http.server 7357 --bind 127.0.0.1
```

## Test

```
npm install
npx playwright install chromium
npm test
```

Twenty-four headless Chromium checks in `tests/nudge.spec.mjs`, one per row of the GOOD table in `CONTRACT.md`, run against `tests/fixture.html`. The fixture is served from `https://nudge.test/` by a Playwright route so clipboard APIs exist; no server or certificate is needed.

## Stack

One file, no build, no dependencies. Vanilla JS, inline styles, and `data-nudge` attributes that keep the tool's own DOM out of selection.

## Licence

MIT. See [LICENSE](LICENSE).
