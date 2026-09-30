#!/usr/bin/env python3
"""Build notes/blog-post/index.html from the notes in this folder.

Inputs: data/transcript_stats.json, data/code_stats.json, differences.md, commentary.md,
images/captions.md. The page is written to the artifact page contract (no <html>/<head>/<body>
wrapper; the publisher adds one) and references images by relative path `images/<file>`.

The Markdown converter below handles only what these notes use (headings, numbered/bulleted
lists, blockquotes, bold/italic/code, links, tables). It fails loudly on a missing input rather
than emitting a page with holes.

Usage:
  build_index.py [--out index.html] [--dry-run]
"""
import argparse
import html
import json
import os
import re
import sys

HERE = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def need(path):
    p = os.path.join(HERE, path)
    if not os.path.exists(p):
        sys.exit(f"missing input: {path}")
    return p


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<![*\w])\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', s)
    return s


def md_to_html(text, skip_h1=True):
    out, para, lst, quote = [], [], None, []

    def flush():
        nonlocal para, lst, quote
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para = []
        if lst:
            tag, items = lst
            out.append(f"<{tag}>" + "".join(f"<li>{inline(i)}</li>" for i in items) + f"</{tag}>")
            lst = None
        if quote:
            out.append("<blockquote>" + md_to_html("\n".join(quote), skip_h1=False) + "</blockquote>")
            quote = []

    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(">"):
            if para or lst:
                q = quote; quote = []; flush(); quote = q
            quote.append(line[1:].lstrip() if line.startswith("> ") or line == ">" else line[1:])
            i += 1
            continue
        elif quote:
            flush()
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            flush()
            head = [c.strip() for c in line.strip().strip("|").split("|")]
            rows = []
            i += 2
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            out.append('<div class="tablewrap"><table><thead><tr>' + "".join(f"<th>{inline(h)}</th>" for h in head)
                       + "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>"
                                                         for r in rows) + "</tbody></table></div>")
            continue
        m = re.match(r"^(#{1,4}) (.*)", line)
        if m:
            flush()
            level = len(m.group(1))
            if not (skip_h1 and level == 1):
                out.append(f"<h{level + 1}>{inline(m.group(2))}</h{level + 1}>")
        elif re.match(r"^\s*(\d+\.|-|\*) ", line):
            if para:
                flush()
            tag = "ol" if re.match(r"^\s*\d+\.", line) else "ul"
            item = re.sub(r"^\s*(\d+\.|-|\*) ", "", line)
            if lst and lst[0] == tag:
                lst[1].append(item)
            else:
                flush()
                lst = (tag, [item])
        elif line.strip() == "---":
            flush()
            out.append("<hr>")
        elif not line.strip():
            flush()
        elif lst and line.startswith("  "):
            lst[1][-1] += " " + line.strip()
        else:
            if lst:
                flush()
            para.append(line.strip())
        i += 1
    flush()
    return "\n".join(out)


TAGS = ["medium adaptation", "new-player design", "simplification", "fidelity fix", "not yet implemented",
        "engine limitation"]


def differences_html():
    text = open(need("differences.md")).read()
    sections = re.split(r"^## ", text, flags=re.M)
    intro = sections[0]
    cats = []
    for sec in sections[1:]:
        title, _, body = sec.partition("\n")
        if not re.match(r"\d+\.", title):
            continue
        items = []
        for line in body.splitlines():
            m = re.match(r"^\d+\. (.*)", line)
            if m:
                items.append(m.group(1))
            elif items and line.startswith("   "):
                items[-1] += " " + line.strip()
        lead = "\n".join(l for l in body.splitlines() if l.strip() and not re.match(r"^\d+\. ", l)
                         and not l.startswith("   "))
        cats.append((title.strip(), lead, items))
    total = sum(len(c[2]) for c in cats)
    parts = ['<div class="filters" role="group" aria-label="Filter by reason">'
             '<button type="button" class="chip on" data-tag="all" id="f-all">All</button>']
    for t in TAGS:
        slug = t.replace(" ", "-")
        parts.append(f'<button type="button" class="chip" data-tag="{slug}" id="f-{slug}">{t}</button>')
    parts.append("</div>")
    for title, lead, items in cats:
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        parts.append(f'<details class="cat" id="d-{slug}" open><summary><span>{inline(title)}</span>'
                     f'<span class="count">{len(items)}</span></summary>')
        if lead.strip():
            parts.append(f'<p class="catlead">{inline(" ".join(lead.split()))}</p>')
        parts.append('<ol class="diffs">')
        for it in items:
            tags = [t for t in TAGS if f"[{t}]" in it]
            it_clean = re.sub(r"\s*\*\[([a-z -]+)\]\*", "", it)
            src = ""
            if " — " in it_clean:
                it_clean, src = it_clean.rsplit(" — ", 1)
            chips = "".join(f'<span class="tag t-{t.replace(" ", "-")}">{t}</span>' for t in tags)
            data = " ".join(t.replace(" ", "-") for t in tags)
            parts.append(f'<li data-tags="{data}"><div>{inline(it_clean)}</div><div class="meta">{chips}'
                         + (f'<span class="src">{inline(src)}</span>' if src else "") + "</div></li>")
        parts.append("</ol></details>")
    return total, len(cats), "\n".join(parts)


