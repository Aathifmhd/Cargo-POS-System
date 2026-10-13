import { Router } from 'express';
import { all, get, run, fail, num, round2, todayStr } from '../db.js';
import { supplierBills, supplierSummary, revalueGrns, costingRate } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

const FIELDS = ['name', 'contact_person', 'phone', 'whatsapp', 'email', 'city', 'state', 'address', 'gst_no', 'bank_details', 'credit_days', 'opening_balance_inr', 'notes', 'active'];

function clean(body) {
  if (!String(body.name || '').trim()) fail('Supplier name is required');
  return {
    ...Object.fromEntries(FIELDS.map((f) => [f, body[f] === '' || body[f] === undefined ? null : body[f]])),
    name: String(body.name).trim(),
    credit_days: Math.round(num(body.credit_days, 30)),
    opening_balance_inr: round2(num(body.opening_balance_inr)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

r.get('/', (req, res) => {
  const rows = all(
    `SELECT s.*, (SELECT COUNT(*) FROM grns g WHERE g.supplier_id = s.id) AS grn_count,
            (SELECT MAX(date) FROM grns g WHERE g.supplier_id = s.id) AS last_grn_date
       FROM suppliers s ORDER BY s.active DESC, s.name`);
  res.json(rows.map((s) => ({ ...s, ...supplierSummary(s.id) })));
});

r.get('/:id', (req, res) => {
  const s = get('SELECT * FROM suppliers WHERE id = ?', num(req.params.id));
  if (!s) fail('Supplier not found', 404);
  const bills = supplierBills(s.id);
  const payments = all(
    `SELECT p.*, g.grn_no FROM supplier_payments p LEFT JOIN grns g ON g.id = p.grn_id
      WHERE p.supplier_id = ? ORDER BY p.date DESC, p.id DESC`, s.id);
  const totals = get(
    `SELECT COUNT(*) AS grn_count, COALESCE(SUM(payable_inr), 0) AS purchased_inr, COALESCE(SUM(total_lkr), 0) AS landed_lkr
       FROM grns WHERE supplier_id = ?`, s.id);
  res.json({ ...s, ...supplierSummary(s.id), ...totals, bills, payments });
});

r.post('/', (req, res) => {
  const d = clean(req.body);
  if (d.opening_balance_inr > 0) guard(req, `New supplier ${d.name} with old balance ₹${d.opening_balance_inr}`);
  const { lastInsertRowid } = run(
    `INSERT INTO suppliers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
    ...FIELDS.map((f) => d[f]));
  res.json(get('SELECT * FROM suppliers WHERE id = ?', lastInsertRowid));
});

r.put('/:id', (req, res) => {
  const d = clean(req.body);
  const old = get('SELECT * FROM suppliers WHERE id = ?', num(req.params.id));
  if (!old) fail('Supplier not found', 404);
  const changes = [];
  if (old.credit_days !== d.credit_days) changes.push(`credit days ${old.credit_days} → ${d.credit_days}`);
  if (old.opening_balance_inr !== d.opening_balance_inr) changes.push(`old balance ₹${old.opening_balance_inr} → ₹${d.opening_balance_inr}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  if ((old.bank_details || null) !== d.bank_details) changes.push('bank details changed');
  if (changes.length) guard(req, `Supplier ${old.name}: ${changes.join(', ')}`);
  run(`UPDATE suppliers SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, ...FIELDS.map((f) => d[f]), num(req.params.id));
  res.json(get('SELECT * FROM suppliers WHERE id = ?', num(req.params.id)));
});

r.delete('/:id', (req, res) => {
  const id = num(req.params.id);
  if (get('SELECT id FROM grns WHERE supplier_id = ? LIMIT 1', id) || get('SELECT id FROM supplier_payments WHERE supplier_id = ? LIMIT 1', id)) {
    fail('This supplier has GRNs or payments. Mark them inactive instead of deleting.');
  }
  guard(req, `Delete supplier #${id}`);
  run('UPDATE products SET supplier_id = NULL WHERE supplier_id = ?', id);
  run('DELETE FROM suppliers WHERE id = ?', id);
  res.json({ ok: true });
});

/* ---------- supplier payments ---------- */
r.post('/:id/payments', (req, res) => {
  const s = get('SELECT * FROM suppliers WHERE id = ?', num(req.params.id));
  if (!s) fail('Supplier not found', 404);
  const amount = round2(num(req.body.amount_inr));
  if (amount <= 0) fail('Enter the amount paid (INR)');
  const rate = costingRate();   // payments are recorded at the same fixed rate as the costs
  const grnId = req.body.grn_id ? num(req.body.grn_id) : null;
  if (grnId && !get('SELECT id FROM grns WHERE id = ? AND supplier_id = ?', grnId, s.id)) fail('That GRN does not belong to this supplier');
  const lkr = round2(amount * rate);
  const { lastInsertRowid } = run(
    `INSERT INTO supplier_payments (supplier_id, grn_id, date, amount_inr, exchange_rate, amount_lkr, method, reference, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id, grnId, req.body.date || todayStr(), amount, rate, round2(lkr), req.body.method || null,
    req.body.reference || null, req.body.notes || null);
  revalueGrns();   // notes when the bill becomes fully paid
  res.json(get('SELECT * FROM supplier_payments WHERE id = ?', lastInsertRowid));
});

r.delete('/:id/payments/:pid', (req, res) => {
  const p = get('SELECT * FROM supplier_payments WHERE id = ? AND supplier_id = ?', num(req.params.pid), num(req.params.id));
  if (!p) fail('Payment not found', 404);
  guard(req, `Delete supplier payment of ₹${p.amount_inr} (${p.date})`);
  run('DELETE FROM supplier_payments WHERE id = ? AND supplier_id = ?', num(req.params.pid), num(req.params.id));
  revalueGrns();
  res.json({ ok: true });
});

export default r;
