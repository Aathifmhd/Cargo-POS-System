import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// On Vercel the deployment is read-only and only /tmp can be written — and /tmp is wiped between
// instances, so data there does NOT last. Set DATA_DIR (or move to a hosted database) for real use.
const dataDir = path.resolve(
  process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/cargo-pos' : path.join(import.meta.dirname, '..', 'data'))
);
fs.mkdirSync(dataDir, { recursive: true });

export const DB_FILE = path.join(dataDir, 'cargo-pos.db');
export const db = new DatabaseSync(DB_FILE);

db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  contact_person      TEXT,
  phone               TEXT,
  whatsapp            TEXT,
  email               TEXT,
  city                TEXT,
  state               TEXT,
  address             TEXT,
  gst_no              TEXT,
  bank_details        TEXT,
  credit_days         INTEGER NOT NULL DEFAULT 30,
  opening_balance_inr REAL NOT NULL DEFAULT 0,
  notes               TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  shop_name       TEXT,
  phone           TEXT,
  whatsapp        TEXT,
  city            TEXT,
  address         TEXT,
  credit_limit    REAL NOT NULL DEFAULT 0,
  credit_days     INTEGER NOT NULL DEFAULT 30,
  opening_balance REAL NOT NULL DEFAULT 0,
  notes           TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Prices are stored per SET (a pack). Stock is stored in PIECES so loose pieces can be sold too.
CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  category          TEXT,
  pcs_per_set       INTEGER NOT NULL DEFAULT 1,
  colors_count      INTEGER NOT NULL DEFAULT 0,
  color_names       TEXT,
  sizes             TEXT,
  supplier_id       INTEGER REFERENCES suppliers(id),
  cost_per_pcs      REAL NOT NULL DEFAULT 0,  -- weighted average landed cost (LKR)
  last_cost_per_pcs REAL NOT NULL DEFAULT 0,  -- landed cost from latest GRN (LKR)
  mrp_per_set       REAL NOT NULL DEFAULT 0,
  expected_per_set  REAL NOT NULL DEFAULT 0,
  stock_pcs         INTEGER NOT NULL DEFAULT 0,
  reorder_sets      INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grns (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_no                 TEXT NOT NULL UNIQUE,
  date                   TEXT NOT NULL,
  supplier_id            INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_invoice_no    TEXT,
  cargo_name             TEXT,
  bale_no                TEXT,
  lr_no                  TEXT,
  exchange_rate          REAL NOT NULL,
  goods_inr              REAL NOT NULL DEFAULT 0,
  cargo_charge_inr       REAL NOT NULL DEFAULT 0,
  cargo_in_supplier_bill INTEGER NOT NULL DEFAULT 0,
  payable_inr            REAL NOT NULL DEFAULT 0,
  expenses_lkr           REAL NOT NULL DEFAULT 0,
  total_lkr              REAL NOT NULL DEFAULT 0,
  total_sets             INTEGER NOT NULL DEFAULT 0,
  total_pcs              INTEGER NOT NULL DEFAULT 0,
  payment_type           TEXT NOT NULL DEFAULT 'credit',
  due_date               TEXT,
  notes                  TEXT,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grn_expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id     INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  amount_lkr REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grn_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_id             INTEGER NOT NULL REFERENCES grns(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  name               TEXT NOT NULL,
  pcs_per_set        INTEGER NOT NULL DEFAULT 1,
  colors_count       INTEGER NOT NULL DEFAULT 0,
  color_names        TEXT,
  sizes              TEXT,
  sets               INTEGER NOT NULL,
  cost_inr_per_set   REAL NOT NULL,
  line_inr           REAL NOT NULL,
  landed_lkr         REAL NOT NULL,
  landed_per_set_lkr REAL NOT NULL,
  landed_per_pcs_lkr REAL NOT NULL,
  mrp_per_set        REAL NOT NULL DEFAULT 0,
  expected_per_set   REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  grn_id        INTEGER REFERENCES grns(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  amount_inr    REAL NOT NULL,
  exchange_rate REAL NOT NULL DEFAULT 0,
  amount_lkr    REAL NOT NULL DEFAULT 0,
  method        TEXT,
  reference     TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no    TEXT NOT NULL UNIQUE,
  date          TEXT NOT NULL,
  customer_id   INTEGER REFERENCES customers(id),
  customer_name TEXT,
  payment_type  TEXT NOT NULL,            -- cash | credit
  subtotal      REAL NOT NULL,
  discount      REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL,
  paid_at_sale  REAL NOT NULL DEFAULT 0,
  cost_total    REAL NOT NULL DEFAULT 0,
  due_date      TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'completed', -- completed | void
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id           INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id),
  code              TEXT,
  name              TEXT NOT NULL,
  unit              TEXT NOT NULL,        -- set | pcs
  qty               REAL NOT NULL,
  pcs               INTEGER NOT NULL,
  price             REAL NOT NULL,
  mrp_per_unit      REAL NOT NULL DEFAULT 0,
  expected_per_unit REAL NOT NULL DEFAULT 0,
  cost_per_unit     REAL NOT NULL DEFAULT 0,
  line_total        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id     INTEGER REFERENCES sales(id),
  date        TEXT NOT NULL,
  amount      REAL NOT NULL,
  method      TEXT,
  reference   TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Every stock change is logged here so each product has a full stock card.
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,   -- grn | grn-delete | sale | void | adjust
  ref        TEXT,
  pcs        INTEGER NOT NULL,
  balance    INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'cashier',  -- admin | cashier
  active        INTEGER NOT NULL DEFAULT 1,
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One-time admin approvals given to a cashier for a protected action.
CREATE TABLE IF NOT EXISTS approvals (
  token       TEXT PRIMARY KEY,
  approver_id INTEGER NOT NULL REFERENCES users(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  action      TEXT,
  used        INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id     INTEGER,
  username    TEXT,
  action      TEXT NOT NULL,
  approved_by TEXT
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  rate   REAL NOT NULL,
  source TEXT
);

CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_grns_supplier ON grns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id);
`);

// Columns added after the first release — added in place so existing shop databases keep working.
function addColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('grns', 'effective_rate', 'REAL');          // rate the goods really cost at (blends payments + today's rate while unpaid)
addColumn('grns', 'settled_at', 'TEXT');              // when the supplier bill was fully paid; cost is fixed from then on
addColumn('products', 'opening_pcs', 'INTEGER NOT NULL DEFAULT 0');
addColumn('products', 'opening_cost_per_pcs', 'REAL NOT NULL DEFAULT 0');
addColumn('sale_items', 'disc', 'REAL NOT NULL DEFAULT 0');      // line discount amount (Rs)
addColumn('sale_items', 'disc_pct', 'REAL NOT NULL DEFAULT 0');
addColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');   // +1 on password change → older logins end
addColumn('products', 'subtype', 'TEXT');                             // product type within the category, e.g. T-shirts → "Collar"
addColumn('grn_items', 'extra_sets', 'INTEGER NOT NULL DEFAULT 0');   // (older GRNs) free sets — not on the supplier's bill
addColumn('grn_items', 'extra_pcs', 'INTEGER NOT NULL DEFAULT 0');    // extra pieces received — billed by the supplier
addColumn('grn_items', 'short_sets', 'INTEGER NOT NULL DEFAULT 0');   // sets billed but missing from the bale
addColumn('grn_items', 'short_pcs', 'INTEGER NOT NULL DEFAULT 0');    // pieces billed but missing from the bale

/* The shop's catalogue: categories, the product types in each, and the sizes they come in.
   Editable in Settings → Categories, products & sizes (stored as JSON in settings.catalog). */
const TOP_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
const BOTTOM_SIZES = ['28/32', '30/36', '28/34', '28/36', '28/38', '38/42', 'M', 'L', 'XL', '2XL'];
export const DEFAULT_CATALOG = [
  { name: 'T-shirts', sizes: TOP_SIZES, types: ['Collar', 'Collar L/S', 'Collar Drop Shoulder', 'Collar Zipper', 'Collar Boxy', 'Old Money', 'R/N Regular', 'R/N Drop Shoulder', 'R/N 5 Sleeve', 'R/N Long Sleeve', 'Arm Cut'] },
  { name: 'Shirts', sizes: TOP_SIZES, types: ['L/S', 'H/S', 'Drop Shoulder', 'Kerala', 'Boxy Fit'] },
  { name: 'Pant', sizes: BOTTOM_SIZES, types: ['Linen Pant', 'Linen Baggy', 'Color Pant', 'Cotton Pant', 'Korean Baggy Pant', 'Kurka Pant', 'Kurka Baggy Pant', 'Formal', 'Cargo', 'Boot Cut'] },
  { name: 'Denim', sizes: BOTTOM_SIZES, types: ['Slim', 'Regular', 'Mom Fit', 'Baggy', 'Wide Leg', 'Cargo'] },
  { name: 'Track Pant', sizes: BOTTOM_SIZES, types: ['Baggy', 'Regular', 'Boot Cut'] },
  { name: 'Shorts', sizes: BOTTOM_SIZES, types: ['Short', '3 Quarter', '3 Quarter Cargo', 'Cargo'] },
  { name: 'Underwear', sizes: ['M', 'L', 'XL', '2XL'], types: ['Boxer', 'V Cut', 'RN West', 'RNS West'] },
  { name: 'Jacket', sizes: TOP_SIZES, types: ['Jacket', 'Hoodie'] },
];

const DEFAULT_SETTINGS = {
  fx_mode: 'auto',
  shop_name: 'My Wholesale Shop',
  shop_address: 'Colombo, Sri Lanka',
  shop_phone: '',
  default_exchange_rate: '3.60',
  default_markup_percent: '40',
  selling_markup_percent: '30',       // auto expected selling price = landed cost + this %
  mrp_markup_percent: '40',           // auto MRP = landed cost + this %
  price_round_to: '10',               // auto prices are rounded up to this (per piece)
  invoice_footer: 'Thank you for your business! Goods once sold cannot be returned without the bill.',
  grn_prefix: 'GRN-',
  invoice_prefix: 'INV-',
  catalog: JSON.stringify(DEFAULT_CATALOG),
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}

// ---------- helpers ----------
export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => db.prepare(sql).get(...p);
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const fail = (message, status = 400) => {
  throw new HttpError(status, message);
};

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const num = (v, d = 0) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getSettings() {
  return Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
}

export function nextNo(table, col, prefix, pad) {
  const row = get(`SELECT ${col} AS no FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`, prefix + '%');
  const n = row ? parseInt(String(row.no).slice(prefix.length), 10) + 1 || 1 : 1;
  return prefix + String(n).padStart(pad, '0');
}

export function nextProductCode() {
  const row = get(`SELECT code FROM products WHERE code GLOB 'P[0-9]*' ORDER BY CAST(SUBSTR(code, 2) AS INTEGER) DESC LIMIT 1`);
  const n = row ? parseInt(row.code.slice(1), 10) + 1 : 1;
  return 'P' + String(n).padStart(4, '0');
}

/**
 * Settle payments against bills oldest-first.
 * docs: [{ amount, linkedPaid, ... }] sorted oldest first.
 * Payments linked to a bill are applied to that bill; unlinked payments flow to the oldest open bills.
 */
export function allocate(docs, unlinked) {
  let pool = round2(unlinked);
  return docs.map((d) => {
    let balance = round2(d.amount - (d.linkedPaid || 0));
    if (balance < 0) {
      pool = round2(pool - balance); // overpaid on a linked bill -> excess becomes credit for others
      balance = 0;
    }
    const take = Math.min(balance, Math.max(pool, 0));
    pool = round2(pool - take);
    balance = round2(balance - take);
    return { ...d, paid: round2(d.amount - balance), balance };
  });
}

export function dueStatus(balance, dueDate, today = todayStr()) {
  if (balance <= 0.009) return 'paid';
  if (dueDate && dueDate < today) return 'overdue';
  if (dueDate && dueDate <= addDays(today, 7)) return 'due-soon';
  return 'open';
}

/**
 * Cost of the stock still on hand, first-in-first-out: the pieces left are taken to be the newest receipts
 * (GRN items, at their current — possibly revalued — landed cost), then any opening stock.
 * With nothing in stock, the latest receipt's cost is used.
 */
export function recomputeProductCost(productId) {
  const p = get('SELECT * FROM products WHERE id = ?', productId);
  if (!p) return;
  const receipts = all(
    `SELECT MAX(0, (gi.sets + gi.extra_sets - gi.short_sets) * gi.pcs_per_set + gi.extra_pcs - gi.short_pcs) AS pcs, gi.landed_per_pcs_lkr AS cost
       FROM grn_items gi JOIN grns g ON g.id = gi.grn_id
      WHERE gi.product_id = ? ORDER BY g.date DESC, g.id DESC, gi.id DESC`, productId);
  if (p.opening_pcs > 0) receipts.push({ pcs: p.opening_pcs, cost: p.opening_cost_per_pcs });
  if (!receipts.length) return;
  let need = Math.max(0, p.stock_pcs);
  let qty = 0;
  let value = 0;
  for (const r of receipts) {
    if (need <= 0) break;
    const take = Math.min(r.pcs, need);
    qty += take;
    value += take * r.cost;
    need -= take;
  }
  const cost = qty > 0 ? value / qty : receipts[0].cost;
  run('UPDATE products SET cost_per_pcs = ?, last_cost_per_pcs = ? WHERE id = ?', round2(cost), round2(receipts[0].cost), productId);
}

export function moveStock(productId, pcs, type, ref, note, date = todayStr()) {
  const p = get('SELECT stock_pcs FROM products WHERE id = ?', productId);
  if (!p) fail('Product not found', 404);
  const balance = p.stock_pcs + pcs;
  run(`UPDATE products SET stock_pcs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, balance, productId);
  run(
    `INSERT INTO stock_moves (product_id, date, type, ref, pcs, balance, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    productId, date, type, ref ?? null, pcs, balance, note ?? null
  );
  recomputeProductCost(productId);
  return balance;
}
