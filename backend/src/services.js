import {
  find, findOne, insert, setById, updateOne, updateMany, deleteMany, tx, fail, round2, num, sum, todayStr, addDays, getSettings,
  nextNo, nextProductCode, allocate, dueStatus, moveStock, recomputeProductCost, grnItemPcs, byDateId, stamp, inParallel,
  itemShortPcs, unbilledExtraInr, setSetting, syncGrnBatch,
} from './db.js';

/* =========================================================
   LANDED COST
   (INR goods + INR cargo) x exchange rate + LKR expenses,
   spread over items by their share of the INR goods value.
   Each item has its own cargo charge and other expenses, entered per piece (LKR): its cost per piece is
   goods cost per piece + cargo per piece + other expenses per piece. (Lines saved before that keep their totals.) Older GRNs kept the cargo as
   separate charges: one with a category is spread over that category's items, any other over the whole shipment.
   ========================================================= */
export function computeLanding({ items, exchange_rate, cargo_charge_inr, expenses, goods_rate, cargo_rate }) {
  const baseRate = num(exchange_rate);
  const rate = num(goods_rate) || baseRate;
  const cRate = num(cargo_rate) || baseRate;
  const lines = items.map((it) => {
    const sets = Math.max(0, Math.round(num(it.sets)));
    const pcsPerSet = Math.max(1, Math.round(num(it.pcs_per_set, 1)));
    const cost = num(it.cost_inr_per_set);
    const q = (v) => Math.max(0, Math.round(num(v)));
    // extra pieces are billed by the supplier at the per-piece price;
    // shorts are still paid in full, so their cost is spread over the pieces that did arrive
    const extraPcs = q(it.extra_pcs);
    const extraSets = q(it.extra_sets); // older GRNs only: free sets, not billed
    const shortSets = q(it.short_sets);
    const shortPcs = q(it.short_pcs);
    // every piece paid for: what arrived + shorts (the cost per piece is over these)
    const paidPcs = Math.max(0, (sets + extraSets - shortSets) * pcsPerSet + extraPcs - shortPcs) + shortSets * pcsPerSet + shortPcs;
    const given = (v) => v !== undefined && v !== null && v !== '';
    const charge = (perPc, total) => (given(perPc) ? round2(Math.max(0, num(perPc)) * paidPcs) : round2(Math.max(0, num(total))));
    const cargoLkr = charge(it.cargo_per_pcs, it.cargo_lkr);
    const otherLkr = charge(it.other_per_pcs, it.other_lkr);
    return {
      ...it, sets, pcs_per_set: pcsPerSet, cost_inr_per_set: cost, cargo_lkr: cargoLkr, other_lkr: otherLkr,
      cargo_per_pcs: given(it.cargo_per_pcs) ? round2(Math.max(0, num(it.cargo_per_pcs))) : paidPcs ? round2(cargoLkr / paidPcs) : 0,
      other_per_pcs: given(it.other_per_pcs) ? round2(Math.max(0, num(it.other_per_pcs))) : paidPcs ? round2(otherLkr / paidPcs) : 0,
      line_inr: round2(sets * cost + extraPcs * (cost / pcsPerSet)),
      extra_sets: extraSets, extra_pcs: extraPcs, short_sets: shortSets, short_pcs: shortPcs,
      billed_pcs: sets * pcsPerSet + extraPcs,
      pcs: Math.max(0, (sets + extraSets - shortSets) * pcsPerSet + extraPcs - shortPcs),
    };
  });
  const goods_inr = round2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = num(cargo_charge_inr);
  // every charge: the items' own cargo and other expenses, and any older shared ones
  const other_lkr = round2(lines.reduce((s, l) => s + l.other_lkr, 0));
  const expenses_lkr = round2((expenses || []).reduce((s, e) => s + num(e.amount_lkr), 0) + lines.reduce((s, l) => s + l.cargo_lkr, 0) + other_lkr);
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + Math.max(0, l.sets + l.extra_sets - l.short_sets), 0);

  // each charge is shared by value over the items it covers: a category's cargo charge over that
  // category's items only, any other charge over the whole shipment
  const overheadOf = lines.map((l) => l.cargo_lkr + l.other_lkr);   // the item's own cargo charge and other expenses
  const all = lines.map((_, i) => i);
  const spread = (amount, idx) => {
    if (!amount) return;
    const val = idx.reduce((s, i) => s + lines[i].line_inr, 0);
    const pcs = idx.reduce((s, i) => s + lines[i].pcs, 0);
    if (!(val > 0 || pcs > 0)) { if (idx !== all) spread(amount, all); return; }
    for (const i of idx) overheadOf[i] += amount * (val > 0 ? lines[i].line_inr / val : lines[i].pcs / pcs);
  };
  spread(cargo_inr * cRate, all);
  for (const e of expenses || []) {
    const cat = String(e.category || '').trim().toLowerCase();
    const mine = cat ? all.filter((i) => String(lines[i].category || '').trim().toLowerCase() === cat) : [];
    spread(num(e.amount_lkr), mine.length ? mine : all);
  }

  // a line's cost per piece is over every piece paid for: short pieces keep their cost (a loss on
  // Extra & Short until they arrive), and free pieces lower it
  const out = lines.map((l, i) => {
    const landed = l.line_inr * rate + overheadOf[i];
    const basis = l.pcs + l.short_sets * l.pcs_per_set + l.short_pcs;
    const perPcs = basis ? landed / basis : 0;
    return { ...l, landed_lkr: round2(landed), landed_per_set_lkr: round2(perPcs * l.pcs_per_set), landed_per_pcs_lkr: round2(perPcs) };
  });
  return { items: out, goods_inr, cargo_inr, expenses_lkr, other_lkr, total_sets, total_pcs, total_lkr: round2(goods_inr * rate + cargo_inr * cRate + expenses_lkr) };
}

