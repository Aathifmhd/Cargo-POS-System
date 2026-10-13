import { Router } from 'express';
import { all, get, run, fail, round2, todayStr, addDays, getSettings, DB_FILE } from '../db.js';
import { supplierBills, customerBills } from '../services.js';
import { guard, audit } from '../auth.js';

const r = Router();

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
    out.push({ name, sizes: uniq(c.sizes), types: uniq(c.types), reorder_sets: Math.max(0, Math.round(Number(c.reorder_sets) || 0)) });
  }
  return JSON.stringify(out);
}

/* ---------------- settings ---------------- */
r.get('/settings', (req, res) => res.json(getSettings()));
/** Receive Goods → "+ Add product": add one product to a category's list (any signed-in user). */
r.post('/catalog/products', (req, res) => {
  const category = String(req.body?.category || '').trim();
  const product = String(req.body?.product || '').trim();
  if (!category || !product) fail('Choose a category and type the product name');
  const list = JSON.parse(getSettings().catalog || '[]');
  const cat = list.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!cat) fail(`"${category}" is not in the category list`);
  cat.types = cat.types || [];
  const existing = cat.types.find((t) => t.toLowerCase() === product.toLowerCase());
  if (!existing) {
    cat.types.push(product);
    run('UPDATE settings SET value = ? WHERE key = ?', cleanCatalog(list), 'catalog');
    audit(req.user, `Added product "${product}" to ${cat.name}`);
  }
  res.json({ catalog: getSettings().catalog, product: existing || product });
});

r.put('/settings', (req, res) => {
  const old = getSettings();
  // the exchange rate has its own endpoint (/api/fx); never overwrite it from here
  for (const k of Object.keys(req.body || {})) if (k === 'default_exchange_rate' || k.startsWith('fx_')) delete req.body[k];
  if ('catalog' in (req.body || {})) req.body.catalog = cleanCatalog(req.body.catalog);
  const changed = Object.keys(req.body || {}).filter((k) => String(req.body[k] ?? '') !== String(old[k] ?? ''));
  if (!changed.length) return res.json(old);
  guard(req, `Settings changed: ${changed.join(', ')}`);
  for (const [k, v] of Object.entries(req.body || {})) {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v ?? ''));
  }
  // a category's re-order level that changed applies to every product in that category
  if (changed.includes('catalog')) {
    let before = [];
    try { before = JSON.parse(old.catalog || '[]'); } catch { /* treat as empty */ }
    for (const c of JSON.parse(req.body.catalog)) {
      const prev = before.find((b) => b.name.toLowerCase() === c.name.toLowerCase());
      if (Number(prev?.reorder_sets || 0) === c.reorder_sets) continue;
      run('UPDATE products SET reorder_sets = ? WHERE LOWER(category) = LOWER(?)', c.reorder_sets, c.name);
    }
  }
  res.json(getSettings());
});

/* ---------------- payables / receivables ---------------- */
function allPayables() {
  return all('SELECT id FROM suppliers').flatMap((s) => supplierBills(s.id)).filter((b) => b.balance > 0.009);
}
function allReceivables() {
  return all('SELECT id FROM customers').flatMap((c) => customerBills(c.id)).filter((b) => b.balance > 0.009);
}
const byDue = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999');

r.get('/dues/payables', (req, res) => res.json(allPayables().sort(byDue)));
r.get('/dues/receivables', (req, res) => res.json(allReceivables().sort(byDue)));

