import { Router } from 'express';
import { find, aggregate, num, contains, nextNo, getSettings, round2 } from '../db.js';
import { createSale, getSale, voidSale, deleteSale, customerLedgers } from '../services.js';
import { guard, audit } from '../auth.js';
import { billChecks } from '../attention.js';

/** A product this far below zero (pieces sold without stock) is flagged in the Action Center → Attention. */
export const ATTENTION_STOCK = -10;

const r = Router();

r.get('/', async (req, res) => {
  const filter = {};
  if (req.query.q) {
    const q = contains(req.query.q);
    // the bill shows the shop name; the person's name finds their bills too
    const people = await find('customers', { $or: [{ name: q }, { shop_name: q }] }, { project: { id: 1 } });
    filter.$or = [{ invoice_no: q }, { customer_name: q }, ...(people.length ? [{ customer_id: { $in: people.map((c) => c.id) } }] : [])];
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
/** The newest lines (up to `max`) of a product on completed bills that match `saleFilter` — newest first. */
async function soldAt(productId, saleFilter, max = 25) {
  const lines = [];
  // a page of bill lines at a time, until enough of the matching bills are found
  for (let before = Infinity, page = 0; lines.length < max && page < 20; page++) {
    const items = await find('sale_items', { product_id: productId, pcs: { $gt: 0 }, ...(before < Infinity ? { id: { $lt: before } } : {}) },
      { sort: { id: -1 }, limit: 100, project: { id: 1, sale_id: 1, unit: 1, qty: 1, pcs: 1, price: 1, disc_pct: 1, line_total: 1 } });
    if (!items.length) break;
    before = items[items.length - 1].id;
    const sales = await find('sales', { id: { $in: [...new Set(items.map((i) => i.sale_id))] }, status: 'completed', ...saleFilter },
      { project: { id: 1, invoice_no: 1, date: 1, created_at: 1, customer_id: 1, customer_name: 1, payment_type: 1 } });
    const byId = new Map(sales.map((x) => [x.id, x]));
    for (const i of items) {
      const x = byId.get(i.sale_id);
      if (!x || lines.length >= max) continue;
      lines.push({
        sale_id: x.id, invoice_no: x.invoice_no, date: x.date, created_at: x.created_at, customer_name: x.customer_name, payment_type: x.payment_type,
        unit: i.unit, qty: i.qty, pcs: i.pcs, price: i.price, disc_pct: i.disc_pct || 0,
        per_pcs: i.pcs ? round2(i.line_total / i.pcs) : i.price,   // what one piece really cost them, after the line discount
      });
    }
  }
  return lines;
}

/**
 * New Sale → F3: the prices a product was sold at before.
 * A customer chosen: that customer's. Walk-in: the walk-in sales first, then the registered customers' (group on each line).
 */
r.get('/price-history', async (req, res) => {
  const productId = num(req.query.product_id);
  const customerId = req.query.customer_id ? num(req.query.customer_id) : null;
  if (!productId) return res.json({ lines: [] });
  if (customerId) return res.json({ lines: await soldAt(productId, { customer_id: customerId }) });
  const [walkin, registered] = await Promise.all([soldAt(productId, { customer_id: null }), soldAt(productId, { customer_id: { $ne: null } })]);
  res.json({ lines: [...walkin.map((l) => ({ ...l, group: 'walkin' })), ...registered.map((l) => ({ ...l, group: 'registered' }))] });
});
r.get('/:id', async (req, res) => res.json(await getSale(num(req.params.id))));
r.post('/', async (req, res) => {
  const sale = await createSale(req.body, (action) => guard(req, action));
  for (const x of sale.sold_without_stock || []) {
    await audit(req.user, `Sold without stock: ${x.pcs} pcs of ${x.name} (${x.code}) on ${sale.invoice_no} — stock now ${x.after} pcs`, null, 'nostock');
    if (x.after <= ATTENTION_STOCK && x.before > ATTENTION_STOCK) {
      await audit(req.user, `${x.name} (${x.code}) is at ${x.after} pcs — ${-x.after} pcs sold without stock (limit ${ATTENTION_STOCK}). Check the stock count, or receive it on a GRN.`, null, 'attention');
    }
  }
  await billChecks(sale, req.user);   // below cost, a big discount, a large cash refund → Attention
  res.json(sale);
});
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
