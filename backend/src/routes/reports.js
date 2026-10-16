import { Router } from 'express';
import {
  find, updateMany, fail, round2, sum, todayStr, addDays, getSettings, setSetting, DB_LABEL, COLLECTIONS, inParallel,
} from '../db.js';
import { supplierLedgers, customerLedgers, revalueGrns } from '../services.js';
import { guard, audit } from '../auth.js';

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
  const supplier = req.query.kind === 'payables';
  const pays = await find(supplier ? 'supplier_payments' : 'customer_payments', {}, { sort: { date: -1, id: -1 }, limit: 1000 });
  const whoIds = [...new Set(pays.map((p) => (supplier ? p.supplier_id : p.customer_id)))];
  const billIds = [...new Set(pays.map((p) => (supplier ? p.grn_id : p.sale_id)).filter((x) => x != null))];
  const [who, bills] = await inParallel(
    () => (whoIds.length ? find(supplier ? 'suppliers' : 'customers', { id: { $in: whoIds } }, { project: { id: 1, name: 1, origin: 1 } }) : []),
    () => (billIds.length ? find(supplier ? 'grns' : 'sales', { id: { $in: billIds } }, { project: { id: 1, grn_no: 1, invoice_no: 1 } }) : []),
  );
  const nameOf = Object.fromEntries(who.map((w) => [w.id, w.name]));
  const localOf = Object.fromEntries(who.map((w) => [w.id, supplier && w.origin === 'local']));
  const billOf = Object.fromEntries(bills.map((b) => [b.id, b.grn_no || b.invoice_no]));
  res.json(pays.map((p) => {
    const whoId = supplier ? p.supplier_id : p.customer_id;
    const billId = supplier ? p.grn_id : p.sale_id;
    return {
      id: p.id, date: p.date, who_id: whoId, who: nameOf[whoId] || '—', bill_id: billId ?? null, bill_no: billId != null ? billOf[billId] || null : null,
      amount: supplier ? p.amount_inr : p.amount, amount_lkr: supplier ? p.amount_lkr : p.amount,
      currency: !supplier || localOf[whoId] ? 'LKR' : 'INR',
      method: p.method || null, reference: p.reference || null, notes: p.notes || null,
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
    () => find('sales', {}, { sort: { id: -1 }, limit: 6, project: { id: 1, invoice_no: 1, date: 1, customer_name: 1, payment_type: 1, total: 1, status: 1 } }),
    () => find('grns', {}, { sort: { id: -1 }, limit: 4, project: { id: 1, grn_no: 1, date: 1, bale_no: 1, cargo_name: 1, total_lkr: 1, supplier_id: 1 } }),
  );
  const between = (from, to) => sales.filter((s) => s.date >= from && s.date <= to);

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
  });
});

/* ---------------- reports ---------------- */
r.get('/reports/sales', async (req, res) => {
  const from = req.query.from || todayStr();
  const to = req.query.to || todayStr();
  const [all, payments] = await inParallel(
    () => find('sales', { date: inRange(from, to) }),
    () => find('customer_payments', { date: inRange(from, to) }, { project: { amount: 1 } }),
  );
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
  res.json({ from, to, summary, daily, products: Object.values(prods).sort(desc('amount')), customers: Object.values(custs).sort(desc('amount')) });
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
r.get('/backup', async (req, res) => {
  await guard(req, 'Download full backup');
  const dump = { app: 'cargo-pos', exported_at: new Date().toISOString(), database: DB_LABEL };
  for (const name of COLLECTIONS.filter((c) => !['users', 'audit_log', 'fx_rates'].includes(c))) {
    dump[name] = await find(name, name === 'settings' ? { key: { $ne: 'session_secret' } } : {}, name === 'settings' ? {} : { sort: { id: 1 } });
  }
  res.setHeader('Content-Disposition', `attachment; filename="cargo-pos-backup-${todayStr()}.json"`);
  res.json(dump);
});

export default r;
