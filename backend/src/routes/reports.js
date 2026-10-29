import { Router } from 'express';
import {
  find, findOne, updateMany, fail, num, round2, sum, todayStr, addDays, getSettings, setSetting, DB_LABEL, COLLECTIONS, inParallel, stamp,
} from '../db.js';
import { supplierLedgers, customerLedgers, revalueGrns, customerLabel, customerPerson } from '../services.js';
import { guard, audit, rankOf, RANK, can } from '../auth.js';
import { lankaNow } from '../cheques.js';
import { setView } from '../costcode.js';

/*
 * The money window. "Start Fresh" (after a stock take) saves the moment the new period starts (settings.fresh_start_at):
 * Sales & Profit and the Dashboard only count what happened after it. Nothing is deleted — a past period can still be
 * looked at (?period=<stock take id>), between its own start and end.
 * win: { after, before } — saved times ("YYYY-MM-DD HH:MM:SS", UTC); either can be empty.
 */
export const stampDate = (s) => (s ? lankaNow(new Date(String(s).replace(' ', 'T') + 'Z')).date : null);
export const inWin = (stampValue, win) => (!win.after || String(stampValue || '') >= win.after) && (!win.before || String(stampValue || '') < win.before);
/** The dates to read: the period asked for, inside the window. */
const datesIn = (from, to, win) => [[from, stampDate(win.after)].filter(Boolean).sort().pop(), [to, stampDate(win.before)].filter(Boolean).sort()[0]];
export async function windowFor(req) {
  if (req.query.period) {
    const st = await findOne('stocktakes', { id: num(req.query.period) }, { project: { period: 1, no: 1 } });
    if (!st?.period) fail('That period was not found', 404);
    return { after: st.period.from_stamp || null, before: st.period.to_stamp || null, no: st.no };
  }
  const s = await getSettings();
  return { after: s.fresh_start_at || null, before: null, no: s.fresh_start_no || null };
}

/** Sales & Profit is the Super Admin's only. */
const superOnly = (req) => { if (rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can see Sales & Profit', 403); };

const r = Router();

/** Settings without the secret that signs logins and approvals (never sent to the browser). */
const publicSettings = async () => {
  const { session_secret, ...rest } = await getSettings();
  return rest;
};

/** Settings → Categories, products & sizes: keep it a tidy list of { name, sizes[], types[] }. */
function cleanCatalog(raw) {
  let list;
  try { list = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { fail('The category list could not be read'); }
  if (!Array.isArray(list)) fail('The category list could not be read');
  const uniq = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean))];
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const name = String(c?.name || '').trim();
    if (!name) continue;
    if (seen.has(name.toLowerCase())) fail(`The category "${name}" is listed twice`);
    seen.add(name.toLowerCase());
    // product names are typed on Receive Goods, so the list keeps only categories, products and sizes
    out.push({ name, sizes: uniq(c.sizes), types: uniq(c.types), reorder_sets: Math.max(0, Math.round(Number(c.reorder_sets) || 0)) });
  }
  return JSON.stringify(out);
}

/* ---------------- the discreet view (5 taps on Settings, on any device, by any user) ---------------- */
r.post('/view', async (req, res) => {
  const on = Boolean(req.body?.on);
  await setView(on);
  await audit(req.user, `Discreet view switched ${on ? 'on' : 'off'} for every device`);
  res.set('X-View-State', on ? '1' : '0');
  res.json({ on });
});

/* ---------------- settings ---------------- */
r.get('/settings', async (req, res) => res.json(await publicSettings()));

/** Receive Goods → "+ Add product": add one product to a category's list (any signed-in user). */
r.post('/catalog/products', async (req, res) => {
  const category = String(req.body?.category || '').trim();
  const product = String(req.body?.product || '').trim();
  if (!category || !product) fail('Choose a category and type the product name');
  const list = JSON.parse((await getSettings()).catalog || '[]');
  const cat = list.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) fail(`"${category}" is not in the category list`);
  cat.types = cat.types || [];
  const existing = cat.types.find((t) => t.toLowerCase() === product.toLowerCase());
  if (!existing) {
    cat.types.push(product);
    await setSetting('catalog', cleanCatalog(list));
    await audit(req.user, `Added product "${product}" to ${cat.name}`);
  }
  res.json({ catalog: (await getSettings()).catalog, product: existing || product });
});

