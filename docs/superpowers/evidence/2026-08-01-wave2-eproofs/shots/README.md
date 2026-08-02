# Browser proofs, 1440×900, headless Playwright

`*.png` is gitignored repo-wide (`.gitignore:20`), so the committed record is the
accessibility snapshot beside each shot. The PNGs stay on disk at the paths below
for whoever reads this next.

| file | what it shows |
| --- | --- |
| `E3-skeleton-midturn-t40s.png` + `.snapshot.yml` | E3 · the skeleton on screen MID-TURN from a box-side `plan.vendo` write. Composer status still reads `streaming`; the assistant bubble shows "Building your view…", the `Overview` tab, the `Mid turn skeleton proof` heading and shimmering placeholders. t≈40s of a turn the box spends 180s in. |
| `E3-skeleton-midturn-browser.snapshot.yml` | the same proof one turn earlier, captured after the turn settled — kept because it shows the finished skeleton for comparison. |
| `D6-vendo-activity-rail.png` | finding D6 · seven rows reading "Automation run · Running" on `/vendo`, every one of them a finished `venue:"chat"` run and three of them errors. |
| `D6-activity-rail-mislabels-chat-runs.png` | the same rail, first capture. |
| `D6-FIXED-activity-rail-chat-turn.png` + `.snapshot.yml` | the SAME rail after the D6 fix, on the shipped default path (`MAPLE_HARNESS` unset): a real chat turn sent through the composer in the browser lands as **"Chat turn · \u2713 Succeeded"** with a static tick, where it used to read "Automation run · \u25cf Running" with a pulse. |
