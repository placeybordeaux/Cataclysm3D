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

## Aim models (wave 3): your shot goes where you aim

The user's feedback: *"making a player miss their shot because their skill isn't high enough
really doesn't feel good in FPV. Instead … make their crosshair bob and weave more when they
have low skill, have the skill increase the damage it does or even have a little timing minigame."*

Three models, switchable at any time: **Options → Aim model**, `?aim=sway|timing|dice`
(remembered in localStorage `cdda3d.aimModel`), or `cdda.setAimModel('dice')`. Code:
`src/game/aimmodel.ts` (pure: model switch, sway, hit zones, damage, timing windows),
`src/game/playercombat.ts` (`fireFree`, `castAim`, `freeHit`, `flightHitsFree`, `visibleDodge`),
`src/aim.ts` (wiring, per-frame reticle presenter, active reload, Options), `src/ui/aimHud.ts`
(overlay). Tunables are `FEEL.aim*` in `combatfeel.ts` (Accessible and Classic differ).

| Model | Name in Options | What decides a hit |
|---|---|---|
| `sway` (**default**) | Steady hands | Geometry only. The round leaves along the reticle the player saw when they clicked. |
| `timing` | Steady hands + timing | As `sway`, plus optional timing bonuses (below). |
| `dice` | Classic dice | BN's dispersion and to-hit rolls, exactly as before (miss reasons, spread circle, aim levels). |

### Free aim (`sway` and `timing`)
- **The reticle weaves; the shot follows the reticle.** Its amplitude is BN's *mean lateral shot
  error* — (weapon + dex + hands + skill dispersion)/2 × 2/π MOA, `Character::get_weapon_dispersion`
  as `combat.ts dispersionBreakdown` ports it — times `FEEL.aimSwayScale` (1.0 Accessible, 1.25
  Classic). So a weapon/skill that BN makes miss often weaves as far as its misses would have
  gone. Skill 0 pistol aimed ≈ 1.1°, skill 5 ≈ 0.3°, skill 10 ≈ 0.1°. BN's aim state (recoil
  above the sight floor: just raised, walking, just fired) adds a compressed "unsteady" share
  (`aimUnsteady`), which holding RMB aims away as before. Posture multiplies it: ADS ×0.65,
  crouch ×0.8, walking up to ×1.6, running ×1.6 more, pain, low stamina. Bows shake ×1.8 while
  drawing, settle at full draw and shake again past `drawHoldSteady`. Low skill also weaves
  *faster* (`swaySpeed`). The motion is smooth sine noise with a slow breath component.
- **Exactness**: the simulation advances the weave at 30 Hz; the renderer samples it in between
  every frame (`AimSway.offset(extra)`) and records what it drew (`markShown`); a click fires
  along that recorded offset (`shotOffset`, fresh within 50 ms), converted to a world ray with
  `aimDirection` (forward + right·tan x + up·tan y, i.e. exactly the camera projection).
  The crosshair (`.hud-cross`), the combat HUD's ring/brackets (`CombatHud.setReticle`), the gun
  in the hands (`Viewmodel.aimPx`) and a drawn bow all move to that point.
- **Recoil is a kick, not a spread**: BN's added recoil (MOA) × `aimKickScale` (× the class's
  `kickScale`) kicks the aim up (and a little sideways); the camera shows `aimKickView` of it,
  the reticle the rest. It springs back at `aimKickRecover + aimKickRecoverPerSkill × skill` /s.
