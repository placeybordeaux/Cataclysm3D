# Characters: 3D pixel-textured creatures (wave 3)

Monsters, NPCs and their corpses used to be camera-facing billboards of their UltiCa sprite.
Next to 3D geometry that read as cardboard cut-outs turning to follow you. They are now
**low-poly procedural bodies** in the Project Shadowglass manner: boxes with nearest-filtered
pixel-art textures at the project's **32 texels per metre**, **stepped animation** (10 poses
per second), turning to face where they walk or what they fight. The sprite is the
inspiration and the paint source; the model is the thing you walk around.

The billboards are still there as a variant.

| Switch | |
|---|---|
| `?chars=model` / `?chars=billboard` | URL, wins for the session |
| Options → **Creatures** | `3D models` / `sprites`, persisted (`localStorage cdda3d.chars`) |
| `cdda.chars('billboard')` | debug console; switches live, rebuilding every creature and body |
| `cdda.chars({ fps: 12 })` | pose rate (0 = every frame, smooth) |
| `cdda.chars({ far: [16, 45], emph: 0.35 })` | hostile readability ramp (m) and strength |
| `cdda.chars({ paint: 'sprite' })` / `?charpaint=sprite` | people painted by projecting the sprite (round 1) instead of the styled skins |
| `?viewmodel=model` / `?viewmodel=sprite`, Options → **First-person hands**, `cdda.chars({ viewmodel: 'sprite' })` | 3D first-person arms/items (default) or the classic 2D viewmodel sprites |
| `cdda.chars()` | current settings + live/body/skin/page counts |

## How it works (src/render/chars/)

