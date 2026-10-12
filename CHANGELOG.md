# Changelog

Installed bookmarks are pinned to a release. To get a new release, reinstall the bookmark from the [install page](https://g1d30nb.github.io/nudge/).

## v1.4.0, 12 October 2026

### Added

- **Undo and redo.** Command-Z (Control-Z on Windows and Linux) undoes the last change of any kind, Shift-Command-Z, Control-Y or Control-Shift-Z redoes it. A match, a siblings apply and a Reset each undo in one step. Copying a batch is the commit point: sent changes are never undone back into the next batch.

- **Previews know their range.** A change belongs to the breakpoint range it was made in. When the window leaves that range the preview is lifted and the row says `made at 1280px, hidden at this width`; back in range it returns. The batch records the width each change was made at, not the window at copy time.
- **One change per breakpoint.** The same element can be corrected once in each range: the desktop change parks while you work on the mobile layout and comes back when the window widens. The batch carries each as its own entry, `measured at 761px wide, in the 641px to 900px range`.

### Fixed

- **Resizing keeps the opposite edge fixed** whatever the layout does. An element aligned to the end of its grid cell or flex container used to grow upward or leftward when its bottom or left handle was dragged, so a locked drag from the bottom-left corner seemed to grow into the bottom-right. nudge now measures after each step and moves the box so the handle's opposite corner stays, and the batch carries that move.

## v1.3.1, 12 October 2026

### Added

- **Action row.** Under the panel header, the selection's own buttons, only the ones that apply: Pin or Unpin, Match when something is pinned, Siblings when the change has siblings to go to, Measure, Remove. The keys still work.
- **Measure button.** Rulers and the gap drag without holding Option. Escape stops.
- **x-ray button** in the header, beside the key.
- The header crumbs name the pinned element, with a × to remove the pin.
- **Movable panel.** Drag the header to put the panel anywhere in the window. A click still collapses it. It stays inside the window when the window shrinks or the panel grows, and keeps its place until the page reloads.

## v1.3.0, 11 October 2026

The biggest release since launch. Four areas: resizing, the responsive view, closing the loop with the agent, and saying what a change means. Every key and command is listed in the README under [Keys and commands](README.md#keys-and-commands).

### Resize from any edge

- **Eight handles.** Drag any edge or corner. Dragging the left or top edge moves that edge and keeps the opposite one fixed; the batch reports both the new size and the move, so `width 360px → 460px` plus `moved left 100px` says exactly what happened.
- **Command resizes from the centre.** Both edges move together. Option or Control locks the aspect ratio, as before; Command no longer does.
- **Width and height fields** in the panel for every selected element, images included. Type a value, or step with the arrow keys or the small arrows in the box: 1 at a time, 10 with Shift, a fine step with Option. Steps snap to other elements' sizes and edges like a drag does.
- **Shift locks a move to one axis** as well as disabling snapping.
- A click on a handle records nothing. Every drag waits for 3px of movement before it starts.

### Breakpoints

- **nudge reads your breakpoints** from the page's own stylesheets: `min-width`, `max-width` and the newer range syntax (`width >= 48rem`), in px, em or rem. Only width queries count.
- **A badge on the panel header**, such as `1280 · 1200+`, shows the window width and the range it falls in. Click it to draw a labelled line at each breakpoint; click again to hide them. Resize the window and the badge follows.
- **The batch says which range it was measured in**, on its second line. An element with media rules at other widths gets its own line, `different rules apply below 600px; this was measured in the 1200px and up range`, and the footer asks the agent to change the rule for that range unless the intent clearly applies everywhere.
- A stylesheet the browser cannot read, such as one served from another domain, is counted and reported rather than guessed at.

### Verify: did the agent do it?

- **Sending a batch records what the page should measure** once the agent has applied it: sizes, positions, text and the type and colour values, taken with the preview in place.
- **After a reload, or when you press Clear preview, nudge measures again** and shows a line under the header: `After the reload: 2 of 3 applied`, then `not applied: …` with the value now and the value wanted for anything missing. The record survives a full reload and dies with the tab.
- `window.__nudge.verify()` runs the check on demand; `window.__nudge.take()` returns the unsent batch and marks it sent without the clipboard. Both exist for tools that drive nudge from outside, such as the Claude Code plugin below.

### Reach: finding and naming things

- **Crumbs.** The panel header shows the selection's ancestry, `section#hero > div.hero-copy > p.hero-subhead`, and each step is clickable. The quickest way to a wrapper.
- **Hover tag.** The hover box names the element under the pointer and gives its size, so you know what a click will select before you click.
- **X-ray.** Press `x` to outline every container on the page, which shows the boxes that have no surface of their own. Press `x` again to turn it off.
- **Component names.** Where React or Vue leave the component name readable in dev mode, the batch entry adds `in <Hero>`. Svelte and Astro leave nothing readable, so those entries stay on the selector path.
- **Measure.** With an element selected, hold Option and hover another to see the distance between them, or the insets when one contains the other.

### Intent: saying what a change means

- **Set the gap.** Hold Option and drag another element to change the space between it and the selection. nudge previews the change by editing the rule that made the space, the parent's `gap` or the larger facing margin, and the batch names that rule: `gap to div.card-a 24px → 40px (set by row-gap 24px on section#cards)`. The agent edits the gap, not the element's position.
- **Pin and match.** Press `p` to pin the selected element, then select another and press `m` to make it match: width and height for boxes and images, font size, line height, letter spacing, weight and colour for text. The batch adds `make this match …: width, font size` and asks the agent to share the matched element's rule rather than copy its values.
- **Apply to siblings.** Press `a` to apply the selected element's change to the elements beside it with the same tag and classes. The batch says `apply the same to its 2 siblings (3 × div.feature-card in total)` and that the change belongs on their shared rule. Press `a` again to release them.
- **Guardrails.** A colour change that leaves text below the AA contrast minimum against its background is flagged with the ratio, in the status and the batch. A font size under 12px is flagged as small for body text.
- **History.** `window.__nudge.history()` returns every batch sent this page load. A second press of Re-copy explains how to paste when the agent is not applying the batch.

### Claude Code plugin

- The repo now carries a plugin for Claude Code, in `mod/`, that puts nudge in the built-in browser with no bookmark and no paste: `/nudge` opens it, `/nudge batch` pulls the batch into the prompt box, `/nudge batch send` sends it, `/nudge at 390` resizes the pane, `/nudge dark` switches the colour scheme, `/nudge verify` checks what was applied, `/nudge history` lists what was sent. After a batch is sent, the plugin checks the page at the end of Claude's turn and prints the verdict under the answer. Install with `/plugin install nudge --marketplace g1d30nB/nudge` in a terminal session.

### Fixed

- Clicking inside a selected element selects what was clicked; only a drag moves (v1.2.1 behaviour, kept).
- A focused size or type field now updates after a step.

## v1.2.1, 16 September 2026

### Added

- **Select the parent.** Option and the up arrow selects the parent of the selected element; Option and the down arrow comes back. This reaches wrappers whose surface is entirely their children.
- **Click selects, drag moves.** Clicking inside a selected element now selects what you clicked; only a drag moves the selection. Before, nothing inside a selected element could be selected without pressing Escape first.
- **Collapse the panel.** Click its header to fold it to a single row with the change count and the Copy button, so the page stays visible while you work. Click again to expand.

## v1.2.0, 16 September 2026

### Added

- **A second install path.** A script tag carrying `data-nudge-dormant` loads the same file asleep: a small dot bottom left instead of a panel. Click the dot to open nudge, close to return to the dot. Meant for a project's dev layout, so nudge works inside Claude Code's built-in browser, which has no bookmarks bar. The README has a prompt to paste into Claude Code that adds it correctly for any framework, plus checked snippets for Astro, Next.js, Vite, SvelteKit, Nuxt and plain HTML.
- **A hostname backstop for the script tag.** With the attribute, nudge only runs on localhost, 127.0.0.1, ::1, a `.localhost` or a `.local` host, and logs one console line elsewhere. The bookmarklet is unaffected.
- The panel keeps itself on screen in narrow viewports, and nudge survives client-side route changes.

## v1.1.1, 15 September 2026

### Fixed

- The batch no longer says an element "was capped by max-width" when it was narrower than its cap. nudge now checks whether the max-width was actually holding the width down, whatever unit it is written in.
- Font size and letter spacing are no longer reported only as computed pixels. Each now comes with a second line giving the rem or em equivalent, so an agent editing a stylesheet written in rem or em keeps its units.

## v1.1.0, 15 September 2026

### Added

- **Edit text in place.** Double-click a selected element to edit its text. Only elements with no child elements can be edited, and only as plain text: Enter, formatting shortcuts and rich paste are blocked. The batch reports the old string and the new one, centred on the change when a long string would otherwise hide it. Undo restores the original.
- **Type.** Font size, line height, letter spacing and weight for a selected text element, stepped with the arrow keys or small stepper arrows that appear on hover. Values snap to other elements' values and the batch names the match, for example `font size 17px → 21px (now matches .lede)`. Line height also reports its ratio to the font size. Font family is deliberately not offered.
- **Token-aware colour.** Text colour, and background colour where one exists, chosen from a palette of the colour tokens declared on `:root`. The batch reports token names. A colour picked outside the palette is reported with a note that no token matched.
- New closing lines in the batch for text, type and colour changes, printed only when the batch contains one.

### Fixed

- Clicking a row's undo straight after typing a value no longer gets swallowed.
- Stepping a type value onto a match no longer moves the fields out from under the pointer.

## v1.0.0, 14 September 2026

First release.

- Select, move, resize and remove elements on any page, with snapping to edges and sizes and a note of what each change lines up with.
- Option locks the aspect ratio while resizing; images resized off their shape are flagged in the batch.
- Copy marks changes as sent; Clear preview reverts them once the agent has applied the batch; Re-copy repeats the batch.
- A warning when a stylesheet reload leaves a sent preview in place.
- Computed max-width values are described as computed, not quoted as rules.
- The batch prints only the instruction lines it needs.
