#!/usr/bin/env python3
"""Resolve git conflict hunks by keeping both sides (ours, then theirs).

For additive conflicts in hot files (imports, install calls). Review the result!
Usage: tools/dev/union-merge.py FILE... [--dry-run]
"""
import re, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
if not args or '--help' in sys.argv:
    print(__doc__); sys.exit(0)
pat = re.compile(r'<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n', re.S)
for f in args:
    s = open(f).read()
    n = len(pat.findall(s))
    out = pat.sub(lambda m: m.group(1) + ''.join(l for l in m.group(2).splitlines(True) if l not in m.group(1).splitlines(True)), s)
    print(f'{f}: {n} hunks')
    if '--dry-run' not in sys.argv:
        open(f, 'w').write(out)
