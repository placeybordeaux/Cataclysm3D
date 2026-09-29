
// Death: CDDA's end screen (end_screen.json "death_tombstone" over the ascii_tombstone
// picture, with name / time survived / kills stamped onto the stone) beside the memorial
// summary (cause of death, kills by monster, distance, unlocks, last messages) in a ui2 panel,
// a last-words field that takes typing at once, and Enter back to the main menu
// (death_screen.ts; this file stays DOM-free for tests).

/** Stamp CDDA's added_info lines onto the tombstone picture at their [x, y] positions. */
export function stampTombstone(picture: string[], info: [[number, number], string][], vars: Record<string, string>): string[] {
  // The picture's color tags only occur near the bottom (grass), below the stamped rows, so
  // splicing by column is safe on untagged rows; tagged rows are left alone.
  const rows = [...picture];
  for (const [[x, y], tmpl] of info) {
    const text = tmpl.replace(/<([a-z_]+)>/g, (m, k: string) => vars[k] ?? m);
    const row = rows[y];
    if (row === undefined || /<color_/.test(row)) continue;
    const plain = text.replace(/<\/?color[^>]*>/g, '');
    let stamp = text;
    let at = x;
    // Keep long untagged values ("Survived: 1 hour and 57 minutes") inside the stone: slide
    // left to end before the right border, and clip only if even that doesn't fit.
    const border = row.trimEnd().length - 1;
    if (plain === text && border > x && x + plain.length > border - 1) {
      at = Math.max(1, border - 1 - plain.length);
      stamp = plain.slice(0, border - 1 - at);
    }
    const len = stamp === text ? plain.length : stamp.length;
    const padded = row.padEnd(at + len);
    rows[y] = padded.slice(0, at) + stamp + padded.slice(at + len);
  }
  return rows;
}