/** A supplier from Sri Lanka bills in Rs (LKR); everyone else is an Indian supplier billing in ₹ (INR). */
export const isLocal = (supplier) => supplier?.origin === 'local';

/** The one rate every cost is worked out at (Settings → Exchange rate, 3.5 by default). The live rate never changes costs. */
export const costingRate = async () => num((await getSettings()).costing_rate) || 3.5;

/* =========================================================
   SUPPLIER BILL SETTLEMENT — how much of each GRN is paid (oldest bills first for unlinked payments)
   ========================================================= */
function settle(supplier, grns, pays, rate) {
  const docs = [];
  if (supplier?.opening_balance_inr > 0) docs.push({ id: null, payable: supplier.opening_balance_inr, paidInr: 0 });
  for (const g of grns) docs.push({ id: g.id, grn: g, payable: g.payable_inr, paidInr: 0 });
  const byId = Object.fromEntries(docs.filter((d) => d.id).map((d) => [d.id, d]));
  const queue = [];
  for (const p of pays) {
    const d = p.grn_id && byId[p.grn_id];
    if (!d) { queue.push(p.amount_inr); continue; }
    const take = Math.min(p.amount_inr, Math.max(0, d.payable - d.paidInr));
    d.paidInr += take;
    if (p.amount_inr - take > 0.009) queue.push(p.amount_inr - take); // overpaid → goes to older bills
  }
  for (let inr of queue) {
    for (const d of docs) {
      if (inr <= 0.009) break;
      const take = Math.min(inr, Math.max(0, d.payable - d.paidInr));
      if (take <= 0) continue;
      d.paidInr += take;
      inr -= take;
    }
  }
  return docs.filter((d) => d.id).map((d) => ({ grn: d.grn, settled: Math.max(0, d.payable - d.paidInr) <= 0.009, rate }));
}

/**
 * Keeps every GRN costed at the costing rate: re-costs any GRN (and the products in it) whose rate differs,
 * e.g. after the costing rate is changed in Settings. Also records when a supplier bill becomes fully paid.
 */
/** Work out a saved GRN's costs again (at the given rate) and store them on its lines. Returns the product ids. */
async function recostGrn(g, rate) {
  const items = await find('grn_items', { grn_id: g.id }, { sort: { id: 1 } });
  // older lines don't keep their category: take it from the product
  const cats = await productsById(items.filter((i) => !i.category).map((i) => i.product_id), { category: 1 });
  for (const i of items) i.category ??= cats[i.product_id]?.category ?? null;
  const expenses = await find('grn_expenses', { grn_id: g.id });
  const calc = computeLanding({ items, expenses, exchange_rate: rate, cargo_charge_inr: g.cargo_charge_inr });
  for (let i = 0; i < calc.items.length; i++) {
    const it = calc.items[i];
    await setById('grn_items', items[i].id, { landed_lkr: it.landed_lkr, landed_per_set_lkr: it.landed_per_set_lkr, landed_per_pcs_lkr: it.landed_per_pcs_lkr });
  }
  // its stock batches take the new cost (only the batches collection exists after the batch update has run)
  if ((await getSettings()).batches_version) {
    for (const pid of new Set(items.map((i) => i.product_id))) await syncGrnBatch(g.id, pid, { ref: g.grn_no, date: g.date });
  }
  return { total_lkr: calc.total_lkr, productIds: items.map((i) => i.product_id) };
}

/**
 * Once, after the update that keeps short pieces at their own cost (before, it was spread over the pieces
 * that arrived): work out every GRN's costs again with the new rule.
 */
export async function upgradeCosting() {
  if (num((await getSettings()).costing_version) >= 2) return 0;
  const grns = await find('grns');
  const rate = await costingRate();
  await tx(async () => {
    const touched = new Set();
    for (const g of grns) {
      const { total_lkr, productIds } = await recostGrn(g, num(g.exchange_rate) || rate);
      await setById('grns', g.id, { total_lkr });
      productIds.forEach((p) => touched.add(p));
    }
    for (const pid of touched) await recomputeProductCost(pid);
    await setSetting('costing_version', 2);
  });
  return grns.length;
}

