// A small D1 stand-in on node:sqlite (Node 22): the Worker binding (prepare/bind/all/first/run/batch)
// and a fake of the D1 REST API (fetch → POST …/query { sql, params }), both on one in-memory database
// with the real migration applied.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = new URL('../../worker/migrations/', import.meta.url);
const plain = (r) => (r ? { ...r } : r);

export function memoryDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  return db;
}

export function d1Binding(db = memoryDb()) {
  const log = [];
  class Stmt {
    constructor(sql, args = []) {
      this.sql = sql;
      this.args = args;
    }
    bind(...args) {
      return new Stmt(this.sql, args);
    }
    _run() {
      log.push({ sql: this.sql, args: this.args });
      return db.prepare(this.sql).run(...this.args);
    }
    async all() {
      log.push({ sql: this.sql, args: this.args });
      return { success: true, results: db.prepare(this.sql).all(...this.args).map(plain) };
    }
    async first(col) {
      log.push({ sql: this.sql, args: this.args });
      const r = plain(db.prepare(this.sql).get(...this.args));
      return r ? (col ? r[col] : r) : null;
    }
    async run() {
      return { success: true, meta: { changes: this._run().changes } };
    }
  }
  return {
    db,
    log,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => ({ success: true, meta: { changes: s._run().changes } }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

/** fetch() for https://api.cloudflare.com/…/d1/database/…/query that runs the SQL on `db`. */
export function d1Rest(db = memoryDb(), { fail } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    if (fail && fail(body)) return new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'boom' }] }), { status: 500 });
    try {
      const st = db.prepare(body.sql);
      const isRead = /^\s*(SELECT|WITH)/i.test(body.sql);
      const results = isRead ? st.all(...(body.params || [])).map(plain) : (st.run(...(body.params || [])), []);
      return new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results, meta: {} }] }), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: e.message }] }), { status: 400 });
    }
  };
  return { db, calls, doFetch };
}
