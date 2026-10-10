# Capture results per app

Hand tests for the Phase 0 checks. Fill in each cell with **Pass**, **Fail**, or **n/a**, and add anything odd in Notes. Write the date and Glossly commit (`git log -1 --oneline`) above each round.

Turn on **Debug view** first (tray menu, or Settings > General). The debug panel at the bottom of the bar answers most columns below: its first line shows the method (`uia` or `copy`), and its `timings` line shows `total` (ms from mouse-up to pill, or from hotkey to bar) and, after an action click, `tier2 1` (surrounding text was read) or `tier2 0` (it wasn't).

## How to test each app

Use a selection of 3 or more words of ordinary text (a message, a paragraph).

1. **Auto pill:** drag-select with the mouse. Pass if the pill appears near the end of the selection.
2. **Double-click:** double-click a word. Pass if the pill appears. There is no word minimum; only an empty selection is skipped.
3. **Hotkey:** select with the keyboard (`Shift+arrows`), press `Ctrl+Alt+Space`. Pass if the bar opens with the right text. In the debug view, `method: uia` means accessibility worked; `method: copy` means the clipboard fallback was used. Check your clipboard still holds what it had before.
4. **Tier 2:** in the bar, click Ask (or press `1` after the hotkey). Pass if the debug `timings` line shows `tier2 1`. Selections made through the clipboard fallback (`method: copy`) skip tier 2, so mark those n/a.
5. **Pill hides:** with the pill showing, type a key, scroll, click elsewhere, or move the mouse far away. Pass if it disappears each time and your typing went to the app.

## Capture

| App | Auto pill (drag) | Double-click | Hotkey | Method (`uia` or `copy`) | Clipboard restored | Tier 2 context | Pill hides | Pill ms (debug `total`) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chrome (a web article) | | | | | | | | | |
| Edge (a web article) | | | | | | | | | |
| Slack desktop (a message) | | | | | | | | | |
| Discord (a message) | | | | | | | | | |
| Outlook web (an email body) | | | | | | | | | |
| VS Code (a comment or code) | | | | | | | | | |
| Notepad | Pass | | Pass | `uia` | n/a | Pass | | 314 to 358 | Tested by the agent on Oct 10 with a sample message (scripted input); double-click and pill hiding are untested. |

## Toolbar overlap

Select text where the app shows its own selection toolbar. Pass if Glossly's pill never covers or delays the app's toolbar: it should sit on the other side of the selection, or shrink to a small dot if both sides are taken. Note where it went.

| App | App toolbar still visible and usable | Pill placement (below, above, dot) | Pill covered anything | Notes |
| --- | --- | --- | --- | --- |
| Notion (a page, in the browser or desktop app) | | | | |
| Google Docs (in Chrome) | | | | |
| Word | | | | |
| Slack composer (text you're typing, before sending) | | | | |

If an app keeps conflicting, use the bar's options menu (⋯) > "Don't show here" to set it to hotkey-only, and note it here so it can go in the built-in hotkey-only list.