export async function revalueGrns() {
  const rate = await costingRate();
  const [suppliers, grnList, payList] = await inParallel(() => find('suppliers'), () => find('grns'), () => find('supplier_payments'));
  const grns = grnList.sort(byDateId);
  const pays = payList.sort(byDateId);
  const actions = [];
  for (const s of suppliers) {
    const mine = grns.filter((g) => g.supplier_id === s.id);
    if (!mine.length) continue;
    for (const st of settle(s, mine, pays.filter((p) => p.supplier_id === s.id), rate)) {
      const g = st.grn;
      const settledAt = st.settled ? g.settled_at || new Date().toISOString() : null;
      const want = g.currency === 'LKR' ? 1 : rate;   // a local purchase is in Rs already
      const sameRate = Math.abs((g.exchange_rate || 0) - want) < 0.00005 && Math.abs((g.effective_rate ?? 0) - want) < 0.00005;
      if (sameRate && (g.settled_at || null) === settledAt) continue;
      actions.push({ g, settledAt, recost: !sameRate, want });
    }
  }
  if (!actions.length) return 0;
  await tx(async () => {
    const touched = new Set();
    for (const { g, settledAt, recost, want } of actions) {
      if (!recost) { await setById('grns', g.id, { settled_at: settledAt }); continue; }
      const { total_lkr, productIds } = await recostGrn(g, want);
      productIds.forEach((p) => touched.add(p));
      await setById('grns', g.id, { exchange_rate: want, effective_rate: want, total_lkr, settled_at: settledAt });
    }
    for (const pid of touched) await recomputeProductCost(pid);
  });
  return actions.length;
}

/* =========================================================
   LEDGERS (supplier payables in INR, customer receivables in LKR)
   Worked out for many suppliers / customers at once, with a few reads.
   ========================================================= */

/** Map of supplier id → its bills (GRNs and old balance) with paid / balance / status. */
export async function supplierLedgers(ids = null) {
  const of = ids ? { supplier_id: { $in: ids } } : {};
  const [suppliers, grnList, pays] = await inParallel(
    () => find('suppliers', ids ? { id: { $in: ids } } : {}),
    () => find('grns', of, { project: { id: 1, grn_no: 1, date: 1, due_date: 1, payable_inr: 1, bale_no: 1, lr_no: 1, cargo_name: 1, exchange_rate: 1, supplier_id: 1 } }),
    () => find('supplier_payments', of, { project: { supplier_id: 1, grn_id: 1, amount_inr: 1 } }),
  );
  const grns = grnList.sort(byDateId);
  const today = todayStr();
  const out = new Map();
  for (const s of suppliers) {
    const myPays = pays.filter((p) => p.supplier_id === s.id);
    const linked = {};
    let unlinked = 0;
    for (const p of myPays) {
      if (p.grn_id != null) linked[p.grn_id] = (linked[p.grn_id] || 0) + p.amount_inr;
      else unlinked += p.amount_inr;
    }
    const docs = [];
    if (s.opening_balance_inr > 0) {
      docs.push({ id: null, grn_no: 'Opening balance', date: String(s.created_at).slice(0, 10), due_date: null, amount: s.opening_balance_inr, linkedPaid: 0 });
    }
    for (const g of grns.filter((x) => x.supplier_id === s.id)) {
      const { supplier_id, payable_inr, ...rest } = g;
      docs.push({ ...rest, amount: payable_inr, linkedPaid: linked[g.id] || 0 });
    }
    out.set(s.id, allocate(docs, unlinked).map((d) => ({ ...d, supplier_id: s.id, supplier_name: s.name, currency: isLocal(s) ? 'LKR' : 'INR', status: dueStatus(d.balance, d.due_date, today) })));
  }
  return out;
}
export const supplierBills = async (supplierId) => (await supplierLedgers([supplierId])).get(supplierId) || [];
export const summarizeSupplier = (bills) => ({
  balance_inr: round2(sum(bills, (b) => b.balance)),
  overdue_inr: round2(sum(bills.filter((b) => b.status === 'overdue'), (b) => b.balance)),
  next_due: bills.filter((b) => b.balance > 0 && b.due_date).map((b) => b.due_date).sort()[0] || null,
});
export const supplierSummary = async (supplierId) => summarizeSupplier(await supplierBills(supplierId));

