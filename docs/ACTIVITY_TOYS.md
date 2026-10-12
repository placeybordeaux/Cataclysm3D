# Optional careful-hands activity toys

Construction offers a hammer beat beside the crosshair. Press **1** (or numpad 1)
when the mark enters the green centre. Construction skill widens the displayed window.
Disassembly offers a calm take-apart board, using the actual recovered component
names and counts (up to eight component types; other products still recover normally). Press the numbered key of a free part; removing a covering part
reveals the parts beneath it. The blocker graph is generated as an acyclic forest:
more component types increase the assembly size, and skill above the recipe difficulty
reveals more independent entry points and shallower layers. It is a calm teardown,
not a physical simulation of screws/wiring.

Correct inputs save four percent of that run's work, up to twenty percent per item,
and request one point of practice in the job's actual skill, subject to its normal
practice cap. Misses, blocked parts and ignoring the card have no cost. Normal
completion rewards, requirements, material handling and disassembly yields stay in
the existing systems. There is no damaged-product or failure penalty.

Options has **Construction toy: timing/off** and **Disassembly toy: teardown/off**.
Session overrides are `?constructiontoy=timing|off` and
`?disassemblytoy=teardown|off`. Off leaves the ordinary activity alone. Toys pause
with the game and during fast-forward. Moving or another interruption ends the
card with the activity. Bonus fractions live in the real item's saved `vars`, so
saving/reloading or resuming an unfinished construction cannot farm the time bonus.
Construction progress is synchronised immediately before any same-frame cancel/save.
The existing construction continuation/cancellation returns materials through moves.

The screenshot shows a real wooden-wall repair supplied with a hammer, four planks
and sixteen nails. An OS-level **1** hit saved 72 game seconds, stored a `.04` bonus
fraction and updated unfinished construction progress immediately. The practice cue
is visible. [Inspected construction capture](screenshots/gaps/construction-toy.png).
The final construction card sits above the work bar. The final teardown card also
avoids the bar and displays its work-saved footer without scrolling (229 px client
height and scroll height in the verification viewport).
[Inspected teardown capture](screenshots/gaps/disassembly-toy.png).
A successive cellphone job with the same four-part count refreshes all labels:
[inspected cellphone capture](screenshots/gaps/disassembly-successive-item.png).

Validation: typecheck and production build pass; seven dedicated controller tests
pass (ignore/miss, repeat-beat/cumulative limits, paused/fast-forward input, immediate
mode/pause changes before a UI update, interruption/resume, off, item save/load bonus
persistence, skill/complexity scaling and teardown solvability). Existing crafting tests
retain the baseline source-tile recovery failure in this isolated worktree; the simulation
lane addresses that separately.

Real-input checks: construction **1** hit saved 72 seconds, and **A** movement cancelled
work, hid the card and kept the real unfinished site and `.04` bonus budget. A toaster's
covered **2** produced no bonus; free **1** saved 24 seconds and requested practice.
Fast-forward input produced no extra hit. Both off variants left ordinary construction
and disassembly running with no toy card. Normal toaster completion recovered its real
products; the following cellphone job showed its own component names. The reviewer
service interruption during the earlier cancellation attempt was resolved; the separate
final verification completed through the normal approval path.

## Crafting assembly mock

Open `/activity-assembly-mock.html`. This standalone page is the required throwaway
prototype before integrating assembly into crafting. Four real recipe definitions
supply components, alternatives and tool qualities. Compare generated grid/exploded
spacing, try batch 1/3/10 or longer work, and pause/restart/cancel. Ghost slots fill
without input, including off mode. A manual placement advances work by four percent;
the maximum bonus per batch is twenty percent. It never changes game items or saves.

Real-input evidence: dragging medical gauze (a non-first alternative) into the bandage
slot saved 4.8 seconds in a two-minute run. Enter, six Tabs and Enter placed duct tape
using keyboard input. All four recipes loaded their actual component/tool summaries.
Real pause/resume clicks stopped elapsed time; an ignored/off twenty-second run finished
with zero bonus and every slot automatic. JS syntax and production asset copying pass.

[Grid mock](screenshots/gaps/assembly-mock.png),
[exploded spacing](screenshots/gaps/assembly-mock-exploded.png),
[ignored/off completion](screenshots/gaps/assembly-mock-off.png).

Assessment: the basic drag/ghost loop is usable and keyboard alternatives work. Full
crafting integration is still deferred until this mock's feel/layout has been assessed;
this package does not select a permanent recipe-layout system.
