// One-time move from the old SQLite file to MongoDB.
//
//   node src/migrate-sqlite.js [path/to/cargo-pos.db] [--replace]
//
// Copies every table (settings, suppliers, customers, products, GRNs, sales, payments, stock moves, users,
// activity log, rate history) into the MongoDB collections of the same name, keeping every id, and sets the
// id counters so new records continue the numbering. --replace empties the MongoDB collections first.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { setup, close, connect, count, deleteMany, bumpCounter, COLLECTIONS } from './db.js';

const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(import.meta.dirname, '..', 'data', 'cargo-pos.db');
const replace = process.argv.includes('--replace');
if (!fs.existsSync(file)) {
  console.error(`No SQLite file at ${file}`);
  process.exit(1);
}

await setup();
const db = await connect();
const lite = new DatabaseSync(file, { readOnly: true });
const tables = new Set(lite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((t) => t.name));

const used = [];
for (const name of COLLECTIONS) if (tables.has(name) && await count(name)) used.push(name);
if (used.length && !replace) {
  console.error(`MongoDB already has data in: ${used.join(', ')}. Run again with --replace to empty them first.`);
  await close();
  process.exit(1);
}
if (replace) {
  for (const name of COLLECTIONS) await deleteMany(name, {});
  await deleteMany('counters', {});
}

// SQLite never re-uses an id (AUTOINCREMENT) — carry its last-used numbers over, so ids keep counting up the same way
const lastUsed = tables.has('sqlite_sequence')
  ? Object.fromEntries(lite.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, r.seq]))
  : {};

for (const name of COLLECTIONS) {
  if (!tables.has(name)) continue;
  const rows = lite.prepare(`SELECT * FROM ${name}`).all().map((r) => ({ ...r }));
  if (rows.length) await db.collection(name).insertMany(rows.map((r) => ({ ...r })));
  if (name !== 'settings') {
    const max = Math.max(rows.reduce((m, r) => Math.max(m, r.id || 0), 0), lastUsed[name] || 0);
    if (max) await bumpCounter(name, max);
  }
  console.log(`${name.padEnd(18)} ${rows.length}`);
}
lite.close();
console.log('Done — the shop data is now in MongoDB.');
await close();
