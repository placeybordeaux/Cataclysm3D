# Documented implementation gaps

Review date: 2026-10-07. This consolidates the repository's explicit backlogs and
known-gap sections. Most source reports describe the 2026-09-30 handoff; a documented
gap is not automatically a freshly reproduced bug. Entries below distinguish missing
systems, partial implementations, and intentional scope choices. Existing uncommitted
work is preserved and is not treated as absent merely because older docs omit it.

## Missing gameplay systems

| Area | Documented gap and consequence | Source |
| --- | --- | --- |
| Rechargeable equipment — addressed in this session | Previously absent; the `recharging` subagent added enabled vehicle chargers/stations charging compatible cargo at the same mount, consuming vehicle battery energy. Alternators already charge vehicle batteries. Solar generation and fueled reactors have since been reviewed and applied; carried UPS transfer is delivered ([UPS transfer](UPS_TRANSFER.md)); connected networks and power-grid charging remain assigned. | [Recharging guide and scope](RECHARGING.md), [Recharge implementation](../src/game/recharging.ts), [Vehicle electrical balance](../src/game/vehicle.ts) |
| Vehicle building | Adoption and selected-square resumable install/remove/repair jobs now work with BN requirements, salvage, condition and saved progress. Ordered geometry previews now admit dependent removals/replacements without changing live parts. Multi-square stripping now queues removable fittings with visible blockers and retains frames. Saved garage chassis construction now creates minimum authored layouts from actual reserved supplies, with interruption/resume and final-only publication. Garage frame dismantling now preserves connected structure, returns actual-condition items and removes the final empty vehicle. Engine-class, mirror/opaque, manual-turret and existing extendable-cell mounting exclusions now follow BN. The 3D driving-stat planner, custom dimensions, new outward extendable-cell placement and socket visuals remain assigned. See [chassis delivery](VEHICLE_CHASSIS.md). See [vehicle-work delivery and limits](VEHICLE_WORK.md). | [Vehicle v3 phases](design/VEHICLES_V3.md#phases-proposed), [Implementation prerequisites](VEHICLES.md) |
| Vehicle extensions | Siphoning is now delivered with timed conserving tank-to-container transfer. Towing is delivered: the heavy duty tow cable links two vehicles through the cable's use action or the vehicle panel, a rope constraint in the momentum physics (slack then taut at BN's distance, the load slows the tower, the towed vehicle trails through turns), BN's breaks (25 tiles, z-levels, a destroyed cable part) plus overload, detach and save/load: [Towing](VEHICLES.md#towing-srcgametowingts-srctowingts-srcrendertowfxts). Trailer/semi coupling is not a gap: BN has no hitch part, only the tow cable. Still missing: automatic turrets (targeting modes, TURRET_CONTROLS), autoloaders, hand-firing USE_TANKS turrets, gun recoil pushing the vehicle, NPC passengers/crew/driving and autopilot. Manual turret fire (gunner stations, the controls volley, reload from cargo, jams) is delivered: [Turrets](VEHICLES.md#turrets-srcgameturretts-srcturretsts-srcrenderturretfxts). | [Vehicle v3 future work](design/VEHICLES_V3.md#future-work-split-off-not-in-this-pass), [Vehicle known gaps](VEHICLES.md#known-gaps--ideas) |
| Mobile-base facilities | A facilities panel now fills compatible containers from installed faucets and actual clean-water tanks, including driver-seat access, with conserving timed transfers. Installed kitchen/welding tools now supply real qualities and consume a finite shared vehicle battery through ordinary crafting, construction and vehicle work. Direct faucet drinking now consumes one actual clean-water portion with source-backed meal and faucet timing. Ordinary vehicle cargo now ages, and enabled refrigerators/freezers consume actual battery energy to limit spoilage temperatures; brownouts fund only the powered fraction. Thermal inertia and tank-liquid condition remain approximations. Vehicle beds/seats now give BN sleep comfort and bedding through the Rest flow (stopped, from inside), and vehicle WORKBENCH parts join BN workbench selection (also newly used for furniture benches) with live re-selection while crafting. Walkable parked rigs remain assigned. Existing cargo access is implemented. See [facility delivery](VEHICLE_FACILITIES.md). | [Facilities from your seat](design/VEHICLES_V3.md#q7-facilities-from-your-seat) |
| NPC simulation | Loaded allies now consume actual carried supplies and seek comfortable rest with persisted sleep permission through the existing dialogue menu. Represented dietary refusals and BN non-ally supply/fatigue approximations now work; unfinished craft supplies remain protected. Loaded-only complete rest paths now detour around obstacles and revalidate occupied/blocked beds. Follower rules now drive the AI (engagement, aim, guns/silence/grenades, friendly fire, follow distance/pace, doors, bashing, pulping, complaints, noise investigation; [NPC architecture](../ARCHITECTURE.md#npcs-dialogue-trade-missions-srcgame-wired-by-srcnpcsts-installnpcs)); NPCs still never fetch items (allow_pick_up: no BN npc::find_item / npc::value) and have no bionics (CBM reserve/recharge rules stored only). Full nutrient/instance fidelity, offscreen needs and recruitment remain assigned. See [NPC needs delivery](BN_NPC_NEEDS.md). | [Systems backlog](STATUS.md#open-backlog-from-wave-2-see-the-wave-3-docs-known-gaps-for-newer-items) |
| Monster simulation | Faction-aware monster-versus-monster melee now works, with attack windups for monsters and NPCs. Sound-driven routing now crosses adjacent loaded levels through reachable stairs without a player trip. Third-party special attacks and broader multi-level/unloaded pathfinding remain assigned. | [Status backlog](STATUS.md#open-backlog-from-wave-2-see-the-wave-3-docs-known-gaps-for-newer-items), [Stair limitations](STAIRS.md#known-gaps) |
| Body systems | Frostbite and radiant heat blisters are now delivered with saved timers, protection and recovery. Declared and supported hardcoded mutation melee specials are delivered for player/NPC combat, with per-strike hit/dodge rolls on apply and BN venom (POISONOUS/POISONOUS2); bodies already use BN's full 12-part human anatomy. Player bionic guns are delivered (see [bionic guns](BN_BIONIC_GUNS.md)); EMP/chain/trail effects and NPC bionic firing remain. See [mutation delivery](BN_MUTATION_ATTACKS.md). Existing mutation and bionic installation/power systems are implemented. See [thermal delivery](THERMAL_INJURIES.md). | [Status backlog](STATUS.md#open-backlog-from-wave-2-see-the-wave-3-docs-known-gaps-for-newer-items), [Body-mod architecture](../ARCHITECTURE.md#mutations--bionics-srcgamemutationsts-bionicsts-bodymodsts-wired-by-srcmutbiots) |
| Power armor | Worn power armor now activates through the real inventory UI with BN `set_transform` messages and wear rules, draws its own charge, then bionic power through a powered armor interface CBM, then a carried UPS, and shuts down when unpaid; active state and owed fractions save. Relic passive effects of wielded, worn and carried (nested) items now follow every BN enchantment condition. Data the port can't evaluate fails loudly. Climate control from power armor, cooling suits, RM13, worn CLIMATE_CONTROL items and powered vehicle interiors now acts on body temperature, and Examine lists each item's effects. Recon/thermometer/drone flags, radiation/intimidation effects, NPC activation, sided mods and the non-value parts of passive effects (granted mutations, effects, spells, NOISE/FLASH_PROTECTION) remain. See [power armor delivery](BN_POWER_ARMOR.md). | [Reload-help implementation notes](ADAPTATION.md#reload-help-what-does-this-take-and-where-did-i-see-some) |
| World content | New games (genVersion 3) generate sewers and subway tunnels (subways crossing region edges), BN's mutable specials (full lab basement with escape cells and train depots, anthills, slime pits, Ice Lab, mines, streams), lakes with depth and the sunken lab, colony monster groups, BN's z −10..10 and the lab_escape start, with `UNIQUE` specials fixed. Remaining: the portal trap doesn't teleport, `mx_portal_in`, the sunken lab is rare with our small lakes. Older saves keep their generation. See [world transport](WORLD_TRANSPORT.md). BN card readers and terrain consoles now work with source-backed door/shutdown behavior; see [lab machinery delivery](BN_LAB_MACHINERY.md). Broader lab escape and transport content remains assigned. | [Status backlog](STATUS.md#open-backlog-from-wave-2-see-the-wave-3-docs-known-gaps-for-newer-items), [Content-gap inventory](../notes/blog-post/differences.md#12-content-gaps--not-yet-implemented) |
| Rubble | Rubble clearing now works through examine and digging-tool activation, preserves actual source drops and contents, and consumes powered-tool energy. Unfinished clearing progress now saves and resumes (same tile and path, no second tool charge), and nearby awake allies speed tool clearing by BN's 10% per helper (max 3). BN's live `activity_speed` assistant system remains unmodelled, as for all activities. See [rubble clearing delivery](BN_RUBBLE_CLEARING.md). | [Adaptation finding 67](ADAPTATION.md), [Content-gap inventory](../notes/blog-post/differences.md#12-content-gaps--not-yet-implemented) |
| Achievements | Verified 2026-10-07: all 95 BN core achievements are supported and fed from real game events (10 event types); a regression test fails if new BN data needs an untracked event. Mod (Arcana) achievements are not extracted. See [achievement coverage](ACHIEVEMENTS.md). | [Achievement architecture](../ARCHITECTURE.md#scores--achievements-srcgameachievementsts-srcachievementsts-srcuiachievements_uits) |
| Optional activity toys | Construction timing and calm skill-scaled teardown toys now work with saved bonus limits, pause/off and cancellation behavior. Crafting assembly now also runs on actual unfinished crafts with saved per-batch limits, Grid/Exploded/Off settings and explicit hand pace. See [craft assembly delivery](CRAFT_ASSEMBLY.md). Bespoke exploded item models remain outside the generated-slot implementation. These are optional enhancements to existing basic activities. | [Activity minigames](design/MINIGAMES.md) |

## Partial behavior and fidelity gaps

| Area | Remaining limitation | Source |
| --- | --- | --- |
| Archery/projectiles | Player rounds, each pellet and arrows now hit NPCs in the line of fire on the drawn model, with BN hostility rules (only the aimed-at NPC turns hostile; adjacent followers skipped); see [NPCs in the line of fire](COMBAT_FEEL.md). NPC and monster arrows now fly the survivor's gravity arc; enemy grenades and launcher rounds lob and blow up by BN's explosion.cpp rules (blast falloff, fragments, occlusion, tear gas), and the survivor's own new-format explosive ammo now explodes; monsters dodge free-aim rounds by BN's deal_projectile_attack rule (effectively never against bullets); see [Enemy arrows, grenades and dodging](COMBAT_FEEL.md#enemy-arrows-grenades-and-dodging). One explosion implementation now serves every caller (the older `explosion.ts` approximation is gone): blasts fling creatures, reach the next level when their radius is 4+, damage vehicle parts by BN `vehicle::damage` (armour, thresholds, fuel tanks that blow up; occupants shielded by closed doors), rounds stop at vehicles and damage the part they hit (`map::shoot`), lobs stay under ceilings or meet them, and the survivor's grenades arm, tick and explode; see [Blasts](COMBAT_FEEL.md#blasts-one-explosion-vehicles-ceilings-and-live-grenades). Remaining: NPCs don't throw hand grenades, monster guns only target the survivor, blasts don't smash or fling items or set off traps, BN's `break_off` of broken vehicle parts. Monster-versus-NPC melee now has a telegraph and correctly misses a victim that moves away; third-party special attacks remain limited. | [Combat follow-ups](COMBAT_FEEL.md#known-gaps-and-follow-ups), [Free-aim details](COMBAT_FEEL.md) |
| Combat clarity/balance | Older playtests request dodge animation and torso aim assistance at arm's length; re-check against current 3D/free-aim combat before treating these as unchanged defects. Skill-0 archery remains difficult by design, with a gentler Accessible curve only proposed. | [Wave-2 QA](QA_V2.md), [Status backlog](STATUS.md#open-backlog-from-wave-2-see-the-wave-3-docs-known-gaps-for-newer-items) |
| Stairs | Melee across a flight's level-switch point is limited. Offset lab stairs retain a search/teleport fallback. Ramps and multi-level ladder shafts lack continuous geometry. Vehicle collision does not account for the stair overlay. | [Stair limitations](STAIRS.md#known-gaps) |
| Vehicle physics | Terrain/vehicle crashes retain the DDA energy loop rather than BN's body-impact model; no sliding along walls, simplified turn pivot and vehicle-to-vehicle momentum transfer. Monster pathfinding still sees whole occupied tiles. | [Vehicle architecture](../ARCHITECTURE.md#vehicles-srcgamevehiclets-srcrendervehiclemeshts-srcuivehicle_uits), [Vehicle limitations](VEHICLES.md#known-gaps--ideas) |
| Dialogue | 98.7% of condition/effect atoms in reachable topics (98.2% in early ones: refugee center, starting NPC, random survivors) are handled; `npx tsx tools/dialogue-coverage.ts` lists the rest. Still unsupported (each warns once naming the system, false/no-op): item ownership (u_has_stolen_item, drop_stolen_item, remove_stolen_status), mounts (find_mount, dismount), NPC activities (do_*, sort_loot, revert_activity), NPC training (npc_train_skills/styles, start_training), NPC surgery (bionic_install/remove), set_npc_pickup, lead_to_safety. Follower rules: the AI acts on every rule except allow_pick_up (NPCs don't fetch items) and the CBM reserve/recharge rules (NPCs have no bionics); setting one of those warns once naming the missing system. The C chat menu's shouted orders (NPC_CHAT_DANGER's set_danger_overrides, batch override toggles) are not ported. | [NPC architecture](../ARCHITECTURE.md#npcs-dialogue-trade-missions-srcgame-wired-by-srcnpcsts-installnpcs) |
| Other approximations | Scent tracking is simplified (explosions now follow BN's explosion.cpp, see [Blasts](COMBAT_FEEL.md#blasts-one-explosion-vehicles-ceilings-and-live-grenades)). BN bash loudness is in dB while the hearing model retains tile-volume conventions. Player smashing of vehicle parts is missing. | [Combat/world architecture](../ARCHITECTURE.md), [Audio gaps](AUDIO.md#known-gaps), [Difference inventory](../notes/blog-post/differences.md#12-content-gaps--not-yet-implemented) |
| Farming/foraging — addressed in the worktree implementation pass | BN nested seed data, epoch growth, fertilizer, save/load, seasonal inline harvest entries and underbrush transforms now work; all ten formerly skipped nature cases are ported. Planting completion revalidates location/inventory and cancellation conserves seeds. Custom non-default furniture growth multipliers remain unsupported (none in current extracted content). | [BN farming delivery](BN_FARMING.md), [Nature tests](../tests/nature.test.ts) |

## Presentation, performance and data

- **Art/model coverage:** historical handoff reports cite 63% item atlas coverage with
  `looks_like`, missing monster sprites and unresolved item/monster group warnings.
  These are historical measurements, not a new coverage scan. NPC held weapons now use detailed item-specific meshes and palettes, and dropped weapons lie on the ground as the same meshes (`tools/ground-item-coverage.ts`: 93 % of guns, 67 % of melee weapons, 9 % of tools; still generic: bows, grenades, pans/brushes/scissors and most tools; pile/inventory icons of art-less items are still glyphs; Classic look unchanged); the third-person survivor retains generic silhouettes; first-person successful eating, drinking and direct item use now have temporary poses that restore the held item; deferred tool uses now gesture on completion only; bespoke portion geometry remains assigned; quadrupeds now have distinct canine, equine, cervid, bear, pig, reptile and feline geometry. Bespoke remaining species and precise corpse contact remain assigned. Boats/aircraft/tanks use fallback models, tanker tanks and socket
  attachments lack dedicated geometry. Sources: [Status](STATUS.md),
  [Character gaps](CHARACTERS.md#known-gaps), [Vehicle gaps](VEHICLES.md#known-gaps--ideas),
  [QA issue 11](QA_WAVE3.md#issues).
- **Furniture/flora:** ceiling lamps lack gameplay power and porch lamps are visual only;
  connected loaded rooms now share consistent cached finishes across chunks; piles do not stack vertically;
  furniture lacks a simpler distant model. Ferns now use curved fronds and shared near/middle/far leaflet geometry; young deciduous trees are bare in winter. General flora LOD transitions still alter silhouettes. Sources:
  [Furniture gaps](FURNITURE.md#known-gaps--next), [Flora gaps](FLORA.md#known-gaps).
- **Remaining visual compromises:** shimmer near the camera, flat distant terrain rings,
  billboard tracers, tinted rather than reflective mirrors, and rider/
  passenger animations. Bullet marks now align to verified loaded surfaces with explicitly documented cosmetic reconstruction limits. Some vehicle appearance switches retain legacy bugs. Sources:
  [Readability](READABILITY.md#known-gaps), [Combat](COMBAT_FEEL.md#known-gaps-and-follow-ups),
  [Vehicles](VEHICLES.md#known-gaps--ideas).
- **Performance:** meshing is sliced on the main thread rather than a worker pool; large
  character crowds still upload dynamic transforms each frame, but stable texture/taper uploads are now reused (22.2% fewer requested instance bytes in measured fixtures); first-use flora palette paints now upload only their painted rows ([flora](FLORA.md)).
  Performance experiments discuss deferred batching. Do not treat historic frame-time
  measurements as a current regression. Sources: [Status](STATUS.md),
  [Characters](CHARACTERS.md#known-gaps), [Flora](FLORA.md#known-gaps),
  [Experiments](PERF_EXPERIMENTS.md).
- **Verification debt:** the initial checkout had 17 `TODO(BN)` markers and 16 explicit
  `it.skip`/`test.skip`/`describe.skip` declarations (static search, not runtime test counts).
  Besides nature, they cover dormant-corpse persistence, snippets, terrain classification,
  suppressors, sights and buckshot. Earlier docs' “24 skipped” and “13 skipped” are historical
  suite totals. Sources: [Tests](../tests), [BN data model](BN_DATA_MODEL.md).
  After farming, terrain, firearm, snippet and dormant fixes, no stale BN migration markers or explicit skip declarations remain; the three previously conditional lab tests now run against real BN content.
  Restored tests use actual BN data/rules or explicitly documented legacy generator compatibility; the lab migration also restores the remaining conditional tests.
  [Firearm migration](BN_FIREARM_MODS.md), [Dialogue snippets](BN_DIALOGUE_SNIPPETS.md).
- **Gallery settings — defaults addressed:** all visual switches now have Options rows,
  and Copy defaults survives reload with session URL precedence. Stable scene cosmetics and living-to-corpse variant consistency
  are now reviewed and applied. Source:
  [Gallery gaps](GALLERY.md#known-gaps).

## Older backlog items superseded by later documentation

Do not count these as currently missing solely because `STATUS.md` or an older QA row
still lists them:

- Gas-pump **refuelling exists**; timed **siphoning** was also delivered in this session.
  [Vehicles](VEHICLES.md), [Refuelling implementation](../src/game/refuel.ts).
- Big-button title layout, crosshair activity progress, BN weather requirements,
  item/flashlight lighting, crafting “Almost” lists and cleaned-up unsupported-feature tips
  were delivered in the adaptation pass. The contradictory “Bloated”/“Famished” display
  was also clarified as “Full, still famished.” [Adaptation fixes](ADAPTATION.md).
- Teleport/load visibility gating and point-light lamp banding were fixed after the
  corresponding open wave-3 QA rows. [Readability follow-up](READABILITY.md#qa-wave-3-fixes-5-6-7),
  [Load gate](PERF.md).
- Shared secondary-window styling is documented as modernized in the current local work.
  [Window audit](design/WINDOW_MODERNIZATION.md).

## Intentional exclusions and release decisions

Keyboard/mouse browser support, absent gamepad/touch/desktop-wrapper support, walking
around inside a moving vehicle, and optional legacy visual/aim modes are product scope
choices, not necessarily defects. VR branch status in the blog notes is historical and
was not re-audited. Sources: [UI scope](UI2.md), [Vehicle scope](design/VEHICLES_V3.md),
[Difference inventory](../notes/blog-post/differences.md#12-content-gaps--not-yet-implemented).

The status handoff records unresolved project-code licensing and branch/release choices.
Its older CO.AG permission concern needs reconciliation with the later adaptation credits
section, which documents permission and attribution tests. These are release decisions
rather than missing game mechanics; credit/title fixes already recorded elsewhere should
not be repeated as unmet requirements. [Status handoff](STATUS.md#decisions-waiting-for-you),
[Credits documentation](ADAPTATION.md).

## Validation of this delivery

All local source-link targets in this report exist. Recharging typecheck and production
build pass, with real-input browser verification documented in [Recharging](RECHARGING.md).
The last complete integration run passed typecheck and the full suite: 136 files,
1,737 tests passed, none skipped and no failures. Both original baseline failures
were repaired with accurate expectations while retaining conservation assertions.
These are the last complete-run counts; subsequent accepted packages have their targeted validation recorded in the ledger. See [the review ledger](GAP_IMPLEMENTATION_WORK.md)
for accepted deliveries, feature-specific evidence and remaining scope.