/** Map of customer id → its unpaid-able bills (credit balances and old balance) with paid / balance / status. */
export async function customerLedgers(ids = null) {
  const of = ids ? { customer_id: { $in: ids } } : { customer_id: { $ne: null } };
  const [customers, saleList, pays] = await inParallel(
    () => find('customers', ids ? { id: { $in: ids } } : {}),
    () => find('sales', { ...of, status: 'completed', $expr: { $gt: [{ $subtract: ['$total', '$paid_at_sale'] }, 0.009] } },
      { project: { id: 1, invoice_no: 1, date: 1, due_date: 1, total: 1, paid_at_sale: 1, payment_type: 1, customer_id: 1 } }),
    () => find('customer_payments', of, { project: { customer_id: 1, sale_id: 1, amount: 1 } }),
  );
  const sales = saleList.sort(byDateId);
  const today = todayStr();
  const out = new Map();
  for (const c of customers) {
    const linked = {};
    let unlinked = 0;
    for (const p of pays.filter((x) => x.customer_id === c.id)) {
      if (p.sale_id != null) linked[p.sale_id] = (linked[p.sale_id] || 0) + p.amount;
      else unlinked += p.amount;
    }
    const docs = [];
    if (c.opening_balance > 0) {
      docs.push({ id: null, invoice_no: 'Opening balance', date: String(c.created_at).slice(0, 10), due_date: null, amount: c.opening_balance, linkedPaid: 0 });
    }
    for (const s of sales.filter((x) => x.customer_id === c.id)) {
      docs.push({
        id: s.id, invoice_no: s.invoice_no, date: s.date, due_date: s.due_date, total: s.total, paid_at_sale: s.paid_at_sale,
        amount: round2(s.total - s.paid_at_sale), payment_type: s.payment_type, linkedPaid: linked[s.id] || 0,
      });
    }
    out.set(c.id, allocate(docs, unlinked).map((d) => ({
      ...d, customer_id: c.id, customer_name: c.name, customer_phone: c.phone, status: dueStatus(d.balance, d.due_date, today),
    })));
  }
  return out;
}
export const customerBills = async (customerId) => (await customerLedgers([customerId])).get(customerId) || [];
export const summarizeCustomer = (bills) => ({
  balance: round2(sum(bills, (b) => b.balance)),
  overdue: round2(sum(bills.filter((b) => b.status === 'overdue'), (b) => b.balance)),
});
export const customerSummary = async (customerId) => summarizeCustomer(await customerBills(customerId));

/* =========================================================
   GRN (goods received)
   ========================================================= */
export const createGrn = (body) => saveGrn(body);
/** Edit a GRN that was entered wrongly: same GRN number; stock is moved by the difference only. */
export const updateGrn = (id, body) => saveGrn(body, id);

