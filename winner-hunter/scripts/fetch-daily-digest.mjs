#!/usr/bin/env node
/*
 * The VPS end of Today's winners: reads the day's digest from D1 (daily_runs, written by daily.mjs on GitHub) and writes it
 * to ~/winner-daily/YYYY-MM-DD.md and ~/winner-daily/latest.md, where Grok Bot reads it at about 07:00 Asia/Bangkok and
 * sends it to Connor's chat. It only reads D1.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [D1_DATABASE_ID=…] [WH_BOARD_URL=https://…] node winner-hunter/scripts/fetch-daily-digest.mjs [--dir ~/winner-daily] [--day YYYY-MM-DD]
 *   node winner-hunter/scripts/fetch-daily-digest.mjs --local copy.sqlite [--dir …]     (a local copy, for tests)
 *
 * latest.md always says something about today, never yesterday's picks as if they were new: the digest when the run is
 * done (ok, or short with fewer than 5), the run's own failure text when it failed, a plain line when it is still running,
 * has not run yet or D1 could not be read. Exit 0 when the day's digest was written, 2 when only such a line was, 1 when
 * nothing could be written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from '../lib/d1.mjs';
import { bangkokDay, dayLabel, withBoard } from '../lib/daily-digest.mjs';

export const DAY_SQL = 'SELECT day, status, started_at, finished_at, picks, digest_md, digest_csv, error FROM daily_runs WHERE day = ?1';
export const LAST_SQL = "SELECT day, status, finished_at FROM daily_runs WHERE day < ?1 ORDER BY day DESC LIMIT 1";

const hhmm = (iso) => (iso ? new Date(Date.parse(iso) + 7 * 3600e3).toISOString().slice(11, 16) + ' ICT' : '');

/** What to write for a day: { md, csv, kind: 'digest' | 'note' }. */
export async function digestFor(db, day) {
  let row;
  try {
    row = (await db.query(DAY_SQL, [day]))[0];
  } catch (e) {
    return { kind: 'note', md: `Winners for ${dayLabel(day)}: the board's database could not be read (${String(e.message || e).slice(0, 120)}). The picks may still be on the board's Today tab.\n` };
  }
  if (row && (row.status === 'ok' || row.status === 'short') && row.digest_md) return { kind: 'digest', md: row.digest_md, csv: row.digest_csv || null };
  if (row && row.status === 'failed') return { kind: 'note', md: row.digest_md || `Winners for ${dayLabel(day)}: the daily run failed (${String(row.error || 'no reason saved').slice(0, 160)}).\n` };
  if (row && row.status === 'running') return { kind: 'note', md: `Winners for ${dayLabel(day)}: the daily run started at ${hhmm(row.started_at)} and is not finished yet. The picks will be on the board's Today tab.\n` };
  let last = null;
  try {
    last = (await db.query(LAST_SQL, [day]))[0] || null;
  } catch {
    last = null;
  }
  return { kind: 'note', md: `Winners for ${dayLabel(day)}: no daily run yet today.${last ? ` The last run was ${dayLabel(last.day)} (${last.status}).` : ''}\n` };
}

/** Writes YYYY-MM-DD.md (and .csv), then latest.md, each through a temporary file. Returns the paths written. */
export function writeFiles(dir, day, { md, csv }, board = '') {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  const put = (name, text) => {
    const file = path.join(dir, name);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    out.push(file);
  };
  put(`${day}.md`, withBoard(md, board));
  if (csv) put(`${day}.csv`, withBoard(csv, board));
  put('latest.md', withBoard(md, board));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dir = opt('--dir') || process.env.WINNER_DAILY_DIR || path.join(os.homedir(), 'winner-daily');
  const day = opt('--day') || bangkokDay();
  let db;
  if (opt('--local')) {
    const { DatabaseSync } = await import('node:sqlite');
    const sq = new DatabaseSync(opt('--local'), { readOnly: true });
    db = { query: async (sql, p = []) => sq.prepare(sql).all(...p).map((r) => ({ ...r })) };
  } else {
    const s = d1Settings();
    db = s ? d1Client(s, { retryMs: 3000 }) : { query: async () => { throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are not set'); } };
  }
  const r = await digestFor(db, day);
  try {
    const files = writeFiles(dir, day, r, process.env.WH_BOARD_URL || '');
    console.log(`fetch-daily-digest ${day}: ${r.kind === 'digest' ? 'digest' : 'a note (no digest yet)'} → ${files.join(', ')}`);
    process.exitCode = r.kind === 'digest' ? 0 : 2;
  } catch (e) {
    console.error(`fetch-daily-digest ${day}: could not write in ${dir}: ${e.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
