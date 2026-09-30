#!/usr/bin/env python3
"""Check that terrain/furniture/monster/vehicle/field ids exist in public/data.

Usage:
  check_ids.py ID [ID...]          report which kind each id is, or MISSING
  check_ids.py --grep REGEX        list ids (all kinds) matching REGEX
Exit status 1 if any id is missing, so recreation scenes fail loudly before a GPU run.
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".."))


def load():
    d = os.path.join(ROOT, "public", "data")
    kinds = {
        "terrain": json.load(open(os.path.join(d, "terrain.json"))),
        "furniture": json.load(open(os.path.join(d, "furniture.json"))),
        "monster": json.load(open(os.path.join(d, "monsters.json"))),
        "vehicle": json.load(open(os.path.join(d, "vehicles.json")))["vehicles"],
        "item": json.load(open(os.path.join(d, "items.json"))),
    }
    misc = json.load(open(os.path.join(d, "misc.json")))
    kinds["field"] = {f["id"] if isinstance(f, dict) and "id" in f else k: 1
                      for k, f in (misc["field_type"].items() if isinstance(misc["field_type"], dict)
                                   else enumerate(misc["field_type"]))}
    return kinds


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--grep")
    a = ap.parse_args()
    kinds = load()
    if a.grep:
        rx = re.compile(a.grep)
        for k, d in kinds.items():
            hits = [i for i in d if rx.search(str(i))]
            if hits:
                print(f"{k}: {' '.join(map(str, hits[:80]))}")
        return
    missing = 0
    for i in a.ids:
        found = [k for k, d in kinds.items() if i in d]
        print(f"{i}: {', '.join(found) if found else 'MISSING'}")
        missing += not found
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
