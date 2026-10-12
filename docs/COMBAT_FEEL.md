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
  as `combat.ts dispersionBreakdown` ports it — times `FEEL.aimSwayScale` (1.6 Accessible, 2.0
  Classic; round 2 raised it from 1.0/1.25 so skill 0 is clearly harder to hold on target). So a
  weapon/skill that BN makes miss often weaves further than a body at range. Skill 0 pistol
  aimed ≈ 1.8°, skill 5 ≈ 0.5°, skill 10 ≈ 0.15°. BN's aim state (recoil
  above the sight floor: just raised, walking, just fired) adds a compressed "unsteady" share
  (`aimUnsteady`), which holding RMB aims away as before. Posture multiplies it: ADS ×0.65,
  crouch ×0.8, walking up to ×1.6, running ×1.6 more, pain, low stamina. Bows shake ×1.8 while
  drawing, settle at full draw and shake again past `drawHoldSteady`. Low skill also weaves
  *faster* (`swaySpeed`). The motion is smooth sine noise with a slow breath component.
- **Exactness**: the simulation advances the weave at 30 Hz; the renderer samples it in between
  every frame (`AimSway.offset(extra)`) and records what it drew (`markShown`); a click fires
  along that recorded offset (`shotOffset`, fresh within 50 ms). With a renderer the ray is built
  from the *drawn* camera (`aimHooks.view`: its matrix, so shake and pixel-snapped rotation are
  included): forward + right·tan x + up·tan y through the reticle's pixel (`basisDirection`).
  **Third person**: the camera is over the shoulder, so the camera's ray finds the point under
  the crosshair and the round leaves the survivor's eye toward it (`PlayerCombat.aimRay`) —
  what's under the crosshair is what you hit, unless something stands between you and it.
  Without a renderer (tests, sim) the ray leaves the eye along the view (`aimDirection`).
  The crosshair (`.hud-cross`), the aim readout (rides under it), the combat HUD's ring/brackets
  (`CombatHud.setReticle`), the gun in the hands (`Viewmodel.aimPx`, fully, at the hip and
  aimed) and a drawn bow all move to that point.
- **Recoil is a kick, not a spread**: BN's added recoil (MOA) × `aimKickScale` (× the class's
  `kickScale`) kicks the aim up (and a little sideways); the camera shows `aimKickView` of it,
  the reticle the rest. It springs back at `aimKickRecover + aimKickRecoverPerSkill × skill` /s.
