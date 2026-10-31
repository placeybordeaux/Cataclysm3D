# What Cataclysm3D changes from Cataclysm

Cataclysm3D is a real-time, first-person 3D game running on Cataclysm's own data. v1 (tag `v1-dda`)
used Dark Days Ahead; v2 and wave 3 (branch `bn`) use Bright Nights (BN). The project describes
itself as "a TV adaptation of a book" (`docs/ADAPTATION.md`): it keeps the story, the systems and
the dread, and it changes whatever only worked in a turn-based terminal game. The list below covers
every material difference we could document. Each entry says what Cataclysm does, what Cataclysm3D
does, why, and where the difference is recorded.

Everything below comes from the repository docs, the git history, the source code, or the agents'
reports in the session transcripts. Nothing was inferred. The list was first written on
2026-09-30 and is current as of 2026-10-26. Unless an entry says otherwise, it describes branch
`bn` at `e8fe3a3`. Entries for other branches are marked **(branch …)**. Most
adaptations have an Options switch that restores the original behaviour. ADAPTATION.md rule 4 is
"keep the old version one option away".

**Why tags**
- `[medium adaptation]`: the change is forced by first person or real time.
- `[new-player design]`: the change is a deliberate choice for the new audience.
- `[simplification]`: a Cataclysm system was cut down.
- `[fidelity fix]`: the port first got Cataclysm wrong, and this fixed it.
- `[not yet implemented]`: the system is missing.
- `[engine limitation]`: the system is missing or different because of how this engine works.

## Count per category

| Category | Items |
|---|---|
| 1. Rendering and presentation | 34 |
| 2. Controls and real time | 25 |
| 3. Combat and aim | 34 |
| 4. UI, inventory and looting | 30 |
| 5. World and mapgen | 16 |
| 6. Vehicles | 27 |
| 7. Stairs and z-levels | 13 |
| 8. Survival rules (weather, fire, light, digging, rot…) | 21 |
| 9. NPCs and missions | 12 |
| 10. Progression and onboarding | 13 |
| 11. Balance and difficulty | 14 |
| 12. Content gaps / not yet implemented | 14 |
| 13. Data-fidelity bugs fixed (the port got it wrong first) | 32 |
| 14. History: v1 (DDA) → v2 (BN) | 6 |
| **Total** | **291** |

(Some differences appear in two categories on purpose. For example, a fidelity fix is listed in
its own area and again in category 13. Counted without the repeats, there are about 265 distinct
differences.)

---

## 1. Rendering and presentation

1. **Camera**. Cataclysm is a top-down grid of ASCII glyphs or tiles. Cataclysm3D is first person by default. Over-the-shoulder and a top-down "classic" camera are one key (`V`) away. *[medium adaptation]* — ARCHITECTURE.md "Visual style"; DESIGN_V2 decision 5
2. **Art direction**. Cataclysm draws 2D sprites or glyphs. Cataclysm3D renders "Project Shadowglass" 3D pixel art: a low-resolution target upscaled with nearest filtering, point-filtered textures, banded lighting, a palette/LUT grade, ordered dither and outlines. *[medium adaptation]* — ARCHITECTURE.md; docs/LOOKS.md
3. **Texel density taken from the tileset**. UltiCa draws a 1 m tile as 32 px. Cataclysm3D paints every 3D surface at 32 texels per metre, so the world is literally built from Cataclysm's pixel art. *[medium adaptation]* — docs/FURNITURE.md, CHARACTERS.md
4. **Five switchable "looks"**: classic, crisp, voxel, terrain and full. The user picked `voxel` as the default in the style gallery, along with a 168 m draw distance and sprite first-person hands (`7c2620c`). *[medium adaptation]* — docs/LOOKS.md; commit `7c2620c`
5. **Monsters and NPCs are low-poly 3D rigs, not sprites**. Each body is procedurally built from boxes, painted from its UltiCa sprite, and animated at a stepped 10 fps. It turns to face where it walks or what it fights. The camera-facing billboards are still an option. *[medium adaptation]* — docs/CHARACTERS.md; `?chars=billboard`
6. **Body plans from BN data**. There are more than 10 archetypes (humanoid, quadruped, insect, flyer, blob, serpent, plant, machine…). They are chosen from BN `bodytype`, then species, flags and symbol, and sized from `volume` in ml. Zombie builds (fat, brute, hulk, skeleton, child, armoured) come from the monster id. Quadrupeds now have separate canine, equine, cervid, bear, pig, reptile and feline shapes. Cataclysm itself has no 3D shape data at all. *[medium adaptation]* — docs/CHARACTERS.md; IMPLEMENTATION_GAPS.md
7. **Individual zombies get quirks**. Each zombie's seed gives it a hunch, a head tilt, a limp or a dragging arm, plus a shambling lurch. None of this exists in Cataclysm. *[medium adaptation]* — CHARACTERS.md round 2/3
8. **Procedural NPC looks**. NPCs get six builds, seven skin tones, eight hair colours, several hair styles and headgear, all stable per uid. NPCs are also painted from their worn-gear composite, so a red jacket reads as a red jacket in 3D. *[medium adaptation]* — CHARACTERS.md round 6
9. **Furniture is modelled**. In Cataclysm, furniture is a sprite on a tile. Cataclysm3D has 75 low-poly archetypes: neighbours join up (long tables drop their inner legs, counter runs turn corners), pieces back onto walls, and chairs face tables. *[medium adaptation]* — docs/FURNITURE.md
10. **Walls and floors are painted at real scale**. Bricks are 25×8 cm, planks 12.5 cm and linoleum tiles 25 cm. Interior faces get drywall or wallpaper chosen per building, rooms get baseboards and crown moulding, and roofs get shingles. Cataclysm has one sprite per terrain. *[medium adaptation]* — FURNITURE.md "Surfaces"
11. **Render-only set dressing**. Houses get pictures, calendars, grime, water stains, peeling paint, bloody handprints, rugs, unlit ceiling lamps, house numbers, porch lamps, gutters and graffiti. All of it is deterministic per room or building, and none of it is a game object. *[medium adaptation]* — FURNITURE.md round 3
12. **"Wrecked" houses**. The building seed picks kept, dirty or wrecked. Wrecked houses get toppled chairs, bookcases on their faces, floor clutter and junk heaps. This is visual only; BN's map items are unchanged. *[medium adaptation]* — FURNITURE.md round 4
13. **Ground items are drawn as 16 generic shapes** (box, bottle, can, gun, blanket…). Each is sized from the item's volume, with small items scaled up so they read. At most three are drawn per tile, resting on the furniture's real top surface. Dropped weapons now lie on the ground as their own meshes: 93 % of guns, 67 % of melee weapons and 9 % of tools. *[medium adaptation]* — FURNITURE.md; CHARACTERS.md "Dropped weapons on the ground"
14. **Trees are modelled species families**: round, willow, conifer, birch, fruit, sapling and dead. Colours come from the seasonal sprite, so trees blossom in spring, fruit in summer and get snow caps in winter. They have 3 LOD rings with no pop to a billboard. *[medium adaptation]* — docs/FLORA.md
15. **Distance is drawn**. Cataclysm shows only what is in sight. Cataclysm3D fades distance toward the sky colour and adds a far ground ring and an overmap skyline out to the horizon. *[medium adaptation]* — docs/READABILITY.md
16. **Dormant monsters are drawn**. Beyond the 60-tile reality bubble, monsters are not simulated, as in Cataclysm, but they are still drawn as idle far figures up to about 130 m. A horde down a long road is visible. *[medium adaptation]* — CHARACTERS.md round 2; monai.ts `ACTIVE_RADIUS = 60`
17. **Far readability aids**. Limbs get up to 45 % thicker between 22 and 55 m, and hostiles get a small self-lit emphasis from 16 to 45 m, so they never sink into dusk. *[new-player design]* — CHARACTERS.md
18. **Weather shows in the sky**. BN's `light_modifier` and `sight_penalty` drive overcast, a dimmed sun and closer haze. Wipers sweep while it rains. *[medium adaptation]* — READABILITY.md; VEHICLES.md round 4
19. **Toon form lighting**. Light comes in 4 bands with a world-fixed side fill, so a house seen from its shadow side still shows its corner. Lamp pools are dithered instead of drawn as rings. *[medium adaptation]* — READABILITY.md
20. **Night uses Cataclysm's light units** in a light map. Flashlights, fires and headlights are dynamic lights. *[medium adaptation]* — ARCHITECTURE.md; vision.ts
21. **Fire is animated**. UltiCa's flame frames play on three crossed, world-fixed cards, with rising ember meshes. *[medium adaptation]* — CHARACTERS.md round 6
22. **Hit feedback you can see**. There is hit-stop (45–85 ms), flinch and shove, and bodies stagger, topple and bounce with a thud. Blood and dust fly, and death falls along the killing blow. Cataclysm reports all of this in text. *[medium adaptation]* — docs/COMBAT_FEEL.md
23. **Arrows are objects**. They are visible meshes in flight and stuck in bodies, walls and the ground, and they can be picked up again. *[medium adaptation]* — COMBAT_FEEL.md "Archery", CHARACTERS.md round 5
24. **Mannequins and statues** are posed humanoid rigs baked into the chunk. *[medium adaptation]* — CHARACTERS.md round 5
25. **Broken windows and doors are drawn as openings**. BN drops their WINDOW/DOOR flags, so a naive renderer showed a floor decal of glass or a floating pane. Cataclysm3D draws jagged shards in the frame. *[fidelity fix]* (render) — FURNITURE.md
26. **Stairs are modelled** as flights, spirals and ladders with stairwells cut into the floor above. Before, stairs were a block of steps with a hole. *[medium adaptation]* — docs/STAIRS.md
27. **Vehicles are one modelled body each**, not a grid of part tiles (see §6). *[medium adaptation]* — docs/VEHICLES.md
28. **3D first-person hands and held weapons**. Arms are painted from your outfit, and there are per-weapon variants (revolver, M1911, AR, AK, pump or break-action…). Bows stay 2D art while drawn, because that read better. The user's defaults switched the hands back to sprites (`7c2620c`). *[medium adaptation]* — CHARACTERS.md rounds 3–5
29. **Style gallery debug page**. `/?gallery` compares every visual switch on fixed scenes, live, as A/B pairs or as a matrix. The user chose the shipped defaults with it. *[new-player design]* (tooling) — docs/GALLERY.md
30. **Title logo and big buttons**. Cataclysm's title is a terminal row. Cataclysm3D has a pixel-art logo and a big-button menu. The ASCII logo and the one-line row are still options. *[new-player design]* — ADAPTATION.md #3; QA_V2 #21
31. **Zombies are hunched and told apart by outline**. After the user called them boxy mannequins, zombies were redrawn after the UltiCa sprites: hunched, head thrust forward, arms reaching at chest height, grey-green skin, and a silhouette per family. They rock and loll their heads while idle, and wind-ups differ by family (rear-back, overhead hammer, crouch before a leap). Low-poly Blender bodies ("sprite 3D") and a far sprite LOD are options, off by default. *[medium adaptation]* — CHARACTERS.md "Round 7"; docs/SPRITE3D.md; commit `c934175`
32. **Far buildings are drawn past the draw distance**. Beyond the streamed chunks, each map column is drawn as a coarse proxy built from the real map (walls, roofs, tree crowns, cars) out to 1.75× the draw radius. When the real chunks are ready they dissolve in over 0.6 s. Before, far buildings popped in. Options → Far detail keeps the old behaviour. *[medium adaptation]* — docs/FAR_LOD.md
33. **Gibbed bodies come apart**. In BN a body pulverised by overkill leaves no corpse, only drops and splatter. Cataclysm3D keeps that rule, but the torso, head and limbs fly as loose pieces and leave blood where they land. Options → Gibbed bodies (`pieces` or the old `splat`) and Gore (4, 6 or 10 pieces). *[medium adaptation]* — VEHICLES.md "Gibs"; CHARACTERS.md "Gibbed bodies"
34. **First-person eating, drinking and item use have short poses**, and the held item comes back after. Tool jobs gesture only when they finish. *[medium adaptation]* — CHARACTERS.md "Successful item gestures", "Deferred tool-use gestures"

