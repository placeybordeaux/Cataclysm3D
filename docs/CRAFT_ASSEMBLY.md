# Optional crafting assembly

After the standalone assembly mock was assessed, the generated grid was selected as the default. Options > Craft assembly offers Grid, Exploded, and Off (`?assembly=grid|exploded|off`). Each option persists as a normal preference; URL overrides are temporary.

While a real craft runs, the card shows its actual committed component choices, a generated slot per recipe component group, and accurately labelled tool requirements. Every recipe alternative is supported when that alternative was committed to the unfinished craft. Unavailable alternative ingredients are not invented for the toy. A large recipe scrolls; the common four-part layout shows its complete footer beside the ordinary crafting progress bar.

Number keys 1–8 quickly place parts. Click for **hand pace** to unlock the cursor and opt into about twelve real seconds per remaining batch; drag a part to its slot, or select it and activate the slot with a click or native Tab/Enter. Hand pace never speeds up work. Escape or clicking outside restores the previous ordinary activity pace. Focus loss, switching Off, cancellation, completion and activity replacement release engagement; an ended/replaced activity retains the engine's new clock warp rather than restoring a stale fast warp to the world. Moving with WASD cancels the craft just as normal movement does.

Ignoring the card automatically fills its slots from ordinary craft progress and leaves the ordinary activity pace untouched. Off runs normal crafting. Inputs pause while the game is paused or fast-forwarding. Mismatches, duplicate placements, already automatic parts and stale batch-boundary inputs do nothing.

Each manual part saves 4% of that batch's work, capped at 20% per batch. The unfinished craft item saves `assembly_bonus` and `assembly_placed`, so cancellation, continuation and save/load cannot farm a bonus. Input re-reads real progress and current batch before rewarding. Sparse per-batch bonus arrays preserve indices. Normal crafting owns the materials, tools, product creation, practice and mishaps: the toy advances ordinary progress through its existing callback and does not create/consume/move items itself.

## Validation

TypeScript, production build and 15 targeted activity/assembly tests passed. Controller tests cover alternatives that were actually committed, mismatch/duplicate rejection, per-batch caps and sparse budgets, automatic ignored work, Off, save/load, cancel/resume, immediate pause/speed/Off guards, progress/batch changes between rendering and input, and ordinary callback cancellation on mishaps. Pace tests cover late engagement, disengagement, cancellation/replacement and stale activity rejection.

Real OS input in an isolated headful GPU browser, using actual recipes/ingredients and ordinary activity warp:

- One flashlight: ordinary warp 5; click opted into hand pace 2.0833. Real drag and number keys saved 72 game seconds. Real W cancelled, preserving progress and the 12% ledger; normal continuation kept the ledger and restored the engine's calculated ordinary warp.
- Ten flashlights: ordinary warp 31.25; hand pace made a current-batch part draggable. Real drag saved 24 seconds; W cancellation/continuation preserved the current batch's 4% budget. Inputs arriving after a batch changed were safely rejected.
- Primitive knife: native Tab/Enter placed a committed stick, saved 144 seconds, and showed HAMMER 1 as a requirement. Escape restored ordinary warp 18.75. A separate actually engaged focus-loss check restored the same ordinary warp and released capture.
- Live Off restored ordinary warp 5 and hid/released the card. Ignored Grid completed in 4.90 real seconds and Off in 4.88: both had no bonus, saved progress 1 and produced exactly one actual flashlight. Hand-paced completion produced one item, returned world warp to 1 and released capture on the next UI frame.

Inspected screenshots: [single craft](screenshots/gaps/crafting-assembly-single.png), [batch craft](screenshots/gaps/crafting-assembly.png), [exploded knife with native keyboard placement](screenshots/gaps/crafting-assembly-exploded.png), [Off](screenshots/gaps/crafting-assembly-off.png).

The earlier controlled-clock experiments helped diagnose input/lifecycle behavior; they are not the usability evidence above. The live toy uses generated recipe slots; it does not yet provide bespoke physical exploded models for individual items.
