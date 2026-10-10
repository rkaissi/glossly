# Glossly mark

The mark in use is **C1, caret + sparkle** (chosen Oct 10): a text cursor (the selection) and a sparkle (the action). It is `GlosslyMark` in `packages/ui/src/icons.tsx` (the pill and bar's menu button, the dot, the settings sidebar), and the tray icon draws the same shape in code (`onMark` in `packages/shell-electron/src/main/tray.ts`, with heavier strokes and a larger sparkle so it holds at tray size).

Every mark here is a 24-unit line icon in the lucide style (`stroke="currentColor"`, width 2, round caps), so it can replace the paths in `GlosslyMark` directly. If the tray changes too, update `onMark` to match.

| File | Design | Rayan's notes (Oct 10) |
| --- | --- | --- |
| `c1-caret-sparkle.svg` | Text cursor + sparkle | **In use.** Matches what the product does. The sparkle is the common "AI" sign, so it can feel generic; if so, change the sparkle (for example to a gloss glint), not the caret. |
| `t2-tile-glint.svg` | Rounded tile + curved corner glint | Shortlisted. Ties to the name and the glass look, not to text; at 12 to 16 px it can read as an empty checkbox. |
| `t4-glass-bubble.svg` | Circle + glint | Shortlisted. Can read as a loading spinner. |
| `t5-tile-filled-gloss.svg` | Faint-fill tile + two streaks | Liked, but too close to the Simplify Jobs logo. T6 replaces it. |
| `t6-filled-tile-glint.svg` | Faint-fill tile + corner glint | Shortlisted. Reads as a generic glossy button. |
| `t7-filled-bubble-glint.svg` | Faint-fill circle + glint | Shortlisted. Reads as a marble or a record button. |
| `m1-caret-in-tile.svg` | Caret inside a glass tile | Liked, but the caret reads as a capital I. |
| `m2-caret-in-open-tile-sparkle.svg` | Caret in a tile open at one corner, sparkle breaking out | Liked, same capital-I problem. |
| `m1c-cursor-line-in-tile.svg`, `m2c-cursor-line-open-tile-sparkle.svg` | M1 and M2 with a plain cursor line | The fix for the capital-I look (round 3). |

`review-round-2.html` and `review-round-3.html` are the comparison pages from the review: each candidate at 12, 16, 18, and 40 px, in the pill, and as the dot, light and dark. Open them in a browser.

No product logo was found that copies any of these (a web search, Oct 10; not a trademark search). Do a proper trademark check before using one as a public logo.
