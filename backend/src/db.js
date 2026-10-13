import { MongoClient } from 'mongodb';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

/*
 * MongoDB data layer.
 * Every table of the shop is a collection (suppliers, customers, products, grns, grn_items, sales, …).
 * Documents keep a numeric `id` (from the `counters` collection) so bill / GRN / product numbers and
 * links stay exactly as before. Multi-step changes (a GRN, a bill, a payment) run in a transaction.
 *
 * Connection: MONGODB_URI (and optional MONGODB_DB, default "cargo_pos").
 * Locally they are read from backend/.env; on Vercel set them in Settings → Environment Variables.
 */
try { process.loadEnvFile(path.join(import.meta.dirname, '..', '.env')); } catch { /* no .env file — use the environment */ }

const URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB || 'cargo_pos';
export const DB_LABEL = `MongoDB (${DB_NAME})`;

// one client per running copy of the backend (serverless copies reuse it between requests)
let client;
let database;
export async function connect() {
  if (database) return database;
  if (!URI) throw new Error('MONGODB_URI is not set. Put it in backend/.env (or the hosting environment variables).');
  globalThis.__cargoMongo ??= new MongoClient(URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 25, minPoolSize: 2 }).connect();
  client = await globalThis.__cargoMongo;
  database = client.db(DB_NAME);
  return database;
}
export const close = async () => { if (client) await client.close(); globalThis.__cargoMongo = null; client = null; database = null; };

const col = (name) => {
  if (!database) throw new Error('Database not connected yet');
  return database.collection(name);
};

/* ---------------- transactions ----------------
 * tx(fn) runs fn inside a MongoDB transaction. Every helper below joins the current transaction by itself
 * (it is carried by AsyncLocalStorage), so code reads the same inside and outside a transaction.
 * Inside a transaction, run database calls one after another (not in parallel).
 */
const als = new AsyncLocalStorage();
const opt = () => { const s = als.getStore(); return s ? { session: s } : {}; };

export async function tx(fn) {
  if (als.getStore()) return fn();   // already inside one
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await als.run(session, fn); },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Run independent reads together: inParallel(() => find(...), () => findOne(...)).
 * Outside a transaction they run at the same time (one network round-trip instead of several);
 * inside one they run one after another, as MongoDB requires.
 */
export async function inParallel(...fns) {
  if (als.getStore()) {
    const out = [];
    for (const fn of fns) out.push(await fn());
    return out;
  }
  return Promise.all(fns.map((fn) => fn()));
}

/* ---------------- defaults for new documents (what the old table columns defaulted to) ---------------- */
export const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');   // "YYYY-MM-DD HH:MM:SS" (UTC)
const DEFAULTS = {
  suppliers: { contact_person: null, phone: null, whatsapp: null, email: null, city: null, state: null, address: null, gst_no: null,
    bank_details: null, credit_days: 30, opening_balance_inr: 0, notes: null, active: 1 },
  customers: { shop_name: null, phone: null, whatsapp: null, city: null, address: null, credit_limit: 0, credit_days: 30,
    opening_balance: 0, notes: null, active: 1 },
  products: { category: null, subtype: null, pname: null, pcs_per_set: 1, colors_count: 0, color_names: null, sizes: null, supplier_id: null,
    cost_per_pcs: 0, last_cost_per_pcs: 0, mrp_per_set: 0, expected_per_set: 0, stock_pcs: 0, reorder_sets: 0, active: 1,
    opening_pcs: 0, opening_cost_per_pcs: 0 },
  grns: { supplier_invoice_no: null, cargo_name: null, bale_no: null, lr_no: null, goods_inr: 0, cargo_charge_inr: 0, cargo_in_supplier_bill: 0,
    payable_inr: 0, expenses_lkr: 0, total_lkr: 0, total_sets: 0, total_pcs: 0, payment_type: 'credit', due_date: null, notes: null,
    effective_rate: null, settled_at: null },
  grn_expenses: { category: null, amount_lkr: 0 },
  grn_items: { category: null, pcs_per_set: 1, colors_count: 0, color_names: null, sizes: null, mrp_per_set: 0, expected_per_set: 0,
    extra_sets: 0, extra_pcs: 0, short_sets: 0, short_pcs: 0 },
  supplier_payments: { grn_id: null, exchange_rate: 0, amount_lkr: 0, method: null, reference: null, notes: null },
  sales: { customer_id: null, customer_name: null, discount: 0, paid_at_sale: 0, cost_total: 0, due_date: null, notes: null, status: 'completed' },
  sale_items: { code: null, mrp_per_unit: 0, expected_per_unit: 0, cost_per_unit: 0, disc: 0, disc_pct: 0 },
  customer_payments: { sale_id: null, method: null, reference: null, notes: null },
  stock_moves: { ref: null, note: null },
  users: { role: 'cashier', active: 1, last_login: null, token_version: 0 },
  audit_log: { user_id: null, username: null, approved_by: null },
  fx_rates: { source: null },
};

