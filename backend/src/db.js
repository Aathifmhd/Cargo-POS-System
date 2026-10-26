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
  suppliers: { origin: 'india', contact_person: null, phone: null, whatsapp: null, email: null, city: null, state: null, address: null, gst_no: null,
    bank_details: null, credit_days: 60, opening_balance_inr: 0, notes: null, active: 1 },
  customers: { shop_name: null, nic_no: null, phone: null, whatsapp: null, city: null, address: null, credit_limit: 0, credit_days: 30,
    opening_balance: 0, notes: null, active: 1 },
  products: { category: null, subtype: null, pname: null, pcs_per_set: 1, colors_count: 0, color_names: null, sizes: null, supplier_id: null,
    cost_per_pcs: 0, last_cost_per_pcs: 0, mrp_per_set: 0, expected_per_set: 0, stock_pcs: 0, reorder_sets: 0, active: 1,
    opening_pcs: 0, opening_cost_per_pcs: 0, damaged_pcs: 0 },
  grns: { currency: 'INR', supplier_invoice_no: null, supplier_bill_date: null, cargo_name: null, bale_no: null, lr_no: null, goods_inr: 0, cargo_charge_inr: 0, cargo_in_supplier_bill: 0,
    payable_inr: 0, expenses_lkr: 0, other_lkr: 0, total_lkr: 0, total_sets: 0, total_pcs: 0, payment_type: 'credit', due_date: null, notes: null,
    effective_rate: null, settled_at: null },
  grn_expenses: { category: null, amount_lkr: 0 },
  grn_items: { category: null, cargo_lkr: 0, other_lkr: 0, cargo_per_pcs: null, other_per_pcs: null, short_status: null, short_date: null, short_note: null, extra_status: null, extra_date: null, extra_note: null, pcs_per_set: 1, colors_count: 0, color_names: null, sizes: null, mrp_per_set: 0, expected_per_set: 0,
    extra_sets: 0, extra_pcs: 0, short_sets: 0, short_pcs: 0, odd_pcs: 0 },
  supplier_payments: { grn_id: null, exchange_rate: 0, amount_lkr: 0, method: null, reference: null, notes: null, cheque_id: null },
  cargo_payments: { method: null, reference: null, notes: null, cheque_id: null },
  cheques: { party_id: null, bill_id: null, owner: null, bank: null, no_auto: 0, notes: null, payment_id: null, passed_on: null, history: [] },
  sales: { customer_id: null, customer_name: null, discount: 0, paid_at_sale: 0, cost_total: 0, due_date: null, notes: null, status: 'completed' },
  sale_items: { batch_id: null, batches: [], no_stock_pcs: 0, damaged: false, damaged_cost: 0, damaged_takes: [], code: null, mrp_per_unit: 0, expected_per_unit: 0, cost_per_unit: 0, disc: 0, disc_pct: 0 },
  customer_payments: { sale_id: null, method: null, reference: null, notes: null, cheque_id: null },
  stock_moves: { ref: null, note: null, batch_id: null, reason_code: null },
  bad_debts: { sale_id: null, reason: null, note: null },
  damaged: { sale_id: null, ref: null, cost_per_pcs: 0, in_pcs: 0, left_pcs: 0 },
  batches: { grn_id: null, kind: 'grn', ref: null, cost_per_pcs: 0, expected_per_pcs: 0, mrp_per_pcs: 0, in_pcs: 0, left_pcs: 0 },
  users: { role: 'cashier', active: 1, last_login: null, token_version: 0 },
  audit_log: { user_id: null, username: null, role: null, approved_by: null, level: null, key: null },
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
/** Find one document and remove it in one step (so two people can't both take it). */
export const takeOne = (name, filter) => col(name).findOneAndDelete(filter, { ...opt(), projection: NO_ID });
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
  'sales', 'sale_items', 'customer_payments', 'stock_moves', 'users', 'audit_log', 'fx_rates', 'batches',
  'cargo_payments', 'cheques', 'customer_ids', 'damaged', 'stocktakes', 'bad_debts', 'held'];

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
  cost_code_word: 'KNIGHTCLUB',        // the cost code: these ten letters are 1 2 3 4 5 6 7 8 9 0
  cost_code_repeat: 'S',               // written for a digit that repeats the one before it
  cost_code_add: '300',                // the code is of the cost per piece + this (the real cost shown stays as it is)
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
    ix('batches', { product_id: 1 }),
    ix('cheques', { cheque_date: 1 }),
    ix('cargo_payments', { cargo_name: 1 }),
    ix('batches', { grn_id: 1, product_id: 1 }),
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
/** Pieces a GRN line put into stock: what arrived, plus short pieces that came later (resolved as "received"). */
export const grnItemPcs = (it) => Math.max(0, ((it.sets || 0) + (it.extra_sets || 0) - (it.short_sets || 0)) * (it.pcs_per_set || 1) + (it.odd_pcs || 0) + (it.extra_pcs || 0) - (it.short_pcs || 0))
  + (it.short_status === 'received' ? itemShortPcs(it) : 0);
