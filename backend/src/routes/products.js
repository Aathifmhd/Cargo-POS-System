import { Router } from 'express';
import { all, get, run, tx, fail, num, round2, todayStr, nextProductCode, moveStock } from '../db.js';
import { guard } from '../auth.js';

const r = Router();

const LIST_SQL = `
  SELECT p.*, s.name AS supplier_name,
         CASE WHEN p.pcs_per_set > 0 THEN p.stock_pcs / p.pcs_per_set ELSE p.stock_pcs END AS stock_sets,
         CASE WHEN p.pcs_per_set > 0 THEN p.stock_pcs % p.pcs_per_set ELSE 0 END AS stock_loose,
         ROUND(p.cost_per_pcs * p.pcs_per_set, 2) AS cost_per_set
    FROM products p LEFT JOIN suppliers s ON s.id = p.supplier_id`;

r.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.active !== 'all') where.push('p.active = 1');
  if (req.query.q) {
    where.push('(p.name LIKE ? OR p.code LIKE ? OR p.category LIKE ?)');
    const q = `%${req.query.q}%`;
    params.push(q, q, q);
  }
  if (req.query.category) {
    where.push('p.category = ?');
    params.push(req.query.category);
  }
  if (req.query.low === '1') where.push('p.stock_pcs < p.reorder_sets * p.pcs_per_set');
  if (req.query.instock === '1') where.push('p.stock_pcs > 0');
  res.json(all(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name`, ...params));
});

r.get('/categories', (req, res) => {
  res.json(all(`SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category <> '' ORDER BY category`).map((r) => r.category));
});

r.get('/next-code', (req, res) => res.json({ code: nextProductCode() }));

/** A category was renamed in Settings — move its products to the new name. */
r.post('/rename-category', (req, res) => {
  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  if (!from || !to) fail('Old and new category names are needed');
  if (from === to) return res.json({ changed: 0 });
  guard(req, `Rename category ${from} → ${to}`);
  const { changes } = run('UPDATE products SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ?', to, from);
  res.json({ changed: changes });
});

r.get('/:id', (req, res) => {
  const p = get(`${LIST_SQL} WHERE p.id = ?`, num(req.params.id));
  if (!p) fail('Product not found', 404);
  p.moves = all('SELECT * FROM stock_moves WHERE product_id = ? ORDER BY id DESC LIMIT 300', p.id);
  p.purchases = all(
    `SELECT gi.*, g.grn_no, g.date, g.bale_no, g.lr_no, g.cargo_name, g.exchange_rate
       FROM grn_items gi JOIN grns g ON g.id = gi.grn_id WHERE gi.product_id = ? ORDER BY g.date DESC, g.id DESC`, p.id);
  p.sold = get(
    `SELECT COALESCE(SUM(si.pcs), 0) AS pcs, COALESCE(SUM(si.line_total), 0) AS amount,
            COALESCE(SUM(si.line_total - si.cost_per_unit * si.qty), 0) AS profit
       FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.product_id = ? AND s.status = 'completed'`, p.id);
  res.json(p);
});

function clean(body) {
  if (!String(body.name || '').trim()) fail('Product name is required');
  return {
    name: String(body.name).trim(),
    category: String(body.category || '').trim() || null,
    subtype: String(body.subtype || '').trim() || null,
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

r.post('/', (req, res) => {
  const d = clean(req.body);
  const code = String(req.body.code || '').trim() || nextProductCode();
  if (get('SELECT id FROM products WHERE code = ?', code)) fail(`Code "${code}" is already used`);
  guard(req, `Add product ${d.name} manually (opening stock ${num(req.body.opening_sets)} sets + ${num(req.body.opening_pcs)} pcs)`);
  const cost = round2(num(req.body.cost_per_set) / d.pcs_per_set);
  const id = tx(() => {
    const opening = Math.round(num(req.body.opening_sets) * d.pcs_per_set + num(req.body.opening_pcs));
    const { lastInsertRowid } = run(
      `INSERT INTO products (code, name, category, subtype, pcs_per_set, colors_count, color_names, sizes, supplier_id, mrp_per_set,
         expected_per_set, reorder_sets, active, cost_per_pcs, last_cost_per_pcs, opening_pcs, opening_cost_per_pcs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code, d.name, d.category, d.subtype, d.pcs_per_set, d.colors_count, d.color_names, d.sizes, d.supplier_id, d.mrp_per_set,
      d.expected_per_set, d.reorder_sets, d.active, cost, cost, Math.max(0, opening), cost);
    if (opening) moveStock(lastInsertRowid, opening, 'adjust', null, 'Opening stock');
    return lastInsertRowid;
  });
  res.json(get(`${LIST_SQL} WHERE p.id = ?`, id));
});