/* ---------------- query helpers (documents come back without MongoDB's _id) ---------------- */
const NO_ID = { _id: 0 };
export async function find(name, filter = {}, { sort, limit, project } = {}) {
  let cur = col(name).find(filter, { ...opt(), projection: project ? { ...NO_ID, ...project } : NO_ID });
  if (sort) cur = cur.sort(sort);
  if (limit) cur = cur.limit(limit);
  return cur.toArray();
}
export const findOne = (name, filter, { sort, project, collation } = {}) =>
  col(name).findOne(filter, { ...opt(), projection: project ? { ...NO_ID, ...project } : NO_ID, sort, collation });
export const count = (name, filter = {}) => col(name).countDocuments(filter, opt());
export const distinct = (name, field, filter = {}) => col(name).distinct(field, filter, opt());
export const aggregate = (name, pipeline) => col(name).aggregate(pipeline, opt()).toArray();
export const updateOne = (name, filter, update, options = {}) => col(name).updateOne(filter, update, { ...opt(), ...options });
export const updateMany = (name, filter, update, options = {}) => col(name).updateMany(filter, update, { ...opt(), ...options });
export const deleteMany = (name, filter) => col(name).deleteMany(filter, opt());
/** set fields on one document by id */
export const setById = (name, id, fields) => updateOne(name, { id }, { $set: fields });

async function nextId(name) {
  const r = await col('counters').findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { ...opt(), upsert: true, returnDocument: 'after' });
  return r.seq;
}
/** Insert one document with the next numeric id; returns the stored document (without _id). */
export async function insert(name, doc) {
  const id = await nextId(name);
  const full = { ...DEFAULTS[name], created_at: stamp(), ...doc, id };
  if (name === 'products') full.updated_at ??= full.created_at;
  await col(name).insertOne({ ...full }, opt());
  return full;
}
/** Make sure the id counter is at least `n` (used after copying data in). */
export const bumpCounter = (name, n) => col('counters').updateOne({ _id: name }, { $max: { seq: n } }, { upsert: true });

export const COLLECTIONS = ['settings', 'suppliers', 'customers', 'products', 'grns', 'grn_expenses', 'grn_items', 'supplier_payments',
  'sales', 'sale_items', 'customer_payments', 'stock_moves', 'users', 'audit_log', 'fx_rates'];

/* ---------------- errors & small helpers ---------------- */
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
/** text for a "contains" search (like SQL LIKE '%q%'), case-insensitive */
export const contains = (q) => new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
export const sum = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + Number(days || 0));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** sort helper: by date, then by id (both ascending) */
export const byDateId = (a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1);

/* ---------------- settings ---------------- */
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
  default_exchange_rate: '3.60',      // the live INR rate (shown on the dashboard; does not change costs)
  costing_rate: '3.5',                // the fixed rate every cost is worked out at (Settings → Exchange rate)
  default_markup_percent: '40',
  selling_markup_percent: '30',       // auto expected selling price = landed cost + this %
  mrp_markup_percent: '40',           // auto MRP = landed cost + this %
  price_round_to: '10',               // auto prices are rounded up to this (per piece)
  invoice_footer: 'Thank you for your business! Goods once sold cannot be returned without the bill.',
  grn_prefix: 'GRN-',
  invoice_prefix: 'INV-',
  catalog: JSON.stringify(DEFAULT_CATALOG),
};