/** Pieces billed but not received on a GRN line. */
export const itemShortPcs = (it) => Math.max(0, (it.short_sets || 0) * (it.pcs_per_set || 1) + (it.short_pcs || 0));
/** Extra pieces taken off the supplier bill: kept free, or settled in the next shipment. */
export const unbilledExtraInr = (it) => (['free', 'next'].includes(it.extra_status) ? round2((it.extra_pcs || 0) * (it.cost_inr_per_set || 0) / (it.pcs_per_set || 1)) : 0);

/* ---------------- stock batches ----------------
 * Stock is kept batch by batch: one product's pieces from one GRN (at that GRN's cost and prices), its opening
 * stock, or a stock correction. Selling takes from the batch the cashier picks (or the oldest first), so the same
 * product bought at different costs keeps them apart. products.stock_pcs is the sum of its batches, and
 * products.cost_per_pcs their average (used for the stock value).
 *
 * Selling more than is in stock (a stock or billing mistake) is allowed: the pieces short go on the product's one
 * "short" batch (kind 'short', left_pcs below zero) at the cost of its last GRN, and that is the cost the bill's
 * profit keeps. Stock that comes in later (the next GRN, a return, a correction) fills the short batch first.
 */
export const batchOrder = (a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1);   // oldest first
const perPc = (v, pps) => round2((Number(v) || 0) / (pps || 1));

/** A product's cost: the average of the pieces left in its batches (or the newest batch's cost when none are left). */
export async function recomputeProductCost(productId) {
  const batches = (await find('batches', { product_id: productId, kind: { $ne: 'short' } })).sort(batchOrder);
  if (!batches.length) return;
  const left = batches.filter((b) => b.left_pcs > 0);
  const qty = sum(left, (b) => b.left_pcs);
  const newest = batches[batches.length - 1];
  const cost = qty > 0 ? sum(left, (b) => b.left_pcs * b.cost_per_pcs) / qty : newest.cost_per_pcs;
  await setById('products', productId, { cost_per_pcs: round2(cost), last_cost_per_pcs: round2(newest.cost_per_pcs) });
}

/** Change the product's stock count and write one line on its stock card. */
async function logMove(productId, pcs, type, ref, note, date, batchId, reasonCode = null) {
  const p = await col('products').findOneAndUpdate({ id: productId }, { $inc: { stock_pcs: pcs }, $set: { updated_at: stamp() } },
    { ...opt(), returnDocument: 'after', projection: NO_ID });
  if (!p) fail('Product not found', 404);
  await insert('stock_moves', { product_id: productId, date, type, ref: ref ?? null, pcs, balance: p.stock_pcs, note: note ?? null, batch_id: batchId ?? null, reason_code: reasonCode });
  return p;
}