async function saveGrn(body, editId = null) {
  const settings = await getSettings();
  const old = editId ? await getGrn(editId) : null;
  // a new product takes its re-order level from its category (Settings → Categories & products)
  let catalog = [];
  try { catalog = JSON.parse(settings.catalog || '[]'); } catch { /* keep empty */ }
  const reorderOf = (category) => Math.round(num(catalog.find((c) => c.name.toLowerCase() === String(category || '').trim().toLowerCase())?.reorder_sets));
  const supplier = await findOne('suppliers', { id: num(body.supplier_id) });
  if (!supplier) fail('Please choose a supplier');
  // an Indian supplier's bill (₹) is costed at the fixed rate — the live rate does not change costs; a local one is in Rs already
  const rate = isLocal(supplier) ? 1 : num(settings.costing_rate) || 3.5;
  const rawItems = (body.items || []).filter((i) => (i.product_id || String(i.name || '').trim()) && (num(i.sets) > 0 || num(i.extra_pcs) > 0));
  if (!rawItems.length) fail('Add at least one item with a quantity');
  const expenses = (body.expenses || []).filter((e) => String(e.label || '').trim() && num(e.amount_lkr) !== 0);
  const date = body.date || (old ? old.date : todayStr());

  const calc = computeLanding({ items: rawItems, exchange_rate: rate, cargo_charge_inr: body.cargo_charge_inr, expenses });
  const cargoInBill = body.cargo_in_supplier_bill ? 1 : 0;
  let payable_inr = round2(calc.goods_inr + (cargoInBill ? calc.cargo_inr : 0));
  const paymentType = body.payment_type === 'paid' ? 'paid' : 'credit';
  // credit: due 60 days after the supplier's bill date (or the date received when that is not given), unless set by hand
  const billDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.supplier_bill_date || '')) ? body.supplier_bill_date : null;
  const due_date = paymentType === 'credit' ? body.due_date || addDays(billDate || date, 60) : date;
  const head = {
    date, supplier_id: supplier.id, currency: isLocal(supplier) ? 'LKR' : 'INR', supplier_invoice_no: body.supplier_invoice_no || null,
    supplier_bill_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.supplier_bill_date || '')) ? body.supplier_bill_date : null, cargo_name: (body.cargo_name || '').trim() || null,
    exchange_rate: rate, goods_inr: calc.goods_inr, cargo_charge_inr: calc.cargo_inr, cargo_in_supplier_bill: cargoInBill, payable_inr,
    expenses_lkr: calc.expenses_lkr, other_lkr: calc.other_lkr, total_lkr: calc.total_lkr, total_sets: calc.total_sets, total_pcs: calc.total_pcs,
    payment_type: paymentType, due_date, notes: body.notes || null, effective_rate: rate,
  };

  const id = await tx(async () => {
    let grnId;
    let grn_no;
    if (old) {
      // same GRN, new details: the old lines and charges are replaced below
      grnId = old.id;
      grn_no = old.grn_no;
      await setById('grns', grnId, head);
      await deleteMany('grn_expenses', { grn_id: grnId });
      await deleteMany('grn_items', { grn_id: grnId });
    } else {
      grn_no = await nextNo('grns', 'grn_no', settings.grn_prefix || 'GRN-', 4);
      grnId = (await insert('grns', { grn_no, ...head })).id;
    }
    const received = new Map(); // product id → what the stock card says about it
    // editing keeps how each line's extra / short pieces were resolved (Extra & Short) — those can't be changed here
    const oldLines = new Map();
    for (const o of old?.items || []) oldLines.set(o.product_id, [...(oldLines.get(o.product_id) || []), o]);
    const resolvedOf = (o) => [o.short_status && 'short', o.extra_status && 'extra'].filter(Boolean).join(' and ');
    const carry = (productId, it) => {
      const o = oldLines.get(productId)?.shift();
      if (!o) return {};
      const keep = {};
      if (o.short_status) {
        if (itemShortPcs(o) !== itemShortPcs(it)) fail(`"${o.name}": its short pieces are already resolved on Extra & Short. Undo that there first, then change them.`);
        Object.assign(keep, { short_status: o.short_status, short_date: o.short_date, short_note: o.short_note });
      }
      if (o.extra_status) {
        if ((o.extra_pcs || 0) !== (it.extra_pcs || 0)) fail(`"${o.name}": its extra pieces are already resolved on Extra & Short. Undo that there first, then change them.`);
        Object.assign(keep, { extra_status: o.extra_status, extra_date: o.extra_date, extra_note: o.extra_note });
      }
      return keep;
    };
    let unbilled = 0;

    for (const e of expenses) await insert('grn_expenses', { grn_id: grnId, label: e.label.trim(), category: String(e.category || '').trim() || null, amount_lkr: round2(e.amount_lkr) });

    for (const it of calc.items) {
      let product = it.product_id ? await findOne('products', { id: num(it.product_id) }) : null;
      if (!product) {
        const code = String(it.code || '').trim() || await nextProductCode();
        if (await findOne('products', { code })) fail(`Product code "${code}" already exists`);
        product = await insert('products', {
          code, name: String(it.name).trim(), category: (it.category || '').trim() || null, subtype: (it.subtype || '').trim() || null,
          pname: (it.pname || '').trim() || null, pcs_per_set: it.pcs_per_set, colors_count: Math.round(num(it.colors_count)),
          color_names: it.color_names || null, sizes: it.sizes || null, supplier_id: supplier.id,
          reorder_sets: Math.round(num(it.reorder_sets)) || reorderOf(it.category),
        });
      }

      // cost comes from the stock batches (syncGrnBatch below)
      const mrp = num(it.mrp_per_set) || product.mrp_per_set;
      const expected = num(it.expected_per_set) || product.expected_per_set;
      const keep = (v, cur) => v || cur;   // like COALESCE: only replace when a new value is given
      await setById('products', product.id, {
        pcs_per_set: it.pcs_per_set, colors_count: Math.round(num(it.colors_count)) || product.colors_count,
        color_names: keep(it.color_names || null, product.color_names), sizes: keep(it.sizes || null, product.sizes),
        category: keep((it.category || '').trim() || null, product.category), subtype: keep((it.subtype || '').trim() || null, product.subtype),
        pname: keep((it.pname || '').trim() || null, product.pname), supplier_id: supplier.id,
        mrp_per_set: round2(mrp), expected_per_set: round2(expected), updated_at: stamp(),
      });

      const line = await insert('grn_items', {
        ...carry(product.id, it),
        grn_id: grnId, product_id: product.id, name: product.name, category: product.category || (it.category || '').trim() || null, pcs_per_set: it.pcs_per_set, colors_count: Math.round(num(it.colors_count)),
        color_names: it.color_names || null, sizes: it.sizes || null, sets: it.sets, cost_inr_per_set: it.cost_inr_per_set,
        line_inr: it.line_inr, cargo_lkr: it.cargo_lkr, other_lkr: it.other_lkr, cargo_per_pcs: it.cargo_per_pcs, other_per_pcs: it.other_per_pcs, landed_lkr: it.landed_lkr, landed_per_set_lkr: it.landed_per_set_lkr, landed_per_pcs_lkr: it.landed_per_pcs_lkr,
        mrp_per_set: round2(mrp), expected_per_set: round2(expected),
        extra_sets: it.extra_sets, extra_pcs: it.extra_pcs, short_sets: it.short_sets, short_pcs: it.short_pcs,
      });

      const notes = [
        it.extra_pcs && `+${it.extra_pcs} extra pcs`,
        it.short_sets && `${it.short_sets} sets short`,
        it.short_pcs && `${it.short_pcs} pcs short`,
      ].filter(Boolean);
      unbilled += unbilledExtraInr(line);
      received.set(product.id, [...(received.get(product.id) || []), `${it.sets} sets${notes.length ? ` (${notes.join(', ')})` : ''}`]);
    }
    // stock: every product of this GRN (before and after an edit) gets its batch brought in line —
    // a batch can't go below what is already sold from it
    for (const pid of new Set([...(old?.items || []).map((i) => i.product_id), ...received.keys()])) {
      await syncGrnBatch(grnId, pid, {
        ref: grn_no, date, type: old ? 'grn-edit' : 'grn',
        note: old ? 'GRN edited' : `Received ${(received.get(pid) || []).join(' + ')}`,
      });
    }

    for (const left of [...oldLines.values()].flat()) {
      if (resolvedOf(left)) fail(`"${left.name}" can't be removed: its ${resolvedOf(left)} pieces are resolved on Extra & Short. Undo that there first.`);
    }
    // extra pieces kept free, or settled in the next shipment, are not on this bill
    if (unbilled > 0) {
      payable_inr = round2(payable_inr - unbilled);
      await setById('grns', grnId, { payable_inr });
    }

    const autoNote = `Paid with ${grn_no}`;
    if (old) {
      // a GRN paid at receipt: its payment follows the new total; switching to credit removes it
      const auto = await findOne('supplier_payments', { grn_id: grnId, notes: autoNote });
      if (auto && (paymentType !== 'paid' || payable_inr <= 0)) await deleteMany('supplier_payments', { id: auto.id });
      if (auto && paymentType === 'paid' && payable_inr > 0) {
        await setById('supplier_payments', auto.id, {
          supplier_id: supplier.id, date, amount_inr: payable_inr, exchange_rate: rate, amount_lkr: round2(payable_inr * rate),
          ...(body.payment_method ? { method: body.payment_method } : {}),
        });
      }
      if (!auto && paymentType === 'paid' && payable_inr > 0) {
        await insert('supplier_payments', {
          supplier_id: supplier.id, grn_id: grnId, date, amount_inr: payable_inr, exchange_rate: rate, amount_lkr: round2(payable_inr * rate),
          method: body.payment_method || 'Bank transfer', reference: body.payment_reference || null, notes: autoNote,
        });
      }
      return grnId;
    }

    if (paymentType === 'paid' && payable_inr > 0) {
      await insert('supplier_payments', {
        supplier_id: supplier.id, grn_id: grnId, date, amount_inr: payable_inr, exchange_rate: rate, amount_lkr: round2(payable_inr * rate),
        method: body.payment_method || 'Bank transfer', reference: body.payment_reference || null, notes: autoNote,
      });
    }
    return grnId;
  });
  await revalueGrns();
  return getGrn(id);
}

