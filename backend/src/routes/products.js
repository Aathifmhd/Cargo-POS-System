import { Router } from 'express';
import {
  find, findOne, insert, setById, updateMany, deleteMany, distinct, tx, fail, num, round2, sum, contains, todayStr, stamp,
  nextProductCode, moveStock, inParallel,
} from '../db.js';
import { guard } from '../auth.js';

const r = Router();

const BATCH_FIELDS = { id: 1, product_id: 1, kind: 1, ref: 1, date: 1, cost_per_pcs: 1, expected_per_pcs: 1, mrp_per_pcs: 1, in_pcs: 1, left_pcs: 1 };
/**
 * The product as the screens use it: + supplier name, stock in sets / loose pieces, cost per set,
 * and its stock batches still in stock (cheapest first — the same product bought at different costs).
 */
async function withExtras(products) {
  const sIds = [...new Set(products.map((p) => p.supplier_id).filter((x) => x != null))];
  const ids = products.map((p) => p.id);
  const [supplierList, batchList, damagedList] = await inParallel(
    () => (sIds.length ? find('suppliers', { id: { $in: sIds } }, { project: { id: 1, name: 1 } }) : []),
    () => (ids.length ? find('batches', { product_id: { $in: ids }, left_pcs: { $gt: 0 } }, { project: BATCH_FIELDS }) : []),
    () => (ids.length ? find('damaged', { product_id: { $in: ids }, left_pcs: { $gt: 0 } }, { project: { product_id: 1, left_pcs: 1, cost_per_pcs: 1, ref: 1, date: 1 } }) : []),
  );
  // damaged returns kept apart: pieces and their (written-off) cost
  const damagedOf = new Map();
  for (const d of damagedList) {
    const x = damagedOf.get(d.product_id) || { pcs: 0, value: 0, refs: [] };
    x.pcs += d.left_pcs; x.value += d.left_pcs * d.cost_per_pcs;
    if (d.ref && !x.refs.includes(d.ref)) x.refs.push(d.ref);
    damagedOf.set(d.product_id, x);
  }
  const names = Object.fromEntries(supplierList.map((s) => [s.id, s.name]));
  const batchesOf = new Map();
  for (const b of batchList.sort((a, b) => a.cost_per_pcs - b.cost_per_pcs || (a.date < b.date ? -1 : 1))) {
    batchesOf.set(b.product_id, [...(batchesOf.get(b.product_id) || []), b]);
  }
  return products.map((p) => ({
    batches: batchesOf.get(p.id) || [],
    ...p,
    damaged: damagedOf.has(p.id) ? { pcs: damagedOf.get(p.id).pcs, cost_per_pcs: round2(damagedOf.get(p.id).value / damagedOf.get(p.id).pcs), value: round2(damagedOf.get(p.id).value), refs: damagedOf.get(p.id).refs } : null,
    supplier_name: p.supplier_id != null ? names[p.supplier_id] ?? null : null,
    stock_sets: p.pcs_per_set > 0 ? Math.trunc(p.stock_pcs / p.pcs_per_set) : p.stock_pcs,
    stock_loose: p.pcs_per_set > 0 ? p.stock_pcs % p.pcs_per_set : 0,
    cost_per_set: round2(p.cost_per_pcs * p.pcs_per_set),
  }));
}
const oneProduct = async (id) => (await withExtras([await findOne('products', { id })]))[0];
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

r.get('/', async (req, res) => {
  const filter = {};
  if (req.query.active !== 'all') filter.active = 1;
  if (req.query.q) {
    const q = contains(req.query.q);
    filter.$or = [{ name: q }, { code: q }, { category: q }];
  }
  if (req.query.category) filter.category = req.query.category;
  if (req.query.low === '1') filter.$expr = { $lt: ['$stock_pcs', { $multiply: ['$reorder_sets', '$pcs_per_set'] }] };
  if (req.query.instock === '1') filter.stock_pcs = { $gt: 0 };
  res.json(await withExtras((await find('products', filter)).sort(byName)));
});