- **Hits** test the drawn 3D model (`aimHooks.pick` → `src/render/aimPick.ts`: a ray against
  every part box of the posed model, `CharInstance.mats`, exactly as drawn that frame), so a
  zombie's head is its head box and a dog's head is out in front and low where the model puts it;
  a ray between the legs or past an arm misses. Part → zone (`zoneOfPart`): head/ears/antennae/
  fangs = head (never with NOHEAD), thighs/shins/feet/legs/tracks = legs, arms/wings/tails =
  limb, the rest torso. Arrows test each tick's stretch of their arc the same way. Without a
  model (billboard look, tests, sim) a column of the body's height (radius ×1.1, `aimHooks.body`)
  zoned by height (`defaultHitZone`: head ≥ 83 % of an upright body, legs < 45 %). Walls,
  furniture and floors come from the tile raycast. No dodge or to-hit dice. What a hit does
  (`hitDamageMul`, shown above the crosshair, e.g. "HEADSHOT ×2", "legs ×0.75 · pistol skill 0 ×0.75"):
  - zone: head ×2 (BN's head severity cap), legs and limbs ×0.75;
  - graze (the outer 20 % of the body, BN's grazing band) ×0.5;
  - weak spot ×1.5, chance `0.04 + 0.025·skill + 0.01·(dex+per−16)` (BN's crit inputs);
  - skill ×0.75 at 0 → ×1.3 at 10 (Classic ×0.65 at 0);
  - skill also adds stagger (`aimStaggerPerSkill`: the flinch/interrupt counts the blow as bigger).
  Misses say nothing (you saw the round go wide) except the physical reasons you might not see:
  *blocked by cover*, *low: hit the ground short of it*, *high: flew over it*, *fell short: out of range*.
- **The reticle shows only while you aim** (user: "having the bow out all of the time makes the
  little aiming minigame play constantly"): the weaving crosshair, the overlay, the gun's follow
  and the timing marks show while RMB aims a gun, while a bow or sling is drawn, and for
  `RETICLE_AFTER_SHOT` (2.5 s) after a shot so follow-ups read (`aimmodel.reticleVisible`,
  `PlayerCombat.reticleShown`). Otherwise a plain crosshair sits at the centre and the gun rests
  still — but the weave keeps running underneath, so a hip shot goes where it really points (no
  extra hip penalty: BN's unaimed recoil already makes hip shots wild). Real input: `--only aimreticle`.
- **Top view** (user: "How exactly is shooting supposed to work in overhead view?"): twin-stick
  style. The mouse turns the survivor; the aim is the facing (`PlayerCombat.topAim`, used by
  `aimRay` whenever `aimHooks.topView()` says the camera is top-down). Height can't be seen from
  above, so it is chosen: a level probe at chest height finds the first body along the facing
  (`castAim`), and the shot is pitched to its centre mass (55 % of its height) — or to its head
  (88 %) while aiming with RMB, the careful shot; with nothing on the line the shot is level.
  The weave turns the facing sideways only. Drawn in the world (`src/render/topAimFx.ts`): while
  aiming or just after a shot, a dotted line from the survivor to where the shot lands (red when
  it meets a body) and a gold ring around that body; at rest only a short dim facing tick (same
  rule as the first-person reticle). Melee swings along the facing (the camera's ray is ignored
  in top view; the swept arc around the facing decides). **Options → Top-view aim assist** (off by
  default): when the line meets nothing, a hostile within 12° of the facing is aimed at. Tests:
  `tests/topaim.test.ts`, real input `--only aimtop` (turn onto a zombie at 10 m with the mouse:
  the line is on it and an aimed shot is a headshot; facing nothing: level, a miss; a swing hits
  what's in front). Gap: the top camera frames ~8 m ahead, so a 10 m target's ring is just
  off-screen at the top; the line still points at it.
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
  "the zombie runner dodged". Plain zombies have dodge 0 and never do. On the 3D model the
  dodge is a hop: it springs 0.28 m and leans 0.35 rad away over 0.3 s on top of the slide
  (`src/aim.ts installModelHooks`, adding to the model's lift/topple between monster-view ticks).
- Throwing (`t`; it was `G` before grab took BN's key) goes where you look. Reloads in every model now use BN's skill divisor
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

### Measurements (before = Classic dice, after = Steady hands, round 2 tuning)
Headless sim, one zombie walking in from 20 m, the shooter tracks the chest and holds RMB and
holds fire until in range; dice fires once aimed (or after 1.2 s); free aim fires a reaction
time after it *sees* the reticle on the body (`--reaction`, 0.18 s = a quick player, 0.3 s = a
slower one), or after 2 s regardless — `npm run sim -- --scenario range --seeds 20 [--aim dice]
[--reaction 0.3] [--preset classic]`. Hit rate / time to kill (s, median) / aiming time per shot:

| Accessible | skill | dice | free aim, 0.18 s | free aim, 0.3 s | dmg per hit (free) |
|---|---|---|---|---|---|
| pistol | 0 | 46 % / 7.4 | 100 % / 6.1 / 0.69 s | 100 % / 6.4 / 0.79 s | 23 |
| pistol | 5 | 68 % / 5.2 | 100 % / 4.8 / 0.57 s | 100 % / 5.1 / 0.70 s | 33 |
| rifle | 0 | 35 % / 4.5 | 100 % / 3.0 / 1.35 s | 67 % / 4.2 / 1.18 s | 31 |
| rifle | 5 | 55 % / 2.6 | 100 % / 1.5 / 0.57 s | 100 % / 1.7 / 0.67 s | 47 |
| shotgun | 0 | 42 % / 8.7 | 100 % / 5.3 / 1.07 s | 80 % / 6.4 / 1.01 s | 15 |
| shotgun | 5 | 61 % / 3.4 | 100 % / 2.4 / 0.57 s | 100 % / 2.7 / 0.68 s | 25 |
| longbow | 0 | 33 % / 8.4 | 60 % / 9.3 / 1.53 s | 52 % / 10.8 / 1.39 s | 31 |
| longbow | 5 | 45 % / 5.2 | 85 % / 4.5 / 1.02 s | 81 % / 5.4 / 1.02 s | 35 |

| Classic | skill | dice | free aim, 0.18 s |
|---|---|---|---|
| pistol | 0 / 5 | 51 % / 7.3 · 71 % / 5.5 | 100 % / 8.2 · 100 % / 5.4 |
| rifle | 0 / 5 | 37 % / 5.4 · 59 % / 3.0 | 100 % / 5.3 · 100 % / 1.6 |
| shotgun | 0 / 5 | 45 % / 9.1 · 61 % / 6.0 | 100 % / 9.6 · 100 % / 3.4 |
| longbow | 0 / 5 | 34 % / 9.0 · 43 % / 7.5 | 62 % / 9.2 (9/20 killed before contact) · 83 % / 5.3 |

Reading it: at skill 0 the price is *time* (the weave is wider than a body at 15–20 m, you wait
for it to cross) and, for a slower player, misses (a third of skill-0 rifle shots at 0.3 s);
at skill 5 the reticle sits on the body and every hit does ~1.5× the damage. Round 1's rifle at
skill 0 (1.5 s) was too easy; it's 3.0 s now (4.2 s for a slower player), and Classic's free-aim
kill times match BN's dice. Guns are not trivial across presets: Classic skill 0 is as slow as
dice. **Ammo and noise**: noise is untouched (every shot is still heard by BN's rules). Rounds per
kill drop (pistol skill 0: 5 → 3 shots median) because well-timed shots don't miss; ammo spawn
rates are unchanged, so ammo stretches further for patient shooters — a deliberate trade for the
new audience; `aimSkillDmg0` (0.75 Accessible, 0.65 Classic) is the lever if it proves too generous.
(Arrow misses in free aim are the stumbling zombie drifting sideways during the flight; the bot
doesn't lead.) Melee first fight (long stick, 30 seeds, Accessible): dice 6.4 s median (4 hits,
2 misses) → free aim 5.2 s (5 hits, 0 misses). Duels: see docs/BALANCE.md.

Real input (GPU, xdotool, `tsx tools/realinput.ts --only aim,aimtiming --gpu`), zombie pinned at
12 m (bat: 1 m), the "player" clicking when the drawn crosshair is on the chest:

| weapon | skill | free aim: hit / dmg per hit | dice: hit / dmg per hit |
|---|---|---|---|
| pistol | 0 / 5 | 6/6, 22 / 6/6, 32.7 | 2/6, 14 / 4/6, 34 |
| rifle | 0 / 5 | 6/6, 31 / 6/6, 50 | 1/6, 35 / 5/6, 43.8 |
| shotgun | 0 / 5 | 6/6, 16 / 5/5, 24.2 | 1/6, 7 / 3/5, 22.3 |
| longbow | 0 / 5 | 6/6, 30.3 / 6/6, 38 | 1/6, 37 / 2/6, 19.5 |
| bat | 0 / 5 | 8/8, 12.6 / 8/8, 22.4 | 7/8, 15.9 / 7/8, 19.3 |

The same run after round 2 (wider skill-0 weave, 3D-model hit zones), free aim, hits / dmg per
hit / ms spent waiting for the crosshair to cross the chest, skill 0 → 5: pistol 4/6, 20.5, 366 →
6/6, 28.8, 105; rifle 6/6, 28.3, 268 → 6/6, 41.2, 107; shotgun 4/6, 13, 335 → 5/5, 19.6, 105; longbow
6/6, 29.2, 448 → 6/6, 37.3, 106; bat 8/8, 12.1 → 8/8, 24.5. Skill 0 now costs aiming time and the
odd miss (the click's latency carries a fast, wide weave off the body); skill 5 never misses.
(Damage per hit is a little lower than round 1 because model hits on the arms in front of the
chest count as limbs.)

Timing (real input): NOW flash → perfect shot, perfect active reload, perfect bow loose and a
chained swing on the beat all pass. Screenshots: `docs/screenshots/wave3/combat/`
(`sway_pistol_skill0[_zoom].png` vs `sway_pistol_skill5[_zoom].png` with the aim trail on — the
yellow circle is the weave, `headshot.png`, `sway_bow_skill0.png`, `timing_*_zoom.png`).

Tests: `tests/aimmodel.test.ts` (23): model switch, sway from BN dispersion and posture, ray
direction/projection, shot uses the drawn reticle, kick recovery by skill, zones and damage
parts, timing windows; in play: skill-0 pistol never misses a centred shot (dice does), a
reticle beside the body misses silently, head/legs follow aim height, skill raises damage, the
zone hook, arrows, glancing melee, visible dodge, zombies never dodge, parry window, melee beat.

Round 2 (real input, GPU, `--only aimzones` and `--only aimwide --size 3440x1304`): shots at a
zombie's drawn head are headshots, at its shin legs; a dog's drawn head (out front, low) is a
headshot and its body torso; over the shoulder, 5/5 shots with the crosshair on the chest hit
and one 0.7 m beside it misses; a nimble zombie's dodge shows as a hop and lean; at 3440×1304
the weaving crosshair stays near the centre and the readout rides under it without overlapping.
Screenshots (JPEG): `r2_zombie_headshot.jpg`, `r2_dog_headshot.jpg`, `r2_third_person.jpg`
(over the shoulder, the hit line reads "limb ×0.75 · weak spot": the arm in front of the chest),
`r2_dodge_hop.jpg` (the zombie leaning away mid-hop), `r2_ultrawide_3440x1304.jpg`,
`r2_ultrawide_breath_zoom.jpg` (NOW flash, readout under the crosshair).
`tests/aimpick.test.ts`: ray-vs-model zones for a zombie and a side-on dog, a ray between the
legs misses, unbuilt/hidden models defer to the column rule.

### Round 3: melee on the models, enemy fire you can read, first-fight hints

**Melee on the model boxes** (`PlayerCombat.meleePick`, `aimmodel.swingFan`, `aimHooks.prepare` →
`render/aimPick.ts prepareModel`). At contact the swing casts a fan of rays from the eye — the
crosshair first, then outward in 4° steps across its arc (±40° swing, ±22° thrust, ±28° punch)
and a ±8°/±16° vertical band — against the posed part boxes of every monster in reach. The
first ray that meets a body within reach (+0.3 m) decides: in a crowd that is the zombie under
(or nearest) the crosshair, and the part it met is the zone. If no ray meets a body (a zombie
crawling at your feet, billboard look), the swept arc decides as before, zone torso — so the
swing still clips what's beside you. Zones (free aim only): head ×1.5 (`aimMeleeHeadMul`), +0.5
stagger, and a blunt or heavy weapon may **stun** (30 % + 4 %/skill, 0.6 s + 0.05 s/skill);
legs/limbs ×0.8 (`aimMeleeLimbMul`), a leg blow makes it **stumble** (0.5 s flinch) and may
**knock it down** (20 % + 4 %/skill, 1.2 s; not huge or immobile monsters). The crosshair line
names it: "HEAD ×1.5 · stunned", "legs ×0.8 · knocked down". Real input (`--only combat3`): with
three zombies shoulder to shoulder at arm's length, 5/5 swings hit the one under the crosshair.
`tests/meleezones.test.ts`.

**Enemy fire** (`src/game/enemyfire.ts`, drawn by `src/render/enemyFireFx.ts`). Every round a
monster (`monguns.ts`: guns, bows, thrown rocks) or an NPC (`npcai.ts shoot`) fires is now a real
round in the air: bullets 90 m/s (a 20 m shot takes 0.22 s, drawn as a 3 m streak of hot
pixels), arrows/bolts at their flight speed (a dark shaft, pale head), stones 14 m/s. The
shooter still rolls BN's dispersion for the direction (so enemy accuracy is BN's, and a hit still
runs BN's `deal_projectile_attack` severity on the survivor); the world decides what it meets:
the first wall (cover works — duck behind one and nothing gets through), the survivor, an NPC or
a follower in the line (friendly fire), and for NPC rounds any monster. A miss flies on past you
and out to its range. **Near misses** (a round passing within 1.4 m) raise `nearMiss`: a quick
zip (`sfx.nearMiss`, the whoosh pitched up for bullets) and a small flinch of the view and hands
toward the side it passed. The survivor's rounds, pellets and arrows hit NPCs on the way
(see [NPCs in the line of fire](#npcs-in-the-line-of-fire)). Fixed on the way: monster
guns now use the monster's own starting ammo when it fits (a light turret carries 9mmfmj and
used to click empty). Real input: a rifle turret at 16 m over 9 s — up to 4 rounds in the air
at once, 17 hits and 10 near misses; behind a wall, none. `tests/enemyfire.test.ts`.

**First-fight hints** (`src/ui/combatHints.ts`). Three short lines by the crosshair, each at the
moment it matters, at most 3 times per profile, never twice within 20 s, one at a time, gone
once you've done the thing, and off with Discovery hints off: "Your aim sways — fire as it
crosses" (the first times you aim a gun at a hostile), "Aim for the head — ×2 damage" (after a
body hit; learned on a headshot), "Hold right mouse: guard · Space: side-step" (a zombie winding
up at arm's length; clears when you raise the guard; learned after guarding twice). The first
showing files the longer text in the Survival Journal (Combat: *Your aim sways*, *Headshots*,
*Guard*) without a toast. `tests/combathints.test.ts`.

**Playtest notes addressed.** *Zombies close fast*: a plain zombie on Accessible (90 % speed)
takes 7.9 s to walk from 15 m to arm's length (sim, `HOLD_FIRE=1 RANGE_DIST=15`); a runner
4.9 s. A newcomer (0.3 s reaction) with a pistol at skill 0 kills a walker from 15 m in 4.1 s
with 3 aimed shots, a runner in 3.7 s — the 2–3 aimed shots are there; two zombies arriving in
~4 s were most likely runners or dogs (speed 105), which close twice as fast. Speeds unchanged.
*Grabbed prompt overlap*: while grabbed only the GRABBED banner shows the key; the crosshair
prompt is empty.

**The `aim`/`aimzones` failures on `bn` after characters rounds 3–4** were not the models' part
boxes (they pick correctly: `cdda.aimDebug(uid)` and the `aimdebug` scenario print the drawn
camera ray, what it meets and a direct model pick). Three causes: (1) the suites reused a
wielded rifle a previous scenario had nearly emptied, so later shots didn't fire and read as
"none" (each setup now wields a fresh, full weapon); (2) the drawn eye rides the ground relief
(1.41 m on a road the renderer draws 0.19 m low) while free-aim **arrows** were launched from the
simulation's flat 1.6 m, so they flew ~0.2 m high of the drawn bodies — they now leave from the
shot ray's origin like hitscan rounds (`launch(..., { eye })`); (3) the suite's "player" watched
a fixed 1.1 m chest instead of the drawn torso. With those, `aim` 26/26 and `aimzones` 9/9 in
sequence. The shamble and the tapered parts are honest geometry: a shin is a hand's width, so the
shin check allows a clean miss (never another zone), and a bow at skill 5 may lose one arrow of
six to a body that shambled during the flight.

Screenshots (JPEG): `r3_melee_crowd_head.jpg` (the middle of three: "HEAD ×1.5 · stunned"),
`r3_enemy_rounds.jpg`, `r3_hint_sway.jpg`, `r3_hint_headshot.jpg`, `r3_hint_guard.jpg`.

Known gaps: the arms hang in front of the torso, so a centre-mass shot on a model sometimes
reads "limb ×0.75" (that is what's drawn in front); monsters don't dodge rounds in free aim
(BN's bullet dodge was ~0 anyway; now modelled, see [Enemy arrows, grenades and dodging](#enemy-arrows-grenades-and-dodging)); enemy rounds fly at the aimed
height only (BN's dispersion is horizontal); arrow drop and grenade lobs/blasts are now done
(same section); the melee arc has no sway (a swing's
timing is the skill); in the dice model the third-person shot still leaves the eye parallel to
the camera (as before).

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
- Monster-versus-NPC melee now uses attack windups; third-party special attacks remain limited.
- The side-step double-tap can trigger for players who stutter-strafe. Space is the main binding. The double-tap window is `FEEL.doubleTap`.
- RMB is guard (melee) and aim (gun). If the UI v2 toolkit wants RMB for world context menus in gameplay, it needs a modifier or a different trigger. The guard reads `input.mouseButtons & 4` in `PlayerCombat.update`.
- Tracers remain billboards. Persistent bullet marks now align to verified loaded wall,
  furniture, floor or ceiling planes; their reconstructed point is cosmetic, and uncertain
  or legacy impacts without explicit landing facts are omitted.
- Archery: the survivor's own arrows never hit the survivor (BN: no hitting yourself); NPC and monster arrows do, as enemy rounds. NPC and monster archers roll BN's dispersion and their arrows fly the survivor's gravity arc ([Enemy arrows, grenades and dodging](#enemy-arrows-grenades-and-dodging)). Arrows stuck in the ground/walls are billboard pixel lines drawn over the ground item icon. A skill-0 survivor misses a lot even at 8 m: that is BN's dispersion; the crosshair now says so ("past your effective range (~6 m, archery 0)") rather than changing the odds.
- NPCs in the line of fire: see [its limits](#npcs-in-the-line-of-fire) (BN's dice for a stray creature on the path, killed-innocent morale and the monster FRIEND_ATTACKED anger are not modelled; an incendiary round on a person lights the tile, not the person).
- Numbers (to-hit, damage, the block formula's inputs) follow BN when the BN data port lands. Only `FEEL` belongs to this layer.

## NPCs in the line of fire

The survivor's hitscan rounds, every shotgun pellet and every arrow, bolt and stone resolve
against the nearest body on their own path: monster, wall, or NPC (followers and neutrals too),
as BN's `projectile_attack` hands a round to whatever critter it reaches. `src/game/npcfire.ts`
does the NPC side; `PlayerCombat` compares it with the monster and wall each ray or arc step
would otherwise reach.

- **Geometry.** Free aim tests the drawn 3D person (`aimHooks.pickNpc`, the same part boxes
  monsters use, `NpcView.modelOf`); without a model a 1.75 m column (half when downed or asleep),
  1.1 × the collision radius, zoned by height like monsters. Classic dice uses the plan line and
  the collision radius, like `castRay` for monsters.
- **Each pellet independently.** Every pellet casts its own ray; one that meets an NPC first
  stops there, the rest fly on to the zombie behind. The NPC's pellets are resolved one by one:
  own body part, worn armor rolled once per pellet (`Inventory.absorbHit`), own part HP. The log
  uses BN's `multi_projectile_hit_message` ("X is hit by many projectiles, dealing N damage").
- **Damage.** Classic dice: BN `deal_projectile_attack` (`projectile.ts`, character head cap
  ×1.5, dodge roll against the projectile speed; an NPC who avoids an arrow lets it fly on).
  Free aim: the model part picks the body part (head, torso, arm, leg); the hit-quality factors
  (graze, weak spot, perfect, skill) are capped at BN's character severity cap for that part
  (head and torso ×1.5, limbs ×1.25), since the part's own HP pool already carries the zone.
- **Consequences, as BN.** `npc::on_attacked` is never called from a projectile: a stray hit (a
  neutral beside the zombie, a follower behind it) hurts without turning them hostile. Only the
  target is provoked: `target_ui::on_target_accepted` makes it angry (`make_angry`, with its
  faction). Here the target is the NPC whose body the crosshair's own ray (no sway) enters
  first (`PlayerCombat.crosshairNpc`; the look ray is tile-granular, too coarse when a person
  stands half a metre beside the line), and a gun now asks the "Really attack?" question for
  that NPC only (melee keeps its swing cone). `ballistics.cpp` skips
  creatures friendly to the shooter within one tile, so a follower at your shoulder is never
  hit. A kill is credited to the survivor (`creatureDied` killer), the body and gear drop.
- **Arrows on people** drop at their feet (`drop_or_embed_projectile` embeds only in monsters)
  through `PlayerCombat.placeRound` (`moves.ts`), or break as usual.
- **NPC fire.** NPC rounds already flew and hit whoever was in the way (survivor, NPCs,
  monsters). Now an NPC shotgun fires each pellet as its own round with the per-pellet damage,
  and their rounds skip the shooter's friends within one tile (the survivor for a follower,
  fellow followers or faction members).

Not modelled: BN re-rolls `missed_by` for an unintended creature on the path
(`rng_float(0.1, 1.5 − missed_by) / target size`, at least 0.4); here the geometry of where the
ray or pellet passed decides, as it does for monsters. The killed-innocent morale
(`hit_by_player`), the FRIEND_ATTACKED monster anger and an incendiary round setting the person
alight are not modelled; overpenetration past the first body is not modelled for anyone.

Tests: `tests/npcfire.test.ts` (ray/column zones, BN adjacency, hitscan stray and aimed hits
under both models, five pellets each armored once, split pellets never counted twice, arrow
drop and conservation, a dodged arrow passing once, kill credit, the attack question, NPC
pellets and adjacency). Real input: `tools/realinput.ts --only npcfire --gpu` (OS mouse and
keys under Xvfb; `cdda.*` only for setup), 15/15 checks: with buckshot aimed at a zombie past a
neutral's shoulder (0.45 m off the line at 5 m), no attack question, and the second shot split
1 pellet into the neutral (right arm, 22) and 2 into the zombie; the neutral stayed neutral;
with the crosshair on the neutral, LMB asked "Really attack …? They are not hostile.", `n`
fired nothing, `y` turned them hostile and the next click hit; a longbow arrow then hit them in
the torso for 35 and lay at their feet, every arrow accounted for. Screenshots:
[split pellets](screenshots/gaps/npcfire-pellets-split.png) ("2/5 pellets" on the zombie, the
log line "Lynna Holbrook is hit by a projectile, dealing 22 damage"),
[the question](screenshots/gaps/npcfire-confirm-neutral.png),
[arrow hit](screenshots/gaps/npcfire-arrow-hit.png).

## Enemy arrows, grenades and dodging

Closes the Archery/projectiles gaps "NPC archers fly straight rounds", "enemy rounds have no arrow
drop or explosive blast arc" and "monsters don't dodge free-aim rounds".

**Arrow drop for enemies** (`enemyfire.ts` `arc`, `rangedfeel.arcHump`). Arrows, bolts and stones
from NPCs (`npcai.ts shoot`) and monsters (`monguns.ts shootAt/throwAt`: the elf-a's longbow, a
feral's crossbow, thrown rocks) fly the survivor's gravity arc: `arcHump(s, D, v) = g/(2v²)·s·(D−s)`
on top of the straight line to what they aimed at, so they rise, meet the target's chest at the
aimed distance (BN's dispersion roll still sets the direction: hit odds unchanged) and fall past
it to the ground. A target that moves during the flight sees it land short or long. BN itself has
no drop (ballistics.cpp flies a straight tile line); like the survivor's, the arc is the picture.
Bullets stay straight.

**Lobbed grenades and blasts** (`enemyfire.lobOf/lobSpeed`, `blast.ts`). Thrown "guns" (skill
`throw`: the SWAT zombie's tear gas) and grenade launchers (GRENADE_LAUNCHERS, or rounds with BN
speed ≤ 100: the feral armored bio-operator's 40 mm HEDP, the riot turret's M203, the Mark 19
turret, the acid mortar) are lobbed: a flight time of 0.6–1.6 s (thrown) or 0.5–1.5 s (launched)
gives a visible lob (apex ~1.2 m over an 8 m throw). Rockets (M202 FLASH) and tank guns fly
straight. Any round whose ammo does something where it ends sets it off wherever it ends: on a
body, the ground, the tile before a wall (ballistics.cpp: `if impassable(tp) tp = prev_point`), or
at range, by BN `apply_ammo_effects` + the custom explosion (`blast.roundEndsAt`): each effect's
`aoe` fields, each `explosion`, and the projectile's `drop` (the M651's armed tear gas canister:
its `emit_tear_gas_stream`, 18 tiles of `fd_tear_gas` at 3). A direct hit first deals the round's
own impact through BN `deal_projectile_attack` at its BN speed (80 for 40 mm: dodgeable).

`blast.detonate` follows Cataclysm-BN `src/explosion.cpp` (default new explosions):
- data (`load_explosion_data`): new `damage`/`radius`/`fragment {impact, range}`; legacy `power` →
  damage = power × 2/15 (`power_to_dmg_mult`), radius = (power × 2/15)^¼ × ln 0.75 / ln
  distance_factor (`blast_radius_from_legacy`), legacy shrapnel → bullet damage ×3 armor to
  2 × radius (`shrapnel_from_legacy`).
- blast (`blast_tile`): tiles with lround(trig distance) ≤ radius not occluded (`is_occluded`: an
  impassable tile on the line). Creatures take damage × `critter_blast_percentage` (×1 within
  radius/2, ×0.5 to the radius; size tiny 0.5, small 0.8, medium 1, large 1.5, huge 2). Monsters
  and NPCs on the torso, bash with 0.4 penetration; the survivor on six parts, rng(dmg × 0.5–1.0)
  at armor ×0.5 for torso/head, rng(dmg × 0.75–1.25) at ×0.4 for limbs ("You're caught in the
  explosion!"). Terrain is bashed with damage × `obstacle_blast_percentage`; passable tiles get
  smoke (fire for `fire` blasts).
- fragments (`project_shrapnel`): every creature on the level within lround(distance) ≤ range and in
  sight takes the fragment impact, no roll: the survivor on all six main parts (the full impact
  each, BN's halved copy is unused), others once. The 40 mm HEDP (AMMO_M433_HEDP: 70 / r 1, 60
  bullet ×1.6 armor to 7 tiles) is therefore deadly to an unarmored survivor anywhere within 7
  tiles in the open, as in BN.
- noise (`explosion_funcs::regular`): min(max(damage, fragment) + (fire ? 70 : 90), 191), "a huge
  explosion!" ≥ 180, "an explosion!" ≥ 120, else "a loud pop!".
- kills are credited to the shooter (monster, NPC, or the survivor); the shooter is not spared.
- drawn by the existing `explosion` event (fireball and smoke in `render/turretFx.ts`) and
  `enemyFireFx.ts` (a grenade: an olive dot with a short smoke trail along its arc).

The survivor's own new-format explosive ammo (EXPLOSIVE, AMMO_M433_HEDP…) never went off before:
`ammoEffectsAt` only read legacy `power`. It now goes through the same `blast` hook (`combatdepth.ts`).

**Monsters dodging free-aim rounds** (`projectile.projectileDodge`, `PlayerCombat.freeDodge`). BN
`Creature::deal_projectile_attack` (creature.cpp) gives every target, monsters included, a partial
dodge: `dodge_roll / dice(10, proj.speed)` (a monster's dodge_roll is `get_dodge() × 5`,
monster.cpp; values under 0.01 are dropped, capped at 1) is added to `missed_by`; at ≥ 1 the
round is avoided ("The elf-a avoids your projectile!") and flies on (ballistics.cpp keeps going,
`hit_critter` unset). Projectile speed is `item::gun_speed`: the ammo's `speed` (default 1000)
plus the gun's. Free aim now applies it: a hitscan round's missedBy (how far off the body's centre
the ray entered) and a free arrow's. Against a gun (1000) it adds ~0.01 at most, so bullets are
effectively never avoided; against an arrow (~100) a dodge-10 elf-a adds ~0.1 on average, turning
edge grazes into misses. Plain zombies (dodge 0) never dodge and roll nothing. An avoided round
reads "dodged" at the crosshair and the monster sways 0.4 m aside (`monsterDodge`).

Not modelled: flinging items, the tear gas canister ticking (one cloud), NPCs throwing hand
grenades (`npc::alt_attack` uses NPC_ALT_ATTACK items; the survivor's armed explosives now tick,
see [Blasts](#blasts-one-explosion-vehicles-ceilings-and-live-grenades)), monster-versus-monster/NPC
gun fire (gun actors only target the survivor), and the survivor's own launcher rounds still resolve
as hitscan (they explode where they hit). Flinging creatures, z-levels, vehicle damage and ceilings
are in the next section.

Tests: `tests/enemyprojectiles.test.ts` (16): the arc shape and that it still hits, a miss falls to
the ground past you, an NPC archer's and the elf-a's arrows arc, BN data/legacy conversion, blast
falloff/size/noise bands, a blast's falloff and wall shielding on zombies, fragments on six parts
and shielding/range, the survivor's per-part blast bands, `lobOf`, the bio-operator's HEDP lob and
blast, the SWAT tear gas cloud, incendiary rockets' fields and blast, the survivor's HEDP reaching
the blast hook, `projectileDodge` statistics, and edge arrows avoided / bullets and zombies never.
Real input: `tools/realinput.ts --only enemyproj --gpu --shots <dir>`.

**Real-input QA** (2026-10-11, Chromium on the GPU, `--only enemyproj`, 16/16 checks): an NPC
archer (archery 4) 15 m away: its arrows fly the arc (+0.1 m over the line mid-flight), 7 loosed in
~7 s, all missed (BN dispersion at 15 m); a follower archer shooting a zombie 9 m away in profile
(+0.04 m: at that range the drop is tiny, for the survivor's arrows too); the bio-operator's HEDP
lobbed +1.2 m over the line, came down 4 m behind the survivor and its fragments hit for 242 (six
parts, BN's no-roll fragments: lethal to an unarmored survivor); the SWAT zombie's tear gas lob
left a yellow cloud; `v` to the shoulder camera (real key). Free-aim longbow at the elf-a's edge
(real RMB draw, LMB loose): 7 of 12 hit, none avoided. Free-aim hits on the drawn part boxes sit
at missed_by ≲ 0.8 (the boxes are narrower than the creature radius the formula divides by), so
BN's average +0.1 dodge rarely reaches 1; the rule is covered by the unit tests. Enemy arrows
remain small dark dots (now 2.2 px; a profile shot at 9 m barely shows them). Frames (session
scratchpad): `lob_fp_zoom.png` (the grenade rising over the bio-operator with its smoke trail, four
frames), `grenade_lob_seq.png`, `run3/` (all 24 frames: arrows at you, profile, lob, blast, tear gas
cloud, dodge test).

## Blasts: one explosion, vehicles, ceilings and live grenades

**One implementation.** `src/game/explosion.ts` (an older approximation: a disc of radius
cbrt(power), its own falloff, a stun, one terrain bash) is gone. Every explosion now goes through
`blast.detonate`: the survivor's ammo effects and CUSTOM_EXPLOSION rounds (the turrets' 120 mm HEAT,
the M79's HEDP: `PlayerCombat.ammoEffectsAt` → the one `blast` hook), enemy grenades and launcher
rounds (`roundEndsAt`), land mines and booby traps (`traps.ts`: BN `get_basic_explosion_data`,
40 / r 3, an 80 bullet ×3 fragment to 6, which used to be a flat 20–40 bash on three parts),
EXPLODE death functions (`mondeath.ts`: BN `mdeath::explode`, legacy power 75–375 by size, which
used to be a ring of fire), fuel tanks (below) and armed grenades (below). `cdda.detonate(dx, dy,
explosion | itemId)` sets one off for testing.

`detonate` now follows Cataclysm-BN `src/explosion.cpp` `ExplosionProcess` step by step (the rules
are listed in the file header; the earlier ones, falloff, sizes, the survivor's six parts, noise,
are unchanged):
- **ints**: the process takes damage and radius as `int` (`ExplosionProcess(p, ex.damage,
  ex.radius…)`): a legacy blast's radius is truncated (1.9 → 1), legacy damage = trunc(power ×
  2/15).
- **fill_maps / z-levels**: z-levels within max(radius, fragment range) / 4 (`Z_LEVEL_DIST` 4); a
  tile is in the blast when lround(3D trig distance + 3 × |dz|) ≤ radius, so a blast of radius ≥ 4
  reaches the room above or below, through the floor (`is_occluded` follows BN's 3D `line_to`
  and only looks for impassable tiles; floors don't stop it). Fragments stay on the level.
- **order**: fragments first (`project_shrapnel`, nearest first), then the blast wave tile by
  tile, nearest first, each tile checked for occlusion *as the wave reaches it*: a window or a
  car door the wave already broke no longer shields what is behind it.
- **fragments on obstacles**: an impassable tile in the fragments' reach is hit by impact × 0.25
  (`SHRAPNEL_OBSTACLE_REDUCTION`): a vehicle part through `vehicle::damage`, terrain/furniture as
  a bash (a grenade's fragments break the windows in sight). `fragment_effect` `onfire` (the
  .50 Raufoss, the 25 mm HEI) sets flammable, or one in `odds` fleshy, monsters alight.
- **multibash**: each blasted tile is bashed at damage × obstacle percentage, then again at a
  force falling by damage / 5 (`MULTIBASH_COUNT` 5, `VEHICLE_DAMAGE_MULT` 2) while above 0: up to
  five bashes (150, 120, 90, 60, 30 for the HEAT round's centre). Each hits the vehicle part there
  (`map::bash_vehicle`) and the terrain and furniture (floors when the tile below is open).
- **fling** (`blast_tile` "Fling creatures", `move_entity`): a creature still standing gets
  (radius − distance) × damage × 40750 / (grams × 100) tiles (`MOB_FLING_FACTOR`,
  `EXPLOSION_CALIBRATION_POWER`; over 30 it's rng 30–50); from 1 tile it flies away from the
  centre (±0.95 tile jitter), stops at an impassable tile or another creature and turns back with
  0.3 of its remaining speed (`RESTITUTION_COEFF`). No landing damage (BN's TODO). A HEAT round
  throws an 82 kg zombie at its centre 2.25 tiles, a 30 kg dog ~6; a grenade (70 / r 2) can't move
  a zombie. Monsters dash there, the survivor slides (the side-step's move), NPCs are moved;
  someone seated in a vehicle stays put.
- **fields**: smoke stays within half the radius (BN clears the outer half's after a delay).
- **summary**: BN's "You are hit by the explosion and shrapnel, taking N damage." (and "The
  zombie is hit by…" for what you can see) after the blast.
- **queue**: an explosion set off by an explosion (a fuel tank) waits until this one is done
  (`explosion_queue`).

**Vehicles** (`src/game/vehicleDamage.ts`, BN `vehicle/vehicle.cpp`): see
[VEHICLES.md, Blasts and vehicles](VEHICLES.md#blasts-and-vehicles-srcgamevehicledamagets).
Occupants: BN has no special case, a creature on a vehicle tile is blasted like any other; the
closed doors, boards and windshields around a seat are impassable, so they shield whoever sits
there until the blast opens or breaks them (a car door survives a grenade; an open door lets the
blast in).

**Rounds stop at vehicles.** The free-aim ray (`castAim`) now stops at a vehicle body at the
height look mode and the reticle give it (`vehicleHitHeight`: 1.6 m for a tile with a closed
obstacle or a roof, else 1.0 m), and the classic ray and thrown items at a vehicle's closed
obstacle parts (`castRay`): before, rounds and grenades flew through parked cars. A round that
stops on a vehicle damages a part there by BN `map::shoot` (`PlayerCombat.shootVehicle`: its
damage through `vehicle::damage`, aimed, as stab or heat for incendiaries): the HEAT shell's own
4000-point impact wrecks the part it strikes before its blast goes off on the tile in front.
The shooter's own vehicle never stops its rounds.

**Ceilings: the decision.** BN's projectiles fly straight on the tile grid and land where they
were aimed; a level change through two floors in a row stops them (ballistics.cpp: "Currently
strictly no shooting through floor", the round ends on its previous tile). The port's lob arc is
a picture of that flight, so indoors it must neither pass through the ceiling nor change where
BN lands it:
- **flatten** (`enemyfire.ceilingSpeed`): a lob that starts under a ceiling or comes down under
  one is launched faster, its apex kept 0.2 m under every ceiling over that stretch (the apex of
  g·s(D−s)/(2v²) must fit the room left over the line). It still lands where it was aimed. A
  building in between, under open sky on both sides, is something to lob over.
- **collide** (`EnemyFire.step`, now level by level): what still meets a ceiling (a line already
  at the ceiling, a round past its aim point) stops just under it ('ceiling', on the shooter's
  level) and a grenade goes off there; rising out of doors over a wall into the level above, it
  flies on over the roof and lands on it (`onEnd` now gets the level it ended on) or beyond.
- the survivor's arrows (`stepFlight`) stop at a ceiling and drop to the floor under it.

**Live grenades** (`src/game/armed.ts`, BN `explosion_iuse`, `item::process_tool`). Pulling the
pin (`u`, the grenade's `transform` with `target_charges` 5: `Inventory.useTransform` now applies
BN's target_charges / rand_target_charges / target_ammo, so a packed LAW also unfolds loaded)
makes an active `grenade_act`; each turn of fuse burns a charge and "Tick."s
(`sound_volume`), and the tick that finds none left sets off its `explosion` where it is: in your
hand, or where it landed when thrown (`t`). Using it again says BN's no_deactivate_msg. A turn is
a combat turn, 1/3 s: a grenade's five turns are 1.7 s (menus pause, so pick and throw at
leisure). Dynamite (20 turns) and pipe bombs (6) work the same way. Before, the armed grenade
"ran out of power" after five turns and nothing happened.

Tests: `tests/blast.test.ts` (26): the HEAT/grenade/legacy data, the survivor's explosions and
CUSTOM_EXPLOSION reaching the one hook, a land mine, an EXPLODE death, multibash forces, BN's
bresenham, a wall broken by the wave no longer shielding, fragments breaking windows, a radius-5
blast reaching the floor above (radius 3 not), fling velocity and bounce, a dog thrown by a HEAT
blast, `vehicle::damage` armour/threshold, a HEAT blast wrecking a car and killing its engine,
the driver shielded by the closed door (and hit through the open one), a tank untouched by 12
grenades around it but dented by HEAT, fragments on a car, a fuel tank blowing up (and through
`detonate`, queued), the Abrams' HEAT round meeting the car it was aimed at, `shootVehicle` (9 mm
on a door, 4000 on Abrams plate), indoor lobs flattened under the ceiling and landing on target,
a lob whose line meets the ceiling stopping under it, a lob over a building and onto its roof,
an arrow loosed into the ceiling, the grenade's fuse held and thrown at a car, the LAW unfolding
loaded. `tests/enemyprojectiles.test.ts` and `tests/turret.test.ts` now run on the one blast.

**Real-input QA** (2026-10-11, Chromium on the GPU via `drive.ts serve --headful --gpu`, scripts in
the session scratchpad: `qa_heat.mts`, `qa_grenade.mts`, `qa_lob.mts`; 18/18 checks):
- the Abrams: `e` at the wheel, real W/A/S/D to the gunner, `e` mans the 120 mm, `r` loads HEAT
  from the rack, LMB at a car parked broadside 21 m out: one blast on the road at its near side,
  the car lost ~900 HP of 17653 with a frame and the windshield destroyed (the shell's impact
  and the multibash), "You hear a huge explosion"; the engine and the far side untouched.
- a hand grenade: `u` + Enter pulls the pin ("You pull the pin on the grenade.", 5/5), `t` +
  Enter throws it at a car 8 m off: it lands against the near doors (it used to fly through the
  car), ticks, goes off 1.5 s after the throw; windshield and a headlight destroyed, "You are hit
  by the shrapnel, but take no damage." (god mode). The M79's HEDP (LMB) at a second car: blast
  at the car, a halfboard destroyed.
- indoors (the refugee center lobby, a 2.6 m ceiling): the feral bio-operator 9 m down the room
  launched two 40 mm grenades (a launched lob is flat, ~0.5 m over its line: topped out at 1.7 m,
  nothing to flatten); both came down on the floor ('ground') on your level and went off there.
  The SWAT zombie's thrown tear gas at 8.5 m: flattened from 8.0 to 8.6 m/s, its apex 2.4 m (the
  unflattened arc reached 2.6 m, into the ceiling), and it struck a body as aimed
  (`lobswat_02_in_flight.png`: the canister just under the ceiling). The survivor's longbow (real
  RMB draw, the view turned up 55° with the real mouse, LMB looses) put its arrow into the ceiling
  and it dropped 0.8 m away.
- screenshots (session scratchpad `shots/blast/`): `heat_01_gunner_aimed_at_car.png`,
  `heat_03_blast.png`, `heat_07_wreck_blast_side.png`, `grenade_02_activate_picker.png`,
  `grenade_03_in_flight.png` (the live grenade lying at the car, "(4/5)"), `grenade_04_blast.png`,
  `m79_02_blast.png`, `lob_01_in_flight.png`, `lobswat_02_in_flight.png`,
  `arrow_01_drawn_at_ceiling.png`, `arrow_02_dropped.png`.

Limits: items on blasted tiles aren't smashed or flung; traps aren't set off by blasts; BN's
`break_off` (an already broken part torn off into scattered pieces) isn't modelled, so a broken
part soaks hits; a round that stops on a vehicle stops there (BN's flies on with what the part
didn't absorb); `obstructed_by_vehicle_rotation` (diagonal gaps in a rotated vehicle) isn't
checked; a fuel tank destroyed outright spills rather than exploding (as in BN, where it leaks
first), and its "loud pop" isn't played; NPCs don't arm explosives; a lob that starts outdoors and
ends indoors through a doorway is flattened only over the covered stretch at its end.

## Surface-aligned bullet marks

Persistent marks use pooled thin world meshes rather than camera-facing billboards. Only
explicitly landed, target-free hard-round misses/whiffs are eligible; arrows, unresolved
range endpoints, target-bearing misses and legacy events without a landing fact leave no
mark. Damage and projectile resolution are unchanged.

The renderer reconstructs height from the current camera and pitch, then verifies a solid
with a cosmetic raycast. This is an approximation: recoil, reticle offset and third-person
parallax can make it differ from the actual projectile. The verified point must be within
35 cm of the reconstructed endpoint (the search extends by the same bound). A loaded-only
wrapper checks each chunk before terrain/furniture/floor reads and abandons missing state
without generating the world. The inferred surface normal orients the patch, with an
8 mm outward offset. This does not claim authoritative projectile impact normals.

Marks retain the existing 30-real-second life and 60-mark cap, reuse pooled instances,
clear on load, and keep their world transform when the camera moves. Actual OS shots,
normal pistol stowing, walking and mouse-look produced the inspected
[wall](screenshots/gaps/impact-wall.png),
[oblique wall](screenshots/gaps/impact-wall-oblique.png) and
[floor](screenshots/gaps/impact-floor.png) captures. The wall patch stayed at y944.008
with tile normal(0,1,0); the floor patch stayed at absolute h0.008 with tile normal(0,0,1),
which maps to world up. The unresolved first floor-fixture shot had landed:false and
created no mark; the following landed:true floor shot consumed one round and created one.
The actual pool later had one allocated instance, zero used after expiry.

Tests exercise event classification, all four wall faces, floor/ceiling normals, bounded
height reconstruction, unrelated earlier obstacles, actual GameMap generation counters,
maximum storage, world-normal placement and expiry. This is a visual-correctness package;
it does not claim GPU performance or removal of the remaining tracer billboards.