- **Hits** use a 3D test against each body's visible column (`castAim`: radius ×1.1, height by
  size, walls/furniture/floor from the tile raycast; arrows use their arc height). No
  dodge or to-hit dice. What a hit does (`hitDamageMul`, shown above the crosshair, e.g.
  "HEADSHOT ×2", "legs ×0.75 · pistol skill 0 ×0.75"):
  - zone by strike height (`aimHooks.hitZone`, default `defaultHitZone`: head ≥ 83 % of an
    upright body, legs < 45 %): head ×2 (BN's head severity cap), legs ×0.75;
  - graze (the outer 20 % of the body, BN's grazing band) ×0.5;
  - weak spot ×1.5, chance `0.04 + 0.025·skill + 0.01·(dex+per−16)` (BN's crit inputs);
  - skill ×0.75 at 0 → ×1.3 at 10 (Classic ×0.65 at 0);
  - skill also adds stagger (`aimStaggerPerSkill`: the flinch/interrupt counts the blow as bigger).
  Misses say nothing (you saw the round go wide) except the physical reasons you might not see:
  *blocked by cover*, *low: hit the ground short of it*, *high: flew over it*, *fell short: out of range*.
- **The overlay** (`aimHud.ts`): a faint dot where the mouse looks; while aiming, a dashed circle
  of the current weave size, green/yellow/red by whether it fits the body under the view centre
  (replaces the BN spread circle). **Options → Aim trail** adds a fading trail of the reticle's
  last second. The aim readout drops "Immediate/Careful … likely hit ≤ N m" and keeps the distance.
- **Melee**: a swing whose arc connects always lands. A failed BN hit roll becomes a *glancing*
  blow (×0.5, no technique, no crit; the crosshair says "glancing ×0.5 (bashing 0)"). BN already
  scales swing speed, stamina cost and damage with skill; free aim adds stagger and widens the
  parry window (`aimParryPerSkill`, via `DefenseState.parryMul`). **Dodges are visible**: at the
  wind-up, a monster that BN would let dodge (hit roll ≥ 0 but under dodge × 5) hops back and aside
  out of the arc before contact (`monsterDodge` event, `dashVx/dashVy`); the whiff then says
  "the zombie runner dodged". Plain zombies have dodge 0 and never do.
- Throwing (`G`) goes where you look. Reloads in every model now use BN's skill divisor
  (`Character::item_reload_cost`: `cost / (1 + min(skill × 0.1, 1))`).
- NPCs and monsters still shoot with BN's dice.

### Timing model extras (`timing`)
- **Hold breath**: Shift while aiming a gun (running is vetoed via `game.runVeto` meanwhile). The
  weave eases to ×0.3 over 0.3 s; for the next `0.4 + 0.04·skill` s the reticle ring flashes and
  the readout says **NOW**: a shot then is *perfect* (×1.25, +25 % weak-spot chance). Held past
  `2.5 + 0.25·skill` s (less when tired) the hands shake; you gasp and need a moment to recover.
- **Bow**: at full draw a ring closes on the reticle; it meets the target ring 0.55 s after full
  draw; loosing within ±(0.08 + 0.015·skill) s of that is perfect.
- **Active reload**: during a reload a bar appears under the reticle; press reload again while
  the marker is in the bright band (42 % … +10 %+1.2 %·skill) to finish at once and make the next
  shot perfect; outside it you fumble (+0.5 s). One try per reload.
- **Melee beat**: a click just before (≤0.12 s) or just after (≤0.08 s + 0.012·skill) the next
  swing is ready chains a perfect swing (×1.25, extra stagger, "on the beat ×1.25"); the ring
  pulses yellow. Holding LMB repeats normally, without the bonus.

### Measurements (before = Classic dice, after = Steady hands)
Headless sim, one zombie walking in from 20 m, the shooter tracks the chest and holds RMB; dice
fires once aimed (or 1.2 s), free aim fires when the reticle is about to be on the body (0.15 s
reaction) — `npm run sim -- --scenario range --seeds 20 [--aim dice]`, Accessible, time to kill in s:

| weapon | skill | dice: hit rate / TTK | free aim: hit rate / TTK / aiming per shot | free aim dmg per hit |
|---|---|---|---|---|
| pistol | 0 | 46 % / 7.4 | 100 % / 5.8 / 0.58 s | 23 |
| pistol | 5 | 68 % / 5.2 | 100 % / 4.8 / 0.53 s | 33 |
| rifle | 0 | 35 % / 4.5 | 100 % / 1.5 / 0.58 s | 32 |
| rifle | 5 | 55 % / 2.6 | 100 % / 1.4 / 0.53 s | 47 |
| shotgun | 0 | 42 % / 8.7 | 100 % / 4.5 / 0.87 s | 17 |
| shotgun | 5 | 61 % / 3.4 | 100 % / 2.3 / 0.53 s | 25 |
| longbow | 0 | 33 % / 8.4 | 77 % / 7.6 / 1.29 s | 26 |
| longbow | 5 | 45 % / 5.2 | 78 % / 3.1 / 0.70 s | 37 |

(Arrow misses in free aim are the stumbling zombie drifting sideways during the ~0.35 s flight;
the bot doesn't lead.) Classic preset, free aim: pistol 0 7.5 s, shotgun 0 8.3 s, bow 0 10.9 s —
about as slow as dice, so Classic stays tense. Melee first fight (long stick, 30 seeds,
Accessible): dice 6.4 s median (4 hits, 2 misses) → free aim 5.2 s (5 hits, 0 misses). Duels:
see docs/BALANCE.md.

Real input (GPU, xdotool, `tsx tools/realinput.ts --only aim,aimtiming --gpu`), zombie pinned at
12 m (bat: 1 m), the "player" clicking when the drawn crosshair is on the chest:

| weapon | skill | free aim: hit / dmg per hit | dice: hit / dmg per hit |
|---|---|---|---|
| pistol | 0 / 5 | 6/6, 22 / 6/6, 32.7 | 2/6, 14 / 4/6, 34 |
| rifle | 0 / 5 | 6/6, 31 / 6/6, 50 | 1/6, 35 / 5/6, 43.8 |
| shotgun | 0 / 5 | 6/6, 16 / 5/5, 24.2 | 1/6, 7 / 3/5, 22.3 |
| longbow | 0 / 5 | 6/6, 30.3 / 6/6, 38 | 1/6, 37 / 2/6, 19.5 |
| bat | 0 / 5 | 8/8, 12.6 / 8/8, 22.4 | 7/8, 15.9 / 7/8, 19.3 |

Timing (real input): NOW flash → perfect shot, perfect active reload, perfect bow loose and a
chained swing on the beat all pass. Screenshots: `docs/screenshots/wave3/combat/`
(`sway_pistol_skill0[_zoom].png` vs `sway_pistol_skill5[_zoom].png` with the aim trail on — the
yellow circle is the weave, `headshot.png`, `sway_bow_skill0.png`, `timing_*_zoom.png`).

Tests: `tests/aimmodel.test.ts` (23): model switch, sway from BN dispersion and posture, ray
direction/projection, shot uses the drawn reticle, kick recovery by skill, zones and damage
parts, timing windows; in play: skill-0 pistol never misses a centred shot (dice does), a
reticle beside the body misses silently, head/legs follow aim height, skill raises damage, the
zone hook, arrows, glancing melee, visible dodge, zombies never dodge, parry window, melee beat.

Known gaps: sway is shown in first and third person but the third-person camera offset makes
the projection approximate; the viewmodel gun follows the reticle only half-way at the hip; the
hit zones are height bands until 3D models install `aimHooks.hitZone` / `aimHooks.body`;
monster ranged dodges don't exist in free aim (BN's bullet dodge was ~0 anyway); the melee arc
has no sway (a swing's timing is the skill).

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
