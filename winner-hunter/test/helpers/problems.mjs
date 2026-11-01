// The Problem Database's sample data (test/fixtures/problems: made up, marked sample) in an in-memory D1, written
// through the real code: saveMentions, then problems-process.mjs in sample mode.
import fs from 'node:fs';
import { d1Client } from '../../lib/d1.mjs';
import { saveMentions } from '../../lib/problem-db.mjs';
import { processRun, settingsOf } from '../../problems-process.mjs';
import { d1Rest } from './sqlite-d1.mjs';
import { seededEnv } from './seed.mjs';

const FIXTURES = new URL('../fixtures/problems/', import.meta.url);
export const SAMPLE = JSON.parse(fs.readFileSync(new URL('sample-mentions.json', FIXTURES), 'utf8'));
export const API_SAMPLES = JSON.parse(fs.readFileSync(new URL('api-samples.json', FIXTURES), 'utf8'));
export const SAMPLE_NOW = Date.parse(SAMPLE.now);
export const sampleRows = () => SAMPLE.mentions.map((m) => ({ ...m, sample: 1 }));

/** lib/d1.mjs's REST client on the in-memory database of env (env.db). */
export const restClient = (db) => d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(db).doFetch, retryMs: 0 });

/** The board's seeded env with the sample problems in it. Returns { env, client, summary, now }. */
export async function problemEnv({ env = null, now = SAMPLE_NOW, process = true } = {}) {
  env = env || (await seededEnv());
  const client = restClient(env.db);
  await saveMentions(client, sampleRows(), { now, runId: 'sample' });
  const summary = process ? await processRun({ db: client, settings: { ...settingsOf({}), sample: true }, now, log: () => {} }) : null;
  return { env, client, summary, now };
}
