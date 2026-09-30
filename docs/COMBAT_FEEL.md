# Combat feel: diagnosis and the feel layer

The playtester's report was "combat feels off". This is what was wrong, what changed, and how
to check it. The CDDA/BN resolution layer (to-hit, damage, armor, block and dodge math in
`combat.ts` / `techniques.ts`) is unchanged underneath. The feel layer decides **when** a
blow resolves, **what** it hits, how it is **telegraphed**, and how the active defences
(guard, side-step) feed into BN's `block_hit` / `dodge_roll`.

Every tunable is in one object: `FEEL` in `src/game/combatfeel.ts`, with presets
`FEEL_PRESETS.accessible` (the default) and `.classic`. The balance pass sets them with
`setFeelDifficulty(d, overrides?)`. At runtime: `cdda.feel` (live object), `cdda.setFeel('classic')`,
`cdda.feelState()`, `cdda.recordFrames(n, dt, each)`.

## Diagnosis (before)

Evidence: real input (xdotool clicks and holds in a headful Chromium, `tools/drive.ts --headful`)
plus screenshot bursts (`docs/screenshots/combat_feel/before_*.png`, about 80 ms apart).

| # | What was off | Why (code) |
|---|---|---|
| 1 | **The hit landed before the swing.** On frame 0 of `before_hit_sheet.png` the zombie is already flashing red while the bat is still at rest. The swing animation plays afterwards, so it looks like a separate event. | `PlayerCombat.melee()` resolved `meleeAttack` on the click. The viewmodel's fixed 0.42 s swing only started at that moment. |
| 2 | **No wind-up and no weight.** A sledgehammer and a fist used the same animation. There was no anticipation, no freeze on contact, and no follow-through tied to the blow. | One canned `ANIMS.melee` curve for every weapon. There was no hit-stop. |
| 3 | **Target picking used a cone.** A 32° cone from the body, fixed at the click, meant you could hit things the swing never visually reached. You also missed anything that stepped in a frame later. | `MELEE_CONE` used the same width for every weapon, and the check ran once. |
| 4 | **Zombie attacks weren't telegraphed.** In `before_swing_sheet.png` the zombie walks in and "grabs your right leg" on the same frame with no tell. You can't react to that. | `monai.act()` called `defaultMelee` / `trySpecial` the moment the cooldown hit 0 and the target was in range. |
| 5 | **Defence was passive dice.** Blocking was a hidden melee×20 % roll and dodging was automatic. The player had nothing to *do* against an incoming blow. | `blockHit` / `tryDodgeRoll` only. |
| 6 | **Grabs read badly.** Only a log line told you that you were grabbed, and walking into the grab was the only way out. | `updateGrab` rolled only on movement attempts. |
| 7 | **Sprites barely reacted.** A whole-sprite red flash, and a positional kick only on "heavy" (≥30 % HP) hits. Downed monsters were drawn at half height instead of lying down. Death was a 0.35 s squash with no sound. | `hitFx` kicked only when `heavy`. `monsterView` used `height*0.5` for downed. |
| 8 | **The cooldown was invisible.** Holding LMB just repeated. You couldn't tell when the next swing would come or whether the target was in reach. | No HUD for it. |
| 9 | **Monsters jittered at melee range and stacked.** They stopped at the exact edge of reach, so any small step restarted and stopped them. A crowd queued in single file and shoved each other. | `inMeleeRange` was the stop test with no hysteresis. Everyone steered for the player's own position. |
| 10 | **Guns lacked punch.** The recoil kick was the same for every gun and the camera never moved. There were no tracers, only a `*` at the end point. There were no bullet marks and no ADS zoom, and reloading was instant and invisible. | `viewmodel.attack('fire')` played one fixed curve. |

## What changed

### Survivor melee (`playercombat.ts`, `combatfeel.ts swingTiming/sweptArcTarget`, `viewmodel.ts swing`)
- A swing has phases: **wind-up**, then **strike** to **contact**, then a short **active window**, then **recovery**.
  Together the phases add up to CDDA's `attack_speed` time, so the swing *rate* is BN's.
  Wind-up grows with weapon weight (0.08 s for fists, about 0.14 s for a bat, up to 0.34 s for heavy weapons), capped at 45 % of the swing.
- The blow resolves **at contact**, against what the weapon's **swept arc** finds around the
  crosshair *then*. An exact camera-ray hit wins. Otherwise the target closest to the crosshair
  in angle wins, with the target's angular size counted. The arc is ±40° for swings, ±22° for
  thrusts (spears, stabbing), and ±28° for punches. It is never checked through walls. A target
  stepping into the arc during the 80 ms active window still gets hit.
