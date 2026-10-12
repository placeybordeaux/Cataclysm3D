# Achievement event coverage

Gap-filling inventory (2026-10) for docs/IMPLEMENTATION_GAPS.md's Achievements row
("Requirements based on unsupported/untracked events never unlock and appear as
'not tracked.'"). See [achievement architecture](../ARCHITECTURE.md#scores--achievements-srcgameachievementsts-srcachievementsts-srcuiachievements_uits)
for the system itself (src/game/achievements.ts, src/achievements.ts, src/ui/achievements_ui.ts).

## Finding: the current BN achievement set is already fully tracked

`npm run extract:achievements -- --dry-run` against the local BN checkout (95 achievements, 70
`event_statistic`s, 68 `event_transformation`s — matches `public/data/achievements.json`
exactly, no drift) resolves, across every statistic and transformation chain, to exactly ten
BN event types:

| Event type (BN `event.h`) | Real game action that emits it (src/achievements.ts) |
| --- | --- |
| `game_start` | `installAchievements(...).begin(loaded)` on a fresh character |
| `avatar_moves` | per-tile movement (`step()`, driven by real walk/run/swim/stairs) |
| `character_wakes_up` | `p.isAsleep()` transitioning false (real sleep) |
| `character_kills_monster` | `creatureDied` with `killer === game.player` |
| `character_takes_damage` | the `playerHurt` event |
| `character_heals_damage` | HP regain seen by the 2 Hz poll (`poll()`) |
| `character_gets_headshot` | the `playerHeadshot` event (src/game/playercombat.ts) |
| `gains_skill_level` | the poll diffing `p.skills[*].level` |
| `gains_mutation` → `crosses_mutation_threshold` / `crosses_mycus_threshold` | the poll diffing `p.traits` against `misc.mutation_category` threshold data |

`AchievementTracker.achievementSupported()` checks every achievement's requirements (plus
`kill_requirements` → `character_kills_monster`, `skill_requirements` → `gains_skill_level`)
against `SUPPORTED_EVENTS`, which is a superset of the ten above. A new regression test,
`tests/achievements.test.ts` "every current BN achievement is supported", asserts zero
achievements in the live data are unsupported — it currently passes, and will fail loudly if
a future BN data refresh adds an achievement this port can't yet feed (or if `SUPPORTED_EVENTS`
regresses), rather than that achievement silently going "not tracked" in the UI.

Concretely, BN's 95 achievements are all kill-count (by species, via `kill_requirements`),
skill-level (16 skills × level 5/10, via `skill_requirements`), movement/travel (distance,
z-level, terrain flags, swimming — all `avatar_moves` derivatives), survival/wake-up, and
mutation-threshold achievements. BN ships **no** achievements keyed on crafting, butchering,
bionic installation, reading, vehicle travel distance, or kill-by-weapon-type — those were
reasonable guesses for what might be missing, but BN's own `data/json/achievements.json` and
`statistics.json` don't define any achievement that needs them. (BN's `event_type` enum defines
several dozen more event types — `reads_book` doesn't even exist there; the port's
`SUPPORTED_EVENTS`/`src/achievements.ts` additionally carry a few non-BN event names such as
`character_wields_item`, `character_consumes_item`, `installs_cbm`, `broken_bone`,
`avatar_enters_omt` — left over from an earlier, CDDA-upstream-shaped version of this system
(see the `12e887d Achievements on Bright Nights data` migration). No current achievement
depends on them; they're otherwise-unused, harmless emits, not a gap.)

## Not tracked (named, with reason)

- **Mod achievements** (`data/mods/Arcana_BN/achievements.json`): this port's extractor
  (`tools/extract/cdda.ts: loadCddaObjects`) only reads `<cddaDir>/data/json`, matching every
  other content system here — mods are out of scope project-wide, not an achievements-specific
  gap.
- **BN event types with no current achievement use** (`character_triggers_trap`,
  `gains_addiction`, `teleports_into_wall`, `learns_martial_art`, and the rest of BN's ~60
  `event_type`s not listed in the table above): real, documented BN events, but nothing in BN's
  own achievement/statistic data reads them, so there is nothing to unlock and nothing to fake
  by adding them. `tests/achievements.test.ts` "marks achievements fed by events this port never
  emits as unsupported" exercises this path with a synthetic achievement on
  `character_triggers_trap`, confirming `achievementSupported()` correctly flags it (and that the
  UI's "Not tracked by this port yet" section would list it, were BN ever to add one).

## What this means for the row in docs/IMPLEMENTATION_GAPS.md

The row is accurate as a general statement of the mechanism (an achievement whose events this
port doesn't emit shows as "not tracked" and never unlocks — see the synthetic test above) but,
for BN's actual current achievement data, the set of events actually needed was already closed
out by prior work (`aea780b` through `12e887d`, well before this gap-filling pass) migrating the
system from upstream CDDA's achievement set to BN's own, much smaller one. No event-emission
code changes were needed or made in this pass; the work here is the inventory above, the
regression test locking it in, and the real-input verification below.

## Real-input verification

`tools/realinput.ts --only achievements` (`tools/realinput_achievements.ts`): spawns one weak,
adjacent zombie and kills it with real LMB sword swings (a bat), then walks with a real held W.
Both are tracked through the real game paths above, not the debug event API:

- A real kill completes `achievement_kill_zombie` ("One Down, Billions to Go…") through the
  actual `creatureDied` → `character_kills_monster` path (and, since it happens in the first
  minute of the run, also completes the time-gated `achievement_kill_in_first_minute`, "Rude
  Awakening" — both visible in the screenshot below).
- Real walking advances `num_moves_walked` and the (un-completed, 1 000-mile) travel
  achievement's progress bar through the real `avatar_moves` path.
- The `)` achievements screen shows both: the zombie-kill card green ("got") with its
  completion time, the travel card's progress bar showing the real square count.

Screenshot: [docs/screenshots/gaps/achievements-realinput-kill-and-travel.png](screenshots/gaps/achievements-realinput-kill-and-travel.png)
("2 of 95 completed", both achievements shown completed with their unlock time, "Kills" tab
badge at 1).
