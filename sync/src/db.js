import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dir) {
  if (dir !== ':memory:') fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dir === ':memory:' ? ':memory:' : path.join(dir, 'sync.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    -- Una fila por (proveedor, referencia del proveedor): su coste y stock
    CREATE TABLE IF NOT EXISTS offers (
      supplier TEXT NOT NULL, supplier_sku TEXT NOT NULL,
      key TEXT NOT NULL, ean TEXT, mpn TEXT, brand TEXT, name TEXT,
      category TEXT, subcategory TEXT,
      cost REAL, currency TEXT, stock INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1, updated_at TEXT,
      PRIMARY KEY (supplier, supplier_sku)
    );
    CREATE INDEX IF NOT EXISTS offers_key ON offers(key);
    -- Un producto de la tienda por clave unificada (EAN o marca+referencia)
    CREATE TABLE IF NOT EXISTS products (
      key TEXT PRIMARY KEY, woo_id INTEGER, sku TEXT,
      price REAL, stock INTEGER, supplier TEXT, supplier_sku TEXT, cost REAL,
      skipped TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS categories (path TEXT PRIMARY KEY, woo_id INTEGER);
    CREATE TABLE IF NOT EXISTS icecat (key TEXT PRIMARY KEY, json TEXT, fetched_at TEXT);
    CREATE TABLE IF NOT EXISTS orders (
      woo_id INTEGER PRIMARY KEY, status TEXT, detail TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}

export const now = () => new Date().toISOString();

export function kvGet(db, k) {
  return db.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v;
}
export function kvSet(db, k, v) {
  db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
}