| File | What |
|---|---|
| `archetype.ts` | Body plan from BN data: `bodytype` first (human, quadruped, dog, pig, bear, horse, gator, insect, spider, crab, bird, "flying insect", blob, snake, fish, frog, migo, angel), then species/flags/symbol for the ~120 without one (robots, plants, fungi, nether). Size from BN `volume` (ml), clamped. Zombie builds (fat, brute, hulk, child, skeleton…) from the id. Pure. |
| `rig.ts` | Rigid-part skeletons + poses per archetype: **humanoid** (hips, torso, head, two-segment arms and legs, feet; optional wings), **quadruped**/**critter** (body, head, 4 legs, tail, ears), **insect** (thorax, abdomen, head, 6 or 8 two-segment legs, antennae or fangs), **flyer** (body, head, wings, tail/abdomen), **blob** (mass + lumps, squash & stretch), **serpent** (7-segment chain), **plant** (base, stalk, bulb, leaves), **machine** (tracked body + turret head, or a turret), **lump** (fallback). Each pose function covers idle, walk/run, wind-up (melee/heavy/leap), strike follow-through, flinch, downed and dead. Pure. |
| `paint.ts` | Skins. Each box gets a Minecraft-style net; the part's rect of the sprite (opaque box, v down) is projected onto its front (people: drawn facing us) or right side (animals: drawn in profile, head to the right); other faces reuse the crop mirrored / its edge columns / hair rows for the back of heads. Sprite outlines are removed first (they would stripe every box edge), texels take the most common sprite colour in their footprint snapped to the sprite's own 16-colour ramp (a pixel-art downsample, not a blur), and every face gets a 1-texel darker rim. Pure (RGBA arrays), unit-tested. |
| `charLayer.ts` | Rendering: one `InstancedMesh` of a unit cube per skin page (1024², shelf-packed), one instance per body part. Per-instance face rects (the vertex shader picks the net rect from the face id), flash colour, sky visibility and the creature root (light-map sample, distance). Banded Lambert + light map + MRT normals like everything else, so outlines, flashlight, lamps and shadow maps just work. Two layers: live creatures (rewritten every frame) and bodies (rewritten only when one is added, removed or still falling). |
| `creature.ts` | Animation driver: stepped pose clock, gait from actual speed, facing that turns toward movement or the target it fights (9 rad/s), downed topple, and `FallingBody` (death: stagger along the killing blow, topple — backwards for people, onto a side for animals, onto the back for bugs — bounce, lie). |
| `index.ts` | Mode switch, shared layers per renderer, sprite pixel reading (atlas page or outfit composite canvas). |
| `playerModel.ts` | The survivor's own body in the third-person/top-down cameras, painted from the player's outfit composite (repainted when clothes change); hides the renderer's billboard via `renderer.playerBodyOverride`. |

`monsterView.ts` and `npcView.ts` keep all the combat-feel logic (telegraph warm/hot flashes,
rear-back, lunge, knock-back kicks, hit-stop, flinch shiver, downed, death sequence and the
body-landing callback) and feed it to either a billboard or a model. NPCs are painted from
their CDDA outfit composite (body + worn overlays + wielded item), so a survivor in a red
jacket is a 3D person in a red jacket; the skin is repainted when the outfit changes.

### Combat readability

- Wind-up: arms swing up over the head and the torso rears back (heavy: further, hands behind
  the head); a leap crouches with bent knees. The warm flash at the start and the hot flash just
  before the blow lands are unchanged. Animals crouch head-low or rear up; bugs rear their
  front legs; blobs stretch tall.
- Strike: arms slam forward, torso pitches in, the body lunges (same kick as before).
- Hits: red flash, knock-back and a head/torso flinch pose; hit-stop freezes the pose.
- Facing: a hostile winding up or within 2.5 m turns to face you; otherwise it faces where it
  walks. You can see which way a zombie is going, and that it has turned toward you.

### Distance readability

- **Far LOD thickening**: from 22 m to 55 m (`FAR_LOD` in `creature.ts`) limbs get up to 45%
  thicker (the core up to 18%), so a zombie stays a few pixels wide at 50 m instead of a
  1-pixel stick figure.
- **Hostile emphasis**: hostile creatures get a small self-lit share of their albedo ramping in
  from 16 m to 45 m (`cdda.chars({ far, emph })`), so they never sink into shade or dusk at
  range. Neutral animals and friendly NPCs don't.
- Box face rims and the post pass's crease outlines keep shapes separate from the ground.

### Picking and effects

Crosshair targeting, look cards and melee reach use the logical creature cylinder in
`game/raycast.ts` (`CREATURE_HEIGHT`), not render meshes, so they are unchanged. Blood sprays
and stuck arrows ask `MonsterView.bodyOf(m)` for the model's own height and half-width (the
billboard path still uses the sprite's art span). The point-blank sprite hacks (`nearClamp`,
`meleeAimLift`) only apply to billboards: a 3D zombie's head is at eye height anyway.

## Round 2: art pass

- **Styled person skins** (`styled.ts`, default for every humanoid): the sprite is read for a
  semantic palette — hair, skin, shirt/jacket (+ undershirt), upper/lower sleeve (bare arm vs
  cloth), pants, shoes, how bloody — and each region is painted deliberately: flat colour,
  a top-lit highlight row and 3 stepped shade bands, darker vertical edges, collar/neckline,
  placket or open jacket, belt + buckle, cuffs, hems, side seams, shoe soles and laces.
  Faces are hand-authored 8×8 pixel templates tinted by the skin (people: brows, eyes with
  whites, nose, lips; zombies: sunken sockets with yellow eyes, open mouth with teeth, jaw).
  The back of the head is hair. Blood is placed splatter decals (chest, hands, legs, a drip
  from a zombie's mouth); zombies get a torn shirt hem. A red shirt is not mistaken for gore.
  Animals keep the sprite projection (it reads well on fur) with the palette-snapped
  downsample.
- **Shapes**: every box can taper along its length (a per-instance attribute; the shadow
  pass uses the same taper). People got shoulders wider than the waist, a neck, fists,
  wrists/ankles narrower than elbows/knees, feet that narrow to the toe and a jaw narrower
  than the crown. Zombies get per-individual quirks from their seed: hunch, head tilt, a
  sideways lean, sometimes one arm hanging and dragging, a limp.
- **Animals**: deep chest / narrow loins, a tapered muzzle with a dark nose, tapering tail and
  legs. **Plants** (triffids, fungaloids) are a root-tendrilled, two-part bending stalk with a
  bulb head that opens in four petals around a dark maw, a whip and drooping leaves (petals
  flare and the whip coils during a wind-up). **Turrets** are a tripod + post with a slewing
  head, twin barrels and a red sensor eye; **robots** a sloped hull on tracks with a sensor
  dome, red visor and antenna.
- **Corpses** fall flat on their back or front (never sideways), arms flung out, feet pointed
  along the legs; nothing sticks up.
- **Weapons**: NPCs (and the survivor in third person) hold a mesh for what they wield
  (`weaponOf`: long guns / handguns by skill, bats and spears vs knives by volume). Guns are
  held at the ready with the off hand supporting; melee weapons hang from the fist.
- **Far figures**: monsters outside monai's 60-tile reality bubble aren't simulated, but
  dormant ones within the draw distance (≤130 m) are now drawn where they stand, idling, with
  the far-LOD thickening and hostile emphasis — a horde down a long road is visible
  (`after_horde_road`: 66–110 m).

## Round 3: the first-person view in 3D

`src/render/chars/fpView.ts` + `held.ts`. The flat pixel viewmodel was the most-seen 2D element
left; the hands and what they hold are now 3D in the same kit, drawn as the overlay scene
(after the world, same outline/dither/grade pass).

- **Not a second animation system.** `render/viewmodel.ts` still runs every pose — phased
  swings (anticipation/strike/follow-through/recovery), hit-stop, guard, block, thrust,
  recoil, reload dip / crossbow crank, ADS, bow/slingshot draw & loose, sling whirl, jolts,
  walk bob, look sway and the free-aim offset (`aimPx`). It now also publishes what it
  computed (`Viewmodel.state`, additive) and hides its sprites when `hide2d` is set; fpView
  maps those screen-space poses into a small perspective scene (grip point → a point in front
  of the eye, 2D rotation → roll/chop, `dy` → forward reach). Upcoming changes to the 2D
  animation (the combat agent's aim work) flow into the 3D view for free.
- **Arms**: forearm + upper arm + fist (knuckle ridge, folded thumb), painted by the styled
  person painter from the survivor's own outfit composite at 80 texels/m — sleeves and skin
  follow what you wear. Lit by the renderer's light-map sample at the player (`vm.tint`) with
  a fixed 3-band key light; muzzle flashes are unlit.
- **Held items** (`heldClass`: guns by BN skill, the rest by id/name keywords): pistol,
  rifle, SMG, shotgun (pump + wooden stock), launcher, crossbow (prod + string), knife,
  machete, sword, axe, hammer, bat (tapered barrel, taped grip), pipe/crowbar, spear (held
  low, two hands), flashlight (lens, head), and a generic object sized by volume in its sprite
  colours. Guns have sights and a muzzle point for the flash; two-handed items put the off
  hand on the support point. Down the sights the gun comes onto the eye axis following the
  free-aim offset.
- **Bow / slingshot**: riser and two limbs that bend with the draw, string halves that follow
  the nock, an arrow with head and fletching that appears when nocked; the right fist pinches
  the nock.
- Also this round: far figures **dither-fade** over the last 12 m before the draw distance
  instead of popping; zombies **shamble** — a per-individual lurch and sway onto the good leg.

## Performance

`tools/char-shots.ts --gpu --bench --views bench` (60 hostile zombies and dogs 8–45 m down
the street, `full` look, RTX 5080, 1920×1080, `cdda.benchView(6)`). Round 1 (machine quiet):

| | frame p50 | p95 | p99 | work p50 | draw calls | triangles |
|---|---|---|---|---|---|---|
| billboards (`?chars=billboard`) | 7.7 ms | 14.6 | 23.9 | 11.0 | 405 | 437.7 k |
| 3D models | 7.4 ms | 14.6 | 23.6 | 10.7 | 405 | 446.4 k |

Round 2 (after merging `bn`'s atmosphere; the machine was shared with other GPU jobs, so
compare within the run): billboards p50 13.8 ms / p99 34.6, work 19.6 ms; models p50 13.8 ms /
p99 39.6, work 18.5 ms — the same. Humanoids are now 16 parts (18 with wings, +1 weapon).

No measurable cost: ~800 part instances are one or two instanced draws (plus shadow), 12
triangles each. Matrices are rebuilt at the simulation rate (30 Hz) only for creatures that
moved; bodies are static once they land. Skins: a zombie is ~4 k texels; one 1024² page holds
~150–250 species/outfits; more pages are added as needed (a warning past 6 = 24 MB).

## Screenshots

`docs/screenshots/wave3/characters/` (JPEG q85) — `before_*` are the billboards, `after_*`
the models: zombie horde near / mid / far / down a long road (66–110 m) and at dusk, a dog,
NPCs (with weapons), corpses, a melee wind-up, critters, plus `after_zoo` (one of each body
plan), `after_night` (flashlight) and `after_third` (the survivor's own body), and the
first-person set `after_fp_*` (fists, punch, pistol firing, rifle hip/ADS/reload, shotgun,
bat idle/swing/guard, knife, axe, spear, katana, flashlight, bow at draw) with
`before_fp_*` for the sprite viewmodel. `tools/char-shots.ts --views fp_...` regenerates them.
Regenerate with

    ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/char-shots.ts --gpu --prefix after'
    ~/claude-stuff/bin/heavy --kind gpu --mem 2 -- nix-shell --run 'npx tsx tools/char-shots.ts --gpu --prefix before --params chars=billboard'

## Known gaps

- One body plan per archetype: a moose and a dog differ in proportions, not anatomy; spiders
  and ants share the insect plan; robots are a generic tracked machine.
- NPC weapons (third person) are simple boxes by kind; the first-person items are per class,
  not per item model.
- The first-person view has no separate eat/use pose: those use the 2D viewmodel's generic
  poses, mapped the same way.
- At 90–110 m a zombie is a few pixels tall; far figures are idle (dormant monsters only
  drift), and they appear/disappear at the draw distance.
- Hordes of hundreds: every live part is re-uploaded each frame (fine for dozens; see perf).