r.put('/settings', async (req, res) => {
  const old = await getSettings();
  const body = { ...(req.body || {}) };
  // the exchange rate has its own endpoint (/api/fx), and the token secret is never changed from here
  for (const k of Object.keys(body)) if (k === 'default_exchange_rate' || k.startsWith('fx_') || k === 'session_secret') delete body[k];
  if ('catalog' in body) body.catalog = cleanCatalog(body.catalog);
  if ('costing_rate' in body && !(Number(body.costing_rate) > 0)) fail('The costing rate must be more than 0');
  // the cost code: ten different letters, a repeat letter that is not one of them, and an amount added
  if ('cost_code_word' in body || 'cost_code_repeat' in body) {
    const w = String(body.cost_code_word ?? old.cost_code_word ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    const rep = String(body.cost_code_repeat ?? old.cost_code_repeat ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    if (w.length !== 10 || new Set(w).size !== 10) fail('The code word needs ten different letters (e.g. KNIGHTCLUB)');
    if (rep.length !== 1) fail('The repeat letter is one letter (e.g. S)');
    if (w.includes(rep)) fail(`The repeat letter "${rep}" can't be one of the code word's letters`);
    body.cost_code_word = w; body.cost_code_repeat = rep;
  }
  if ('cost_code_add' in body && !(Number(body.cost_code_add) >= 0)) fail('The amount added for the code must be 0 or more');
  const changed = Object.keys(body).filter((k) => String(body[k] ?? '') !== String(old[k] ?? ''));
  if (!changed.length) return res.json(await publicSettings());
  await guard(req, `Settings changed: ${changed.join(', ')}`);
  for (const [k, v] of Object.entries(body)) await setSetting(k, v);
  // a category's re-order level that changed applies to every product in that category
  if (changed.includes('catalog')) {
    let before = [];
    try { before = JSON.parse(old.catalog || '[]'); } catch { /* treat as empty */ }
    for (const c of JSON.parse(body.catalog)) {
      const prev = before.find((b) => b.name.toLowerCase() === c.name.toLowerCase());
      if (Number(prev?.reorder_sets || 0) === c.reorder_sets) continue;
      const exact = new RegExp(`^${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
      await updateMany('products', { category: exact }, { $set: { reorder_sets: c.reorder_sets } });
    }
  }
  // a new costing rate re-costs every GRN and product
  if (changed.includes('costing_rate')) await revalueGrns();
  res.json(await publicSettings());
});

/* ---------------- stock value, batch by batch ----------------
 * The same product bought at different costs keeps them apart (stock batches), each batch with its own cost and
 * expected price — so stock value is pieces × cost (and × expected price) batch by batch, not one price per product.
 */
async function stockValues(products) {
  const ids = products.map((p) => p.id);
  const batches = ids.length ? await find('batches', { product_id: { $in: ids }, left_pcs: { $gt: 0 } }) : [];
  const out = new Map();
  for (const p of products) {
    const mine = batches.filter((b) => b.product_id === p.id);
    const expPc = p.expected_per_set / (p.pcs_per_set || 1);
    out.set(p.id, mine.length ? {
      cost: sum(mine, (b) => b.left_pcs * b.cost_per_pcs),
      expected: sum(mine, (b) => b.left_pcs * (b.expected_per_pcs || expPc)),
    } : { cost: Math.max(0, p.stock_pcs) * p.cost_per_pcs, expected: Math.max(0, p.stock_pcs) * expPc });
  }
  return out;
}

/* ---------------- payables / receivables ---------------- */
const allPayables = async () => [...(await supplierLedgers()).values()].flat().filter((b) => b.balance > 0.009);
const allReceivables = async () => [...(await customerLedgers()).values()].flat().filter((b) => b.balance > 0.009);
const byDue = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999');

r.get('/dues/payables', async (req, res) => res.json((await allPayables()).sort(byDue)));
r.get('/dues/receivables', async (req, res) => res.json((await allReceivables()).sort(byDue)));

/** Payments Due → History: payments made to suppliers, or received from customers, newest first. */
r.get('/dues/history', async (req, res) => {
  if (req.query.kind === 'cargo') {
    const pays = await find('cargo_payments', {}, { sort: { date: -1, id: -1 }, limit: 1000 });
    return res.json(pays.map((p) => ({ id: p.id, date: p.date, at: p.created_at || null, who: p.cargo_name, who_id: null, bill_id: null, bill_no: null, amount: p.amount, amount_lkr: p.amount,
      method: p.method, reference: p.reference, notes: p.notes, currency: 'LKR', cargo: true, cheque_id: p.cheque_id ?? null })));
  }
  const supplier = req.query.kind === 'payables';
  const pays = await find(supplier ? 'supplier_payments' : 'customer_payments', {}, { sort: { date: -1, id: -1 }, limit: 1000 });
  const whoIds = [...new Set(pays.map((p) => (supplier ? p.supplier_id : p.customer_id)))];
  const billIds = [...new Set(pays.map((p) => (supplier ? p.grn_id : p.sale_id)).filter((x) => x != null))];
  const [who, bills] = await inParallel(
    () => (whoIds.length ? find(supplier ? 'suppliers' : 'customers', { id: { $in: whoIds } }, { project: { id: 1, name: 1, origin: 1, shop_name: 1 } }) : []),
    () => (billIds.length ? find(supplier ? 'grns' : 'sales', { id: { $in: billIds } }, { project: { id: 1, grn_no: 1, invoice_no: 1 } }) : []),
  );
  const nameOf = Object.fromEntries(who.map((w) => [w.id, supplier ? w.name : customerLabel(w)]));
  const personOf = Object.fromEntries(who.map((w) => [w.id, supplier ? null : customerPerson(w)]));
  const localOf = Object.fromEntries(who.map((w) => [w.id, supplier && w.origin === 'local']));
  const billOf = Object.fromEntries(bills.map((b) => [b.id, b.grn_no || b.invoice_no]));
  res.json(pays.map((p) => {
    const whoId = supplier ? p.supplier_id : p.customer_id;
    const billId = supplier ? p.grn_id : p.sale_id;
    return {
      id: p.id, date: p.date, at: p.created_at || null, who_id: whoId, who: nameOf[whoId] || '—', who_sub: personOf[whoId] || null, bill_id: billId ?? null, bill_no: billId != null ? billOf[billId] || null : null,
      amount: supplier ? p.amount_inr : p.amount, amount_lkr: supplier ? p.amount_lkr : p.amount,
      currency: !supplier || localOf[whoId] ? 'LKR' : 'INR',
      method: p.method || null, reference: p.reference || null, notes: p.notes || null, cheque_id: p.cheque_id ?? null,
    };
  }));
});

/* ---------------- shared sums ---------------- */
const inRange = (from, to) => ({ $gte: from, $lte: to });
/** totals of completed bills: count, sales, profit, cash, credit */
const billTotals = (sales) => ({
  bills: sales.length,
  sales: sum(sales, (s) => s.total),
  profit: sum(sales, (s) => s.total - s.cost_total),
  cash: sum(sales.filter((s) => s.payment_type === 'cash'), (s) => s.total),
  credit: sum(sales.filter((s) => s.payment_type === 'credit'), (s) => s.total),
});
const desc = (key) => (a, b) => (b[key] || 0) - (a[key] || 0);
const lowStock = (p) => p.stock_pcs < p.reorder_sets * p.pcs_per_set;

/* ---------------- dashboard ---------------- */
r.get('/dashboard', async (req, res) => {
  const win = await windowFor({ query: {} });
  const today = todayStr();
  const monthStart = today.slice(0, 8) + '01';
  const first = [monthStart, addDays(today, -6)].sort()[0];
  // everything the dashboard needs, read together
  const [sales, paysToday, payables, receivables, products, recentSales, recent] = await inParallel(
    () => find('sales', { status: 'completed', date: inRange(first, today) }),
    () => find('customer_payments', { date: today }, { project: { amount: 1 } }),
    () => allPayables(),
    () => allReceivables(),
    () => find('products', { active: 1 }),
    () => find('sales', {}, { sort: { id: -1 }, limit: 6, project: { id: 1, invoice_no: 1, date: 1, created_at: 1, customer_name: 1, payment_type: 1, total: 1, status: 1 } }),
    () => find('grns', {}, { sort: { id: -1 }, limit: 4, project: { id: 1, grn_no: 1, date: 1, bale_no: 1, cargo_name: 1, total_lkr: 1, supplier_id: 1 } }),
  );
  const between = (from, to) => sales.filter((s) => s.date >= from && s.date <= to && inWin(s.created_at, win));

  const collectedToday = sum(paysToday, (p) => p.amount) + sum(between(today, today), (s) => s.paid_at_sale);

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const t = billTotals(between(d, d));
    last7.push({ date: d, sales: t.sales, profit: t.profit });
  }

  const inStock = products.filter((p) => p.stock_pcs > 0);
  const values = await stockValues(inStock);
  const stock = {
    cost_value: sum(inStock, (p) => values.get(p.id).cost),
    expected_value: sum(inStock, (p) => values.get(p.id).expected),
    pcs: sum(inStock, (p) => p.stock_pcs),
    products: inStock.length,
  };
  const low = products.filter(lowStock);
  const lowList = low
    .map(({ id, code, name, stock_pcs, pcs_per_set, reorder_sets }) => ({ id, code, name, stock_pcs, pcs_per_set, reorder_sets }))
    .sort((a, b) => a.stock_pcs / (a.reorder_sets * a.pcs_per_set) - b.stock_pcs / (b.reorder_sets * b.pcs_per_set))
    .slice(0, 8);

  const monthSales = between(monthStart, today);
  const [monthLines, sList] = await inParallel(
    () => (monthSales.length ? find('sale_items', { sale_id: { $in: monthSales.map((s) => s.id) } }) : []),
    () => find('suppliers', { id: { $in: recent.map((g) => g.supplier_id) } }, { project: { id: 1, name: 1 } }),
  );
  const top = {};
  for (const l of monthLines) {
    const t = (top[l.product_id] ??= { product_id: l.product_id, name: l.name, pcs: 0, amount: 0 });
    t.pcs += l.pcs;
    t.amount += l.line_total;
  }
  const sNames = Object.fromEntries(sList.map((s) => [s.id, s.name]));

  const week = addDays(today, 7);
  res.json({
    today: billTotals(between(today, today)),
    month: billTotals(monthSales),
    collectedToday: round2(collectedToday),
    last7,
    payables: {
      total_inr: round2(sum(payables.filter((b) => b.currency !== 'LKR'), (b) => b.balance)),
      overdue_inr: round2(sum(payables.filter((b) => b.currency !== 'LKR' && b.status === 'overdue'), (b) => b.balance)),
      total_lkr: round2(sum(payables.filter((b) => b.currency === 'LKR'), (b) => b.balance)),
      overdue_lkr: round2(sum(payables.filter((b) => b.currency === 'LKR' && b.status === 'overdue'), (b) => b.balance)),
      upcoming: payables.filter((b) => b.due_date && b.due_date <= week).sort(byDue).slice(0, 6),
    },
    receivables: {
      total: round2(sum(receivables, (b) => b.balance)),
      overdue: round2(sum(receivables.filter((b) => b.status === 'overdue'), (b) => b.balance)),
      upcoming: receivables.filter((b) => b.status === 'overdue' || (b.due_date && b.due_date <= week)).sort(byDue).slice(0, 6),
    },
    stock: { ...stock, cost_value: round2(stock.cost_value), expected_value: round2(stock.expected_value), low_count: low.length },
    lowStock: lowList,
    topProducts: Object.values(top).sort(desc('amount')).slice(0, 5),
    recentSales,
    recentGrns: recent.filter((g) => sNames[g.supplier_id] !== undefined).map(({ supplier_id, ...g }) => ({ ...g, supplier_name: sNames[supplier_id] })),
    fresh: win.after ? { at: win.after, no: win.no } : null,
    ...(can(req.user, 'suppliers') ? {} : { payables: null, recentGrns: [] }),
  });
});

/* ---------------- reports ---------------- */
r.get('/reports/sales', async (req, res) => {
  superOnly(req);
  const win = await windowFor(req);
  const [from, to] = datesIn(req.query.from || todayStr(), req.query.to || todayStr(), win);
  const [allRaw, paymentsRaw] = await inParallel(
    () => find('sales', { date: inRange(from, to) }),
    () => find('customer_payments', { date: inRange(from, to) }, { project: { amount: 1, created_at: 1 } }),
  );
  const all = allRaw.filter((s) => inWin(s.created_at, win));
  const payments = paymentsRaw.filter((p) => inWin(p.created_at, win));
  const sales = all.filter((s) => s.status === 'completed');
  const t = billTotals(sales);
  const summary = {
    bills: t.bills, sales: t.sales, cost: sum(sales, (s) => s.cost_total), profit: t.profit, discount: sum(sales, (s) => s.discount),
    cash: t.cash, credit: t.credit, collections: sum(payments, (p) => p.amount), voided: all.filter((s) => s.status === 'void').length,
  };
  const days = {};
  for (const s of sales) (days[s.date] ??= []).push(s);
  const daily = Object.keys(days).sort().map((date) => {
    const d = billTotals(days[date]);
    return { date, bills: d.bills, sales: d.sales, profit: d.profit, cash: d.cash, credit: d.credit };
  });
  const lines = sales.length ? await find('sale_items', { sale_id: { $in: sales.map((s) => s.id) } }) : [];
  // damaged: the cost written off on damaged returns, and what damaged pieces were sold for (both already in the profit)
  summary.damage_loss = round2(sum(lines.filter((l) => l.damaged && l.qty < 0), (l) => l.damaged_cost * -l.qty));
  summary.damage_sold = round2(sum(lines.filter((l) => l.damaged && l.qty > 0), (l) => l.line_total));
  summary.damage_sold_cost = round2(sum(lines.filter((l) => l.damaged && l.qty > 0), (l) => l.damaged_cost * l.qty));
  const prods = {};
  for (const l of lines) {
    const p = (prods[l.product_id] ??= { product_id: l.product_id, code: l.code, name: l.name, pcs: 0, amount: 0, profit: 0 });
    p.pcs += l.pcs;
    p.amount += l.line_total;
    p.profit += l.line_total - l.cost_per_unit * l.qty;
  }
  const custs = {};
  for (const s of sales) {
    const key = s.customer_id ?? `name:${s.customer_name}`;
    const c = (custs[key] ??= { customer_id: s.customer_id, customer_name: s.customer_name, bills: 0, amount: 0, profit: 0 });
    c.bills++;
    c.amount += s.total;
    c.profit += s.total - s.cost_total;
  }
  // every bill of the period (cancelled ones too, marked)
  const bills = all.slice().sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1)).map((s) => ({
    id: s.id, invoice_no: s.invoice_no, date: s.date, created_at: s.created_at, customer_id: s.customer_id, customer_name: s.customer_name,
    payment_type: s.payment_type, total: s.total, paid_at_sale: s.paid_at_sale, discount: s.discount, status: s.status,
    items: lines.filter((l) => l.sale_id === s.id).length,
  }));
  res.json({ from, to, fresh: win.after ? { at: win.after, before: win.before, no: win.no } : null, summary, daily, bills, products: Object.values(prods).sort(desc('amount')), customers: Object.values(custs).sort(desc('amount')) });
});

/**
 * Sales & Profit → Profit & loss for a period.
 *  Profit: each bill's profit (its sales less their cost), the extra pieces suppliers let us keep free, stock found on a count.
 *  Loss, with its reason: damaged returns (their cost written off), selling under cost (cost − price), GRN short pieces
 *  lost, stock taken off on a correction.
 * The losses inside a bill (damaged returns, under cost) are taken out of that bill's profit and listed as losses,
 * so: net profit = gross profit − losses = what the bills made, + free extras, ± stock corrections, − lost shorts.
 */
r.get('/reports/profit', async (req, res) => {
  superOnly(req);
  const win = await windowFor(req);
  res.json(await profitLoss(req.query.from || todayStr(), req.query.to || todayStr(), win));
});

/** Profit & loss between two dates, inside the window (see /reports/profit). */
export async function profitLoss(fromDate, toDate, win = {}) {
  const [from, to] = datesIn(fromDate, toDate, win);
  const sales = (await find('sales', { date: inRange(from, to), status: 'completed' })).filter((s) => inWin(s.created_at, win)).sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  const [lines, extraLines, shortLines, moves, bads] = await inParallel(
    () => (sales.length ? find('sale_items', { sale_id: { $in: sales.map((s) => s.id) } }) : []),
    () => find('grn_items', { $or: [{ extra_status: 'free', extra_date: inRange(from, to) }, { extra_sets: { $gt: 0 } }] }),
    () => find('grn_items', { short_status: 'lost', short_date: inRange(from, to) }),
    () => find('stock_moves', { type: { $in: ['adjust', 'damaged', 'repaired', 'stocktake'] }, date: inRange(from, to), note: { $ne: 'Opening stock' } }).then((l) => l.filter((m) => inWin(m.created_at, win))),
    () => find('bad_debts', { date: inRange(from, to) }).then((l) => l.filter((d) => inWin(d.created_at, win))),
  );
  const grnIds = [...new Set([...extraLines, ...shortLines].map((i) => i.grn_id))];
  const [grns, batches, products] = await inParallel(
    () => (grnIds.length ? find('grns', { id: { $in: grnIds } }, { project: { id: 1, grn_no: 1, date: 1 } }) : []),
    () => (moves.length ? find('batches', { id: { $in: moves.map((m) => m.batch_id).filter((x) => x != null) } }, { project: { id: 1, cost_per_pcs: 1, ref: 1 } }) : []),
    () => (moves.length ? find('products', { id: { $in: [...new Set(moves.map((m) => m.product_id))] } }, { project: { id: 1, code: 1, name: 1, cost_per_pcs: 1 } }) : []),
  );
  const grnOf = Object.fromEntries(grns.map((g) => [g.id, g]));
  const batchOf = Object.fromEntries(batches.map((b) => [b.id, b]));
  const prodOf = Object.fromEntries(products.map((p) => [p.id, p]));
  const losses = [];
  const gains = [];

  // each bill: its profit, with the losses inside it taken out (listed below with their reason)
  const invoices = sales.map((s) => {
    const mine = lines.filter((l) => l.sale_id === s.id);
    let lost = 0;
    for (const l of mine) {
      if (l.damaged && l.qty < 0) {
        const amount = round2(l.damaged_cost * -l.qty);
        lost += amount;
        losses.push({ reason: 'damaged', date: s.date, ref: s.invoice_no, sale_id: s.id, code: l.code, name: l.name, pcs: -l.pcs, amount,
          note: `Damaged return from ${s.customer_name} — cost written off` });
      } else if (!l.damaged && l.qty > 0 && l.cost_per_unit * l.qty > l.line_total + 0.009) {
        const amount = round2(l.cost_per_unit * l.qty - l.line_total);
        lost += amount;
        losses.push({ reason: 'undercost', date: s.date, ref: s.invoice_no, sale_id: s.id, code: l.code, name: l.name, pcs: l.pcs, amount,
          note: `Sold at ${round2(l.line_total / l.qty)} — cost ${l.cost_per_unit} (${s.customer_name})` });
      }
    }
    const made = round2(s.total - s.cost_total);
    return {
      id: s.id, invoice_no: s.invoice_no, date: s.date, created_at: s.created_at, customer_id: s.customer_id, customer_name: s.customer_name,
      payment_type: s.payment_type, total: s.total, cost: s.cost_total, items: mine.length,
      damaged_sold: round2(sum(mine.filter((l) => l.damaged && l.qty > 0), (l) => l.line_total)),
      profit: round2(made + lost),      // before its losses
      losses: round2(lost), net: made,
    };
  });

  // extra pieces kept free: a profit (what they cost us per piece)
  for (const it of extraLines) {
    const g = grnOf[it.grn_id];
    if (!g) continue;
    const pc = it.landed_per_pcs_lkr || 0;
    const productPc = ((it.cost_inr_per_set || 0) / (it.pcs_per_set || 1)) * (g.exchange_rate || 1);   // the product cost, no cargo charge
    if (it.extra_status === 'free' && it.extra_pcs > 0 && it.extra_date >= from && it.extra_date <= to) {
      gains.push({ reason: 'extra', date: it.extra_date, ref: g.grn_no, grn_id: g.id, name: it.name, pcs: it.extra_pcs, amount: round2(it.extra_amount ?? it.extra_pcs * productPc), note: it.extra_note || 'Extra pieces kept free' });
    }
    // older GRNs: free extra sets, on the GRN's date
    if (it.extra_sets > 0 && g.date >= from && g.date <= to) {
      const pcs = it.extra_sets * (it.pcs_per_set || 1);
      gains.push({ reason: 'extra', date: g.date, ref: g.grn_no, grn_id: g.id, name: it.name, pcs, amount: round2(pcs * pc), note: 'Free extra sets' });
    }
  }
  // GRN short pieces lost: paid for, never received
  for (const it of shortLines) {
    const g = grnOf[it.grn_id];
    if (!g) continue;
    const pcs = (it.short_sets || 0) * (it.pcs_per_set || 1) + (it.short_pcs || 0);
    const productPc = ((it.cost_inr_per_set || 0) / (it.pcs_per_set || 1)) * (g.exchange_rate || 1);   // the product cost, no cargo charge
    losses.push({ reason: 'short', date: it.short_date, ref: g.grn_no, grn_id: g.id, name: it.name, pcs, amount: round2(it.short_amount ?? pcs * productPc), note: it.short_note || 'Short pieces lost — paid for, not received' });
  }
  // stock corrections: taken off = a loss, found = a gain (at the batch's cost)
  for (const m of moves) {
    const p = prodOf[m.product_id];
    const amount = round2(Math.abs(m.pcs) * (batchOf[m.batch_id]?.cost_per_pcs ?? p?.cost_per_pcs ?? 0));
    const row = { date: m.date, ref: 'Stock correction', code: p?.code, name: p?.name || `#${m.product_id}`, pcs: Math.abs(m.pcs), amount, note: m.note || '' };
    if (m.type === 'stocktake') {
      if (m.pcs < 0) losses.push({ ...row, reason: 'stocktake', ref: m.ref || 'Stock take', note: 'Short on the stock take' });
      else gains.push({ ...row, reason: 'stocktake_over', ref: m.ref || 'Stock take', note: 'More than the system on the stock take' });
      continue;
    }
    if (m.type === 'damaged') losses.push({ ...row, reason: 'damaged', ref: 'Stock Count', note: `${m.note || 'Damaged'} — moved to damaged stock` });
    else if (m.pcs < 0) losses.push({ reason: m.reason_code && m.reason_code !== 'nobill' ? m.reason_code : 'stock', ...row });
    else if (m.type === 'repaired') gains.push({ ...row, reason: 'repaired', note: `${m.note || 'Repaired'} — back from the damaged stock` });
    else gains.push({ reason: m.reason_code ? `add_${m.reason_code}` : 'stockfound', ...row });
  }

  // bad debts: dues written off — what the customer never paid
  if (bads.length) {
    const cs = Object.fromEntries((await find('customers', { id: { $in: [...new Set(bads.map((d) => d.customer_id))] } })).map((c) => [c.id, c]));
    for (const d of bads) {
      losses.push({ reason: 'baddebt', date: d.date, ref: d.invoice_no, sale_id: d.sale_id, name: customerLabel(cs[d.customer_id]) || '—', pcs: 0, amount: round2(d.amount),
        note: `Uncollectable — ${d.reason}${d.note ? `: ${d.note}` : ''} (by ${d.by})` });
    }
  }
  const invoiceProfit = round2(sum(invoices, (i) => i.profit));
  const extraProfit = round2(sum(gains.filter((g) => g.reason === 'extra'), (g) => g.amount));
  const stockGain = round2(sum(gains.filter((g) => g.reason !== 'extra'), (g) => g.amount));
  const lossTotal = round2(sum(losses, (l) => l.amount));
  const gross = round2(invoiceProfit + extraProfit + stockGain);
  const byReason = Object.entries(losses.reduce((m, l) => ({ ...m, [l.reason]: (m[l.reason] || 0) + l.amount }), {})).map(([reason, amount]) => ({ reason, amount: round2(amount), count: losses.filter((l) => l.reason === reason).length }));
  return {
    from, to, fresh: win.after || win.before ? { at: win.after, before: win.before, no: win.no } : null,
    summary: {
      bills: invoices.length, sales: round2(sum(invoices, (i) => i.total)), cost: round2(sum(invoices, (i) => i.cost)),
      invoice_profit: invoiceProfit, extra_profit: extraProfit, stock_gain: stockGain, gross_profit: gross, losses: lossTotal, net_profit: round2(gross - lossTotal),
    },
    invoices: invoices.slice().reverse(),
    gains: gains.sort((a, b) => (a.date < b.date ? 1 : -1)),
    losses: losses.sort((a, b) => (a.date < b.date ? 1 : -1)),
    by_reason: byReason.sort((a, b) => b.amount - a.amount),
  };
}

/** Damaged stock: damaged returns kept apart (their cost is written off as a loss). */
r.get('/reports/damaged', async (req, res) => {
  const list = await find('damaged', { left_pcs: { $gt: 0 } }, { sort: { date: -1, id: -1 } });
  const prods = Object.fromEntries((list.length ? await find('products', { id: { $in: [...new Set(list.map((d) => d.product_id))] } }, { project: { id: 1, code: 1, name: 1 } }) : []).map((p) => [p.id, p]));
  res.json(list.map((d) => ({ ...d, code: prods[d.product_id]?.code, name: prods[d.product_id]?.name })));
});

r.get('/reports/stock', async (req, res) => {
  const products = await find('products', { active: 1, stock_pcs: { $gt: 0 } });
  const values = await stockValues(products);
  const cats = {};
  for (const p of products) {
    const key = p.category ?? 'Uncategorised';
    const c = (cats[key] ??= { category: key, products: 0, pcs: 0, cost_value: 0, expected_value: 0, mrp_value: 0 });
    c.products++;
    c.pcs += p.stock_pcs;
    c.cost_value += values.get(p.id).cost;
    c.expected_value += values.get(p.id).expected;
    c.mrp_value += (p.stock_pcs * p.mrp_per_set) / p.pcs_per_set;
  }
  // slow movers: in stock, nothing sold in 60 days
  const since = addDays(todayStr(), -60);
  const ids = products.map((p) => p.id);
  const lines = ids.length ? await find('sale_items', { product_id: { $in: ids } }, { project: { sale_id: 1, product_id: 1 } }) : [];
  const saleDates = Object.fromEntries((lines.length ? await find('sales', { id: { $in: [...new Set(lines.map((l) => l.sale_id))] }, status: 'completed' }, { project: { id: 1, date: 1 } }) : [])
    .map((s) => [s.id, s.date]));
  const lastSold = {};
  for (const l of lines) {
    const d = saleDates[l.sale_id];
    if (d && (!lastSold[l.product_id] || d > lastSold[l.product_id])) lastSold[l.product_id] = d;
  }
  const slow = products
    .filter((p) => !(lastSold[p.id] && lastSold[p.id] >= since))
    .map((p) => ({ id: p.id, code: p.code, name: p.name, stock_pcs: p.stock_pcs, pcs_per_set: p.pcs_per_set, cost_value: round2(values.get(p.id).cost), last_sold: lastSold[p.id] || null }))
    .sort(desc('cost_value'))
    .slice(0, 50);
  res.json({ categories: Object.values(cats).sort(desc('cost_value')), slow });
});

r.get('/reports/shipments', async (req, res) => {
  const from = req.query.from || addDays(todayStr(), -30);
  const to = req.query.to || todayStr();
  const list = await find('grns', { date: inRange(from, to) });
  const names = Object.fromEntries((await find('suppliers', { id: { $in: [...new Set(list.map((g) => g.supplier_id))] } }, { project: { id: 1, name: 1 } })).map((s) => [s.id, s.name]));
  const grns = list.filter((g) => names[g.supplier_id] !== undefined).map((g) => ({ ...g, supplier_name: names[g.supplier_id] }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const cargo = {};
  const supp = {};
  for (const g of grns) {
    const key = g.cargo_name ?? 'Not set';
    const local = g.currency === 'LKR';   // a local purchase: its goods are in Rs, not ₹
    const c = (cargo[key] ??= { cargo_name: key, shipments: 0, goods_inr: 0, goods_local_lkr: 0, cargo_inr: 0, cargo_lkr: 0, expenses_lkr: 0, total_lkr: 0, pcs: 0 });
    c.shipments++;
    if (local) c.goods_local_lkr += g.goods_inr; else c.goods_inr += g.goods_inr;
    c.cargo_inr += g.cargo_charge_inr;
    // cargo paid in rupees on the oldest GRNs + the cargo charges in LKR (on each item, or older shared ones), without other expenses
    c.cargo_lkr += g.cargo_charge_inr * g.exchange_rate + g.expenses_lkr - (g.other_lkr || 0);
    c.expenses_lkr += g.expenses_lkr;
    c.total_lkr += g.total_lkr;
    c.pcs += g.total_pcs;
    const s = (supp[g.supplier_id] ??= { supplier_name: g.supplier_name, currency: local ? 'LKR' : 'INR', shipments: 0, goods_inr: 0, total_lkr: 0, rates: 0 });
    s.shipments++;
    s.goods_inr += g.goods_inr;
    s.total_lkr += g.total_lkr;
    s.rates += g.exchange_rate;
  }
  const bySupplier = Object.values(supp).map(({ rates, ...s }) => ({ ...s, avg_rate: rates / s.shipments })).sort(desc('total_lkr'));
  res.json({ from, to, grns, byCargo: Object.values(cargo).sort(desc('total_lkr')), bySupplier });
});

/* ---------------- backup ---------------- */
/** The monthly backup reminder was put off ("Remind me tomorrow"): the Super Admin sees it under Action Center → Attention. */
r.post('/backup/remind-later', async (req, res) => {
  const { last_backup_at: last } = await getSettings();
  await audit(req.user, `Monthly backup not downloaded yet — "Remind me tomorrow" was pressed${last ? ` (last backup ${String(last).slice(0, 10)})` : ' (no backup downloaded so far)'}`, null, 'attention');
  res.json({ ok: true });
});

r.get('/backup', async (req, res) => {
  await guard(req, 'Download full backup');
  const dump = { app: 'cargo-pos', exported_at: new Date().toISOString(), database: DB_LABEL };
  for (const name of COLLECTIONS.filter((c) => !['users', 'audit_log', 'fx_rates'].includes(c))) {
    dump[name] = await find(name, name === 'settings' ? { key: { $ne: 'session_secret' } } : {}, name === 'settings' ? {} : { sort: { id: 1 } });
  }
  await setSetting('last_backup_at', stamp());
  await setSetting('last_backup_by', req.user?.username || '');
  res.setHeader('Content-Disposition', `attachment; filename="cargo-pos-backup-${todayStr()}.json"`);
  res.json(dump);
});

export default r;
