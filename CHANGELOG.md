# Changelog

Installed bookmarks are pinned to a release. To get a new release, reinstall the bookmark from the [install page](https://g1d30nb.github.io/nudge/).

## Unreleased

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