/* ---------------- dashboard ---------------- */
r.get('/dashboard', (req, res) => {
  const today = todayStr();
  const monthStart = today.slice(0, 8) + '01';
  const sum = (from, to) => get(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(total), 0) AS sales, COALESCE(SUM(total - cost_total), 0) AS profit,
            COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total END), 0) AS cash,
            COALESCE(SUM(CASE WHEN payment_type = 'credit' THEN total END), 0) AS credit
       FROM sales WHERE status = 'completed' AND date BETWEEN ? AND ?`, from, to);

  const collectedToday = get(`SELECT COALESCE(SUM(amount), 0) AS s FROM customer_payments WHERE date = ?`, today).s
    + get(`SELECT COALESCE(SUM(paid_at_sale), 0) AS s FROM sales WHERE status = 'completed' AND date = ?`, today).s;

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = addDays(today, -i);
    const row = sum(d, d);
    last7.push({ date: d, sales: row.sales, profit: row.profit });
  }

  const payables = allPayables();
  const receivables = allReceivables();
  const stock = get(
    `SELECT COALESCE(SUM(stock_pcs * cost_per_pcs), 0) AS cost_value,
            COALESCE(SUM(stock_pcs * expected_per_set / pcs_per_set), 0) AS expected_value,
            COALESCE(SUM(stock_pcs), 0) AS pcs, COUNT(*) AS products
       FROM products WHERE active = 1 AND stock_pcs > 0`);
  const lowStock = all(
    `SELECT id, code, name, stock_pcs, pcs_per_set, reorder_sets FROM products
      WHERE active = 1 AND stock_pcs < reorder_sets * pcs_per_set ORDER BY stock_pcs * 1.0 / (reorder_sets * pcs_per_set) LIMIT 8`);
  const lowCount = get(`SELECT COUNT(*) AS n FROM products WHERE active = 1 AND stock_pcs < reorder_sets * pcs_per_set`).n;
  const topProducts = all(
    `SELECT si.product_id, si.name, SUM(si.pcs) AS pcs, SUM(si.line_total) AS amount
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'completed' AND s.date >= ? GROUP BY si.product_id ORDER BY amount DESC LIMIT 5`, monthStart);
  const recentSales = all(
    `SELECT id, invoice_no, date, customer_name, payment_type, total, status FROM sales ORDER BY id DESC LIMIT 6`);
  const recentGrns = all(
    `SELECT g.id, g.grn_no, g.date, g.bale_no, g.cargo_name, g.total_lkr, s.name AS supplier_name
       FROM grns g JOIN suppliers s ON s.id = g.supplier_id ORDER BY g.id DESC LIMIT 4`);

  const week = addDays(today, 7);
  res.json({
    today: sum(today, today),
    month: sum(monthStart, today),
    collectedToday: round2(collectedToday),
    last7,
    payables: {
      total_inr: round2(payables.reduce((a, b) => a + b.balance, 0)),
      overdue_inr: round2(payables.filter((b) => b.status === 'overdue').reduce((a, b) => a + b.balance, 0)),
      upcoming: payables.filter((b) => b.due_date && b.due_date <= week).sort(byDue).slice(0, 6),
    },
    receivables: {
      total: round2(receivables.reduce((a, b) => a + b.balance, 0)),
      overdue: round2(receivables.filter((b) => b.status === 'overdue').reduce((a, b) => a + b.balance, 0)),
      upcoming: receivables.filter((b) => b.status === 'overdue' || (b.due_date && b.due_date <= week)).sort(byDue).slice(0, 6),
    },
    stock: { ...stock, cost_value: round2(stock.cost_value), expected_value: round2(stock.expected_value), low_count: lowCount },
    lowStock,
    topProducts,
    recentSales,
    recentGrns,
  });
});

/* ---------------- reports ---------------- */
r.get('/reports/sales', (req, res) => {
  const from = req.query.from || todayStr();
  const to = req.query.to || todayStr();
  const summary = get(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(total), 0) AS sales, COALESCE(SUM(cost_total), 0) AS cost,
            COALESCE(SUM(total - cost_total), 0) AS profit, COALESCE(SUM(discount), 0) AS discount,
            COALESCE(SUM(CASE WHEN payment_type = 'cash' THEN total END), 0) AS cash,
            COALESCE(SUM(CASE WHEN payment_type = 'credit' THEN total END), 0) AS credit
       FROM sales WHERE status = 'completed' AND date BETWEEN ? AND ?`, from, to);
  summary.collections = get(`SELECT COALESCE(SUM(amount), 0) AS s FROM customer_payments WHERE date BETWEEN ? AND ?`, from, to).s;
  summary.voided = get(`SELECT COUNT(*) AS n FROM sales WHERE status = 'void' AND date BETWEEN ? AND ?`, from, to).n;
  const daily = all(
    `SELECT date, COUNT(*) AS bills, SUM(total) AS sales, SUM(total - cost_total) AS profit,
            SUM(CASE WHEN payment_type = 'cash' THEN total ELSE 0 END) AS cash,
            SUM(CASE WHEN payment_type = 'credit' THEN total ELSE 0 END) AS credit
       FROM sales WHERE status = 'completed' AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`, from, to);
  const products = all(
    `SELECT si.product_id, si.code, si.name, SUM(si.pcs) AS pcs, SUM(si.line_total) AS amount,
            SUM(si.line_total - si.cost_per_unit * si.qty) AS profit
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status = 'completed' AND s.date BETWEEN ? AND ? GROUP BY si.product_id ORDER BY amount DESC`, from, to);
  const customers = all(
    `SELECT customer_id, customer_name, COUNT(*) AS bills, SUM(total) AS amount, SUM(total - cost_total) AS profit
       FROM sales WHERE status = 'completed' AND date BETWEEN ? AND ? GROUP BY COALESCE(customer_id, customer_name) ORDER BY amount DESC`, from, to);
  res.json({ from, to, summary, daily, products, customers });
});

