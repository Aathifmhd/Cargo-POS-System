import { Router } from 'express';
import { find, distinct, aggregate, num, contains, inParallel } from '../db.js';
import { createGrn, updateGrn, getGrn, deleteGrn, supplierLedgers, computeLanding, productsById, resolveLine } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

const supplierNames = async (ids) => Object.fromEntries(
  (ids.length ? await find('suppliers', { id: { $in: [...new Set(ids)] } }, { project: { id: 1, name: 1 } }) : []).map((s) => [s.id, s.name]));
const newestFirst = (a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.id - a.id);

r.get('/', async (req, res) => {
  const filter = {};
  if (req.query.supplier_id) filter.supplier_id = num(req.query.supplier_id);
  if (req.query.from || req.query.to) filter.date = { ...(req.query.from && { $gte: req.query.from }), ...(req.query.to && { $lte: req.query.to }) };
  const [found, supplierList] = await inParallel(() => find('grns', filter), () => find('suppliers', {}, { project: { id: 1, name: 1 } }));
  const names = Object.fromEntries(supplierList.map((s) => [s.id, s.name]));
  let rows = found;
  rows = rows.filter((g) => names[g.supplier_id] !== undefined).map((g) => ({ ...g, supplier_name: names[g.supplier_id] }));
  if (req.query.q) {
    const q = contains(req.query.q);
    rows = rows.filter((g) => [g.grn_no, g.bale_no, g.lr_no, g.cargo_name, g.supplier_name, g.supplier_invoice_no].some((v) => v && q.test(v)));
  }
  rows = rows.sort(newestFirst).slice(0, 500);
  // attach payment status
  const ledgers = await supplierLedgers([...new Set(rows.map((g) => g.supplier_id))]);
  res.json(rows.map((g) => {
    const b = (ledgers.get(g.supplier_id) || []).find((x) => x.id === g.id);
    return { ...g, paid_inr: b?.paid ?? 0, balance_inr: b?.balance ?? 0, pay_status: b?.status ?? 'paid' };
  }));
});

r.get('/cargo-names', async (req, res) => {
  res.json((await distinct('grns', 'cargo_name', { cargo_name: { $ne: null } })).sort());
});

r.get('/expense-labels', async (req, res) => {
  const rows = await aggregate('grn_expenses', [{ $group: { _id: '$label', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }]);
  res.json(rows.map((x) => x._id));
});

r.post('/preview', (req, res) => res.json(computeLanding(req.body)));

/** Extra & Short: every GRN line where the bale didn't match the bill (extra pieces, or sets/pieces short). */
r.get('/extra-short', async (req, res) => {
  const extra = [{ extra_pcs: { $gt: 0 } }, { extra_sets: { $gt: 0 } }];
  const short = [{ short_sets: { $gt: 0 } }, { short_pcs: { $gt: 0 } }];
  const lineFilter = { $or: req.query.kind === 'extra' ? extra : req.query.kind === 'short' ? short : [...extra, ...short] };
  const items = await find('grn_items', lineFilter);
  const gFilter = { id: { $in: [...new Set(items.map((i) => i.grn_id))] } };
  if (req.query.from || req.query.to) gFilter.date = { ...(req.query.from && { $gte: req.query.from }), ...(req.query.to && { $lte: req.query.to }) };
  if (req.query.supplier_id) gFilter.supplier_id = num(req.query.supplier_id);
  const grns = Object.fromEntries((await find('grns', gFilter)).map((g) => [g.id, g]));
  const names = await supplierNames(Object.values(grns).map((g) => g.supplier_id));
  const prods = await productsById(items.map((i) => i.product_id), { code: 1 });
  const rows = items.filter((i) => grns[i.grn_id] && names[grns[i.grn_id].supplier_id] !== undefined && prods[i.product_id]).map((i) => {
    const g = grns[i.grn_id];
    return {
      id: i.id, grn_id: i.grn_id, grn_no: g.grn_no, date: g.date, bale_no: g.bale_no, lr_no: g.lr_no, cargo_name: g.cargo_name,
      supplier_id: g.supplier_id, supplier_name: names[g.supplier_id], product_id: i.product_id, code: prods[i.product_id].code,
      name: i.name, sizes: i.sizes, pcs_per_set: i.pcs_per_set, sets: i.sets, odd_pcs: i.odd_pcs || 0, extra_sets: i.extra_sets, extra_pcs: i.extra_pcs,
      short_sets: i.short_sets, short_pcs: i.short_pcs, cost_inr_per_set: i.cost_inr_per_set, landed_per_pcs_lkr: i.landed_per_pcs_lkr,
      short_status: i.short_status, short_date: i.short_date, short_note: i.short_note,
      extra_status: i.extra_status, extra_date: i.extra_date, extra_note: i.extra_note,
      exchange_rate: g.exchange_rate, currency: g.currency || 'INR',
    };
  });
  rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.grn_id !== b.grn_id ? b.grn_id - a.grn_id : a.id - b.id));
  res.json(rows);
});

/** Resolve a line's extra or short pieces (or undo that): see resolveLine. */
const RESOLVE_TEXT = { received: 'received later', lost: 'lost', free: 'kept free', billed: 'paid with the bill', next: 'settled in the next shipment', reopen: 'reopened' };
r.post('/lines/:id/resolve', async (req, res) => {
  const { kind, action } = req.body || {};
  await guard(req, `Extra & Short: ${kind} pieces ${RESOLVE_TEXT[action] || action} (line ${num(req.params.id)})`);
  res.json(await resolveLine(num(req.params.id), req.body || {}));
});

r.get('/:id', async (req, res) => res.json(await getGrn(num(req.params.id))));
r.post('/', async (req, res) => res.json(await createGrn(req.body)));
// fixing a GRN that was entered wrongly always needs the Super Admin's password
r.put('/:id', async (req, res) => {
  const g = await getGrn(num(req.params.id));
  await guard(req, `Edit ${g.grn_no} (${g.supplier_name})`, 'superadmin', { always: true });
  res.json(await updateGrn(g.id, req.body));
});
r.delete('/:id', async (req, res) => {
  const g = await getGrn(num(req.params.id));
  await guard(req, `Delete ${g.grn_no} (${g.supplier_name})`);
  res.json(await deleteGrn(g.id));
});

export default r;