r.get('/categories', async (req, res) => {
  res.json((await distinct('products', 'category', { category: { $nin: [null, ''] } })).sort());
});

r.get('/next-code', async (req, res) => res.json({ code: await nextProductCode() }));

/** A category was renamed in Settings — move its products to the new name. */
r.post('/rename-category', async (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) fail('Old and new category names are needed');
  if (from === to) return res.json({ changed: 0 });
  await guard(req, `Rename category ${from} → ${to}`);
  const r2 = await updateMany('products', { category: from }, { $set: { category: to, updated_at: stamp() } });
  res.json({ changed: r2.modifiedCount });
});

r.get('/:id', async (req, res) => {
  const found = await findOne('products', { id: num(req.params.id) });
  if (!found) fail('Product not found', 404);
  const p = (await withExtras([found]))[0];
  const [moves, items, lines] = await inParallel(
    () => find('stock_moves', { product_id: p.id }, { sort: { id: -1 }, limit: 300 }),
    () => find('grn_items', { product_id: p.id }),
    () => find('sale_items', { product_id: p.id }, { project: { sale_id: 1, pcs: 1, line_total: 1, cost_per_unit: 1, qty: 1 } }),
  );
  p.moves = moves;
  const [grnList, doneList] = await inParallel(
    () => find('grns', { id: { $in: [...new Set(items.map((i) => i.grn_id))] } }),
    () => find('sales', { id: { $in: [...new Set(lines.map((l) => l.sale_id))] }, status: 'completed' }, { project: { id: 1 } }),
  );
  // purchase history: this product's GRN lines with the GRN's details (newest first)
  const grns = Object.fromEntries(grnList.map((g) => [g.id, g]));
  p.purchases = items.filter((i) => grns[i.grn_id]).map((i) => {
    const g = grns[i.grn_id];
    return { ...i, grn_no: g.grn_no, date: g.date, bale_no: g.bale_no, lr_no: g.lr_no, cargo_name: g.cargo_name, exchange_rate: g.exchange_rate };
  }).sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.grn_id - a.grn_id));
  // what has been sold (completed bills only)
  const done = new Set(doneList.map((s) => s.id));
  const sold = lines.filter((l) => done.has(l.sale_id));
  p.sold = { pcs: sum(sold, (l) => l.pcs), amount: sum(sold, (l) => l.line_total), profit: sum(sold, (l) => l.line_total - l.cost_per_unit * l.qty) };
  res.json(p);
});