/** Products by id (for joining onto GRN / sale lines). */
export async function productsById(ids, project) {
  const list = ids.length ? await find('products', { id: { $in: [...new Set(ids)] } }, project ? { project: { id: 1, ...project } } : {}) : [];
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

export async function getGrn(id) {
  const g = await findOne('grns', { id });
  if (!g) fail('GRN not found', 404);
  const [s, items, expenses, payments, bills] = await inParallel(
    () => findOne('suppliers', { id: g.supplier_id }),
    () => find('grn_items', { grn_id: id }, { sort: { id: 1 } }),
    () => find('grn_expenses', { grn_id: id }, { sort: { id: 1 } }),
    () => find('supplier_payments', { grn_id: id }, { sort: { date: 1, id: 1 } }),
    () => supplierBills(g.supplier_id),
  );
  if (!s) fail('GRN not found', 404);
  Object.assign(g, { supplier_name: s.name, supplier_phone: s.phone, supplier_city: s.city });
  const prods = await productsById(items.map((i) => i.product_id), { code: 1, category: 1, subtype: 1, pname: 1 });
  g.items = items.filter((i) => prods[i.product_id]).map((i) => {
    const p = prods[i.product_id];
    return { ...i, code: p.code, category: i.category ?? p.category ?? null, subtype: p.subtype ?? null, pname: p.pname ?? null };
  });
  g.expenses = expenses;
  g.payments = payments;
  const bill = bills.find((b) => b.id === g.id);
  g.paid_inr = bill ? bill.paid : 0;
  g.balance_inr = bill ? bill.balance : 0;
  g.pay_status = bill ? bill.status : 'paid';
  return g;
}

/* =========================================================
   EXTRA & SHORT — resolving a GRN line's extra or short pieces
   short: received → the pieces came later and go into stock at the line's cost; lost → lost at the cargo / clearance
   extra: free → the supplier lets us keep them (off the bill); billed → paid with this bill; next → settled in the next shipment (off this bill)
   "reopen" undoes a resolution.
   ========================================================= */
const RESOLVE = { short: ['received', 'lost'], extra: ['free', 'billed', 'next'] };
export async function resolveLine(itemId, { kind, action, date, note } = {}) {
  if (!RESOLVE[kind]) fail('Choose extra or short');
  const to = action === 'reopen' ? null : action;
  if (to && !RESOLVE[kind].includes(to)) fail('Choose how it was resolved');
  const item = await findOne('grn_items', { id: itemId });
  if (!item) fail('GRN line not found', 404);
  const g = await findOne('grns', { id: item.grn_id });
  if (!g) fail('GRN not found', 404);
  const day = date || todayStr();
  const text = String(note || '').trim() || null;
  await tx(async () => {
    if (kind === 'short') {
      const pcs = itemShortPcs(item);
      if (!pcs) fail('This line has no short pieces');
      const was = item.short_status || null;
      await setById('grn_items', item.id, { short_status: to, short_date: to ? day : null, short_note: to ? text : null });
      if ((was === 'received') !== (to === 'received')) {
        await syncGrnBatch(g.id, item.product_id, {
          ref: g.grn_no, date: g.date, type: to === 'received' ? 'short-received' : 'short-undo',
          note: to === 'received' ? `Short pieces received ${day}${text ? ` (${text})` : ''}` : 'Short pieces taken back off (resolve undone)',
        });
      }
    } else {
      if (!(item.extra_pcs > 0)) fail('This line has no extra pieces');
      await setById('grn_items', item.id, { extra_status: to, extra_date: to ? day : null, extra_note: to ? text : null });
      // the supplier bill follows: extras kept free or settled in the next shipment come off it
      const lines = await find('grn_items', { grn_id: g.id });
      const payable = round2(g.goods_inr + (g.cargo_in_supplier_bill ? g.cargo_charge_inr : 0) - sum(lines, unbilledExtraInr));
      await setById('grns', g.id, { payable_inr: payable });
    }
  });
  await revalueGrns();   // a bill that is now fully paid gets its settled date
  return findOne('grn_items', { id: itemId });
}

export async function deleteGrn(id) {
  const g = await getGrn(id);
  return tx(async () => {
    await deleteMany('grn_items', { grn_id: id });
    for (const pid of new Set(g.items.map((i) => i.product_id))) {
      await syncGrnBatch(id, pid, { ref: g.grn_no, date: todayStr(), type: 'grn-delete', note: 'GRN deleted' });
    }
    await deleteMany('supplier_payments', { grn_id: id });
    await deleteMany('grn_expenses', { grn_id: id });
    await deleteMany('grns', { id });
    return { ok: true };
  });
}

/* =========================================================
   SALES
   ========================================================= */
/** approve(action) is called when the bill needs an admin's OK (below cost). */
export async function createSale(body, approve) {
  const settings = await getSettings();
  const items = (body.items || []).filter((i) => num(i.qty) > 0);
  if (!items.length) fail('The bill is empty');
  const paymentType = body.payment_type === 'credit' ? 'credit' : 'cash';
  const customer = body.customer_id ? await findOne('customers', { id: num(body.customer_id) }) : null;
  if (paymentType === 'credit' && !customer) fail('Choose a customer for a credit bill');
  const date = body.date || todayStr();

  return tx(async () => {
    const invoice_no = await nextNo('sales', 'invoice_no', settings.invoice_prefix || 'INV-', 5);
    const lines = [];
    for (const i of items) {
      const p = await findOne('products', { id: num(i.product_id) });
      if (!p) fail('Product not found');
      const unit = i.unit === 'pcs' ? 'pcs' : 'set';
      const per = unit === 'set' ? p.pcs_per_set : 1;
      const qty = num(i.qty);
      const pcs = Math.round(qty * per);
      if (pcs > p.stock_pcs) fail(`Not enough stock for "${p.name}". Available: ${p.stock_pcs} pcs`);
      // taken now (the whole bill is undone if anything below fails), so the cost is the batch's own
      const taken = await moveStock(p.id, -pcs, 'sale', invoice_no, `${qty} ${unit}`, date, { batchId: Array.isArray(i.batch_ids) && i.batch_ids.length > 1 ? null : i.batch_id ?? null, batchIds: Array.isArray(i.batch_ids) ? i.batch_ids : null });
      const costPc = pcs ? sum(taken, (t) => -t.pcs * t.cost_per_pcs) / pcs : p.cost_per_pcs;
      const batch = taken.length === 1 ? await findOne('batches', { id: taken[0].batch_id }) : null;
      const price = num(i.price);
      const disc_pct = Math.min(100, Math.max(0, num(i.disc_pct)));
      const disc = round2((qty * price * disc_pct) / 100);
      lines.push({
        p, unit, qty, pcs, price, disc, disc_pct,
        net: qty ? round2((qty * price - disc) / qty) : price,     // price per unit after the line discount
        mrp: round2((batch?.mrp_per_pcs || p.mrp_per_set / p.pcs_per_set) * per),
        expected: round2((batch?.expected_per_pcs || p.expected_per_set / p.pcs_per_set) * per),
        cost: round2(costPc * per),
        batches: taken.map((t) => ({ batch_id: t.batch_id, pcs: -t.pcs })),
        line_total: round2(qty * price - disc),
      });
    }
    const subtotal = round2(sum(lines, (l) => l.line_total));
    const discount = Math.min(round2(num(body.discount)), subtotal);
    const total = round2(subtotal - discount);
    const cost_total = round2(sum(lines, (l) => l.cost * l.qty));
    const paid = paymentType === 'cash' ? total : Math.min(round2(num(body.paid_amount)), total);
    const due_date = paymentType === 'credit' ? body.due_date || addDays(date, customer.credit_days) : null;

    const reasons = [];
    const below = lines.filter((l) => l.cost > 0 && l.net < l.cost);
    if (below.length) reasons.push(`Sell below cost: ${below.map((l) => `${l.p.name} at Rs ${l.net} (cost Rs ${l.cost})`).join('; ')}`);
    if (paymentType === 'credit' && customer.credit_limit > 0) {
      const after = round2((await customerSummary(customer.id)).balance + total - paid);
      // not approvable here: the Super Admin has to raise the limit first, then the bill goes through
      if (after > customer.credit_limit) {
        fail(`${customer.name} would owe Rs ${after}, over the credit limit of Rs ${customer.credit_limit}. Raise the credit limit first.`, 409);
      }
    }
    if (reasons.length && approve) await approve(reasons.join(' · '));

    const sale = await insert('sales', {
      invoice_no, date, customer_id: customer?.id ?? null, customer_name: customer?.name || (body.customer_name || '').trim() || 'Walk-in customer',
      payment_type: paymentType, subtotal, discount, total, paid_at_sale: paid, cost_total, due_date, notes: body.notes || null,
    });
    for (const l of lines) {
      await insert('sale_items', {
        sale_id: sale.id, product_id: l.p.id, code: l.p.code, name: l.p.name, unit: l.unit, qty: l.qty, pcs: l.pcs, price: l.price,
        mrp_per_unit: l.mrp, expected_per_unit: l.expected, cost_per_unit: l.cost, line_total: l.line_total, disc: l.disc, disc_pct: l.disc_pct,
        batch_id: l.batches.length === 1 ? l.batches[0].batch_id : null, batches: l.batches,
      });
    }
    return sale.id;
  }).then((saleId) => getSale(saleId));
}

export async function getSale(id) {
  const s = await findOne('sales', { id });
  if (!s) fail('Bill not found', 404);
  const withBills = s.customer_id && s.status === 'completed';
  const [c, items, payments, bills] = await inParallel(
    () => (s.customer_id ? findOne('customers', { id: s.customer_id }) : null),
    () => find('sale_items', { sale_id: id }, { sort: { id: 1 } }),
    () => find('customer_payments', { sale_id: id }, { sort: { date: 1, id: 1 } }),
    () => (withBills ? customerBills(s.customer_id) : null),
  );
  Object.assign(s, { customer_phone: c?.phone ?? null, customer_address: c?.address ?? null, customer_shop: c?.shop_name ?? null });
  s.items = items;
  s.payments = payments;
  if (withBills) {
    const bill = bills.find((b) => b.id === s.id);
    s.balance = bill ? bill.balance : 0;
    s.pay_status = bill ? bill.status : 'paid';
    s.customer_balance = summarizeCustomer(bills).balance;
  } else {
    s.balance = 0;
    s.pay_status = s.status === 'void' ? 'void' : 'paid';
  }
  s.profit = round2(s.total - s.cost_total);
  return s;
}

/**
 * Deletes a bill for good (Super Admin only). Its stock goes back (unless it was already cancelled),
 * and any payments recorded against it stay with the customer as money on account.
 */
/** A cancelled or deleted bill: each line's pieces go back to the batches they were sold from. */
async function returnStock(s, note) {
  for (const it of s.items) {
    const from = it.batches?.length ? it.batches : [{ batch_id: it.batch_id ?? null, pcs: it.pcs }];
    for (const b of from) {
      const there = b.batch_id != null && await findOne('batches', { id: b.batch_id });
      await moveStock(it.product_id, b.pcs, 'void', s.invoice_no, note, todayStr(), { batchId: there ? b.batch_id : null });
    }
  }
}

export async function deleteSale(id) {
  const s = await getSale(id);
  return tx(async () => {
    if (s.status !== 'void') await returnStock(s, 'Bill deleted');
    await updateMany('customer_payments', { sale_id: id }, { $set: { sale_id: null } });
    await deleteMany('sale_items', { sale_id: id });
    await deleteMany('sales', { id });
    return { ok: true, invoice_no: s.invoice_no, payments_kept: s.payments.length };
  });
}

export async function voidSale(id, reason) {
  const s = await getSale(id);
  if (s.status === 'void') fail('This bill is already cancelled');
  if (s.payments.length) fail('This bill has payments recorded against it. Delete those payments first.');
  await tx(async () => {
    await returnStock(s, 'Bill cancelled');
    await setById('sales', id, { status: 'void', notes: `${s.notes || ''} [Cancelled: ${reason || 'no reason'}]`.trim() });
  });
  return getSale(id);
}

/* re-export for routes */
export { updateOne };