/** The cost per piece of a product's last GRN (else its newest batch, else the product's own cost): what pieces sold without stock cost. */
export async function lastGrnCost(p) {
  const list = (await find('batches', { product_id: p.id, kind: { $ne: 'short' } })).sort(batchOrder);
  const grn = list.filter((b) => b.kind === 'grn').pop() || list.pop();
  return round2(grn ? grn.cost_per_pcs : p.last_cost_per_pcs || p.cost_per_pcs || 0);
}
/** The product's "short" batch (pieces sold without stock), made when first needed. */
async function shortBatch(p, date) {
  return (await findOne('batches', { product_id: p.id, kind: 'short' })) || insert('batches', {
    product_id: p.id, kind: 'short', ref: 'Sold without stock', grn_id: null, date, cost_per_pcs: await lastGrnCost(p),
    expected_per_pcs: perPc(p.expected_per_set, p.pcs_per_set), mrp_per_pcs: perPc(p.mrp_per_set, p.pcs_per_set), in_pcs: 0, left_pcs: 0,
  });
}
/**
 * Pieces sold without stock are made good by stock that comes in: they are taken from the other batches (newest
 * first) onto the short batch, which is removed once it is back to 0. The product's stock count doesn't change.
 */
export async function settleShort(productId) {
  const short = await findOne('batches', { product_id: productId, kind: 'short' });
  if (!short) return;
  let owed = -short.left_pcs;
  if (owed > 0) {
    const others = (await find('batches', { product_id: productId, kind: { $ne: 'short' }, left_pcs: { $gt: 0 } })).sort(batchOrder).reverse();
    for (const b of others) {
      if (owed <= 0) break;
      const take = Math.min(b.left_pcs, owed);
      await col('batches').updateOne({ id: b.id }, { $inc: { left_pcs: -take } }, opt());
      owed -= take;
    }
    await col('batches').updateOne({ id: short.id }, { $set: { left_pcs: -owed } }, opt());
  }
  if (owed <= 0) await deleteMany('batches', { id: short.id, left_pcs: { $gte: 0 } });
}

/**
 * Change a product's stock (in pieces), batch by batch, and log it on its stock card.
 * Taking out: from the chosen batch, or the oldest batches first. Putting in: into the chosen batch, or the newest;
 * `newBatch` (e.g. opening stock) — or a product with no batch yet — starts a new one.
 * Returns where the pieces went: [{ batch_id, pcs, cost_per_pcs }] (pcs negative when taken out).
 */
export async function moveStock(productId, pcs, type, ref, note, date = todayStr(), { batchId = null, batchIds = null, newBatch = null, reasonCode = null } = {}) {
  pcs = Math.round(pcs);
  if (!pcs) return [];
  const p = await findOne('products', { id: productId });
  if (!p) fail('Product not found', 404);
  const batches = (await find('batches', { product_id: productId })).sort(batchOrder);
  // several batches at the same cost (one row on the screens): taken from the oldest of them first
  const pool = Array.isArray(batchIds) && batchIds.length > 1 ? batches.filter((b) => batchIds.map(Number).includes(b.id)) : null;
  if (pool && !pool.length && pcs < 0) fail(`That stock of "${p.name}" no longer exists. Pick the item again.`);
  const one = batchId ?? (Array.isArray(batchIds) && batchIds.length === 1 ? batchIds[0] : null);
  const chosen = !pool && one != null ? batches.find((b) => b.id === Number(one)) : null;
  if (!pool && one != null && !chosen && pcs < 0) fail(`That stock batch of "${p.name}" no longer exists. Pick the item again.`);
  const moves = [];
  if (pcs < 0) {
    let need = -pcs;
    if (pool) {
      for (const b of pool) {
        if (need <= 0) break;
        const take = Math.min(Math.max(0, b.left_pcs), need);
        if (take > 0) { moves.push({ b, pcs: -take }); need -= take; }
      }
    } else if (chosen) {
      const take = Math.min(Math.max(0, chosen.left_pcs), need);
      if (take > 0) { moves.push({ b: chosen, pcs: -take }); need -= take; }
    }
    // then the oldest batches; what still isn't there is sold without stock (the short batch, at the last GRN's cost)
    for (const b of batches) {
      if (need <= 0) break;
      if (b.kind === 'short' || moves.some((m) => m.b.id === b.id)) continue;
      const take = Math.min(Math.max(0, b.left_pcs), need);
      if (take > 0) { moves.push({ b, pcs: -take }); need -= take; }
    }
    if (need > 0) moves.push({ b: await shortBatch(p, date), pcs: -need });
  } else {
    let b = newBatch ? null : chosen || batches.filter((x) => x.kind !== 'short').pop() || null;
    if (!b) {
      b = await insert('batches', {
        product_id: productId, kind: 'adjust', ref: 'Stock correction', date, cost_per_pcs: round2(p.cost_per_pcs),
        expected_per_pcs: perPc(p.expected_per_set, p.pcs_per_set), mrp_per_pcs: perPc(p.mrp_per_set, p.pcs_per_set),
        ...newBatch, in_pcs: 0, left_pcs: 0,
      });
    }
    moves.push({ b, pcs });
  }
  for (const m of moves) {
    await col('batches').updateOne({ id: m.b.id }, { $inc: { left_pcs: m.pcs, ...(m.b.kind !== 'grn' && m.pcs > 0 && !chosen ? { in_pcs: m.pcs } : {}) } }, opt());
    await logMove(productId, m.pcs, type, ref, note, date, m.b.id, reasonCode);
  }
  if (pcs > 0) await settleShort(productId);   // stock coming in makes good what was sold without stock
  await recomputeProductCost(productId);
  return moves.map((m) => ({ batch_id: m.b.id, pcs: m.pcs, cost_per_pcs: m.b.cost_per_pcs, short: m.b.kind === 'short' }));
}

