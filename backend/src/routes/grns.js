import { Router } from 'express';
import { all, num } from '../db.js';
import { createGrn, getGrn, deleteGrn, supplierBills, computeLanding } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

r.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    const q = `%${req.query.q}%`;
    where.push('(g.grn_no LIKE ? OR g.bale_no LIKE ? OR g.lr_no LIKE ? OR g.cargo_name LIKE ? OR s.name LIKE ? OR g.supplier_invoice_no LIKE ?)');
    params.push(q, q, q, q, q, q);
  }
  if (req.query.supplier_id) { where.push('g.supplier_id = ?'); params.push(num(req.query.supplier_id)); }
  if (req.query.from) { where.push('g.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('g.date <= ?'); params.push(req.query.to); }
  const rows = all(
    `SELECT g.*, s.name AS supplier_name FROM grns g JOIN suppliers s ON s.id = g.supplier_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY g.date DESC, g.id DESC LIMIT 500`, ...params);

  // attach payment status
  const cache = {};
  res.json(rows.map((g) => {
    cache[g.supplier_id] ??= Object.fromEntries(supplierBills(g.supplier_id).filter((b) => b.id).map((b) => [b.id, b]));
    const b = cache[g.supplier_id][g.id];
    return { ...g, paid_inr: b?.paid ?? 0, balance_inr: b?.balance ?? 0, pay_status: b?.status ?? 'paid' };
  }));
});

r.get('/cargo-names', (req, res) => {
  res.json(all(`SELECT DISTINCT cargo_name FROM grns WHERE cargo_name IS NOT NULL ORDER BY cargo_name`).map((x) => x.cargo_name));
});

r.get('/expense-labels', (req, res) => {
  res.json(all(`SELECT label, COUNT(*) AS n FROM grn_expenses GROUP BY label ORDER BY n DESC LIMIT 12`).map((x) => x.label));
});

r.post('/preview', (req, res) => res.json(computeLanding(req.body)));

r.get('/:id', (req, res) => res.json(getGrn(num(req.params.id))));
r.post('/', (req, res) => res.json(createGrn(req.body)));
r.delete('/:id', (req, res) => {
  const g = getGrn(num(req.params.id));
  guard(req, `Delete ${g.grn_no} (${g.supplier_name}, bale ${g.bale_no || '—'})`);
  res.json(deleteGrn(g.id));
});

export default r;