r.get('/reports/stock', (req, res) => {
  const categories = all(
    `SELECT COALESCE(category, 'Uncategorised') AS category, COUNT(*) AS products, SUM(stock_pcs) AS pcs,
            SUM(stock_pcs * cost_per_pcs) AS cost_value, SUM(stock_pcs * expected_per_set / pcs_per_set) AS expected_value,
            SUM(stock_pcs * mrp_per_set / pcs_per_set) AS mrp_value
       FROM products WHERE active = 1 AND stock_pcs > 0 GROUP BY COALESCE(category, 'Uncategorised') ORDER BY cost_value DESC`);
  // slow movers: in stock, nothing sold in 60 days
  const since = addDays(todayStr(), -60);
  const slow = all(
    `SELECT p.id, p.code, p.name, p.stock_pcs, p.pcs_per_set, ROUND(p.stock_pcs * p.cost_per_pcs, 2) AS cost_value,
            (SELECT MAX(s.date) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = p.id AND s.status = 'completed') AS last_sold
       FROM products p WHERE p.active = 1 AND p.stock_pcs > 0
        AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                         WHERE si.product_id = p.id AND s.status = 'completed' AND s.date >= ?)
      ORDER BY cost_value DESC LIMIT 50`, since);
  res.json({ categories, slow });
});

r.get('/reports/shipments', (req, res) => {
  const from = req.query.from || addDays(todayStr(), -30);
  const to = req.query.to || todayStr();
  const grns = all(
    `SELECT g.*, s.name AS supplier_name FROM grns g JOIN suppliers s ON s.id = g.supplier_id
      WHERE g.date BETWEEN ? AND ? ORDER BY g.date DESC`, from, to);
  const byCargo = all(
    `SELECT COALESCE(cargo_name, 'Not set') AS cargo_name, COUNT(*) AS shipments, SUM(goods_inr) AS goods_inr,
            SUM(cargo_charge_inr) AS cargo_inr,
            -- cargo paid in rupees on older GRNs + 'Cargo …' lines paid in LKR
            SUM(cargo_charge_inr * exchange_rate + COALESCE((SELECT SUM(amount_lkr) FROM grn_expenses e WHERE e.grn_id = grns.id AND e.label LIKE 'Cargo%'), 0)) AS cargo_lkr,
            SUM(expenses_lkr) AS expenses_lkr, SUM(total_lkr) AS total_lkr, SUM(total_pcs) AS pcs
       FROM grns WHERE date BETWEEN ? AND ? GROUP BY COALESCE(cargo_name, 'Not set') ORDER BY total_lkr DESC`, from, to);
  const bySupplier = all(
    `SELECT s.name AS supplier_name, COUNT(*) AS shipments, SUM(g.goods_inr) AS goods_inr, SUM(g.total_lkr) AS total_lkr,
            AVG(g.exchange_rate) AS avg_rate
       FROM grns g JOIN suppliers s ON s.id = g.supplier_id WHERE g.date BETWEEN ? AND ? GROUP BY g.supplier_id ORDER BY total_lkr DESC`, from, to);
  res.json({ from, to, grns, byCargo, bySupplier });
});

/* ---------------- backup ---------------- */
r.get('/backup', (req, res) => {
  guard(req, 'Download full backup');
  const tables = ['settings', 'suppliers', 'customers', 'products', 'grns', 'grn_items', 'grn_expenses', 'supplier_payments',
    'sales', 'sale_items', 'customer_payments', 'stock_moves'];
  const dump = { app: 'cargo-pos', exported_at: new Date().toISOString(), db_file: DB_FILE };
  for (const t of tables) dump[t] = all(`SELECT * FROM ${t}`);
  res.setHeader('Content-Disposition', `attachment; filename="cargo-pos-backup-${todayStr()}.json"`);
  res.json(dump);
});

export default r;
