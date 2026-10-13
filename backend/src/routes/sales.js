import { Router } from 'express';
import { all, num, nextNo, getSettings } from '../db.js';
import { createSale, getSale, voidSale, deleteSale, customerBills } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

r.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.q) {
    const q = `%${req.query.q}%`;
    where.push('(s.invoice_no LIKE ? OR s.customer_name LIKE ?)');
    params.push(q, q);
  }
  if (req.query.from) { where.push('s.date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('s.date <= ?'); params.push(req.query.to); }
  if (req.query.type) { where.push('s.payment_type = ?'); params.push(req.query.type); }
  if (req.query.customer_id) { where.push('s.customer_id = ?'); params.push(num(req.query.customer_id)); }
  const rows = all(
    `SELECT s.*, (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count
       FROM sales s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.date DESC, s.id DESC LIMIT 1000`, ...params);

  const cache = {};
  res.json(rows.map((s) => {
    let balance = 0;
    let pay_status = s.status === 'void' ? 'void' : 'paid';
    if (s.customer_id && s.status === 'completed' && s.total - s.paid_at_sale > 0.009) {
      cache[s.customer_id] ??= Object.fromEntries(customerBills(s.customer_id).filter((b) => b.id).map((b) => [b.id, b]));
      const b = cache[s.customer_id][s.id];
      balance = b?.balance ?? 0;
      pay_status = b?.status ?? 'paid';
    }
    return { ...s, profit: Math.round((s.total - s.cost_total) * 100) / 100, balance, pay_status };
  }));
});

r.get('/next-no', (req, res) => res.json({ invoice_no: nextNo('sales', 'invoice_no', getSettings().invoice_prefix || 'INV-', 5) }));
r.get('/:id', (req, res) => res.json(getSale(num(req.params.id))));
r.post('/', (req, res) => res.json(createSale(req.body, (action) => guard(req, action))));
r.post('/:id/void', (req, res) => {
  const s = getSale(num(req.params.id));
  if (s.status === 'void') return res.json(s);
  guard(req, `Cancel bill ${s.invoice_no} (Rs ${s.total}) — ${req.body?.reason || 'no reason'}`);
  res.json(voidSale(s.id, req.body?.reason));
});

// Deleting a bill always needs the Super Admin's password — even when the Super Admin is the one logged in
r.delete('/:id', (req, res) => {
  const s = getSale(num(req.params.id));
  guard(req, `Delete bill ${s.invoice_no} (Rs ${s.total}, ${s.customer_name})`, 'superadmin', { always: true });
  res.json(deleteSale(s.id));
});

export default r;
