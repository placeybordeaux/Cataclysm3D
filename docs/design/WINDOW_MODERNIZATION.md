# Window treatment audit

The remaining inconsistency was the shared `src/ui/framework.ts` window shell.
Examine (`e`) and many secondary pickers still used its black curses frame even
when their parent screen used ui2. The framework now shares the ui2 palette,
pixel panel skin, font scale, title bar, close button, and spaced selection rows.
Title bars can be dragged; existing input capture and action handlers stay intact.

| Window family | Treatment |
| --- | --- |
| Examine / world interactions, doors, furniture, stairs | Modern shared framework |
| Crafting, construction, recipes, disassembly and repair pickers | Modern shared framework |
| Item actions, legacy inventory pickers and item information | Modern shared framework |
| Liquids, mutations, bionics and installation pickers | Modern shared framework |
| Vehicle fallback menus, controls and examination | Modern shared framework |
| NPC fallback dialogue, trade and item pickers | Modern shared framework |
| Save loading, memorial lists and details | Modern shared framework |
| Difficulty, labs, nature, butchery and combat action pickers | Modern shared framework |
| Character creation, tips, confirmations and text prompts | Modern shared framework |
| Inventory, looting, context menus, count and text modals | Existing ui2 components |
| Character sheet, overmap, help, options, key bindings, pause and message log | Existing ui2 screens |
| Dialogue, trade, missions, vehicles, body mods, autodoc and achievements | Existing modern interaction screens |
| Journal and new-game/start pickers | Existing ui2 panels |
| Rest, activity/time warp and reading quiz | Existing dedicated styled interfaces |
| Title screen and death screen | Existing dedicated presentation |

Explicit Classic options (title layout, rest menu and detailed HUD) remain available.
This pass gives the framework windows a consistent modern shell; it preserves
specialized content such as ASCII vehicle diagrams and character-creation lists.

Verification: browser screenshots at 960×540 and 640×480; arrow/Enter selection,
disabled entries, safe/destructive confirmations, close buttons, Space dismissal,
and propagation of ui2 scale changes to framework windows.