- The viewmodel animates the same phases: anticipation (weapon cocked over the shoulder), a
  fast strike to the **contact pose exactly at resolution**, follow-through, then recovery. It starts
  from the current pose, so chained swings and guard-to-swing don't pop.
- **Hit-stop**: 45 to 85 ms, scaled by the blow's share of max HP (longest on a kill). It freezes the swing
  clock, the hands (snapped to contact) and the struck sprite.
- Audio: the swing sound plays on contact, and the impact sound on the same frame. A miss or whiff adds a clear
  synthesized **whoosh** (`synth_whoosh`).
- Holding LMB repeats at the weapon's rate. `melee()` without phases (scripts, tests, NPC code)
  still resolves instantly.

### Monster telegraphs (`monai.ts startWindup/tickWindup`, `monattack.ts specialTelegraph`, `monsterView.ts`)
- Every melee blow aimed at the survivor winds up first. That covers plain swings, grab, bite, scratch, hulk
  smash and leap. The wind-up is **0.4 to 0.8 s in Accessible** and 0.25 to 0.6 s in Classic, longer for slow monsters.
  Heavy blows (large and huge monsters, throws) take ×1.5 and leaps use a 0.45 s crouch.
- During the tell the monster is rooted and turns to track you. Its sprite **rears back and draws up**. It
  **flashes warm** when the tell starts and **white-hot at 72 %** ("now!"). A rising snarl plays
  (`synth_windup`). Then it **lunges** forward.
- At resolution, the CDDA attack runs only if you're still within reach + 0.35 m (the lunge).
  Stepping back, side-stepping out, or putting a wall in the way makes it **whiff**, with a whoosh and no log spam.
- A blow off-screen shows a **pulsing yellow wedge** on the HUD ring pointing at the attacker.
- Accessible stretches a monster's swing cycle to at least tell + 0.35 s recovery. A plain zombie drops from about
  1.4 to about 1.05 attacks/s. **Classic keeps CDDA's swing rate exactly** (tested).
- Guns keep their existing CDDA targeting warm-up. Shrieks, spit and bile fire as before.

### Active defence (`combatfeel.ts`, `techniques.ts blockHit`, `combat.ts tryDodgeRoll`)
- **Guard: hold RMB with a melee weapon or bare hands.** You raise the weapon or fists and walk at
  ×0.55. It drains 60 stamina/s. It maps onto BN's `block_hit`:
  - The block attempt always happens. That's BN's rule. DDA's melee×20 % reaction roll only applies
    unguarded. Blocks don't run out while you guard, but each still costs stamina, and below
    2000 stamina nothing blocks.
  - The block score gets **+8** (Classic +4). Bare-handed guards block with the arms.
  - **Parry**: the guard was raised within 0.35 s of the blow landing (Classic 0.18 s). That gives another **+10** score.
    The attacker is **stunned 0.8 s**, a parried grab never takes hold, and a clack plays (`synth_parry`).
    Timing the guard to the tell is the skill.
- **Side-step: Space** (in the held movement direction, default back), or **double-tap A, D or S**.
  It moves 1.3 m in 0.18 s, costs 300 stamina and has a 0.6 s cooldown. Blows landing within the next 0.3 s roll
  CDDA's dodge with **+6 dodge** and use no dodge from the turn. Often the step simply takes you out of the lunge's reach.
- **Grabs**: a *GRABBED by the zombie, mash [e] to break free* banner with a struggle bar, and the
  prompt under the crosshair. Each press of the interact key rolls CDDA's break-free check,
  at most once per turn. Each failure adds +3 to the next roll (Classic +1). Walking away still rolls, as in CDDA.