def gallery_html():
    """captions.md entries: a heading or bold line naming the file, then caption text."""
    text = open(need("images/captions.md")).read()
    entries = []
    cur = None
    for line in text.splitlines():
        m = re.search(r"([0-9][0-9a-z_.-]*\.(?:jpg|png))", line)
        if line.startswith("#") and m:
            cur = {"file": m.group(1), "lines": []}
            entries.append(cur)
        elif cur is not None and line.strip() and not line.startswith("#"):
            cur["lines"].append(line.strip())
        elif line.startswith("#") and not m:
            cur = None
    if not entries:
        sys.exit("images/captions.md: no '### <file>.jpg' entries found")
    out = []
    for e in entries:
        path = os.path.join(HERE, "images", e["file"])
        if not os.path.exists(path):
            sys.exit(f"captions.md names {e['file']} but images/{e['file']} does not exist")
        caption = ""
        how = []
        for l in e["lines"]:
            l2 = re.sub(r"^[-*]\s*", "", l)
            key = re.match(r"\*\*([^*]+)\*\*:?\s*(.*)", l2) or re.match(r"([A-Za-z ]+):\s+(.*)", l2)
            if key and key.group(1).strip().lower().rstrip(":") in ("caption",):
                caption = key.group(2)
            elif not caption:
                caption = l2
            else:
                how.append(l2)
        hero = "-hero" in e["file"]
        out.append(f'<figure class="shot{" hero" if hero else ""}"><a href="images/{e["file"]}">'
                   f'<img src="images/{e["file"]}" alt="{html.escape(re.sub(r"[*`]", "", caption))}" loading="lazy"></a>'
                   f'<figcaption><span class="fn">{e["file"]}</span> {inline(caption)}'
                   + (f'<details><summary>How it was made</summary><p>{inline(" ".join(how))}</p></details>' if how else "")
                   + "</figcaption></figure>")
    return len(entries), "\n".join(out)


def bar_chart(rows, value_key, fmt, label):
    """Horizontal bars, one series. rows: [(name, value)]."""
    w, lh, left, right = 640, 34, 190, 80
    h = lh * len(rows) + 10
    mx = max(v for _, v in rows)
    parts = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="{html.escape(label)}" class="chart">']
    for i, (name, v) in enumerate(rows):
        y = 5 + i * lh
        bw = max(2, (w - left - right) * v / mx)
        parts.append(f'<g><title>{html.escape(name)}: {fmt(v)}</title>'
                     f'<text x="{left - 10}" y="{y + 21}" text-anchor="end" class="lbl">{html.escape(name)}</text>'
                     f'<rect x="{left}" y="{y + 7}" width="{bw:.1f}" height="20" rx="3" class="bar"></rect>'
                     f'<text x="{left + bw + 8:.1f}" y="{y + 21}" class="val">{fmt(v)}</text></g>')
    parts.append(f'<line x1="{left}" x2="{left}" y1="0" y2="{h}" class="axis"></line></svg>')
    return "".join(parts)