/**
 * Bring one GRN's batch of a product in line with that GRN's lines (after saving, editing or deleting the GRN,
 * re-costing it, or receiving its short pieces later). Pieces already sold from the batch stay sold, so the GRN
 * can't go below them.
 */
export async function syncGrnBatch(grnId, productId, { ref, date, type = 'grn', note = null } = {}) {
  const lines = await find('grn_items', { grn_id: grnId, product_id: productId }, { sort: { id: 1 } });
  const b = await findOne('batches', { grn_id: grnId, product_id: productId });
  const gone = b ? b.in_pcs - b.left_pcs : 0;   // sold (or corrected) from this batch
  const name = (await findOne('products', { id: productId }, { project: { name: 1 } }))?.name || 'This product';
  if (!lines.length) {
    if (!b) return;
    if (gone > 0) fail(`"${name}" from ${b.ref} is already sold (${gone} pcs) — it can't be taken off this GRN.`);
    await deleteMany('batches', { id: b.id });
    if (b.left_pcs) await logMove(productId, -b.left_pcs, type, ref ?? b.ref, note, date ?? b.date, b.id);
    await recomputeProductCost(productId);
    return;
  }
  const inPcs = sum(lines, grnItemPcs);
  const left = inPcs - gone;
  if (left < 0) fail(`Cannot save: ${gone} pcs of "${name}" from this GRN are already sold, so it can't go below ${gone} pcs.`);
  const cost = inPcs ? sum(lines, (l) => grnItemPcs(l) * l.landed_per_pcs_lkr) / inPcs : lines[0].landed_per_pcs_lkr;
  const fields = {
    product_id: productId, grn_id: grnId, kind: 'grn', ref: ref ?? b?.ref ?? null, date: date ?? b?.date ?? todayStr(),
    cost_per_pcs: round2(cost), expected_per_pcs: perPc(lines[0].expected_per_set, lines[0].pcs_per_set), mrp_per_pcs: perPc(lines[0].mrp_per_set, lines[0].pcs_per_set),
    in_pcs: inPcs, left_pcs: left,
  };
  const id = b ? (await setById('batches', b.id, fields), b.id) : (await insert('batches', fields)).id;
  const diff = left - (b ? b.left_pcs : 0);
  if (diff) await logMove(productId, diff, type, fields.ref, note, fields.date, id);
  if (diff > 0) await settleShort(productId);
  await recomputeProductCost(productId);
}

/**
 * Once: split every product's stock into batches (its GRNs, opening stock), the pieces left being the newest.
 * Every start: if a product's batches don't add up to its stock (e.g. an older copy of the app sold from it),
 * the difference is taken from the oldest batches or put on the newest.
 */
