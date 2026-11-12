import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // bigint
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

type Runner = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

export async function q<T = any>(text: string, params: any[] = [], c: Runner = pool): Promise<T[]> {
  return (await c.query(text, params)).rows as T[];
}
export async function one<T = any>(text: string, params: any[] = [], c: Runner = pool): Promise<T | null> {
  return ((await c.query(text, params)).rows[0] as T) ?? null;
}
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const done = new Set((await q('SELECT name FROM _migrations')).map((r) => r.name));
  const files = fs.readdirSync(config.migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(config.migrationsDir, f), 'utf8');
    await tx(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
    });
    console.log(`[db] migration appliquée : ${f}`);
  }
}

/** Fragment SQL : point géographique à partir de ($lng, $lat). */
export const pt = (lngIdx: number, latIdx: number) => `ST_SetSRID(ST_MakePoint($${lngIdx}, $${latIdx}), 4326)::geography`;

export type Settings = {
  delivery_fee: { base_cents: number; per_km_cents: number; min_cents: number; max_cents: number };
  commission: { rate: number };
  courier_pay: { base_cents: number; per_km_cents: number; approach_per_km_cents: number; min_cents: number };
  dispatch: { radius_km: number; offer_timeout_s: number };
  service: { max_delivery_km: number; enforce_hours: boolean; min_order_cents: number; accept_timeout_min: number };
};
let cache: { at: number; v: Settings } | null = null;
export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5000) return cache.v;
  const rows = await q('SELECT key, value FROM settings');
  const v = Object.fromEntries(rows.map((r) => [r.key, r.value])) as Settings;
  cache = { at: Date.now(), v };
  return v;
}
export function invalidateSettings() { cache = null; }