def growth_chart(rows):
    """Column chart of TS/JS code lines at each milestone (single series)."""
    w, h, top, bottom, left = 640, 260, 20, 64, 48
    mx = 120000
    n = len(rows)
    step = (w - left - 10) / n
    y = lambda v: top + (h - top - bottom) * (1 - v / mx)
    parts = [f'<svg viewBox="0 0 {w} {h}" role="img" aria-label="Lines of TypeScript and JavaScript at each milestone" class="chart">']
    for t in range(0, mx + 1, 30000):
        parts.append(f'<line x1="{left}" x2="{w - 10}" y1="{y(t):.1f}" y2="{y(t):.1f}" class="grid"></line>'
                     f'<text x="{left - 6}" y="{y(t) + 4:.1f}" text-anchor="end" class="tick">{t // 1000}k</text>')
    short = {"scaffold (first commit)": "scaffold", "v1 first working copy (0251064)": "v1 working",
             "v1-dda tag": "v1-dda tag", "end of v2 (BN) push": "end of v2", "end of wave 3 overnight": "end of wave 3",
             "now (bn head)": "now"}
    for i, r in enumerate(rows):
        v = int(r["ts_js_code"])
        x = left + i * step + step * 0.2
        bw = step * 0.6
        parts.append(f'<g><title>{html.escape(r["phase"])} ({r["date_pdt"]} PDT): {v:,} lines</title>'
                     f'<rect x="{x:.1f}" y="{y(v):.1f}" width="{bw:.1f}" height="{max(1, y(0) - y(v)):.1f}" rx="3" class="bar"></rect>'
                     f'<text x="{x + bw / 2:.1f}" y="{y(v) - 6:.1f}" text-anchor="middle" class="val">{v / 1000:.0f}k</text>'
                     f'<text x="{x + bw / 2:.1f}" y="{h - bottom + 18}" text-anchor="middle" class="lbl">{short.get(r["phase"], r["phase"])}</text>'
                     f'<text x="{x + bw / 2:.1f}" y="{h - bottom + 34}" text-anchor="middle" class="tick">{r["date_pdt"][5:]}</text></g>')
    parts.append("</svg>")
    return "".join(parts)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "index.html"))
    ap.add_argument("--dry-run", action="store_true", help="build and report sizes, write nothing")
    args = ap.parse_args()

    ts = json.load(open(need("data/transcript_stats.json")))
    cs = json.load(open(need("data/code_stats.json")))
    import csv
    growth = list(csv.DictReader(open(need("data/growth.csv"))))
    tmpl = open(need("scripts/index.template.html")).read()

    phases = [("v1 autonomous build", "v1 autonomous build (DDA)"), ("v1 review + UX", "v1 review + UX pass"),
              ("v2 Bright Nights", "v2 Bright Nights push"), ("wave 3 overnight", "wave 3 overnight"),
              ("wave 4 (so far)", "wave 4 interactive (gallery, vehicles, stairs, VR, perf, blog)")]
    out_rows, read_rows = [], []
    for short, key in phases:
        d = ts["tokens_by_phase"][key]
        out_rows.append((short, sum(x["output"] for x in d.values())))
        read_rows.append((short, sum(x["cache_read"] for x in d.values())))
    ndiff, ncat, diffs = differences_html()
    nimg, gallery = gallery_html()
    commentary = md_to_html(open(need("commentary.md")).read())
    subs = {
        "{{CHART_OUTPUT}}": bar_chart(out_rows, "output", lambda v: f"{v / 1e6:.2f} M", "Output tokens per phase"),
        "{{CHART_CACHE}}": bar_chart(read_rows, "cache", lambda v: f"{v / 1e9:.2f} B", "Cache-read tokens per phase"),
        "{{CHART_GROWTH}}": growth_chart(growth),
        "{{DIFFERENCES}}": diffs, "{{NDIFF}}": str(ndiff), "{{NCAT}}": str(ncat),
        "{{GALLERY}}": gallery, "{{NIMG}}": str(nimg),
        "{{COMMENTARY}}": commentary,
    }
    page = tmpl
    for k, v in subs.items():
        if k not in page:
            sys.exit(f"template lacks {k}")
        page = page.replace(k, v)
    left = re.findall(r"\{\{[A-Z_]+\}\}", page)
    if left:
        sys.exit(f"unfilled placeholders: {left}")
    print(f"index.html: {len(page) / 1024:.0f} KB, {ndiff} differences in {ncat} categories, {nimg} images")
    if not args.dry_run:
        open(args.out, "w").write(page)


if __name__ == "__main__":
    main()
