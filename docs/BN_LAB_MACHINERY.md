# BN laboratory machinery

BN cardreader terrain uses the string examine_action "cardreader", not DDA's JSON examine actor. It accepts exact science/military/industrial ID item types. Science reader tests now use real BN ID cards with a carried-storage fixture. A successful swipe consumes exactly one card, unlocks locked metal doors seeded within radius 3 and their four-connected extensions in loaded chunks, and retains the reader. Redundant swipes preserve cards, and a military ID cannot open a science reader. Legacy JSON actors remain supported.

Consoles recognize terrain CONSOLE flags as well as compatible furniture. The terminal root-menu loop also checks terrain. Shutdown converts nearby consoles to t_console_broken; if none are nearby, it scans the loaded same-level map, matching BN's fallback without generating chunks. The existing six-part/continuous-map adaptations remain; this is not a complete computer-action fidelity claim.

Previously conditional tests now run against actual BN science readers and t_console. The absent DDA boom barrier test uses a real BN CLIMBABLE chain fence. The existing BN terrain-console/vending mapgen test now runs unconditionally. Turret targeting test's stale TODO was replaced with the extracted BN actor details.

Source: BN iexamine.cpp:1189–1227 (exact card IDs, connected door floodfill, consume only after open); computer_session.cpp:1311–1329 (shutdown). Validation: 59 lab/mapgen/combat-depth tests, typecheck, and production build pass. Conservation assertions include wrong-card retention, two science cards reduced to one, redundant swipe retaining one, isolated far door unchanged, connected beyond-radius door opened, and loaded-map shutdown without generating chunks.

Shutdown also replaces the real BN f_console_table with f_console_broken_table, removing its CONSOLE flag. Loaded-edge cardreader regression confirms neither radius scanning nor connected-door traversal generates chunks.

Headful Chromium OS e/y opened and confirmed the card swipe; inspection confirmed t_door_metal_c, retained t_card_science, and zero science cards after one card was supplied. OS e/a then opened the terrain terminal and selected UNLOCK ENTRANCE; inspection confirmed the door unlocked and t_console remained. Inspected [swipe confirmation](screenshots/gaps/bn-cardreader-swipe.png) and [terminal root menu](screenshots/gaps/bn-console-menu.png).
