/*
 * A small CSV reader and writer (RFC 4180: quoted fields, doubled quotes, newlines inside quotes), for the research exports
 * the Winner Score reads and the daily digest's CSV. No dependencies.
 */

/** Rows of objects keyed by the header row. A byte-order mark on the first header is dropped. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  const s = String(text || '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const head = rows[0].map((h, j) => (j === 0 ? h.replace(/^﻿/, '') : h));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}

const cell = (v) => {
  const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^[=+\-@]/.test(s) ? '"' + (/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s;
};
/** CSV text for a list of objects and the columns to write (a cell starting with = + - @ is quoted with a ' so a sheet never runs it). */
export const toCsv = (list, cols) => [cols.join(','), ...list.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
