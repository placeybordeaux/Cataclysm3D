# Audio notes: bash / smash sounds

The engine, soundset and `sfx.*` helpers are described in ARCHITECTURE.md ("Audio"). This note
covers what a bash plays and how tests prove a sound was heard.

## What a bash plays (`src/audio/bashSounds.ts`)

User report: "when you smash a door there's no sound (it just says whump)". BN's `map::bash`
plays `smash_fail/<ter or furn id>` for a blow that holds and `smash_success/<id>` for one that
breaks it; the soundpack decides. CC-Sounds names ~300 of the ~1250 bashable ids and has no
`default`, so most bashes had only our quiet synthesized thud (a 250 Hz low-passed noise that
small speakers barely reproduce) and every door the pack doesn't name (open doors, metal and
glass doors, gates) sounded like that. A cold first blow could also be dropped: a one-shot whose
sample isn't decoded within 400 ms is discarded, and smash samples weren't preloaded.

Now `sfx.smash(pos, { success, targetId, material })` resolves, in order:

1. the pack's exact variant for the id (`smash_fail/t_door_c`: CC-Sounds' door knock);
2. the representative pack variant for the thing's **material**, from BN's bash description
   ("glass breaking!", "clang!", "rrrrip!") plus id/flags: glass, window, ceramic, door_wood,
   wood, wall, brick, concrete, metal, chain_link, plastic (`MATERIAL_SOUNDS`);
3. synthesized `soft` (cloth, tents, bushes) and `wet` (alien/organic) sounds, `explosion/small`
   for resin "boom!", and the generic smash only for BN's joke strings (`DELIBERATELY_GENERIC`).

It plays at the bashed tile for whoever bashes (the player's X or melee swing, monsters, cars),
and `smash*`, `open_door` and `close_door` are preloaded.

`tests/bash_sounds.test.ts` fails if any bash string in the data has no material, any bashable
thing resolves to a sample that doesn't exist, or a representative variant disappears from the
pack. `tools/realinput.ts --only smashsound` smashes doors (X and bat swings) and a window with
real input and checks each logged "whump!" against the samples that actually started.

## Proving a sound was heard

- Browser: `cdda.audio.history` (last 64) now has `outcome`: `pending` while the sample loads,
  `playing` once it started, `stale` if it arrived too late and was dropped, `failed` on a load
  error, plus `waitMs`.
- Unit tests: `recordSfx()` makes every `sfx.*` request land in `sfxRequests` (id, variant, pos),
  and `setSfxCatalog(has)` gives `sfx` the shipped soundset without WebAudio.

## Known gaps

- BN measures bash loudness in dB now (`sound_vol` default 20 dB + strength); our hearing model
  still uses tile volumes (`sound_fail_vol` default 12), unchanged here.
- No vehicle-part smashing by the player exists yet; car collisions already play
  `smash_success/hit_vehicle`.