export async function getSettings() {
  const rows = await find('settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
export const setSetting = (key, value) => col('settings').updateOne({ key }, { $set: { key, value: String(value ?? '') } }, { ...opt(), upsert: true });

/** First run (or after an upgrade): indexes, default settings. Safe to run every start. */
export async function setup() {
  await connect();
  const existing = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of [...COLLECTIONS, 'counters', 'revoked_tokens', 'used_approvals']) {
    if (!existing.has(name)) await database.createCollection(name).catch(() => {});
  }
  const ix = (name, keys, options = {}) => col(name).createIndex(keys, options).catch(() => {});
  await Promise.all([
    ix('settings', { key: 1 }, { unique: true }),
    ...COLLECTIONS.filter((c) => c !== 'settings').map((c) => ix(c, { id: 1 }, { unique: true })),
    ix('products', { code: 1 }, { unique: true }),
    ix('grns', { grn_no: 1 }, { unique: true }),
    ix('grns', { supplier_id: 1 }),
    ix('grn_items', { grn_id: 1 }),
    ix('grn_items', { product_id: 1 }),
    ix('grn_expenses', { grn_id: 1 }),
    ix('sales', { invoice_no: 1 }, { unique: true }),
    ix('sales', { date: 1 }),
    ix('sales', { customer_id: 1 }),
    ix('sale_items', { sale_id: 1 }),
    ix('sale_items', { product_id: 1 }),
    ix('supplier_payments', { supplier_id: 1 }),
    ix('customer_payments', { customer_id: 1 }),
    ix('stock_moves', { product_id: 1 }),
    ix('users', { username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } }),
    ix('revoked_tokens', { exp: 1 }, { expireAfterSeconds: 0 }),
    ix('used_approvals', { exp: 1 }, { expireAfterSeconds: 0 }),
  ]);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await col('settings').updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }
}

/* ---------------- numbering ---------------- */
export async function nextNo(name, field, prefix, pad) {
  const row = await findOne(name, { [field]: { $regex: '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }, { sort: { id: -1 } });
  const n = row ? parseInt(String(row[field]).slice(prefix.length), 10) + 1 || 1 : 1;
  return prefix + String(n).padStart(pad, '0');
}

export async function nextProductCode() {
  const codes = await distinct('products', 'code', { code: { $regex: /^P\d+$/ } });
  const n = codes.reduce((m, c) => Math.max(m, parseInt(c.slice(1), 10) || 0), 0) + 1;
  return 'P' + String(n).padStart(4, '0');
}

/* ---------------- ledgers ---------------- */
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

/* ---------------- stock ---------------- */
export const grnItemPcs = (it) => Math.max(0, ((it.sets || 0) + (it.extra_sets || 0) - (it.short_sets || 0)) * (it.pcs_per_set || 1) + (it.extra_pcs || 0) - (it.short_pcs || 0));

/**
 * Cost of the stock still on hand, first-in-first-out: the pieces left are taken to be the newest receipts
 * (GRN items, at their landed cost), then any opening stock. With nothing in stock, the latest receipt's cost is used.
 */
export async function recomputeProductCost(productId) {
  const p = await findOne('products', { id: productId });
  if (!p) return;
  const items = await find('grn_items', { product_id: productId });
  const grns = items.length ? await find('grns', { id: { $in: [...new Set(items.map((i) => i.grn_id))] } }, { project: { id: 1, date: 1 } }) : [];
  const dateOf = Object.fromEntries(grns.map((g) => [g.id, g.date]));
  const receipts = items
    .filter((i) => dateOf[i.grn_id] !== undefined)
    .sort((a, b) => (dateOf[a.grn_id] !== dateOf[b.grn_id] ? (dateOf[a.grn_id] < dateOf[b.grn_id] ? 1 : -1) : a.grn_id !== b.grn_id ? b.grn_id - a.grn_id : b.id - a.id))
    .map((i) => ({ pcs: grnItemPcs(i), cost: i.landed_per_pcs_lkr }));
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
  await setById('products', productId, { cost_per_pcs: round2(cost), last_cost_per_pcs: round2(receipts[0].cost) });
}

/** Change a product's stock (in pieces) and log it on its stock card. */
export async function moveStock(productId, pcs, type, ref, note, date = todayStr()) {
  const p = await col('products').findOneAndUpdate({ id: productId }, { $inc: { stock_pcs: pcs }, $set: { updated_at: stamp() } },
    { ...opt(), returnDocument: 'after', projection: NO_ID });
  if (!p) fail('Product not found', 404);
  await insert('stock_moves', { product_id: productId, date, type, ref: ref ?? null, pcs, balance: p.stock_pcs, note: note ?? null });
  await recomputeProductCost(productId);
  return p.stock_pcs;
}
