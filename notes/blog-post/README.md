# Blog-post notes: building Cataclysm3D

Material for a long-form post about how Cataclysm3D was built by a lead Claude Code session and ~70
subagents. Updated 2026-10-26 (first snapshot 2026-09-30 11:26 PDT). The `w-*` images are copies of
agents' evidence screenshots from `docs/screenshots/`, not blog renders. The project was called
CDDA-3D until 2026-10-30; verbatim quotes from the sessions keep the old name.

| file | what |
|---|---|
| `index.html` | The briefing page (headline numbers, prompt, timeline, charts, gallery, differences, quotes, post outline). Self-contained; images by relative path `images/…`. Written to the artifact page contract (no `<html>/<head>/<body>` wrapper; the publisher adds it). |
| `facts.md` | Every number, with how it was computed and what can't be counted |
| `differences.md` | ~250 categorized differences from Cataclysm (DDA/BN), each with a why-tag and source |
| `recreations.md` | The two official screenshots (BN readme title, DDA UltiCa showcase) rebuilt in the engine: inventories, method, mismatches; originals in `images/originals/` (CC BY-SA 3.0) |
| `commentary.md` | Verbatim quotes from the user, the lead and subagents: fidelity bugs, lessons, corrections, debates |
| `images/` | In-engine image suite (half-size JPEGs + `*-hero.jpg` at 1920×1080) and `captions.md` (what, how made) |
| `data/` | Raw script output: `transcript_stats.{md,json}`, `code_stats.{md,json}`, `growth.csv`, `commits_per_hour.txt` |
| `scripts/` | The scripts below |
| `transcripts.sqlite` | Git-ignored; rebuilt by `load_transcripts.py` |

## Regenerating the numbers

Two steps, so the analysis can change without re-parsing ~1.1 GB of JSONL:

```sh
cd notes/blog-post
python3 scripts/load_transcripts.py            # ~/.claude/projects/-home-peter-code-CDDA-3d → transcripts.sqlite
python3 scripts/analyse.py --json data/transcript_stats.json > data/transcript_stats.md
python3 scripts/code_stats.py --json data/code_stats.json --growth-csv data/growth.csv > data/code_stats.md
git log bn --format='%ad' --date=format:'%Y-%m-%d %H' | sort | uniq -c \
  | awk '{print $2"T"$3":00 "$1}' > data/commits_per_hour.txt
python3 scripts/grep_transcripts.py 'snowstorm'   # find / verify a quote
```

All scripts take `--help`; `load_transcripts.py --dry-run` lists what it would read. Phase
boundaries live in `analyse.py:PHASES` and `code_stats.py:PHASES`. Re-running later will include
work done after the snapshot (including the agents that made this folder), so numbers will grow.

## Regenerating the images

See `images/captions.md` for the per-image setup and the capture command. GPU runs go through
`~/claude-stuff/bin/heavy --kind gpu --mem 2`.

## Publishing

The lead publishes `index.html` as an artifact with the images as supporting files
(`files: {"images/<name>.jpg": "notes/blog-post/images/<name>.jpg", …}`). Nothing here is published.
Personal data: no emails; machine paths only where needed to regenerate.
