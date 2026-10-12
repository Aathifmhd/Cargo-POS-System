import { Router } from 'express';
import { all, get, run, fail, num, round2, todayStr } from '../db.js';
import { customerBills, customerSummary } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

const FIELDS = ['name', 'shop_name', 'phone', 'whatsapp', 'city', 'address', 'credit_limit', 'credit_days', 'opening_balance', 'notes', 'active'];

function clean(body) {
  if (!String(body.name || '').trim()) fail('Customer name is required');
  return {
    ...Object.fromEntries(FIELDS.map((f) => [f, body[f] === '' || body[f] === undefined ? null : body[f]])),
    name: String(body.name).trim(),
    credit_limit: round2(num(body.credit_limit)),
    credit_days: Math.round(num(body.credit_days, 30)),
    opening_balance: round2(num(body.opening_balance)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

r.get('/', (req, res) => {
  const rows = all(
    `SELECT c.*,
            (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS bill_count,
            (SELECT COALESCE(SUM(total), 0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS total_bought,
            (SELECT MAX(date) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS last_sale_date
       FROM customers c ORDER BY c.active DESC, c.name`);
  res.json(rows.map((c) => ({ ...c, ...customerSummary(c.id) })));
});

r.get('/:id', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', num(req.params.id));
  if (!c) fail('Customer not found', 404);
  const sales = all(
    `SELECT id, invoice_no, date, payment_type, total, paid_at_sale, status, due_date
       FROM sales WHERE customer_id = ? ORDER BY date DESC, id DESC LIMIT 200`, c.id);
  const payments = all(
    `SELECT p.*, s.invoice_no FROM customer_payments p LEFT JOIN sales s ON s.id = p.sale_id
      WHERE p.customer_id = ? ORDER BY p.date DESC, p.id DESC`, c.id);
  const totals = get(
    `SELECT COUNT(*) AS bill_count, COALESCE(SUM(total), 0) AS total_bought, COALESCE(SUM(total - cost_total), 0) AS profit
       FROM sales WHERE customer_id = ? AND status = 'completed'`, c.id);
  res.json({ ...c, ...customerSummary(c.id), ...totals, bills: customerBills(c.id), sales, payments });
});

r.post('/', (req, res) => {
  const d = clean(req.body);
  if (d.credit_limit > 0 || d.opening_balance > 0) {
    // a credit limit is the Super Admin's call; an old balance alone needs an admin
    guard(req, `New customer ${d.name}: credit limit Rs ${d.credit_limit}, old balance Rs ${d.opening_balance}`, d.credit_limit > 0 ? 'superadmin' : 'admin');
  }
  const { lastInsertRowid } = run(
    `INSERT INTO customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
    ...FIELDS.map((f) => d[f]));
  res.json({ ...get('SELECT * FROM customers WHERE id = ?', lastInsertRowid), balance: d.opening_balance, overdue: 0 });
});

r.put('/:id', (req, res) => {
  const d = clean(req.body);
  const old = get('SELECT * FROM customers WHERE id = ?', num(req.params.id));
  if (!old) fail('Customer not found', 404);
  const changes = [];
  if (old.credit_limit !== d.credit_limit) changes.push(`credit limit Rs ${old.credit_limit} → Rs ${d.credit_limit}`);
  if (old.credit_days !== d.credit_days) changes.push(`credit days ${old.credit_days} → ${d.credit_days}`);
  if (old.opening_balance !== d.opening_balance) changes.push(`old balance Rs ${old.opening_balance} → Rs ${d.opening_balance}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  if (changes.length) guard(req, `Customer ${old.name}: ${changes.join(', ')}`, old.credit_limit !== d.credit_limit ? 'superadmin' : 'admin');
  run(`UPDATE customers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...FIELDS.map((f) => d[f]), num(req.params.id));
  res.json(get('SELECT * FROM customers WHERE id = ?', num(req.params.id)));
});

/** Raise (or set) just the credit limit — used from the till when a credit bill would go over it. Super Admin only. */
r.put('/:id/credit-limit', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', num(req.params.id));
  if (!c) fail('Customer not found', 404);
  const limit = round2(num(req.body.credit_limit));
  if (limit < 0) fail('Credit limit cannot be negative');
  if (limit === c.credit_limit) return res.json({ ...c, ...customerSummary(c.id) });
  guard(req, `Customer ${c.name}: credit limit Rs ${c.credit_limit} → Rs ${limit}${req.body.reason ? ` (${req.body.reason})` : ''}`, 'superadmin');
  run('UPDATE customers SET credit_limit = ? WHERE id = ?', limit, c.id);
  res.json({ ...get('SELECT * FROM customers WHERE id = ?', c.id), ...customerSummary(c.id) });
});

r.delete('/:id', (req, res) => {
  const id = num(req.params.id);
  if (get('SELECT id FROM sales WHERE customer_id = ? LIMIT 1', id) || get('SELECT id FROM customer_payments WHERE customer_id = ? LIMIT 1', id)) {
    fail('This customer has bills or payments. Mark them inactive instead of deleting.');
  }
  guard(req, `Delete customer #${id}`);
  run('DELETE FROM customers WHERE id = ?', id);
  res.json({ ok: true });
});

/* ---------- customer payments (collections) ---------- */
r.post('/:id/payments', (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', num(req.params.id));
  if (!c) fail('Customer not found', 404);
  const amount = round2(num(req.body.amount));
  if (amount <= 0) fail('Enter the amount received');
  const saleId = req.body.sale_id ? num(req.body.sale_id) : null;
  if (saleId && !get('SELECT id FROM sales WHERE id = ? AND customer_id = ?', saleId, c.id)) fail('That bill does not belong to this customer');
  const { lastInsertRowid } = run(
    `INSERT INTO customer_payments (customer_id, sale_id, date, amount, method, reference, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    c.id, saleId, req.body.date || todayStr(), amount, req.body.method || 'Cash', req.body.reference || null, req.body.notes || null);
  res.json({ ...get('SELECT * FROM customer_payments WHERE id = ?', lastInsertRowid), ...customerSummary(c.id) });
});

r.delete('/:id/payments/:pid', (req, res) => {
  const p = get('SELECT * FROM customer_payments WHERE id = ? AND customer_id = ?', num(req.params.pid), num(req.params.id));
  if (!p) fail('Payment not found', 404);
  guard(req, `Delete customer payment of Rs ${p.amount} (${p.date})`);
  run('DELETE FROM customer_payments WHERE id = ? AND customer_id = ?', num(req.params.pid), num(req.params.id));
  res.json({ ok: true });
});

export default r;