- **Grab pacing and escape (QA_V2's first fight)**: melee specials (grab, bite, scratch) cool down on the
  melee clock, like the swings they share a budget with. Accessible also stretches grab cooldowns ×1.6
  (`FEEL.grabCooldownMul`). A staggering blow (≥ `staggerShare` of its HP, or a crit) makes the grabber
  let go: "The zombie loses its grip on you!" (`FEEL.staggerBreaksGrab`, off in Classic).
- **Why a blow missed**: the `playerAttack` event carries a `reason`, and the crosshair shows it for a
  second: *miss: dodged* (the target's dodge made the difference), *miss: clumsy swing* / *wild swing* /
  *off balance* (your hit roll or the weapon's stumble), *too small to hit*, *out of reach* (a whiff with
  a monster in the arc just past the weapon's reach) and *no damage* (armor took it all). The rule is
  `missReason()` in combatfeel.ts.

### Hit reactions (`monai.ts react`, `monsterView.ts`, `hitFx.ts`)
- Every damaging player hit makes the monster **flinch**. The flinch lasts up to 0.35 s, scaled by damage/max HP. The monster pauses and
  its tell slips. A hit taking **≥20 % max HP or a crit interrupts the wind-up**. There's also a small real
  **shove** of up to 0.35 tiles, and the sprite kicks back, squashes and shivers in proportion to the damage.
- Downed monsters **lie flat** (short and wide, easing down and back up).
- **Death has weight**: the body staggers along the killing blow, topples with an easing that speeds up,
  bounces, and lands with a thud (`synth_bodyfall`) in a burst of dust and blood. Kills spray more.
- Getting hit: a red **directional wedge** points at the attacker. The existing shake and red vignette
  still scale with damage. The hands are knocked toward the side the blow came from.

### Spacing (`monai.ts assignSlots`, `act` hold logic)
- Chasers stop 0.2 m **inside** their reach and don't move again until you're clearly out of it.
  That hysteresis removed the step-stop jitter.
- Within 3.5 m, chasers are spread into **slots around you** (`surroundAngles`, so bodies plus a hand's
  width fit). Four zombies from one side end up around you instead of in a queue (tested).
  Separation still keeps bodies apart, and `NEAR_CLAMP` still keeps point-blank sprites readable.

### Ranged (`playercombat.ts fireOne`, `viewmodel.recoil/reload`, `camera.ts kick/ads`, `hitFx.ts tracer/mark`)
- The viewmodel kick and a **camera kick** (pitch plus a little random yaw, springing back) scale with the
  round's CDDA recoil. The muzzle flash (firearms and launchers only, see Archery below) is drawn on the exact frame the round fires (`rec_gun_sheet.png` frame 6).
- **Tracers**: a dotted line of bright pixels from the muzzle to the impact, shown for one or two frames. This covers monster guns too.
  Rounds that hit a wall leave a dark **bullet mark** for 30 s (60 max) plus dust.
- **ADS: RMB with a gun** zooms 70° to 50°, brings the gun toward the centre and steadies bob and sway. The CDDA
  aim-level readout (Immediate, Regular, Careful, Precise) under the crosshair is unchanged.
- **Reload takes and shows time**: the gun dips out of view for the reload (0.7 to 2.5 s from CDDA's
  reload cost) and can't fire until it's back.

### Archery and every ranged miss (`rangedfeel.ts`, `playercombat.ts draw/flights`, `bowArt.ts`, `arrowFx.ts`)

The playtester's report: *"it's super hard to tell why I am missing with my long bow, also it sounds
like a gun and has the muzzle flash lol"*. Every gun-shaped item went through the firearm path: a
pistol kick, a muzzle flash and its light, a hitscan tracer, a bullet crack where it landed, and a
miss said nothing at all.

- **Weapon classes** from BN data (`rangedClass`): firearm, bow (BOWS / arrow ammo), crossbow
  (CROSSBOW / *_XBOWS / bolts, spearguns), sling (SLINGS / SLINGSHOTS / skill throw / pebbles and
  rocks), launcher, energy, air, thrown. **Only powder flashes** (`hasMuzzleFlash`: firearm and
  launcher); a crossbow or air rifle kicks without a flash, a bow barely moves (`kickScale`).
- **Bows are drawn**: RMB draws (BN's draw time: `item_reload_cost`, slower for a weak archer, at
  least 0.45 s), and aim only builds at full draw. Holding costs stamina; past 4 s (Classic 2.5 s) the arms
  shake and the aim drifts back. LMB looses, at once if drawn, else as soon as the draw completes, so a
  bare click is a snap shot. Letting go of RMB lets the string down. RELOAD_AND_SHOOT nocks an arrow from
  what you carry. The viewmodel is a procedural longbow (`bowArt.ts`): canted low at rest, it rises
  with the draw until the arrowhead sits under the crosshair, and the string snaps on release. A
  slingshot uses the same model with its fork. Slings whirl overhead on LMB. Crossbows have a trigger (LMB),
  aim with RMB and crank on reload.
- **BN strength rules** (`get_str_draw_penalty` and its bands). Under the bow's min_strength, damage and
  range drop to 0.75x. Under 3/4 of it they drop to 0.5x and the spread doubles. Under half you can't draw
  at all. Archery 4/8/10 lowers the requirement by 1/2/3. Item info shows the line ("Strength 10 to draw:
  damage and range 0.75x (you have 8)"). Wielding a bow you can't draw properly warns at once.
- **Visible arrows**: arrows, bolts and stones fly at 22–77 m/s (a 20 m shot takes about 0.44 s, measured
  in real input). They follow a gravity arc that meets the crosshair at the aimed distance and falls
  beyond it. They resolve against what they actually reach: a monster's circle (BN
  `deal_projectile_attack` at the arrow's own speed, so dodging matters more than against bullets), a
  wall, or the ground. Nothing is hit past BN's range. The BN dispersion roll still decides the direction,
  so hit odds are BN's. A fading trail of dots shows where the arrow went (`arrowFx.ts`).
- **Recovery (BN `drop_or_embed_projectile`)**: a round survives unless `one_in(dont_recover_one_in)`
  (wooden arrows 1 in 25, bolts 1 in 35). A survivor leaves the bow as an object (`moves.takeRound`, not
  destroyed). It sticks in a big enough monster when the cutting part of the blow beats bash + bulk
  (`Monster.stuck`; it's drawn stuck in the body, saved with the monster, and falls when it dies).
  Otherwise it drops where it landed, drawn stuck in the ground or wall until picked up (quick loot `r`).
  A broken one says "Your wooden broadhead arrow breaks." Conservation is tested (unit and real input).
- **Why it missed, for every ranged weapon** (`rangedMissReason`). The target is whatever the crosshair
  was on at the shot. When the round misses it, the crosshair says why for ~2 s, in this order:
  *blocked by cover*, *fell short: out of range (22 m)*, *low: hit the ground short of it*, *high: flew
  over it*, *dodged*, then for a shot that went wide the biggest fixable cause:
  *wide: too weak to draw fully (Str 10)*, *wide: unsteady aim — hold RMB to draw and aim* (recoil left
  to aim away is the biggest term), *wide: past your effective range (~6 m, archery 0)*, *wide: archery
  skill too low (0)*, *inaccurate weapon*, *low dexterity*, *hands encumbered*, and *wide: unlucky shot*
  when the spread was small. Hits can say *grazed* or *no damage*. Refusals use the same line: *too weak
  to draw this bow (Str 10 needed)*, *no arrows*. Guns (hitscan) use the same reasons.
- **Spread you can see**: a dashed circle around the crosshair is the typical error of the next shot
  (half BN's dispersion maximum, projected with the camera's FOV). It shrinks as you aim and is **green /
  yellow / red** as it fits within / roughly matches / exceeds the body under the crosshair. The readout
  under it adds *Drawing…*, *arms shaking*, the distance and *likely hit ≤ N m* (the distance at which
  your typical error equals a body's radius), or *out of range (N m)*.
- **Sounds**: a bow layers the pack's `fire_gun/<bow>` recording (quieter) over a synthesized bowstring
  twang. Drawing creaks, a crossbow clicks and thonks and its crank ratchets, a sling whirls. Arrows land
  with a thock (flesh), a thunk and quiver (walls), or a thud (ground) instead of the bullet crack. Monster
  crossbows fly visibly too.

Evidence (real input, `tools/realinput_archery.ts`, GPU): `docs/screenshots/archery/`: `rest.png`,
`drawn_8m.png` (full draw, "Careful 8 m · likely hit ≤ 6 m", yellow circle), `why_8m.png`,
`drawn_20m.png`, `why_snap.png` ("wide: unsteady aim — hold RMB to draw and aim"), `too_weak.png`,
`landed.png` (hits, "sticks in the zombie!"). `flight_sheet.png` is frame-exact (`recordFrames`, 1/30 s):
the draw, the release, the arrow and its trail, the hit flash, and the arrow stuck in the zombie.

### Crosshair HUD (`src/ui/combatHud.ts`)
- **Reach brackets**: red corner ticks appear when a swing right now would connect.
- **Swing ring**: a thin arc fills over the swing and recovery. It's warm before contact and white after, and blinks once when you can swing again.
- **Guard arc** under the crosshair, **yellow during the parry window**.
- Threat wedges (red for hurt, yellow for an off-screen tell) and the grab banner.

## After: frame sequences

The frame-exact ones come from `cdda.recordFrames(n, 1/30, …)`. They run the simulation and the
render in lockstep, so the frames are exactly 33 ms apart. These captures don't include the DOM HUD. The `rt_*` and `gun_sheet` images are
real-input screenshots, and those do include the HUD.

- `rec_swing3_sheet.png`: bat, one swing. Frames 0–4 anticipation, frame 5 **contact pose and hit flash on the same frame**, frames 5–7 held by hit-stop, then follow-through. Compare `before_hit_sheet.png`, where the flash comes *before* the bat moves.
- `rec_tele_sheet.png`: a zombie's tell. It rears back and grows over about 0.4 s, flashes white-hot (frames 10–12), then lunges (frames 15–17) and the blow lands.
- `rec_kill_sheet.png`: a killing blow. Contact and flash, hit-stop, then the body staggers, topples and lies down, with blood.
- `rec_gun_sheet.png`: pistol while aiming down sights. The muzzle flash and kick land on the shot frame, the muzzle light shows on the wall, and the camera kicks up and settles.
- `rt_sheet.png` (real input): holding RMB raises the guard (bat across the body, yellow parry arc), then LMB. The swing ring and reach brackets show around the crosshair.
- `grab.png` (real input): the grab banner and prompt. Mashing `e` through xdotool broke free.
- `gun_sheet.png` (real input): hip-fire, ADS zoom, the shot, and a Space side-step.

## Tests

`tests/combatfeel.test.ts` (19 tests):
- phase timing: the phases add up to CDDA's time, heavier weapons wind up longer, and a phased swing resolves on the first tick at or after contact (not on the click) and then finishes its recovery.
- swept-arc selection: the ray hit wins, then the smallest angle, and reach, arc width and walls are respected. A thrust misses what a swing catches.
- telegraph → resolve ordering: nothing lands during the tell, and backing off makes it whiff. A hard hit interrupts it.
- guard → block mapping: the attempt chance is 1 when guarding, and damage let through is `logarithmic_range(0,40, str+WBLOCK+melee+guard[+parry])`. Guarding blocks every blow, a huge attacker still can't be blocked, bare hands block with the arms, a parried grab never takes hold and stuns, and struggling frees you.
- side-step: the dodge roll gets the bonus without spending the turn's dodge, and Space moves you back 1.3 m.
- surround: a stacked crowd spreads into slots, and zombies hold still once in place.

`tests/rangedfeel.test.ts` (24 tests): weapon classes from BN data, draw styles, the no-muzzle-flash rule (a bow shot leaves `flashShots` at 0, a pistol flashes), BN STR_DRAW bands and skill adjust, recovery odds and the embed rule, `takeRound`, the arc, RMB-draw / LMB-loose / let-down / too-weak flows, travel time, arrow conservation over 30 shots (carried + ground + stuck + broken), arrows falling when the zombie dies, and miss-reason selection (in play too: "fell short"). Real input: `tools/realinput.ts --only archery` (14 checks).

`tests/monsters.test.ts` now checks both presets: **Classic keeps CDDA's swing rate**, and Accessible stretches it to tell + recovery.

## What to try (for the human)
1. Wield a bat and fight one zombie. Watch it rear back and flash, then step back (S) or tap Space as it flashes white: it whiffs. Hold RMB just as it flashes to parry. You'll hear a clack and it staggers.
2. Hit it hard during its tell. A heavy blow or a crit knocks it out of the attack.
3. Hold LMB and watch the ring: the next swing comes when it fills. The red brackets tell you you're in reach.
4. Let three or four zombies come at you from one side. They should spread around you, not stack.
5. Get grabbed and mash `e`.
6. Pistol: RMB to aim down the sights, then fire and reload. Try `cdda.setFeel('classic')` in the console to feel the tighter timings.
7. Longbow (`cdda.giveItem("longbow", { wield: true }); cdda.giveItem("arrow_wood", { count: 20 })`): hold RMB to draw and watch the circle shrink and the readout ("Precise 12 m · likely hit ≤ 6 m"), click to loose, and read the line above the crosshair when it misses. Try a bare click (snap shot), a zombie past 22 m, and `cdda.game.player.str_base = 7; cdda.game.player.resetStats()` (a hard pull). Walk the arrows and press `r` on them to take them back.

## Known gaps and follow-ups
- Monster-vs-NPC fights resolve without a telegraph (the survivor isn't involved).
- The side-step double-tap can trigger for players who stutter-strafe. Space is the main binding. The double-tap window is `FEEL.doubleTap`.
- RMB is guard (melee) and aim (gun). If the UI v2 toolkit wants RMB for world context menus in gameplay, it needs a modifier or a different trigger. The guard reads `input.mouseButtons & 4` in `PlayerCombat.update`.
- Tracers and bullet marks are billboards: marks don't align to the wall plane.
- Archery: flights ignore NPCs and never hit the survivor (only monsters, walls and the ground); NPC archers still shoot hitscan. Arrows stuck in the ground/walls are billboard pixel lines drawn over the ground item icon. A skill-0 survivor misses a lot even at 8 m: that is BN's dispersion; the crosshair now says so ("past your effective range (~6 m, archery 0)") rather than changing the odds.
- Numbers (to-hit, damage, the block formula's inputs) follow BN when the BN data port lands. Only `FEEL` belongs to this layer.