## 2. Controls and real time

1. **Turns become seconds**. One BN turn (100 moves) takes 1/3 real second (`ACTION_SCALE = 3`), so a speed-100 walker covers 3 tiles/s. *[medium adaptation]* — src/core/time.ts
2. **Melee runs on a slower clock** (`MELEE_SCALE = 2` turns/s), "so fights read blow by blow". At 3 turns/s, a pack of zombies shredded you before you could react. *[medium adaptation]* — src/core/time.ts
3. **A game day is about one real hour** (`CLOCK_SCALE = 24`). Day length is a Custom difficulty knob. *[medium adaptation]* — docs/BALANCE.md "Real-time pacing"
4. **Long actions warp the clock**. A night's sleep takes about 16 s (2 real s per game hour), and crafting, reading and waiting take 2–8 real s. Like Cataclysm activities, they stop when a hostile comes into view. *[medium adaptation]* — BALANCE.md; ARCHITECTURE.md
5. **Tactical pause** (`` ` `` or Pause/Break). A turn-based game never needs one. Here it freezes the simulation, and you can still look around and open every window. *[medium adaptation]* — BALANCE.md "Tactical pause"
6. **Menus pause time** on Accessible. On Classic, time runs in the inventory and crafting screens, while the Esc menu always pauses. BN menus take no time at all, but real time can't be stopped per keypress. *[medium adaptation]* — BALANCE.md
7. **WASD and mouse-look, with CDDA letter keys as accelerators**. Where the two collide, CDDA's keys moved. For example, `F` is the flashlight and fire mode moved to `b`; `^` still takes the controls. *[medium adaptation]* — ARCHITECTURE.md "Game design conversion rules"; STATUS.md controls
8. **Every key is rebindable**, and layouts are handled. AZERTY is learned from the layout map, CapsLock no longer turns `e` into `E` (eat), and AltGr and non-Latin layouts work. *[new-player design]* — docs/UX_REVIEW.md #1–4, #10
9. **`e` does the obvious thing** at the crosshair. `o` opens a world context menu, and in menus a right-click opens a context menu. *[new-player design]* — docs/UI2.md
10. **Hitting things smashes them**. Swinging at a window, door, fence or piece of furniture with nothing alive in front of you smashes it. In Cataclysm you need the smash key (`X` still works). *[new-player design]* — commit `c2c0095`; lead's live-fix report 2026-09-30
11. **Movement slides round a lone blocked corner** (a tree tile). Axis-by-axis sliding had nothing to slide along. *[medium adaptation]* — ADAPTATION.md #33; `tests/physics_corner.test.ts`
12. **Side-step**: Space, or a double-tap of A, D or S. *[medium adaptation]* — COMBAT_FEEL.md
13. **Timed actions show a ring at the crosshair** that says "stand still". Moving interrupts, and the reason flashes at the crosshair instead of appearing in the log. *[new-player design]* — ADAPTATION.md #4
14. **A movement key already held when an action starts is ignored**, both for cancelling and for walking. The user's "I stopped lighting a fire" report was an activity cancelled on the same tick. *[medium adaptation]* — lead, session 1, 2026-09-30 05:32
15. **Mouse capture rules**. Esc resumes with any key, F11 gives fullscreen with keyboard lock, and a "Leave site?" guard catches Ctrl+W. These are browser pointer-lock problems a terminal game never has. *[engine limitation]* — docs/UX_REVIEW.md
16. **Wait menu in seconds and minutes** ("20 seconds", not "20 heartbeats"). *[new-player design]* — ADAPTATION.md #7
17. **Stairs are walked**. In Cataclysm, `<` and `>` move you a level. In Cataclysm3D you walk up the flight, and `<` and `>` climb the nearest flight for you (see §7). *[medium adaptation]* — docs/STAIRS.md
18. **Driving uses a direct throttle** by default. BN's 4-mph cruise steps are an option (see §6). *[medium adaptation]* — ARCHITECTURE.md "Vehicles"
19. **Look mode (`x`) uses the mouse**. *[medium adaptation]* — UX_REVIEW.md #22
20. **Fast-forward for timed actions**. During reading, crafting, construction, butchering, waiting or sleeping, `+` steps the speed ×1 → ×2 → ×4 → ×8 → ×16 on top of the action's own warp. It runs more 1/30 s ticks, never longer ones, so every interrupt check runs as at ×1 (tested to give identical results). It drops to ×1 when the action is interrupted, when you are hurt, or when hunger or thirst gets a step worse. A governor caps the speed when the machine can't keep up. *[medium adaptation]* — BALANCE.md "Fast-forward"
21. **Being hurt stops the action and wakes you**, as BN's `Character::on_hurt` does. Before, a zombie got six blows in on a sleeping survivor. *[fidelity fix]* — BALANCE.md "Fast-forward"
22. **Grab and drag in real time**. `G` grabs adjacent furniture or a hand-pushed vehicle, as in BN, and walking pushes, pulls or nudges it one tile step at a time at BN's cost (a dresser at Str 10 takes about 0.6 s a tile). BN's strength rules, strain roll, spilled contents and scraping noise apply. Throwing moved from `G` to BN's own `t`. Not ported: grabbing creatures, ramps and harnessed animals. *[medium adaptation]* — ADAPTATION.md "Grab and drag"
23. **Space closes every menu** (the rebindable `close_menu` key, or the key that opened it). Esc still works, but no hint ever shows it, because outside fullscreen the browser takes Esc to release the mouse. *[engine limitation]* — UX_REVIEW.md "Closing menus"
24. **Load gate**. Creatures, corpses and vehicles are drawn only once the walls around them are built. While the world within 40 m on your level and the ones above and below is unbuilt, the game holds: no turns, no monster moves, the clock stopped. That shows as a loading screen after loads and teleports, or a small "Loading surroundings" note when you outrun streaming. Options → Load gate. *[engine limitation]* — PERF.md "Load gate"
25. **Curtains and windows are separate actions**. BN keeps curtains in terrain, so "open" on a curtained window opens the window and "close" draws the curtains. The port ran the first step only, so the curtains were unreachable. Now `e` offers close/open the curtains, open/close the window, peek (6 real seconds) and tear down, and a pry tool opens one from outside. Drawn curtains block sight and daylight from the data. *[fidelity fix]* — FURNITURE.md "Curtains"

## 3. Combat and aim

1. **Free aim is the default**. The shot goes where the reticle was when you clicked, and there are no to-hit dice for the survivor ("Steady hands"). BN's dice are the `dice` Aim model option. *[new-player design]* — docs/COMBAT_FEEL.md "Aim models"; user feedback 2026-09-30
2. **Skill is the reticle's weave**. Its amplitude is BN's mean lateral shot error (weapon, dex, hands and skill dispersion). Skill 0 with a pistol is about 1.8°, skill 5 about 0.5°. Low skill also weaves faster. *[new-player design]* — COMBAT_FEEL.md
3. **Skill also scales damage** (×0.75 at skill 0 up to ×1.3 at 10), crit chance, stagger and recoil recovery. *[new-player design]* — COMBAT_FEEL.md
4. **Hit zones come from the drawn 3D model**. A head is ×2 (BN's head severity cap), legs and limbs ×0.75, and a graze on the outer 20 % of the body ×0.5. A ray between the legs misses. *[medium adaptation]* — COMBAT_FEEL.md; `render/aimPick.ts`
5. **Recoil is a kick, not a spread**. BN's recoil (MOA) kicks the aim up, and it recovers faster with skill. *[medium adaptation]* — COMBAT_FEEL.md
6. **Optional timing minigame**. Hold breath for a NOW window, loose the bow as a ring closes, active reload, and "melee on the beat" (×1.25). *[new-player design]* — COMBAT_FEEL.md "Timing model extras"
7. **Melee swings have phases**: wind-up, strike, contact and recovery. They add up to BN's `attack_speed`, and the blow resolves *at contact* against what the swept arc finds then. In v1 it resolved on the click, before the swing played. *[medium adaptation]* — COMBAT_FEEL.md "Diagnosis" #1, "What changed"
8. **A failed melee roll becomes a glancing blow** in free aim (×0.5, no technique, no crit), not a clean miss. *[new-player design]* — COMBAT_FEEL.md
9. **Melee zones**. A head hit does ×1.5 and may stun, and a leg hit may knock the target down. The target is the zombie under the crosshair, found with a fan of rays against the model boxes. *[medium adaptation]* — COMBAT_FEEL.md round 3
10. **Monsters telegraph their blows**. Each blow winds up for 0.4–0.8 s on Accessible (0.25–0.6 s on Classic): the monster rears back, flashes warm and then white-hot, and a snarl plays. Stepping out of reach makes it whiff. BN has no wind-ups. *[medium adaptation]* — COMBAT_FEEL.md "Monster telegraphs"
11. **Guard maps onto BN's `block_hit`**. The readied stance (hold RMB) is the guard: the block attempt always happens (+8 score), and raising the stance just before a blow lands is a **parry** (+10) that stuns the attacker for 0.8 s. *[medium adaptation]* — COMBAT_FEEL.md "Active defence", "Ready stance"
12. **Side-step dodge**. Space moves you 1.3 m and gives +6 dodge against blows in the next 0.3 s. Normally the step simply leaves the lunge's reach. *[medium adaptation]* — COMBAT_FEEL.md
13. **Grabs are a mash-`e` struggle bar**. Each press rolls BN's break-free check. Before, walking away was the only way out. *[medium adaptation]* — COMBAT_FEEL.md
14. **A staggering blow breaks a grab** on Accessible (20 % of HP or a crit). *[new-player design]* — BALANCE.md "First fight"; `FEEL.staggerBreaksGrab`
15. **Dodges are visible**. A monster BN would let dodge hops back and aside before contact. Plain zombies (dodge 0) never do. *[medium adaptation]* — COMBAT_FEEL.md
16. **Every miss says why** at the crosshair: "dodged", "clumsy swing", "blocked by cover", "fell short: out of range (22 m)", "wide: archery skill too low (0)"… *[new-player design]* — COMBAT_FEEL.md; QA_V2
17. **Monsters take slots around you** within 3.5 m instead of queueing in single file. They stop 0.2 m inside their reach, with hysteresis. *[medium adaptation]* — COMBAT_FEEL.md "Spacing"
18. **Enemy fire is real rounds in the air**. Bullets fly at 90 m/s and are drawn as streaks; arrows and stones fly visibly. Walls stop them, bystanders get hit, and near misses make a zip and a flinch. BN's dispersion still sets the direction. *[medium adaptation]* — COMBAT_FEEL.md round 3; `08120ee`
19. **Bows are drawn and loosed**. RMB draws for BN's draw time and LMB looses. Arrows follow a gravity arc and take time to arrive. BN's strength bands and recovery odds (1 in 25 wooden arrows break) apply. *[medium adaptation]* — COMBAT_FEEL.md "Archery"
20. **Only powder weapons flash** (firearms and launchers). Before this fix a longbow "sounds like a gun and has the muzzle flash" (the user). *[fidelity fix]* — COMBAT_FEEL.md; QA_V2
21. **ADS zoom** (70° to 50°) with RMB on a gun, and **reloads take visible time** (0.7–2.5 s from BN's reload cost). *[medium adaptation]* — COMBAT_FEEL.md
22. **Accessible slows monster swings** so each cycle is at least the tell plus 0.35 s: about 1.4 → 1.05 attacks/s for a zombie. Classic keeps BN's swing rate exactly (tested). *[new-player design]* — COMBAT_FEEL.md
23. **Tracers and bullet marks**, which stay on walls for 30 s. *[medium adaptation]* — COMBAT_FEEL.md
24. **First-fight hints by the crosshair**: "Your aim sways — fire as it crosses", "Aim for the head — ×2", "Hold right mouse: guard · Space: side-step". *[new-player design]* — COMBAT_FEEL.md round 3
25. **Throwing (`G`) goes where you look.** *[medium adaptation]* — COMBAT_FEEL.md
26. **NPCs and monsters still use BN's dice** for their own attacks. *[simplification]* — COMBAT_FEEL.md
27. **Melee has no sway**. In free aim, a swing's timing is the skill. *[simplification]* — COMBAT_FEEL.md known gaps
28. **Ammo stretches further**. Well-aimed shots don't miss, so a skill-0 pistol needs about 3 rounds per kill instead of about 5, while ammo spawns are unchanged. This is flagged as an open decision for the user. *[new-player design]* — STATUS.md "Decisions waiting"; BALANCE.md
29. **Right mouse readies a melee weapon, and LMB swings only while readied**. Swinging any time let a player walk backwards and hit a mob for free, which a turn-based swing never allows. Readied, you walk at ×0.65 (Classic ×0.6) and spend 20 stamina/s, so backing off no longer outpaces a zombie. Running lowers the weapon. Options → Controls → Melee keeps "Swing any time". *[medium adaptation]* — COMBAT_FEEL.md "Ready stance"
30. **The weaving reticle shows only while you aim** (RMB on a gun, a drawn bow) and for 2.5 s after a shot. Otherwise a plain crosshair shows, but the weave keeps running, so a hip shot still goes where the gun points. *[new-player design]* — COMBAT_FEEL.md "Free aim"
31. **Top-view aim is twin-stick**. In the top-down camera the mouse turns the survivor and the facing is the aim. Height is picked for you: centre mass, or the head while aiming. A dotted line and a ring show where the shot lands. An aim assist is an option, off by default. *[medium adaptation]* — COMBAT_FEEL.md "Top view"
32. **Enemy arrows drop and grenades lob**. BN flies every projectile along a straight tile line. Here arrows, bolts and stones from NPCs and monsters fly the same gravity arc as the survivor's, and grenades and launcher rounds are lobbed. BN's dispersion still sets the direction, so hit odds are unchanged. *[medium adaptation]* — COMBAT_FEEL.md "Enemy arrows, grenades and dodging"
33. **Explosions follow BN's `explosion.cpp`**. The old approximation (a disc of radius cbrt(power) with its own falloff) is gone. One implementation serves rounds, grenades, mines, exploding monsters and fuel tanks. Blasts of radius 4 or more reach the level above or below, and blasts damage vehicle parts by BN's `vehicle::damage`. *[fidelity fix]* — COMBAT_FEEL.md "Blasts"
34. **Bionic guns use the same free aim**. Turning one on in the bionics panel (`p`) arms a gun that is never put in your inventory. LMB fires it, `b` cycles its modes, and each shot that fires pays its power. Aiming is not saved, and EMP, chain lightning and trail effects are not modelled. *[medium adaptation]* — docs/BN_BIONIC_GUNS.md

## 4. UI, inventory and looting

1. **Mouse-first pixel UI instead of curses letter menus**. There are windows, drag and drop, context menus, tooltips, toasts and a hotbar. "Inventory screens: Classic" brings the letter lists back. *[new-player design]* — docs/DESIGN_V2.md decision 2; docs/UI2.md
2. **Three-window inventory**: Equipment (a paper doll with 12 body parts and encumbrance per part), Inventory, and Nearby (a tab per place in reach). *[new-player design]* — UI2.md
3. **Right-click shows every action with its time cost**. Impossible actions stay in the list, greyed, with the reason ("Need: a screwdriver"). *[new-player design]* — UI2.md
4. **Hotbar 1–0** binds item types and shows a label under each slot; a key press says what it used ("3: combat knife"). *[new-player design]* — UI2.md; QA_V2 #5
5. **Quick loot at the crosshair** (Skyrim/Fallout style). Wheel to select, `e` to take, `r` to take all, and mouse-look never stops. *[new-player design]* — UI2.md "Looting"
6. **Area loot** (Zomboid / BN AIM style). One window merges every place in reach by item type and stays open while you walk. *[new-player design]* — UI2.md
7. **Pile markers and search memory**. A badge shows the most notable item and a count; a container shows `?` until searched, then what you remember, then "empty". *[new-player design]* — UI2.md
8. **Smart Take all** takes the best value per share of the room left first and never overburdens you. It says what stayed and why. *[new-player design]* — UI2.md; QA_V2 #4
9. **The loot card offers Wear, Eat or Drink** when it matters ("You're cold: [O] puts it on", "You're hungry: [E] eats it here"). *[new-player design]* — ADAPTATION.md #13, #37
10. **Crafting opens on Craftable, plus "Almost: one thing short"**. BN opens on all known recipes (305 on day 1, one of them craftable). Rows say what's missing in words. *[new-player design]* — ADAPTATION.md #30, #32
11. **Crafting search also matches descriptions**. "spear" finds the "long pointy stick". *[new-player design]* — QA_V2 #15
12. **Construction shows a ghost placement and says what's missing** ("missing 10 more rocks", "missing Fabrication skill 1 (you have 0)"). *[new-player design]* — ADAPTATION.md #48
13. **One Rest window for sleep and wait**. It describes the spot in words ("wooden floor, hard: a bed or sleeping bag would help"), not as "comfort 0". *[new-player design]* — ADAPTATION.md #8, #16
14. **Needs in words**. BN shows "Bloated" next to "Famished"; Cataclysm3D shows one icon reading "Full, still famished", with a tooltip saying what to do. *[new-player design]* — ADAPTATION.md #6
15. **Tips of the day curated**. Of BN's 86 tips, 47 were kept, 11 rewritten for first person and real time, and 28 dropped; 9 were added. A test fails if BN adds a tip nobody has reviewed. *[new-player design]* — ADAPTATION.md #5
16. **No "safe mode" messages**. "Spotted zombie--safe mode is on!" became "You spot a zombie to the northwest!" *[new-player design]* — QA_V2 #7
17. **Heard sounds have a direction and a distance** ("a thump to the north, 12 m away"). Repeats fold together, and heard sounds leave marks on the compass strip. *[new-player design]* — QA_V2 #11
18. **Weather messages only for changes you'd notice** (rain, storm or snow starting or stopping), not "Rain! / Drizzle! / Light Drizzle! / Cloudy!" in a row. *[new-player design]* — ADAPTATION.md #54
19. **Zombie nurses and surgeons are named as zombies**. BN names them by their old job, so "You spot a nurse" read like a survivor to rescue. *[new-player design]* — ADAPTATION.md #35
20. **Modern dialogue, trade and mission screens**. Dialogue has a portrait, typewriter text, opinion and faction chips, and trial chips. Trade is drag-and-drop with a balance bar and is a single transaction. The mission log gives a direction and a distance. *[new-player design]* — ARCHITECTURE.md "Interaction screens"
21. **Distances in metres, not OMTs**: "about 140 m north-west" instead of "6 OMT north-west". *[new-player design]* — ADAPTATION.md #44
22. **Food cards show freshness** ("about 9 days at room temperature, about 4 weeks in a fridge"), worked out from BN's rot model. *[new-player design]* — ADAPTATION.md round 6
23. **Unclean water is labelled** ("Drink the unclean shallow water") instead of BN's y/n popup. *[new-player design]* — ADAPTATION.md #61
24. **"Continue" loads the latest save directly.** *[new-player design]* — ADAPTATION.md #26
25. **In-game Credits screen** with the licence attributions. *[new-player design]* — ADAPTATION.md "Credits"
26. **Destructive confirmations never take Enter as yes.** *[new-player design]* — UX_REVIEW.md #31
27. **Empty tools are greyed** ("Empty (0/25): it needs charges to use"). *[new-player design]* — ADAPTATION.md #50
28. **A failed reload says what the item takes**. BN says "You don't have any batteries to reload your …". Cataclysm3D names the fitting items from BN's fields, gives examples you saw recently and where ("You saw 2 light batteries in a dresser 40 m northwest"), or else the most common ones in BN spawn data, and names the failure (flat, wrong size, wrong calibre loaded). *[new-player design]* — ADAPTATION.md "Reload help"
29. **A hotbar slot is a quick-draw**. Weapons, bows included, are wielded; clothing is worn; food is eaten; tools are used. It used to run the item's default action, which wore a bow because BN gives bows armour data. *[new-player design]* — ADAPTATION.md "Hotbar: weapons are wielded"
30. **Starting a job from the inventory closes the windows and starts the work**. The Disassemble entry shows the yield, so the click is the confirmation (BN asks "Really disassemble?"), and stacks get "Disassemble all N". *[new-player design]* — ADAPTATION.md "Seeing skill practice"

## 5. World and mapgen

1. **BN content end to end**. A JSON mapgen interpreter, plus TypeScript ports of BN's C++ builtins (fields, roads, parking lots) and of `lab.lua`. *[medium adaptation]* (engine) — ARCHITECTURE.md "Bright Nights world"
2. **1 tile = 1 m and 1 chunk = 1 OMT (24×24)**. A storey is 2.6 m tall, and that mismatch is why stairs needed spirals (§7). *[medium adaptation]* — ARCHITECTURE.md; STAIRS.md
3. **The start is always BN's Evac Shelter**, and hostiles within 10 tiles are removed in the first second of a new game. *[new-player design]* — ARCHITECTURE.md "Progression"; `placement.ts`
4. **A refugee center is always placed near the start town.** *[new-player design]* — ARCHITECTURE.md "NPCs"
5. **One modular mutagen lab and one microlab are always placed** in the start region. *[simplification]* — ARCHITECTURE.md "Underground labs"
6. **Transport and mutable specials follow BN in new worlds**. New games get sewers under every town with manholes you pry open, subway tunnels joining stations (also across region edges), BN's mutable lab basement with escape cells and train depots, and BN's solver for anthills, slime pits, the Ice Lab, mines and streams. Lakes have depth: `>` dives and `<` surfaces. Before, the lab basement was simplified and no tunnels or sewers existed. The sunken lab is rare because our lakes are small, and the portal trap does nothing. *[fidelity fix]* — docs/WORLD_TRANSPORT.md
7. **Ground relief, curbs and ditches are visual only**; gameplay stays on the flat grid. *[engine limitation]* — ARCHITECTURE.md "Visual styles"
8. **No scent map**. A survivor very close by is noticed by "sound/smell" proximity instead of BN's scent tracking. *[simplification]* — src/game/monai.ts; ARCHITECTURE.md "Game design conversion rules"
9. **Dormant monsters are stashed per OMT column** beyond 7 OMTs and restored within 6. Clean chunks are evicted and regenerated when you return. *[engine limitation]* — ARCHITECTURE.md
10. **Road atlas**. CDDA's fog hides everything past 15 OMTs; the map now shows the names of towns within 60 OMTs, and faint lines for the roads to them. *[new-player design]* — ADAPTATION.md #53
11. **Walking routes to a map destination**, drawn as a trail of ground marks or a beacon, and preferring roads. A route to a special goes to its entrance. *[new-player design]* — ADAPTATION.md round 4–5
12. **A second map legend spells out** the CDDA letters in view. *[new-player design]* — QA_V2 #12
13. **Roads never pave another special**. The start shelter used to be paved over on some seeds. *[fidelity fix]* — ADAPTATION.md #18
14. **The "fenced warehouse" beside the shelter is BN as designed**: it is the surface of `lab_mutagen_6_level`, kept as is. *[—, kept]* — ADAPTATION.md #69
15. **A world keeps the generation it started with**. Chunks are generated as you reach them, so a save records `world.genVersion`, and older saves keep generating the world they stored chunks of. Only games started after a change get it: genVersion 3 for the transport, lakes, colony spawns and full depth. *[engine limitation]* — WORLD_TRANSPORT.md "Status"
16. **`UNIQUE` specials are unique**. Before the fix, a 3×3 block of regions had about 150 mutagen labs. Now there is at most one per region, with BN's chance scaled by region area (a region is about 0.28 of a BN overmap): 1–2 mutagen labs per 3×3 regions. *[fidelity fix]* — WORLD_TRANSPORT.md "Overmap fixes"

## 6. Vehicles

1. **Each vehicle is one modelled body**, not a grid of 1 m part tiles. There are 11 body styles plus liveries (police, ambulance, school bus…). The old part blocks are the `parts` Vehicle look option. *[medium adaptation]* — docs/VEHICLES.md
2. **Real-world proportions**. A BN car grid is 4×6 tiles, "pancakes" at real scale. The body is drawn at about 5.6 × 2.1 × 1.62 m, with seats keeping their columns. *[medium adaptation]* — VEHICLES.md "Proportions"; design/VEHICLES_V3.md
3. **Collision follows the drawn body**, not whole tiles, for walking, riding, run-overs and doors. You can pass a parked car with 0.3 m of air, or park in a 2.57 m gap that the 4 m grid could never fit. *[medium adaptation]* — VEHICLES.md "Driving collision"
4. **Crashes are tested as an oriented box**, in substeps of at most 0.25 m and bisected to within millimetres of the paint. What blocks is still BN's per-tile rules; what a crash does is in #10. *[medium adaptation]* — VEHICLES.md
5. **Direct throttle**. W is a throttle with a short ramp, releasing it coasts, S brakes and then reverses, and `c` is cruise control. CDDA's 4-mph-step cruise model is the "Driving controls" option. *[medium adaptation]* — ARCHITECTURE.md "Vehicles"; user report "The speed that we accelerate and decelerate feels awful"
6. **"Felt" acceleration** is BN's power and mass compressed toward a car (0–30 mph in about 4 s). Steering lock narrows with speed (lateral acceleration ≤ 5.5 m/s²). *[medium adaptation]* — ARCHITECTURE.md
7. **Chase camera and a cockpit view**. The cockpit has live speed and fuel dials, a steering wheel with your hands at ten-to-two, wipers, a windscreen film and a mirror. BN has a top-down map. *[medium adaptation]* — VEHICLES.md rounds 3–4; user: "maybe switch from fpv to third person when driving?"
8. **`e` beside a door means "Drive / Get in"**, and `e` again when stopped climbs out through the nearest door. Doors swing shut once you drive off. BN uses `^` and examine menus. *[new-player design]* — QA_V2 #16, #18; VEHICLES.md "Playtest fixes"
9. **Run-overs use BN's impulse model**: 0.1 damage per N·s minus torso bash armour, which kills a zombie at 20 mph. Kills are credited to the driver. *[fidelity fix]* — QA_V2 #19; commit `062d7d6`
10. **Crashes push and spin, GTA 3 / Vice City style**. CDDA ran its collision loop until the rammer stopped, so another vehicle was an immovable wall: a tank that clipped an ambulance lost all its speed and killed its driver. Now the two exchange an impulse as rigid boxes, with momentum conserved. A heavy vehicle barely slows, a light one is shoved and spun, a car clipped on the tail spins out, and a car steering into a wall scrapes along it. Damage still comes from CDDA's energy formula (`d_E / 400`, ×1.2), split by each side's own change in speed, and a jolt under a 35 mph change can't take the torso below 1 HP. This is BN's body-impact model for neither. Options → Vehicle crashes keeps the old `immovable` model. *[new-player design]* — VEHICLES.md "Momentum crashes and heavy handling"; GAP_HANDOFF.md
11. **Heavy vehicles handle heavy**. "Heft" from mass, engine power and tracks slows the pedal, acceleration, braking and steering: an Abrams takes 6.4 s to 20 mph, a car 2.8 s. Tracked vehicles are governed (about 45 mph for the Abrams, where CDDA's drag maths gave 150 mph), and the dashboard shows the governed speed. Options → Heavy vehicles `light` restores car tuning for everything. *[medium adaptation]* — VEHICLES.md "Heavy handling"
12. **Filling up at gas pumps** is a timed activity at BN's fill rate (2/3 L per game second). BN's dexterity spill roll is left out. *[simplification]* — VEHICLES.md "Filling up"
13. **Vehicle work is adopt, plan, then a queued timed job**. You adopt a vehicle, then queue install, remove/salvage, repair and strip jobs with BN's per-part skill, tool and component rules. The queue previews the vehicle after earlier jobs, runs as one interruptible activity and survives saving. A new chassis is built from an authored template, only inside a ground-level garage. *[medium adaptation]* — docs/VEHICLE_WORK.md; docs/VEHICLE_CHASSIS.md; design/VEHICLES_V3.md
14. **Wheel sizes are in cm** (a "425 mm" rim is 42.5). The port first read them as larger units and drew 1.4 m tyres. *[fidelity fix]* — STATUS.md "Rules that paid off"; VEHICLES.md
15. **Headlights light the road** about 30–35 m ahead with a spot and four light-map beams. *[medium adaptation]* — QA_V2 #20; ARCHITECTURE.md
16. **Visual-only states**. Parked cars keep their wheels turned, bikes lean on the kickstand, and wrecks show smashed glass on the road, soot, hanging doors and flat-tyre sag. *[medium adaptation]* — VEHICLES.md
17. **Boats, aircraft and trains use the "frame" fallback**. Tanks, road rollers and work machines now have their own models. Semis and trailers link only by the tow cable, as in BN, which has no hitch part. *[not yet implemented]* — VEHICLES.md "Known gaps", "Armoured hulls", "Towing"
18. **Monster pathfinding still sees whole vehicle tiles** (only the drawn body collides with physics). *[engine limitation]* — VEHICLES.md known gaps
19. **Every BN vehicle maps onto a chassis template** (Vehicles v3 phase 1). 21 templates (bicycle, sedan, SUV, box truck, bus, frame, boat frame…) carry typed sockets for BN's parts, and the body a vehicle is drawn with is the one it collides with, is boarded through and crashes with. *[medium adaptation]* — VEHICLES.md "v3 phase 1"; design/VEHICLES_V3.md
20. **The survivor's body is seated on bikes and in cars** outside first person (IK hands and feet, pedalling crank, lean). This fixes the "ghost bicycle (no person)". Nobody sits in passenger seats, because there are no NPC passengers yet. *[medium adaptation]* — VEHICLES.md "Your body in the seat"; commit `dcdccf8`
21. **The vehicle controls menu still uses CDDA letters** (`s` engine) while the in-game key is `k`. *[—, kept]* — UX_REVIEW.md #39
22. **Siphoning is a timed transfer** at BN's 4/6 L per second, into a container or another vehicle within hose reach. BN pours vehicle to vehicle in one 1000-move step; here it keeps the hose rate, and moving interrupts it with the finished part kept. *[medium adaptation]* — docs/SIPHONING.md
23. **Towing is a rope in the physics**. BN's heavy duty tow cable links two vehicles. The cable goes taut at 7 m hook to hook (BN: 8 tiles between the cable parts), the load slows the tower through momentum, and the towed vehicle trails through turns on its tyres. It snaps at 24 m, across z-levels or when a cable part breaks, as in BN, and also on overload (over 120 kN), which BN doesn't have. *[medium adaptation]* — VEHICLES.md "Towing"
24. **Turrets are manned and aimed in real time**. At a gunner station `e` mans the gun and you fire it with free aim; you reload from the rack beside you. Turrets traverse at a set rate (a tank gun 45°/s). BN's controls volley fires every turret at once; here each turret swings onto the crosshair point and fires as it comes on target. Automatic targeting, autoloaders, hand-fired USE_TANKS turrets and recoil pushing the vehicle are not built. *[medium adaptation]* — VEHICLES.md "Turrets"
25. **Inside a vehicle you move between stations**. In BN you walk a vehicle's cells at a quarter of road speed. Here a car seats you at the wheel or a seat. An RV or bus has stations (seats, beds, one spot per aisle cell), and W/A/S/D hop to the next one in 0.2–0.8 s. A tank has crew stations and hatches. Options → Inside vehicles keeps the free walk. *[medium adaptation]* — VEHICLES.md "Inside vehicles"
26. **Run-over bodies fly**. BN's `fling_creature` teleports a creature up to 6 tiles, and a killed one falls where it died. Here the body is launched along your path, tumbles as a rag doll, bounces off walls and comes to rest on a free tile; a survivor lies downed for 1.1 s, then gets up. BN's damage is unchanged. NPCs and the player keep BN's teleport. Options → Run-over bodies (`loose`, `ragdoll`, `fall`). *[medium adaptation]* — VEHICLES.md "Run-over bodies"
27. **Facilities work from the driver's seat**. Faucets anywhere in the vehicle fill containers from there, even while moving; outside you must be parked and within 2 m. Installed kitchen and welding tools serve crafting, beds give BN sleep comfort through the Rest window, and powered fridges slow spoilage. *[new-player design]* — docs/VEHICLE_FACILITIES.md; design/VEHICLES_V3.md Q7

## 7. Stairs and z-levels

1. **You walk up and down stairs**. In Cataclysm, `<` and `>` move you a level. Here you climb the flight with W, the view follows the path, and footsteps sound per tread. *[medium adaptation]* — docs/STAIRS.md; user: "the stairs look janky as hell and seem worth just letting you walk up and down them"
2. **Stair shapes are solved from BN layouts**. A straight flight extends over free floor toward a real 41° pitch; 1-wide pockets become 360° or 450° spirals; ladders get rails and rungs. A link never cuts a floor apart. *[medium adaptation]* — STAIRS.md
3. **Why spirals: a storey is 2.6 m but a tile is 1 m.** Only about 25 % of BN stair tiles have room for a straight flight. *[engine limitation]* — STAIRS.md survey
4. **Your level switches when the eye passes 1.0 m**, so the light map and level-bound systems follow the view. *[medium adaptation]* — STAIRS.md
5. **Climbing speeds**: 0.72× walking on flights, 1.44× running, 0.38× on ladders. Going up costs more stamina. *[medium adaptation]* — STAIRS.md
6. **Monsters follow you up the flight, visibly**. A hostile that saw you in the last 12 s climbs after you, from up to 30 m away and up to 25 s later. Followers take the flight too. Before, monsters only ever fell. *[medium adaptation]* — STAIRS.md
7. **Items dropped on a flight, and bodies killed on one, tumble to its foot.** *[medium adaptation]* — STAIRS.md
8. **Fighting on a flight is limited**. Attacks compare levels, so a zombie below the switch point can't hit you above it. *[engine limitation]* — STAIRS.md known gaps
9. **Not modelled as continuous shafts**: ramps, multi-level ladder shafts, and offset lab stairs (those use the classic 24-tile search teleport). *[not yet implemented]* — STAIRS.md
10. **Monsters on open air fall**. After the user reported "a tough zombie just levitating", non-flyers that step off roofs and upper floors drop, taking about 5–15 damage per level. *[fidelity fix]* — commit `b177ba8`
11. **Three stair variants**: flight (default), compact and classic (teleport). *[—, switch]* — STAIRS.md
12. **Monsters take the stairs on their own toward a noise** on the level above or below, walking the same flights. Routes must be complete through loaded chunks on both levels; there is no route through unloaded levels or several levels at once. *[simplification]* — docs/MONSTER_STAIR_ROUTING.md
13. **The map spans BN's z −10..10**. It was −7..5, so BN's deep labs hit the floor and tower tops at z6–z7 never generated. New worlds (genVersion 3) grow labs to BN depth; tower tops now appear in every world. *[fidelity fix]* — WORLD_TRANSPORT.md "Full z range"

## 8. Survival rules (weather, fire, light, digging, rot…)

1. **Weather follows BN's `requirements` object**. The port read only DDA's condition fields, so every weather type matched and **it was always a snowstorm**. *[fidelity fix]* — ADAPTATION.md #1; commit `8033597`
2. **The climate runs 45 days ahead of the calendar**, so day 1 has mid-spring weather (BN's own default start is day 15 of a 30-day season). The calendar, and so sunset, is unchanged. *[medium adaptation]* — ADAPTATION.md #2; QA_WAVE3 note
3. **Item light comes from BN `light_emission`**. The port read the DDA-era `light` field, which no BN item has, so **every flashlight was dark**. *[fidelity fix]* — ADAPTATION.md #19; `20b08b4`
4. **Battery drain uses `power_draw` in milliwatts**. It was read as watts, so a flashlight "was emptying a full battery in about 10 game seconds". *[fidelity fix]* — commit `ff906f9`; lead, 2026-09-30 01:08
5. **Diggable ground comes from BN `digging_results`**. The port tested DDA's `DIGGABLE` flag, which only 2 BN terrains still have, so "too hard to dig" was everywhere. *[fidelity fix]* — ADAPTATION.md #47
6. **Fires burn their fuel while time is sped up**. The field system simulated 8 turns a frame and decayed the rest in bulk, so campfires went out in about 20 min with every stick unburnt. They now run turn by turn within a budget, with BN's `roll_remainder` and the contained burn rates for fire rings. *[fidelity fix]* — ADAPTATION.md #59; `574bc38`
7. **Fire safety warning**. Lighting a fire away from a fire ring, next to something that burns, or under a roof warns first; a second try lights it. Off = BN. *[new-player design]* — ADAPTATION.md round 6
8. **"Boil water" on a lit fire** runs BN's `water_clean` recipe with the same time and tools. *[new-player design]* — ADAPTATION.md round 6
9. **Unclean water carries no disease in BN**, and the journal now says so. It had said "can make you sick". *[fidelity fix]* — ADAPTATION.md #61
10. **First beds need no skill**. Straw and makeshift beds can be built at Fabrication 0, 1.5× slower; BN needs Fabrication 2–4. Off = BN. *[new-player design]* — ADAPTATION.md round 6
11. **Low morale says it slows learning** (at most once an hour). *[new-player design]* — ADAPTATION.md round 6
12. **The Rest window warns before sleeping very hungry or thirsty.** BN doesn't interrupt for that. *[new-player design]* — ADAPTATION.md #55
13. **Lying down switches your light off**. The phone's flashlight app used to run flat overnight. *[new-player design]* — ADAPTATION.md #23
14. **"You can't sleep" says why** ("you aren't tired yet"). *[new-player design]* — ADAPTATION.md #63
15. **Walking speed uses BN's additive `run_cost`**, not a percentage. A dressed survivor used to walk no faster than a zombie. *[fidelity fix]* — BALANCE.md finding 1; `ee40db1`
16. **Rot**. Chunks near you are updated every 10 game minutes, and map items rot by the hourly outdoor temperature (+3 °C indoors; unpowered fridges don't help). *[medium adaptation]* — ARCHITECTURE.md "Seasons…"
17. **The HUD day/night icon and "Night falls" follow the sun.** They used to use a fixed 06:00–20:00 and 20:30. *[fidelity fix]* — ADAPTATION.md #20–21
18. **The day counter turns over at midnight.** It used to count 24 h from the start. *[fidelity fix]* — ADAPTATION.md #25
19. **Rubble clearing follows BN, with a smaller helper range**. Examining rubble with a digging tool, or activating the tool, clears it in BN's times and drops BN's items, and unfinished progress is saved. Nearby allies speed tool clearing by BN's 10 % each (at most 3), but only within 2 tiles, this port's crafting range, not BN's 6. BN's live `activity_speed` assistant factor is not modelled. *[simplification]* — docs/BN_RUBBLE_CLEARING.md
20. **Frostbite and blisters follow BN on a simpler body**. Mouth, hands and feet track frostbite with BN's risk zones, clothing, wetness and wind, and radiant heat raises blisters. Body temperature is kept on the six main parts only, so hands and feet have no temperature of their own, and BN's clothing damage is left out. *[simplification]* — docs/THERMAL_INJURIES.md
21. **Power armor runs, with parts missing**. The worn exoskeleton activates from the inventory and draws its own charge, then bionic power through a Power Armor Interface CBM, then a carried UPS. Climate control keeps you comfortable. Recon, thermometer and drone flags, radiation and intimidation effects, and NPC activation are not ported. *[not yet implemented]* — docs/BN_POWER_ARMOR.md

## 9. NPCs and missions

1. **Talking pauses time** on Accessible, and an NPC's line types itself out. *[medium adaptation]* — ARCHITECTURE.md "Interaction screens"
2. **Dialogue conditions and effects are a large subset**: 98.7 % of the atoms in reachable topics are handled. Unsupported ones (item ownership, mounts, NPC activities, NPC training and surgery, `lead_to_safety`) warn once and act as false or no-op. The `C` chat menu's shouted orders are not ported. *[simplification]* — ARCHITECTURE.md "NPCs"; IMPLEMENTATION_GAPS.md "Dialogue"
3. **"Track" on a mission sets the map destination**, so the compass, the map line and the route guide lead there. *[new-player design]* — ADAPTATION.md #45
4. **Job difficulty in words** ("Dangerous: expect a real fight. New survivors usually say no…"). *[new-player design]* — ADAPTATION.md #46
5. **Faction standing explained** on the NPC card ("Finished jobs and kind answers earn their trust…"). *[new-player design]* — ADAPTATION.md round 6
6. **NPC needs cover loaded allies**. Allies eat and drink what they carry, ranked by BN's rules, and rest at a better spot within 6 tiles when tired and allowed. Non-allies get BN's own shortcut (stored hunger and fatigue reset). Nothing happens offscreen. BN has no NPC calendar schedules either, so the old "schedules" gap was wrong. *[simplification]* — docs/BN_NPC_NEEDS.md
7. **NPC and monster rounds are visible projectiles**, and the survivor's rounds, pellets and arrows hit NPCs in the line of fire on the drawn model. As in BN, only the NPC you aimed at turns hostile. A stray hit is decided by geometry, not BN's `missed_by` re-roll. *[medium adaptation]* — COMBAT_FEEL.md round 3, "NPCs in the line of fire"
8. **Follower rules drive the NPC AI, except two**. NPCs never fetch items (`allow_pick_up`) and have no bionics, so those rules are stored only and warn once. NPCs don't throw hand grenades. *[not yet implemented]* — IMPLEMENTATION_GAPS.md "NPC simulation"; ARCHITECTURE.md "NPCs"
9. **Monsters fight each other** by BN faction attitudes: pets fight hostile wild monsters, and hated factions fight on sight. Plain melee uses BN's hit rolls, dodge and armour. Special attacks still target only the survivor. *[simplification]* — docs/MONSTER_FACTION_COMBAT.md
10. **Monster blows against NPCs and other monsters are telegraphed too**, and a victim that steps out of reach during the wind-up escapes the hit. *[medium adaptation]* — docs/MONSTER_FACTION_COMBAT.md
11. **You can run NPCs over**, with BN impact damage, stuns and knock-downs. *[—, faithful]* — ARCHITECTURE.md
12. **Trade is one all-or-nothing transaction**, property-tested. The test found a real bug where a stale stack threw an error mid-deal. *[fidelity fix]* (engineering) — lead relay of the screens agent's report, 2026-09-29

## 10. Progression and onboarding

1. **No character creator up front**. **Start** is a quick start as a named Evacuee with BN's `unemployed` kit. *[new-player design]* — DESIGN_V2 decision 6
2. **Achievements unlock starts, scenarios, professions and the custom creator**. They persist across deaths as sidegrades only; nothing makes a run stronger. BN makes everything available up front. *[new-player design]* — DESIGN_V2; user answer 2026-09-29
3. **A "Classic" toggle unlocks everything** for veterans without recording it. *[—, switch]* — ARCHITECTURE.md "Progression"
4. **Discovery nudges and a survival journal**: "You could craft…", first-time explanations, rate-limited (at least 20 s apart, never mid-fight). *[new-player design]* — ARCHITECTURE.md
5. **Only five scenarios can be placed**: evacuee shelter, "missed" town house, wilderness forest, and BN's two lab challenges, which start in a lab's escape cells (BN allows several lab start locations). The catalogue refuses others. *[simplification]* — src/progression/placement.ts; WORLD_TRANSPORT.md
6. **The hints popup at start is off by default**; discovery tips replace it. *[new-player design]* — ARCHITECTURE.md
7. **Permadeath is off on Accessible**. You keep the last save, and the memorial still counts the death. *[new-player design]* — BALANCE.md
8. **First-fight hints** by the crosshair (see §3). *[new-player design]* — COMBAT_FEEL.md
9. **Tips about features this port lacks were removed** (safe mode rules, helicopters, going prone). *[new-player design]* — ADAPTATION.md
10. **"Nothing to eat" tip** when you're very hungry and carry no food: look in kitchens, stores and crates. *[new-player design]* — ADAPTATION.md #66
11. **Reading has an optional quiz**. In BN you choose "read" and wait. Here a card by the crosshair asks a question generated from the game's data ("Which magazine fits the Glock 19?"). A right answer skips 2.5 s of reading and adds practice; a wrong one shows why, with no penalty. A good player levels from a book about twice as fast. A Skim variant and Off are options, and a book you've outgrown offers "Skim it?". *[new-player design]* — ADAPTATION.md "Reading: field notes"
12. **Optional activity toys**. While crafting, a card shows the recipe's parts; placing one by hand saves 4 % of that batch's work, at most 20 %. Construction offers a hammer beat and disassembly a take-apart board on the same terms. Ignoring them costs nothing, and each can be turned off. *[new-player design]* — docs/CRAFT_ASSEMBLY.md; docs/ACTIVITY_TOYS.md
13. **Skill practice is shown**. A cue by the needs says what trained which skill, or that a task was too simple to train anything; menus preview what an action trains; the character sheet says how to reach the next level. The rules stay BN's, so a difficulty-0 toaster teardown still teaches nothing unless "Practice from simple tasks" is switched on (off = BN). *[new-player design]* — ADAPTATION.md "Seeing skill practice"

## 11. Balance and difficulty

1. **Difficulty presets**: Accessible (default), Classic ("BN numbers adapted only where real time breaks them") and Custom. *[new-player design]* — BALANCE.md; DESIGN_V2 decision 3
2. **Zombies in buildings**: 45 % on Accessible, 75 % on Classic (real time leaves no pause to think between blows). *[medium adaptation]* — BALANCE.md
3. **City hordes**: 10 % on Accessible, 20 % on Classic, of BN's 80 per city size. *[medium adaptation]* — BALANCE.md
4. **Safe radius** of 32 m on Accessible, which also covers animal packs (a mutant coyote pack killed the Evacuee in about 25 s on seed 1). Classic is 10 m. *[new-player design]* — BALANCE.md finding 2
5. **Monster speed 90 %, toughness 70 %** on Accessible. *[new-player design]* — BALANCE.md
6. **Damage taken 70 %, bleeding 50 %, crash damage 50 %** on Accessible. *[new-player design]* — BALANCE.md
7. **Hunger and thirst 75 %, healing 200 %, cold 70 %** on Accessible. Tiredness stays at 100 % so bedtime lands around midnight. *[new-player design]* — BALANCE.md
8. **Accessible spaces grabs further apart** (cooldown ×1.6). *[new-player design]* — BALANCE.md
9. **Grab, bite and scratch cooldowns run on the melee clock** in both presets. They were converted at the movement rate, so zombies grabbed about 1.5× as often per swing as in BN. *[fidelity fix]* — BALANCE.md; `eb9725b`
10. **Classic free aim is tuned to match BN's dice kill times** (sway ×2.0 and skill-0 damage ×0.65, against Accessible's 1.6 and 0.75). *[medium adaptation]* — BALANCE.md "Aim models"
11. **BN's zombie density** (SPAWN_DENSITY 0.5×/1×/2×) stays a separate world option. *[—, kept]* — BALANCE.md
12. **Measured, not guessed**. A headless newcomer bot died on day 1 in 12/20 seeds on Classic against 3/20 on Accessible; the difference was tuned on *how many* zombies you meet, not how hard they hit. *[—, method]* — BALANCE.md day-1 table
13. **Sleeping on the shelter floor in Classic can kill you** (BN's cold effect on a very cold head). Accessible's 70 % cold avoids it. *[—, faithful vs adapted]* — BALANCE.md "First night"
14. **Colony monsters at a quarter**. BN's colony populations (about 100 ants around an anthill, about 100 fungi in a fungal town) are a lot in real time. New worlds spawn a quarter of them by default; Options → Colony monsters offers BN (full), reduced or off, saved per world. *[medium adaptation]* — WORLD_TRANSPORT.md "Special spawns"

## 12. Content gaps / not yet implemented

1. **Vehicles**: automatic turret targeting and autoloaders, NPC passengers, crews and autopilot, walkable parked rigs (the `rig` template exists but nothing builds it), custom chassis sizes, the 3D driving-stat planner, power networks and grid charging, and BN's `break_off` of broken parts. *[not yet implemented]* — IMPLEMENTATION_GAPS.md; VEHICLES.md "Known gaps"
2. **World**: the portal trap from BN's `mx_portal` does nothing, and the `mx_portal_in` extra is not ported. The sunken lab is rare, because our lakes are small. Worlds started before genVersion 2 have no tunnels or sewers. *[not yet implemented]* — docs/WORLD_TRANSPORT.md
3. **Bionic guns**: EMP, chain lightning and trail fields, NPCs firing bionic guns, and a bionic-gun viewmodel. *[not yet implemented]* — docs/BN_BIONIC_GUNS.md
4. **NPC needs**: needs offscreen, full nutrient and food-instance fidelity, and recruitment. *[not yet implemented]* — IMPLEMENTATION_GAPS.md "NPC simulation"
5. **Monsters**: special attacks against NPCs and other monsters, and routes through unloaded levels or across several levels. *[not yet implemented]* — MONSTER_FACTION_COMBAT.md; MONSTER_STAIR_ROUTING.md
6. **Art coverage**: 72 monsters without UltiCa art get stand-in sprites, and item coverage is 63 % with `looks_like` (historical measurements, not rescanned). *[engine limitation]* — QA_V2 #25; STATUS.md "Tech"; IMPLEMENTATION_GAPS.md
7. **Blasts and enemy fire**: blasts don't smash or fling items or set off traps, NPCs don't throw hand grenades, and monster guns only target the survivor. *[not yet implemented]* — IMPLEMENTATION_GAPS.md "Archery/projectiles"
8. **Scent tracking** (see §5). *[simplification]*
9. **Platforms**: browser with keyboard and mouse only (no gamepad, touch or desktop wrapper, by the user's choice). **VR (WebXR, Quest) is unmerged** **(branch `vr`)**: 35 commits of its own, last rebased onto `bn` on 2026-10-18. It has stick and teleport locomotion, 3D hands with swing melee, bow and reload gestures, controller driving and menus on world panels. It has been tested only in an emulated Quest 3; frame rate, comfort and controller feel need a real headset. *[not yet implemented]* — DESIGN_V2 decision 4; `git log bn..vr`; docs/VR.md on branch `vr`
10. **Unknown item and monster group ids** in BN data (camera_pro, laser_rifle, GROUP_ZOMBIE_HORDE…) warn at start. *[not yet implemented]* — QA_WAVE3 #11
11. **Character presentation**: the third-person survivor keeps generic shapes, food has no bespoke portion models, and some species still share a body plan. *[not yet implemented]* — IMPLEMENTATION_GAPS.md "Art/model coverage"
12. **Talk conditions/effects outside the supported subset** (see §9). *[simplification]* — ARCHITECTURE.md; IMPLEMENTATION_GAPS.md "Dialogue"
13. **Power armor extras**: recon, thermometer and drone flags, radiation and intimidation effects, NPC activation and sided mods. *[not yet implemented]* — docs/BN_POWER_ARMOR.md
14. **Other approximations**: BN bash loudness is in dB while the hearing model keeps tile-volume units, and the player can't smash vehicle parts. *[simplification]* — IMPLEMENTATION_GAPS.md "Other approximations"

## 13. Data-fidelity bugs fixed (the port got it wrong first)

These are the cases where the port first misread Cataclysm and later matched it. The project's
rule "Units come from BN's C++, not guesses" (STATUS.md) came out of them.

1. **Always a snowstorm**. BN's weather thresholds live in `requirements`, and the port only read DDA's `condition`. — ADAPTATION.md #1
2. **Every flashlight dark**: `light` read instead of `light_emission`. — ADAPTATION.md #19
3. **Batteries drained 1000× too fast**: `power_draw` is mW, not W. — `ff906f9`
4. **1.4 m tyres**: wheel diameter is in cm. — STATUS.md
5. **"Too hard to dig" everywhere**: the `DIGGABLE` flag was used instead of `digging_results`. — ADAPTATION.md #47
6. **Campfires died with the wood unburnt** during time warps: bulk field decay ignored the fuel. — ADAPTATION.md #59
7. **Broken windows drawn as floor decals** (BN drops their WINDOW flag). — FURNITURE.md
8. **Locked doors and stained glass drawn as plain walls** (no DOOR flag; WALL flag). — FURNITURE.md "Surfaces"
9. **Car doors drawn as coloured blocks**: BN flags them `OPENABLE`, not `DOOR`. — VEHICLES.md intro
10. **Zombies grabbed 1.5× too often**: grab cooldowns were on the movement clock. — BALANCE.md
11. **Survivor no faster than a zombie**: encumbrance was applied as a percentage instead of BN's additive `run_cost`. — BALANCE.md
12. **Run-overs barely hurt**: DDA's energy loop gave about 10 damage at 20 mph, against BN's impulse model. — QA_V2 #19
13. **A light turret "clicked empty"**: monster guns didn't use the monster's own starting ammo. — COMBAT_FEEL.md round 3; `82f032c`
14. **Dandelions were 1 m yellow crates**: UltiCa has only `_season_` tiles for them, and the lookup ignored the season. — QA_WAVE3 #2; `403cef9`
15. **The start shelter was paved over** by another special's road. — ADAPTATION.md #18
16. **Monsters levitated off roofs**: nothing made non-flyers fall. — `b177ba8`
17. **Bows had a muzzle flash and gun sounds**: every gun-shaped item went through the firearm path. — COMBAT_FEEL.md "Archery"
18. **Unclean water "can make you sick"** is wrong for BN. — ADAPTATION.md #61
19. **The HUD's day was 06:00–20:00** regardless of season; it now follows the sun. — ADAPTATION.md #20
20. **Inheritance rules**. BN inherits `open`, `close`, `roof` and `transforms_into` where DDA resets them. `proportional` is a double product truncated to integer units, and an item's modifier wins over an explicit value. — BN_DATA_MODEL.md §1
21. **All comestibles count by charges** in BN, solid food too; DDA counted only non-solids. — BN_DATA_MODEL.md §3
22. **Legacy integer units** (volumes in 250 ml steps, `spoils_in` in hours, book time in minutes, recipe time in moves…) are converted from BN's C++ readers. — BN_DATA_MODEL.md §2
23. **Arrows flew about 0.2 m high**: they were launched from the simulation's flat 1.6 m eye, not the drawn eye riding the ground relief. *[engine]* — COMBAT_FEEL.md round 3
24. **v1 duplicated items when you unloaded a bag**. The UI didn't check that an item was where the list said, and a wielded bag was listed twice. It was fixed with one move API and property-tested conservation. *[engineering]* — docs/INVENTORY_MODEL.md "Why v1 duplicated items"
25. **About 150 mutagen labs per 3×3 regions**: `UNIQUE` specials were placed like any other. — WORLD_TRANSPORT.md "Overmap fixes"
26. **The map stopped at z −7..5**, short of BN's −10..10: deep labs hit the floor and tower tops never generated. — WORLD_TRANSPORT.md "Full z range"
27. **Curtains were unreachable and "Pry open" never appeared**: `e` ran only the first of BN's open/close steps, and prying read DDA's `prying`, which no BN terrain has. — FURNITURE.md "Curtains"
28. **Explosions were an approximation** (a disc of radius cbrt(power); land mines a flat 20–40 bash; exploding monsters a ring of fire). Now BN's `explosion.cpp`. — COMBAT_FEEL.md "Blasts"
29. **Flamethrowers used one round per shot**: every gun did, because BN's `ammo_required` (`ammo_to_fire` 20, 50 or 100 for flamers) was not read. — BN_BIONIC_GUNS.md "ammo_required audit"
30. **A sleeping survivor took six blows before waking**: BN's `on_hurt` interrupt and wake were missing. — BALANCE.md "Fast-forward"
31. **Monsters heard noises on other levels at the wrong level**: the source's level was passed as the listener's, with an arbitrary one-third volume. — MONSTER_STAIR_ROUTING.md
32. **Stray rounds angered any NPC they hit**. BN turns only the aimed-at NPC hostile. — GAP_IMPLEMENTATION_WORK.md "NPCs in the line of fire"; GAP_HANDOFF.md decision 2

## 14. History: v1 (DDA) → v2 (BN)

1. **v1 targeted Dark Days Ahead**, kept CDDA's "curses-style UI wherever sensible" (black panels, a monospace font, the 16 CDDA colours, `[x]` letter menus), and resolved ranged fire as a hitscan cone. *[—]* — ARCHITECTURE.md "Goals", "Game design conversion rules" (historical); tag `v1-dda`
2. **v2 switched to Bright Nights at the user's request** ("track CDDA:BN and aggressively overhaul balance & UX"). BN became the design authority, and DDA-only systems (pockets, proficiencies, vitamin-driven mutagen, e-files, recipe variants) were dropped. *[fidelity to BN]* — DESIGN_V2.md decision 1; BN_DATA_MODEL.md §8
3. **Pockets → one storage pool**. In BN, worn `storage` adds to one carrying volume and a backpack "is not a box you open". *[fidelity to BN]* — BN_DATA_MODEL.md §4; INVENTORY_MODEL.md
4. **Mutations use BN's mutagen actors and thresholds**, not DDA vitamins. *[fidelity to BN]* — BN_DATA_MODEL.md §8
5. **The atlas uses BN's compiled UltiCa**, with an optional fill from the DDA source tileset. *[—]* — ARCHITECTURE.md "Source material"
6. **The v1 → v2 driving and input complaints** (Shift+W opened the wear menu, Esc killed mouse-look, no third-person driving, awful acceleration, "running him over doesn't seem to work") drove the "real input only" QA rule. *[—]* — DESIGN_V2 "Quality bar"; user messages 2026-09-29