function clean(body) {
  if (!String(body.name || '').trim()) fail('Product name is required');
  return {
    name: String(body.name).trim(),
    category: String(body.category || '').trim() || null,
    subtype: String(body.subtype || '').trim() || null,
    pname: String(body.pname || '').trim() || null,
    pcs_per_set: Math.max(1, Math.round(num(body.pcs_per_set, 1))),
    colors_count: Math.round(num(body.colors_count)),
    color_names: body.color_names || null,
    sizes: body.sizes || null,
    supplier_id: body.supplier_id ? num(body.supplier_id) : null,
    mrp_per_set: round2(num(body.mrp_per_set)),
    expected_per_set: round2(num(body.expected_per_set)),
    reorder_sets: Math.round(num(body.reorder_sets)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

r.post('/', async (req, res) => {
  const d = clean(req.body);
  const code = String(req.body.code || '').trim() || await nextProductCode();
  if (await findOne('products', { code })) fail(`Code "${code}" is already used`);
  await guard(req, `Add product ${d.name} manually (opening stock ${num(req.body.opening_sets)} sets + ${num(req.body.opening_pcs)} pcs)`);
  const cost = round2(num(req.body.cost_per_set) / d.pcs_per_set);
  const opening = Math.round(num(req.body.opening_sets) * d.pcs_per_set + num(req.body.opening_pcs));
  const id = await tx(async () => {
    const p = await insert('products', {
      code, ...d, cost_per_pcs: cost, last_cost_per_pcs: cost, opening_pcs: Math.max(0, opening), opening_cost_per_pcs: cost,
    });
    if (opening) await moveStock(p.id, opening, 'adjust', null, 'Opening stock', todayStr(), { newBatch: { kind: 'opening', ref: 'Opening stock', cost_per_pcs: cost } });
    return p.id;
  });
  res.json(await oneProduct(id));
});

r.put('/:id', async (req, res) => {
  const id = num(req.params.id);
  const d = clean(req.body);
  const code = String(req.body.code || '').trim();
  if (code && await findOne('products', { code, id: { $ne: id } })) fail(`Code "${code}" is already used`);
  const old = await findOne('products', { id });
  if (!old) fail('Product not found', 404);
  const changes = [];
  if (old.expected_per_set !== d.expected_per_set) changes.push(`expected price Rs ${old.expected_per_set} → Rs ${d.expected_per_set}`);
  if (old.mrp_per_set !== d.mrp_per_set) changes.push(`MRP Rs ${old.mrp_per_set} → Rs ${d.mrp_per_set}`);
  if (old.pcs_per_set !== d.pcs_per_set) changes.push(`pcs per set ${old.pcs_per_set} → ${d.pcs_per_set}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  if (changes.length) await guard(req, `Product ${old.name}: ${changes.join(', ')}`);
  await setById('products', id, { ...(code ? { code } : {}), ...d, updated_at: stamp() });
  res.json(await oneProduct(id));
});

/* Bulk re-price: apply a markup % on landed cost (expected price) */
r.post('/reprice', async (req, res) => {
  const markup = num(req.body.markup_percent);
  const ids = (req.body.ids || []).map(num);
  if (!ids.length) fail('Select products first');
  await guard(req, `Re-price ${ids.length} products at cost + ${markup}%`);
  await tx(async () => {
    for (const id of ids) {
      const p = await findOne('products', { id });
      if (p) await setById('products', id, { expected_per_set: round2(p.cost_per_pcs * p.pcs_per_set * (1 + markup / 100)) });
    }
  });
  res.json({ ok: true });
});

/* Stock adjustment: damaged, missing, found, customer return, stock count */
r.post('/:id/adjust', async (req, res) => {
  const id = num(req.params.id);
  const p = await findOne('products', { id });
  if (!p) fail('Product not found', 404);
  let pcs;
  if (req.body.mode === 'count') {
    const counted = Math.round(num(req.body.sets) * p.pcs_per_set + num(req.body.pcs));
    pcs = counted - p.stock_pcs;
  } else {
    pcs = Math.round(num(req.body.sets) * p.pcs_per_set + num(req.body.pcs)) * (req.body.direction === 'out' ? -1 : 1);
  }
  if (!pcs) fail('Nothing to change');
  if (p.stock_pcs + pcs < 0) fail('Stock cannot go below zero');
  const batchId = req.body.batch_id ? num(req.body.batch_id) : null;
  await guard(req, `Stock correction ${p.name}: ${pcs > 0 ? '+' : ''}${pcs} pcs (${req.body.reason || 'Adjustment'})`);
  await tx(() => moveStock(id, pcs, 'adjust', null, req.body.reason || 'Adjustment', req.body.date || todayStr(), { batchId }));
  res.json(await oneProduct(id));
});

r.delete('/:id', async (req, res) => {
  const id = num(req.params.id);
  if (await findOne('grn_items', { product_id: id }) || await findOne('sale_items', { product_id: id })) {
    fail('This product has purchase or sales history. Mark it inactive instead.');
  }
  await guard(req, `Delete product #${id}`);
  await tx(async () => {
    await deleteMany('stock_moves', { product_id: id });
    await deleteMany('batches', { product_id: id });
    await deleteMany('products', { id });
  });
  res.json({ ok: true });
});

export default r;