export async function setupBatches() {
  if (num((await getSettings()).batches_version) < 1) {
    await tx(async () => {
      const [products, grns, lines, existing] = await Promise.all([find('products'), find('grns'), find('grn_items'), find('batches', {}, { project: { product_id: 1 } })]);
      const has = new Set(existing.map((b) => b.product_id));
      const grnOf = Object.fromEntries(grns.map((g) => [g.id, g]));
      for (const p of products) {
        if (has.has(p.id)) continue;
        const list = [];
        if (p.opening_pcs > 0) {
          list.push({ kind: 'opening', ref: 'Opening stock', grn_id: null, date: String(p.created_at || '').slice(0, 10) || todayStr(), cost_per_pcs: round2(p.opening_cost_per_pcs),
            expected_per_pcs: perPc(p.expected_per_set, p.pcs_per_set), mrp_per_pcs: perPc(p.mrp_per_set, p.pcs_per_set), in_pcs: p.opening_pcs, id: 0 });
        }
        const byGrn = new Map();
        for (const l of lines.filter((x) => x.product_id === p.id && grnOf[x.grn_id])) byGrn.set(l.grn_id, [...(byGrn.get(l.grn_id) || []), l]);
        for (const [gid, ls] of byGrn) {
          const g = grnOf[gid];
          const inPcs = sum(ls, grnItemPcs);
          list.push({ kind: 'grn', ref: g.grn_no, grn_id: gid, date: g.date, id: gid,
            cost_per_pcs: round2(inPcs ? sum(ls, (l) => grnItemPcs(l) * l.landed_per_pcs_lkr) / inPcs : ls[0].landed_per_pcs_lkr),
            expected_per_pcs: perPc(ls[0].expected_per_set, ls[0].pcs_per_set), mrp_per_pcs: perPc(ls[0].mrp_per_set, ls[0].pcs_per_set), in_pcs: inPcs });
        }
        list.sort(batchOrder);
        // the pieces still in stock are the newest ones
        let need = Math.max(0, p.stock_pcs);
        for (const b of [...list].reverse()) { b.left_pcs = Math.min(b.in_pcs, need); need -= b.left_pcs; }
        if (need > 0) {
          list.push({ kind: 'adjust', ref: 'Stock correction', grn_id: null, date: todayStr(), cost_per_pcs: round2(p.cost_per_pcs),
            expected_per_pcs: perPc(p.expected_per_set, p.pcs_per_set), mrp_per_pcs: perPc(p.mrp_per_set, p.pcs_per_set), in_pcs: need, left_pcs: need });
        }
        for (const { id, ...b } of list) await insert('batches', { ...b, product_id: p.id });
      }
      await setSetting('batches_version', 1);
    });
  }
  return reconcileBatches();
}

async function reconcileBatches() {
  const [products, batches] = await Promise.all([find('products', {}, { project: { id: 1, stock_pcs: 1, cost_per_pcs: 1, expected_per_set: 1, mrp_per_set: 1, pcs_per_set: 1 } }), find('batches')]);
  let fixed = 0;
  for (const p of products) {
    const mine = batches.filter((b) => b.product_id === p.id).sort(batchOrder);
    let diff = p.stock_pcs - sum(mine, (b) => b.left_pcs);
    if (!diff) continue;
    fixed++;
    if (diff > 0) {
      const b = mine.find((x) => x.kind === 'short') || mine[mine.length - 1];
      if (b) await col('batches').updateOne({ id: b.id }, { $inc: { left_pcs: diff } });
      else {
        await insert('batches', { product_id: p.id, kind: 'adjust', ref: 'Stock correction', date: todayStr(), cost_per_pcs: round2(p.cost_per_pcs),
          expected_per_pcs: perPc(p.expected_per_set, p.pcs_per_set), mrp_per_pcs: perPc(p.mrp_per_set, p.pcs_per_set), in_pcs: diff, left_pcs: diff });
      }
    } else {
      for (const b of mine) {
        if (diff >= 0) break;
        const take = Math.min(Math.max(0, b.left_pcs), -diff);
        if (take) { await col('batches').updateOne({ id: b.id }, { $inc: { left_pcs: -take } }); diff += take; }
      }
      // still more out than in: those pieces were sold without stock
      if (diff < 0) await col('batches').updateOne({ id: (await shortBatch(p, todayStr())).id }, { $inc: { left_pcs: diff } });
    }
    await recomputeProductCost(p.id);
  }
  return fixed;
}
