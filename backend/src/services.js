import {
  find, findOne, insert, setById, updateOne, updateMany, deleteMany, tx, fail, round2, num, sum, todayStr, addDays, getSettings,
  nextNo, nextProductCode, allocate, dueStatus, moveStock, recomputeProductCost, grnItemPcs, byDateId, stamp, inParallel,
} from './db.js';

/* =========================================================
   LANDED COST
   (INR goods + INR cargo) x exchange rate + LKR expenses,
   spread over items by their share of the INR goods value.
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
    return {
      ...it, sets, pcs_per_set: pcsPerSet, cost_inr_per_set: cost,
      line_inr: round2(sets * cost + extraPcs * (cost / pcsPerSet)),
      extra_sets: extraSets, extra_pcs: extraPcs, short_sets: shortSets, short_pcs: shortPcs,
      billed_pcs: sets * pcsPerSet + extraPcs,
      pcs: Math.max(0, (sets + extraSets - shortSets) * pcsPerSet + extraPcs - shortPcs),
    };
  });
  const goods_inr = round2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = num(cargo_charge_inr);
  const expenses_lkr = round2((expenses || []).reduce((s, e) => s + num(e.amount_lkr), 0));
  const overhead_lkr = cargo_inr * cRate + expenses_lkr;
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + Math.max(0, l.sets + l.extra_sets - l.short_sets), 0);

  // a line's landed cost is spread over every piece received, so free pieces lower the cost per piece
  const out = lines.map((l) => {
    const share = goods_inr > 0 ? l.line_inr / goods_inr : total_pcs > 0 ? l.pcs / total_pcs : 0;
    const landed = l.line_inr * rate + share * overhead_lkr;
    const perPcs = l.pcs ? landed / l.pcs : 0;
    return { ...l, landed_lkr: round2(landed), landed_per_set_lkr: round2(perPcs * l.pcs_per_set), landed_per_pcs_lkr: round2(perPcs) };
  });
  return { items: out, goods_inr, cargo_inr, expenses_lkr, total_sets, total_pcs, total_lkr: round2(goods_inr * rate + cargo_inr * cRate + expenses_lkr) };
}

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
      const sameRate = Math.abs((g.exchange_rate || 0) - rate) < 0.00005 && Math.abs((g.effective_rate ?? 0) - rate) < 0.00005;
      if (sameRate && (g.settled_at || null) === settledAt) continue;
      actions.push({ g, settledAt, recost: !sameRate });
    }
  }
  if (!actions.length) return 0;
  await tx(async () => {
    const touched = new Set();
    for (const { g, settledAt, recost } of actions) {
      if (!recost) { await setById('grns', g.id, { settled_at: settledAt }); continue; }
      const items = await find('grn_items', { grn_id: g.id }, { sort: { id: 1 } });
      const expenses = await find('grn_expenses', { grn_id: g.id });
      const calc = computeLanding({ items, expenses, exchange_rate: rate, cargo_charge_inr: g.cargo_charge_inr });
      for (let i = 0; i < calc.items.length; i++) {
        const it = calc.items[i];
        await setById('grn_items', items[i].id, { landed_lkr: it.landed_lkr, landed_per_set_lkr: it.landed_per_set_lkr, landed_per_pcs_lkr: it.landed_per_pcs_lkr });
        touched.add(items[i].product_id);
      }
      await setById('grns', g.id, { exchange_rate: rate, effective_rate: rate, total_lkr: calc.total_lkr, settled_at: settledAt });
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
    out.set(s.id, allocate(docs, unlinked).map((d) => ({ ...d, supplier_id: s.id, supplier_name: s.name, status: dueStatus(d.balance, d.due_date, today) })));
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
  const rate = num(settings.costing_rate) || 3.5;   // fixed — the live rate does not change costs
  const rawItems = (body.items || []).filter((i) => (i.product_id || String(i.name || '').trim()) && (num(i.sets) > 0 || num(i.extra_pcs) > 0));
  if (!rawItems.length) fail('Add at least one item with a quantity');
  const expenses = (body.expenses || []).filter((e) => String(e.label || '').trim() && num(e.amount_lkr) !== 0);
  const date = body.date || (old ? old.date : todayStr());

  const calc = computeLanding({ items: rawItems, exchange_rate: rate, cargo_charge_inr: body.cargo_charge_inr, expenses });
  const cargoInBill = body.cargo_in_supplier_bill ? 1 : 0;
  const payable_inr = round2(calc.goods_inr + (cargoInBill ? calc.cargo_inr : 0));
  const paymentType = body.payment_type === 'paid' ? 'paid' : 'credit';
  const due_date = paymentType === 'credit' ? body.due_date || addDays(date, supplier.credit_days) : date;
  const head = {
    date, supplier_id: supplier.id, supplier_invoice_no: body.supplier_invoice_no || null, cargo_name: (body.cargo_name || '').trim() || null,
    exchange_rate: rate, goods_inr: calc.goods_inr, cargo_charge_inr: calc.cargo_inr, cargo_in_supplier_bill: cargoInBill, payable_inr,
    expenses_lkr: calc.expenses_lkr, total_lkr: calc.total_lkr, total_sets: calc.total_sets, total_pcs: calc.total_pcs,
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
    const newPcs = new Map(); // product id → pieces this GRN now brings in

    for (const e of expenses) await insert('grn_expenses', { grn_id: grnId, label: e.label.trim(), amount_lkr: round2(e.amount_lkr) });

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

      // cost is worked out from the receipts by recomputeProductCost (called from moveStock below)
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

      await insert('grn_items', {
        grn_id: grnId, product_id: product.id, name: product.name, pcs_per_set: it.pcs_per_set, colors_count: Math.round(num(it.colors_count)),
        color_names: it.color_names || null, sizes: it.sizes || null, sets: it.sets, cost_inr_per_set: it.cost_inr_per_set,
        line_inr: it.line_inr, landed_lkr: it.landed_lkr, landed_per_set_lkr: it.landed_per_set_lkr, landed_per_pcs_lkr: it.landed_per_pcs_lkr,
        mrp_per_set: round2(mrp), expected_per_set: round2(expected),
        extra_sets: it.extra_sets, extra_pcs: it.extra_pcs, short_sets: it.short_sets, short_pcs: it.short_pcs,
      });

      const notes = [
        it.extra_pcs && `+${it.extra_pcs} extra pcs`,
        it.short_sets && `${it.short_sets} sets short`,
        it.short_pcs && `${it.short_pcs} pcs short`,
      ].filter(Boolean);
      if (old) newPcs.set(product.id, (newPcs.get(product.id) || 0) + it.pcs);
      else await moveStock(product.id, it.pcs, 'grn', grn_no, `Received ${it.sets} sets${notes.length ? ` (${notes.join(', ')})` : ''}`, date);
    }

    const autoNote = `Paid with ${grn_no}`;
    if (old) {
      // stock moves by the difference only — and can't take back pieces that are already sold
      const oldPcs = new Map();
      for (const it of old.items) oldPcs.set(it.product_id, (oldPcs.get(it.product_id) || 0) + grnItemPcs(it));
      for (const pid of new Set([...oldPcs.keys(), ...newPcs.keys()])) {
        const diff = (newPcs.get(pid) || 0) - (oldPcs.get(pid) || 0);
        if (!diff) { await recomputeProductCost(pid); continue; }
        const p = await findOne('products', { id: pid });
        if (p.stock_pcs + diff < 0) fail(`Cannot save: "${p.name}" from this GRN is already sold — only ${p.stock_pcs} pcs are left to take back.`);
        await moveStock(pid, diff, 'grn-edit', grn_no, `GRN edited (${diff > 0 ? '+' : ''}${diff} pcs)`, date);
      }
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
    return { ...i, code: p.code, category: p.category ?? null, subtype: p.subtype ?? null, pname: p.pname ?? null };
  });
  g.expenses = expenses;
  g.payments = payments;
  const bill = bills.find((b) => b.id === g.id);
  g.paid_inr = bill ? bill.paid : 0;
  g.balance_inr = bill ? bill.balance : 0;
  g.pay_status = bill ? bill.status : 'paid';
  return g;
}

export async function deleteGrn(id) {
  const g = await getGrn(id);
  return tx(async () => {
    for (const it of g.items) {
      const pcs = grnItemPcs(it);
      const p = await findOne('products', { id: it.product_id });
      if (p.stock_pcs < pcs) fail(`Cannot delete: "${p.name}" from this GRN is already sold (only ${p.stock_pcs} pcs left).`);
      await moveStock(it.product_id, -pcs, 'grn-delete', g.grn_no, 'GRN deleted');
    }
    await deleteMany('supplier_payments', { grn_id: id });
    await deleteMany('grn_items', { grn_id: id });
    await deleteMany('grn_expenses', { grn_id: id });
    await deleteMany('grns', { id });
    for (const pid of new Set(g.items.map((i) => i.product_id))) await recomputeProductCost(pid);
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
    const lines = [];
    for (const i of items) {
      const p = await findOne('products', { id: num(i.product_id) });
      if (!p) fail('Product not found');
      const unit = i.unit === 'pcs' ? 'pcs' : 'set';
      const per = unit === 'set' ? p.pcs_per_set : 1;
      const qty = num(i.qty);
      const pcs = Math.round(qty * per);
      if (pcs > p.stock_pcs) fail(`Not enough stock for "${p.name}". Available: ${p.stock_pcs} pcs`);
      const price = num(i.price);
      const disc_pct = Math.min(100, Math.max(0, num(i.disc_pct)));
      const disc = round2((qty * price * disc_pct) / 100);
      lines.push({
        p, unit, qty, pcs, price, disc, disc_pct,
        net: qty ? round2((qty * price - disc) / qty) : price,     // price per unit after the line discount
        mrp: round2(p.mrp_per_set / (unit === 'set' ? 1 : p.pcs_per_set)),
        expected: round2(p.expected_per_set / (unit === 'set' ? 1 : p.pcs_per_set)),
        cost: round2(p.cost_per_pcs * per),
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

    const invoice_no = await nextNo('sales', 'invoice_no', settings.invoice_prefix || 'INV-', 5);
    const sale = await insert('sales', {
      invoice_no, date, customer_id: customer?.id ?? null, customer_name: customer?.name || (body.customer_name || '').trim() || 'Walk-in customer',
      payment_type: paymentType, subtotal, discount, total, paid_at_sale: paid, cost_total, due_date, notes: body.notes || null,
    });
    for (const l of lines) {
      await insert('sale_items', {
        sale_id: sale.id, product_id: l.p.id, code: l.p.code, name: l.p.name, unit: l.unit, qty: l.qty, pcs: l.pcs, price: l.price,
        mrp_per_unit: l.mrp, expected_per_unit: l.expected, cost_per_unit: l.cost, line_total: l.line_total, disc: l.disc, disc_pct: l.disc_pct,
      });
      await moveStock(l.p.id, -l.pcs, 'sale', invoice_no, `${l.qty} ${l.unit}`, date);
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
export async function deleteSale(id) {
  const s = await getSale(id);
  return tx(async () => {
    if (s.status !== 'void') for (const it of s.items) await moveStock(it.product_id, it.pcs, 'void', s.invoice_no, 'Bill deleted');
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
    for (const it of s.items) await moveStock(it.product_id, it.pcs, 'void', s.invoice_no, 'Bill cancelled');
    await setById('sales', id, { status: 'void', notes: `${s.notes || ''} [Cancelled: ${reason || 'no reason'}]`.trim() });
  });
  return getSale(id);
}

/* re-export for routes */
export { updateOne };
