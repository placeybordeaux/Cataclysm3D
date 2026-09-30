# CDDA-3D: the story in numbers

Snapshot taken **2026-09-30 11:26 PDT** (last API call in the transcripts at load time). The project
is still being worked on (VR, vehicles v3, perf telemetry and this blog brief were in flight), so
anything marked *snapshot* will keep moving. Every number below says how it was computed;
the scripts are in `scripts/` and their raw output is in `data/`.

Times are PDT (the machine's zone). The transcripts store UTC; PDT = UTC − 7 h.

## Headline numbers

| | value | how |
|---|---|---|
| Time from first prompt to "CDDA-3D is finished" (v1) | **5 h 26 min** | first user message 22:25:00 PDT Sep 28 → lead's completion message 03:51:03 PDT Sep 29 (transcript timestamps) |
| Human input before that first working copy | **1 prompt + 1 round of 4 multiple-choice questions** (one answered with a free-text note) | `user_msgs` + `ask_answers` tables, lead session, before 03:51 PDT |
| Manual tool approvals | **0 recorded** | every `permissionMode` record in both lead transcripts is `auto` (332 records); no permission-request records exist |
| Total elapsed so far | **~37 h** (22:25 Sep 28 → 11:26 Sep 30) | wall clock, includes sleep and idle time |
| Lead sessions | **2** (split by `/clear` at 22:43 PDT Sep 29) | `~/.claude/projects/-home-peter-code-CDDA-3d/*.jsonl` |
| Subagent transcripts | **72** (61 spawned by the lead + 11 nested forks/sub-subagents) *snapshot* | `<session>/subagents/*.jsonl`, `spawnDepth` in `.meta.json` |
| Subagent wall-clock | **76 agent-hours**; peak **7 agents at once** | sum of first-to-last message span per subagent; sweep over start/end events |
| API responses | **16,354** | assistant messages de-duplicated on message id |
| Tool calls | **18,587** (Bash 14,224 · Read 1,968 · Write 1,302 · Edit 690 · Agent 77) | `tool_use` blocks |
| Output tokens (visible in transcripts) | **4.3 M** (of which 0.55 M thinking) | max usage per message id, summed |
| Context tokens processed | **5.46 B cache reads + 95 M cache writes + 33 k uncached input** | same |
| TypeScript/JS code (bn head) | **111,454 lines** (plus 16.6 k comment lines) | `scripts/code_stats.py` over git objects, excluding `public/`, `vendor/`, `notes/` |
| Test files / test cases | **87 files**, 1,059 `it()`/`test()` calls (static); the lead's last `npm test` on bn: **1,238 passing** | static count in `code_stats.py`; runtime count from the lead's merge report 11:14 PDT Sep 30 |
| Commits | **495 on `bn`** (108 merges), 500 across all refs; **63** subagent worktree branches | `git rev-list`, `git for-each-ref` |
| Lines added / removed (bn, non-merge, excl. `public/` and screenshots) | **+160,632 / −13,520** | `git log --numstat` |
| Docs | **24 Markdown files**, ~6,150 lines; 439 committed screenshots | `code_stats.py`, `find docs/screenshots` |
| Messages the person typed in total | **33 typed + 4 typed-while-busy**, and **13 multiple-choice questions** across 4 rounds | `user_msgs`, `ask_answers` |

## 1. The original prompt (verbatim)

First user message of the first session, 2026-09-28 22:25:00 PDT (typos kept):

> You have a large task ahead of you. You're going to be making a real time 3d version of Cataclysm Dark Days Ahead. You'll be aiming to keep as much of the style, content & approaches to game design as possible while converting this to a fully real time 3d game. This is an excersize in determining how much you can do *automomously* there will be a brief period at the start to ask the user questions. After that you are expected to lead a team of subagents to deliver a fully working game. You'll be judged on completeness, how much you were able to retain and enjoyment. Bonus points for closely using similar graphical style by immitating the graphic appraoch used by project shadowglass. Now is your opportunity for asking questions go!

### The only questions asked before v1 (one AskUserQuestion round, 22:25:56 PDT)

| # | question (lead) | options offered | answer |
|---|---|---|---|
| 1 | Which engine/platform should the 3D game target? | Browser: Three.js + TS (Recommended) · Godot 4 · Rust + Bevy · You pick | **"You pick, note this is NixOS so you can use anything that can be accessed via nixpkgs"** (free text) |
| 2 | What is 'project shadowglass'? I'm not sure which project you mean. | I'll paste a link · Research it yourself | **Research it yourself** |
| 3 | How should the game use CDDA's content (JSON data, tilesets, sounds)? CDDA is CC-BY-SA. | Import CDDA JSON directly (Recommended) · Hand-curated subset | **Import CDDA JSON directly** |
| 4 | How much autonomy and scale are you comfortable with? | Go big, many hours · Moderate | **Go big, many hours** |

After that the person typed nothing until 07:09 PDT: *"what's the status are you done? Is it ready for human review?"*

### Defining "first working copy"

**The first working copy is commit `0251064` (03:48 PDT Sep 29), announced by the lead at 03:51 PDT
as "CDDA-3D is finished: a complete, playable real-time first-person Cataclysm: DDA that runs in the
browser".** Justification:

- It is the end of the autonomous run: the last v1 agent (QA3, a full-run regression pass that played
  the whole loop on the built game) reported at 03:50 PDT with no crash or blocking bug, and the lead
  declared completion one minute later. Typecheck, 565 tests and the production build passed.
- Nothing changed between then and the person's first check-in at 07:09 PDT.
- Alternatives considered: the earliest *booting* build (the game "boots into a real CDDA evac
  shelter" at 23:10 PDT, 45 minutes in, lead message at 06:10:31Z) is too early to call a game; the
  `v1-dda` tag (08:21 PDT, `aff1709`) already includes the person's first round of UX feedback
  (Shift+W opening the wear menu, Esc releasing the mouse), so it's not "before feedback".

**Human input to reach it:** 1 free-form prompt, 1 AskUserQuestion round with 4 questions (3 option
picks, 1 free-text answer), 0 other messages, 0 manual approvals (auto permission mode).

## 2. Timeline

| phase | when (PDT) | wall clock | what happened | person's input |
|---|---|---|---|---|
| **v1 autonomous build** (DDA data) | Sep 28 22:25 → Sep 29 03:51 | 5 h 26 m | scaffold commit at 22:33 (8 min in); 24 subagents in waves (data, atlas, render, worldgen, core → UI, interaction, monsters, crafting, render 2 → vehicles, save, NPCs, QA1 → mutations, seasons, polish, QA2, combat depth, content → cleanup, QA3); 123 commits | 1 prompt, 4 answers |
| idle | 03:51 → 07:09 | 3 h 18 m | person asleep; nothing running | — |
| **v1 review + UX pass** | 07:09 → 08:37 | 1 h 28 m | UX review agent with *real* keyboard/mouse (xdotool on Xvfb); key rebinding, pointer-lock state machine; tagged `v1-dda` at 08:21 | 4 typed + 1 queued |
| **v2: Bright Nights push** | Sep 29 08:37 → 22:43 | ~14 h | switch to Cataclysm: Bright Nights data/rules on branch `bn`; modern drag-and-drop UI, item-conservation inventory, progression/unlocks, difficulty presets, combat feel, looting, archery, driving camera; interactive with the person playing live via hot reload | 16 typed + 2 queued; 3 AskUserQuestion rounds (9 questions) |
| **wave 3 overnight** | Sep 29 22:49 → Sep 30 07:14 | ~8.5 h (agents 22:52→05:04) | "TV adaptation" wave: Shadowglass-style 3D models for characters, furniture, vehicles, trees; readability at distance; aim-based combat; new-player adaptation pass; integrated QA. **Hit the session usage limit 02:18–03:40 PDT** (15 rate-limit messages); agents resumed after reset | 1 typed |
| **wave 4 interactive** (current) | Sep 30 07:14 → snapshot 11:26 | 4 h+ | style gallery, driving collision on drawn body, vehicles v3 research + phase 1, walkable stairs, bike riders, VR (WebXR) branch, streaming perf telemetry, this blog brief | 11 typed + 1 queued; 8 design questions answered in one free-text message |

Source: `data/transcript_stats.md` (phase cut-offs at the person's messages that started each push,
defined in `scripts/analyse.py:PHASES`), git log.

## 3. Tokens, calls and agents

### What is counted

- Every assistant message in the 2 lead transcripts and 72 subagent transcripts. Claude Code writes
  one JSONL line per content block and repeats the message's `usage` on each; early lines carry
  partial output counts, so each field is the **max over lines with the same message id**.
- Tokens are Anthropic's four usage buckets: uncached input, cache writes (`cache_creation`), cache
  reads, output (which includes thinking; thinking is also shown separately).
- Model: all 16,339 real responses are `claude-opus-5-5`; 15 more are synthetic rate-limit notices.

### Per phase

| phase | API responses | uncached input | cache write | cache read | output (incl. thinking) | thinking | tool calls |
|---|---:|---:|---:|---:|---:|---:|---:|
| v1 autonomous build | 5,323 | 10.7 k | 11.5 M | 1.50 B | 1.4 M | 154 k | 5,962 |
| v1 review + UX pass | 310 | 0.6 k | 0.9 M | 95 M | 111 k | 29 k | 363 |
| v2 Bright Nights push | 6,057 | 12.2 k | 17.3 M | 2.14 B | 1.7 M | 230 k | 6,692 |
| wave 3 overnight | 3,518 | 7.2 k | 60.3 M | 1.50 B | 768 k | 105 k | 4,416 |
| wave 4 interactive *snapshot* | 1,146 | 2.3 k | 5.4 M | 233 M | 354 k | 35 k | 1,305 |
| **total** | **16,354** | **33.0 k** | **95.4 M** | **5.46 B** | **4.30 M** | **552 k** | **18,587** |

Exact totals: input 32,978 · cache write 95,388,386 · cache read 5,464,238,743 · output 4,299,743 · thinking 552,329.

| role | API responses | cache read | output |
|---|---:|---:|---:|
| lead (2 sessions) | 709 | 279 M | 494 k |
| subagents (72) | 15,645 | 5.18 B | 3.81 M |

The lead did ~4% of the calls and ~11% of the output: it planned, briefed, merged and reported; the
subagents wrote the game. Wave 3 wrote 60 M cache tokens (vs 11–17 M in other phases) because its six
agents each ran 5–6 hours on large rendering work with long contexts.

### Subagents

| phase | spawned by lead | nested (forks / sub-subagents) |
|---|---:|---:|
| v1 autonomous build | 24 | 1 |
| v1 review + UX pass | 1 | 0 |
| v2 Bright Nights push | 20 | 5 |
| wave 3 overnight | 7 | 0 |
| wave 4 interactive *snapshot* | 9 | 5 (includes this blog brief's two helper forks) |

The Agent tool was called 77 times; SendMessage 68 times (the lead passing merges and fixes to running
agents, resuming finished ones, and agents messaging back). 93 hand-back reports were delivered
(some agents reported more than once after being resumed).

Longest-running: "New-player adaptation pass" (wave 3; 6 h 08 m, 1,139 API calls, 503 M cache reads),
"Furniture and props models" (6 h 12 m), "Distance readability" (6 h 06 m), "3D characters and
monsters" (5 h 57 m). Wave 1 agents typically finished in 10–45 minutes.

### What can't be counted from transcripts (be careful quoting)

- **Claude Code's own session meter is higher.** Session 1 ended with a `cost-state` record whose
  model usage (lead + its subagents) is: 3.89 M uncached input, 28.9 M cache writes, 4.66 B cache
  reads, **8.88 M output (2.53 M thinking)**, plus a little Haiku (52 k input, 3 web searches). The
  transcript messages of the same session sum to 23 k / 29.8 M / 3.73 B / 3.18 M. Cache writes agree;
  the other buckets don't. The gap is model work that doesn't appear as transcript messages — most
  likely the auto-mode permission classifier that reviews tool calls (every assistant message carries
  a `serverClassifierRequest` field) and side calls like titles and summaries. We can't attribute it
  per call, so **the transcript numbers above are a lower bound**. Session 2 has no cost-state record
  yet (still running).
- The same record gives, for session 1 only: API time 28.8 h, **lines added 121,559 / removed 6,400**
  (Claude Code's own edit counter), and a list-price cost-equivalent of **$1,280**. That dollar figure
  is Claude Code's estimate at API prices, not what was paid (the work ran on a subscription and hit
  its session limit once); quote it only with that caveat, or not at all.
- Rate-limit interruption: 02:18–03:40 PDT Sep 30 all running wave-3 agents stopped ("You've hit your
  session limit · resets 3:40am"); they resumed after the reset. The 15 synthetic messages are excluded
  from token totals.
- No transcripts are missing: the 70 background-task `.output` files under `/tmp/claude-1000/…/tasks/`
  are symlinks to the same subagent JSONL (all resolve); the other 223 are background shell outputs.

## 4. Code

At `bn` head `e7e9bf1` (11:13 PDT Sep 30). `scripts/code_stats.py`, which reads git objects and
classifies lines as code/comment/blank (C-style comments for TS/JS/CSS, `#` for Python/shell/Nix).
Excludes `public/` (extracted data, atlas, audio, fonts), `vendor/`, `node_modules/`, `notes/`.

| language | files | code | comment | blank |
|---|---:|---:|---:|---:|
| TypeScript | 531 | 110,900 | 16,644 | 8,748 |
| Markdown | 24 | 5,313 | — | 840 |
| CSS | 16 | 1,417 | 121 | 88 |
| JavaScript | 4 | 554 | 84 | 1 |
| other (JSON, shell, Python, HTML, Nix) | 7 | 126 | 18 | 1 |

| area | files | code lines |
|---|---:|---:|
| `src/game` (rules, items, combat, vehicles, NPCs…) | 92 | 27,982 |
| `src/render` (3D pipeline, models, lighting) | 98 | 22,311 |
| `tests` | 89 | 16,274 |
| `src/ui` (v1 curses-style UI, still selectable) | 65 | 11,593 |
| `tools` (extractors, screenshot/real-input/bench tools) | 58 | 10,597 |
| `src/ui2` (modern UI toolkit) | 48 | 6,916 |
| `src/world` (mapgen interpreter, overmap) | 19 | 3,804 |
| `src` root (main, game loop, debug API) | 16 | 3,573 |
| `src/screens` | 16 | 2,601 |
| `src/progression` | 13 | 1,881 |
| `src/audio` | 11 | 1,524 |
| `src/save` | 11 | 1,455 |
| `src/gallery` | 5 | 1,168 |
| `src/data`, `src/core`, `src/dev` | 12 | 1,232 |

### Growth (`data/growth.csv`)

| milestone | commit | PDT | commits on branch | TS/JS code | src | tests | tools | test files | Markdown lines |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| scaffold (first commit) | ce7b579 | Sep 28 22:33 | 1 | 1,014 | 933 | 0 | 80 | 0 | 133 |
| **v1 first working copy** | 0251064 | Sep 29 03:48 | 123 | 52,760 | 41,297 | 7,890 | 3,684 | 36 | 681 |
| v1-dda tag | aff1709 | Sep 29 08:21 | 134 | 54,546 | 42,160 | 8,096 | 4,405 | 38 | 816 |
| end of v2 (BN) | 941157a | Sep 29 22:41 | 301 | 87,138 | 67,435 | 12,930 | 8,013 | 62 | 2,854 |
| end of wave 3 | 3e89023 | Sep 30 05:11 | 479 | 107,083 | 82,968 | 15,493 | 9,985 | 84 | 4,983 |
| bn head | e7e9bf1 | Sep 30 11:13 | 495 | 111,454 | 86,040 | 16,274 | 10,597 | 87 | 6,153 |

So: **~53 k lines of TypeScript in the first 5.4 hours**, ~87 k by the end of day one, ~111 k now.
Commits per hour are in `data/commits_per_hour.txt` (peak 56 in one hour, 00:00–01:00 PDT Sep 30 during v2; v1 peaked at 45 in 01:00–02:00 PDT Sep 29; counted on `bn`, merges included).

Git: 495 commits on `bn`, 108 of them merges (the lead merging subagent branches); 377 of the 387
non-merge commits carry a Claude co-author trailer (the rest are merge-resolution / lead commits
without it). 63 `worktree-agent-*` branches remain; each subagent worked in its own git worktree and
the lead merged.

### Data extracted from Bright Nights (`public/data/`, 21.0 MB JSON)

| file | size | contents |
|---|---:|---|
| items.json | 5.8 MB | 6,061 item types |
| mapgen.json | 3.5 MB | 2,247 overmap-terrain mapgens, 785 nested chunks |
| recipes.json | 2.5 MB | 3,187 recipes |
| misc.json | 2.5 MB | 632 constructions, 1,093 uncrafts, 760 mutations, 144 bionics, 266 professions, 40 scenarios, 37 martial arts, 181 techniques, 287 effects… |
| item_groups.json | 1.2 MB | 2,688 item groups |
| vehicles.json | 1.2 MB | 257 vehicle prototypes, 813 vehicle parts |
| npcs.json | 1.2 MB | 979 dialogue topics, 177 missions, 105 NPC templates, 17 factions |
| monsters.json | 0.8 MB | 615 monster types (232 monster groups) |
| overmap.json | 0.7 MB | 2,261 overmap terrains, 437 overmap specials |
| terrain / furniture | 1.0 MB | 869 terrains, 490 furniture |
| achievements.json | 58 kB | 95 achievements, 70 statistics |

Plus the UltiCa tileset compiled into a 14.8 MB GPU atlas (12k sprites), 16.9 MB of CC-licensed
sound (402 files) and 12.8 MB of fonts. v1 used DDA data: the lead reported "10k items, 1.2k
monsters, 5.6k recipes and 12k sprites" after the first extraction, and NPC dialogue "running all
3,272 CDDA talk topics".

## 5. The person's messages after v1 (what steered the rest)

All typed messages are in the transcripts' `user_msgs` table (lead sessions, `kind in
('human','queued_human')`). Themes, in order: UX bugs from real play (Shift+W → wear menu, Esc
losing the mouse) → hot reload and "can you see my game" (led to the live bridge) → **switch to
Bright Nights and aggressively overhaul UX for a new audience** → driving is unreadable ("everything
is SO flat") → looting is laborious → deploy question → archery feedback ("sounds like a gun and has
the mussel flash lol") → windows, flashlights, a levitating zombie, a fire that wouldn't light → wave
3's "TV adaptation of a book" brief → style gallery → vehicle sizes and a deathmobile builder → walkable
stairs → set of chosen defaults → VR → performance telemetry → this blog post.
