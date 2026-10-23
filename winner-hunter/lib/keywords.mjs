/** The keyword list: one per line, # starts a comment, empty lines skipped. */
export function parseKeywords(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
}

/** A cursor (where the last run stopped) as a valid index into a list of n keywords. */
export const wrap = (i, n) => (n ? (((Math.floor(Number(i) || 0)) % n) + n) % n : 0);