r.put('/:id', (req, res) => {
  const id = num(req.params.id);
  const d = clean(req.body);
  const code = String(req.body.code || '').trim();
  if (code && get('SELECT id FROM products WHERE code = ? AND id <> ?', code, id)) fail(`Code "${code}" is already used`);
  const old = get('SELECT * FROM products WHERE id = ?', id);
  if (!old) fail('Product not found', 404);
  const changes = [];
  if (old.expected_per_set !== d.expected_per_set) changes.push(`expected price Rs ${old.expected_per_set} → Rs ${d.expected_per_set}`);
  if (old.mrp_per_set !== d.mrp_per_set) changes.push(`MRP Rs ${old.mrp_per_set} → Rs ${d.mrp_per_set}`);
  if (old.pcs_per_set !== d.pcs_per_set) changes.push(`pcs per set ${old.pcs_per_set} → ${d.pcs_per_set}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  if (changes.length) guard(req, `Product ${old.name}: ${changes.join(', ')}`);
  run(
    `UPDATE products SET code = COALESCE(?, code), name = ?, category = ?, subtype = ?, pcs_per_set = ?, colors_count = ?, color_names = ?, sizes = ?,
       supplier_id = ?, mrp_per_set = ?, expected_per_set = ?, reorder_sets = ?, active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    code || null, d.name, d.category, d.subtype, d.pcs_per_set, d.colors_count, d.color_names, d.sizes, d.supplier_id,
    d.mrp_per_set, d.expected_per_set, d.reorder_sets, d.active, id);
  res.json(get(`${LIST_SQL} WHERE p.id = ?`, id));
});

/* Bulk re-price: apply a markup % on landed cost (expected price) */
r.post('/reprice', (req, res) => {
  const markup = num(req.body.markup_percent);
  const ids = (req.body.ids || []).map(num);
  if (!ids.length) fail('Select products first');
  guard(req, `Re-price ${ids.length} products at cost + ${markup}%`);
  tx(() => {
    for (const id of ids) {
      const p = get('SELECT cost_per_pcs, pcs_per_set FROM products WHERE id = ?', id);
      if (p) run('UPDATE products SET expected_per_set = ? WHERE id = ?', round2(p.cost_per_pcs * p.pcs_per_set * (1 + markup / 100)), id);
    }
  });
  res.json({ ok: true });
});

/* Stock adjustment: damaged, missing, found, customer return, stock count */
r.post('/:id/adjust', (req, res) => {
  const id = num(req.params.id);
  const p = get('SELECT * FROM products WHERE id = ?', id);
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
  guard(req, `Stock correction ${p.name}: ${pcs > 0 ? '+' : ''}${pcs} pcs (${req.body.reason || 'Adjustment'})`);
  tx(() => moveStock(id, pcs, 'adjust', null, req.body.reason || 'Adjustment', req.body.date || todayStr()));
  res.json(get(`${LIST_SQL} WHERE p.id = ?`, id));
});

r.delete('/:id', (req, res) => {
  const id = num(req.params.id);
  if (get('SELECT id FROM grn_items WHERE product_id = ? LIMIT 1', id) || get('SELECT id FROM sale_items WHERE product_id = ? LIMIT 1', id)) {
    fail('This product has purchase or sales history. Mark it inactive instead.');
  }
  guard(req, `Delete product #${id}`);
  tx(() => {
    run('DELETE FROM stock_moves WHERE product_id = ?', id);
    run('DELETE FROM products WHERE id = ?', id);
  });
  res.json({ ok: true });
});

export default r;
