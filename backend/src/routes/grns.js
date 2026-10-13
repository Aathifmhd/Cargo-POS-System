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

/** Extra & Short: every GRN line where the bale didn't match the bill (extra pieces, or sets/pieces short). */
r.get('/extra-short', (req, res) => {
  const where = ['(gi.extra_pcs > 0 OR gi.extra_sets > 0 OR gi.short_sets > 0 OR gi.short_pcs > 0)'];
  const params = [];
  if (req.query.from) { where.push('g.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('g.date <= ?'); params.push(req.query.to); }
  if (req.query.supplier_id) { where.push('g.supplier_id = ?'); params.push(num(req.query.supplier_id)); }
  if (req.query.kind === 'extra') where.push('(gi.extra_pcs > 0 OR gi.extra_sets > 0)');
  if (req.query.kind === 'short') where.push('(gi.short_sets > 0 OR gi.short_pcs > 0)');
  res.json(all(
    `SELECT gi.id, gi.grn_id, g.grn_no, g.date, g.bale_no, g.lr_no, g.cargo_name, g.supplier_id, s.name AS supplier_name,
            gi.product_id, p.code, gi.name, gi.sizes, gi.pcs_per_set, gi.sets, gi.extra_sets, gi.extra_pcs, gi.short_sets, gi.short_pcs,
            gi.cost_inr_per_set, gi.landed_per_pcs_lkr, g.exchange_rate
       FROM grn_items gi
       JOIN grns g ON g.id = gi.grn_id
       JOIN suppliers s ON s.id = g.supplier_id
       JOIN products p ON p.id = gi.product_id
      WHERE ${where.join(' AND ')}
      ORDER BY g.date DESC, g.id DESC, gi.id`, ...params));
});

r.get('/:id', (req, res) => res.json(getGrn(num(req.params.id))));
r.post('/', (req, res) => res.json(createGrn(req.body)));
r.delete('/:id', (req, res) => {
  const g = getGrn(num(req.params.id));
  guard(req, `Delete ${g.grn_no} (${g.supplier_name}, bale ${g.bale_no || '—'})`);
  res.json(deleteGrn(g.id));
});

export default r;
