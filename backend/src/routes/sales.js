import { Router } from 'express';
import { find, aggregate, num, contains, nextNo, getSettings, round2 } from '../db.js';
import { createSale, getSale, voidSale, deleteSale, customerLedgers } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

r.get('/', async (req, res) => {
  const filter = {};
  if (req.query.q) {
    const q = contains(req.query.q);
    filter.$or = [{ invoice_no: q }, { customer_name: q }];
  }
  if (req.query.from || req.query.to) filter.date = { ...(req.query.from && { $gte: req.query.from }), ...(req.query.to && { $lte: req.query.to }) };
  if (req.query.type) filter.payment_type = req.query.type;
  if (req.query.customer_id) filter.customer_id = num(req.query.customer_id);
  const rows = await find('sales', filter, { sort: { date: -1, id: -1 }, limit: 1000 });

  const counts = Object.fromEntries((rows.length ? await aggregate('sale_items', [
    { $match: { sale_id: { $in: rows.map((s) => s.id) } } },
    { $group: { _id: '$sale_id', n: { $sum: 1 } } },
  ]) : []).map((x) => [x._id, x.n]));

  // balance / status for credit bills still (partly) unpaid
  const open = rows.filter((s) => s.customer_id && s.status === 'completed' && s.total - s.paid_at_sale > 0.009);
  const ledgers = open.length ? await customerLedgers([...new Set(open.map((s) => s.customer_id))]) : new Map();
  res.json(rows.map((s) => {
    let balance = 0;
    let pay_status = s.status === 'void' ? 'void' : 'paid';
    if (s.customer_id && s.status === 'completed' && s.total - s.paid_at_sale > 0.009) {
      const b = (ledgers.get(s.customer_id) || []).find((x) => x.id === s.id);
      balance = b?.balance ?? 0;
      pay_status = b?.status ?? 'paid';
    }
    return { ...s, item_count: counts[s.id] || 0, profit: round2(s.total - s.cost_total), balance, pay_status };
  }));
});

r.get('/next-no', async (req, res) => res.json({ invoice_no: await nextNo('sales', 'invoice_no', (await getSettings()).invoice_prefix || 'INV-', 5) }));
r.get('/:id', async (req, res) => res.json(await getSale(num(req.params.id))));
r.post('/', async (req, res) => res.json(await createSale(req.body, (action) => guard(req, action))));
r.post('/:id/void', async (req, res) => {
  const s = await getSale(num(req.params.id));
  if (s.status === 'void') return res.json(s);
  await guard(req, `Cancel bill ${s.invoice_no} (Rs ${s.total}) — ${req.body?.reason || 'no reason'}`);
  res.json(await voidSale(s.id, req.body?.reason));
});

// Deleting a bill always needs the Super Admin's password — even when the Super Admin is the one logged in
r.delete('/:id', async (req, res) => {
  const s = await getSale(num(req.params.id));
  await guard(req, `Delete bill ${s.invoice_no} (Rs ${s.total}, ${s.customer_name})`, 'superadmin', { always: true });
  res.json(await deleteSale(s.id));
});

export default r;
