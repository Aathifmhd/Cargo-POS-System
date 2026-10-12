import {
  all, get, run, tx, fail, round2, num, todayStr, addDays, getSettings,
  nextNo, nextProductCode, allocate, dueStatus, moveStock, recomputeProductCost,
} from './db.js';

/* =========================================================
   LANDED COST
   (INR goods + INR cargo) x exchange rate + LKR expenses,
   spread over items by their share of the INR goods value.
   ========================================================= */
export function computeLanding({ items, exchange_rate, cargo_charge_inr, expenses, goods_rate, cargo_rate }) {
  // goods_rate / cargo_rate let a credit GRN be revalued: goods at the rate actually paid (or today's rate
  // while unpaid), cargo at the rate it was paid at. Both default to the GRN's own rate.
  const baseRate = num(exchange_rate);
  const rate = num(goods_rate) || baseRate;
  const cRate = num(cargo_rate) || baseRate;
  const lines = items.map((it) => {
    const sets = Math.max(0, Math.round(num(it.sets)));
    const pcsPerSet = Math.max(1, Math.round(num(it.pcs_per_set, 1)));
    const cost = num(it.cost_inr_per_set);
    return { ...it, sets, pcs_per_set: pcsPerSet, cost_inr_per_set: cost, line_inr: round2(sets * cost), pcs: sets * pcsPerSet };
  });
  const goods_inr = round2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = num(cargo_charge_inr);
  const expenses_lkr = round2((expenses || []).reduce((s, e) => s + num(e.amount_lkr), 0));
  const overhead_lkr = cargo_inr * cRate + expenses_lkr;
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + l.sets, 0);

  const out = lines.map((l) => {
    const share = goods_inr > 0 ? l.line_inr / goods_inr : total_pcs > 0 ? l.pcs / total_pcs : 0;
    const landed = l.line_inr * rate + share * overhead_lkr;
    return {
      ...l,
      landed_lkr: round2(landed),
      landed_per_set_lkr: l.sets ? round2(landed / l.sets) : 0,
      landed_per_pcs_lkr: l.pcs ? round2(landed / l.pcs) : 0,
    };
  });
  return {
    items: out,
    goods_inr,
    cargo_inr,
    expenses_lkr,
    total_sets,
    total_pcs,
    total_lkr: round2(goods_inr * rate + cargo_inr * cRate + expenses_lkr),
  };
}

/* =========================================================
   EXCHANGE-RATE SETTLEMENT OF SUPPLIER BILLS
   Each GRN's payable INR is settled by payments, each made at its own rate.
   Paid part  → fixed at the rates actually paid.
   Unpaid part → today's rate, so the cost of credit goods moves day by day until the bill is settled.
   ========================================================= */
export function grnSettlements(supplierId, todayRate) {
  const s = get('SELECT * FROM suppliers WHERE id = ?', supplierId);
  const grns = all('SELECT * FROM grns WHERE supplier_id = ? ORDER BY date, id', supplierId);
  const docs = [];
  if (s?.opening_balance_inr > 0) docs.push({ id: null, payable: s.opening_balance_inr, paidInr: 0, paidLkr: 0 });
  for (const g of grns) docs.push({ id: g.id, grn: g, payable: g.payable_inr, paidInr: 0, paidLkr: 0 });
  const byId = Object.fromEntries(docs.filter((d) => d.id).map((d) => [d.id, d]));
  const pays = all('SELECT * FROM supplier_payments WHERE supplier_id = ? ORDER BY date, id', supplierId);
  const rateOf = (p) => (p.amount_inr > 0 && p.amount_lkr > 0 ? p.amount_lkr / p.amount_inr : p.exchange_rate || todayRate);

  const queue = []; // [inr, rate] still to place, oldest bill first
  for (const p of pays) {
    const d = p.grn_id && byId[p.grn_id];
    if (!d) { queue.push([p.amount_inr, rateOf(p)]); continue; }
    const take = Math.min(p.amount_inr, Math.max(0, d.payable - d.paidInr));
    d.paidInr += take;
    d.paidLkr += take * rateOf(p);
    if (p.amount_inr - take > 0.009) queue.push([p.amount_inr - take, rateOf(p)]); // overpaid → goes to older bills
  }
  for (let [inr, rate] of queue) {
    for (const d of docs) {
      if (inr <= 0.009) break;
      const take = Math.min(inr, Math.max(0, d.payable - d.paidInr));
      if (take <= 0) continue;
      d.paidInr += take;
      d.paidLkr += take * rate;
      inr -= take;
    }
  }
  return docs.filter((d) => d.id).map((d) => {
    const unpaid = Math.max(0, d.payable - d.paidInr);
    const effective = d.payable > 0 ? (d.paidLkr + unpaid * todayRate) / d.payable : d.grn.exchange_rate;
    return { grn: d.grn, paid_inr: round2(d.paidInr), unpaid_inr: round2(unpaid), effective_rate: Math.round(effective * 10000) / 10000, settled: unpaid <= 0.009 };
  });
}

/** Re-cost every GRN whose effective rate moved, then the products it holds. */
export function revalueGrns(todayRate) {
  if (!(todayRate > 0)) return 0;
  let changed = 0;
  tx(() => {
    const touched = new Set();
    for (const { supplier_id } of all('SELECT DISTINCT supplier_id FROM grns')) {
      for (const st of grnSettlements(supplier_id, todayRate)) {
        const g = st.grn;
        const settledAt = st.settled ? g.settled_at || new Date().toISOString() : null;
        if (g.effective_rate != null && Math.abs(g.effective_rate - st.effective_rate) < 0.00005 && (g.settled_at || null) === settledAt) continue;
        const items = all('SELECT * FROM grn_items WHERE grn_id = ? ORDER BY id', g.id);
        const expenses = all('SELECT amount_lkr FROM grn_expenses WHERE grn_id = ?', g.id);
        const calc = computeLanding({
          items, expenses, exchange_rate: g.exchange_rate, cargo_charge_inr: g.cargo_charge_inr,
          goods_rate: st.effective_rate, cargo_rate: g.cargo_in_supplier_bill ? st.effective_rate : g.exchange_rate,
        });
        calc.items.forEach((it, i) => {
          run('UPDATE grn_items SET landed_lkr = ?, landed_per_set_lkr = ?, landed_per_pcs_lkr = ? WHERE id = ?',
            it.landed_lkr, it.landed_per_set_lkr, it.landed_per_pcs_lkr, items[i].id);
          touched.add(items[i].product_id);
        });
        run('UPDATE grns SET effective_rate = ?, total_lkr = ?, settled_at = ? WHERE id = ?', st.effective_rate, calc.total_lkr, settledAt, g.id);
        changed++;
      }
    }
    for (const pid of touched) recomputeProductCost(pid);
  });
  return changed;
}

/* =========================================================
   LEDGERS (supplier payables in INR, customer receivables in LKR)
   ========================================================= */
export function supplierBills(supplierId) {
  const s = get('SELECT * FROM suppliers WHERE id = ?', supplierId);
  if (!s) return [];
  const grns = all(
    `SELECT id, grn_no, date, due_date, payable_inr AS amount, bale_no, lr_no, cargo_name, exchange_rate
       FROM grns WHERE supplier_id = ? ORDER BY date, id`, supplierId);
  const linked = Object.fromEntries(
    all(`SELECT grn_id, SUM(amount_inr) AS s FROM supplier_payments WHERE supplier_id = ? AND grn_id IS NOT NULL GROUP BY grn_id`, supplierId)
      .map((r) => [r.grn_id, r.s]));
  const unlinked = get(`SELECT COALESCE(SUM(amount_inr), 0) AS s FROM supplier_payments WHERE supplier_id = ? AND grn_id IS NULL`, supplierId).s;
  const docs = [];
  if (s.opening_balance_inr > 0) {
    docs.push({ id: null, grn_no: 'Opening balance', date: s.created_at.slice(0, 10), due_date: null, amount: s.opening_balance_inr, linkedPaid: 0 });
  }
  for (const g of grns) docs.push({ ...g, linkedPaid: linked[g.id] || 0 });
  const today = todayStr();
  return allocate(docs, unlinked).map((d) => ({
    ...d,
    supplier_id: s.id,
    supplier_name: s.name,
    status: dueStatus(d.balance, d.due_date, today),
  }));
}

export function supplierSummary(supplierId) {
  const bills = supplierBills(supplierId);
  return {
    balance_inr: round2(bills.reduce((a, b) => a + b.balance, 0)),
    overdue_inr: round2(bills.filter((b) => b.status === 'overdue').reduce((a, b) => a + b.balance, 0)),
    next_due: bills.filter((b) => b.balance > 0 && b.due_date).map((b) => b.due_date).sort()[0] || null,
  };
}

export function customerBills(customerId) {
  const c = get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!c) return [];
  const sales = all(
    `SELECT id, invoice_no, date, due_date, total, paid_at_sale, ROUND(total - paid_at_sale, 2) AS amount, payment_type
       FROM sales WHERE customer_id = ? AND status = 'completed' AND total - paid_at_sale > 0.009
      ORDER BY date, id`, customerId);
  const linked = Object.fromEntries(
    all(`SELECT sale_id, SUM(amount) AS s FROM customer_payments WHERE customer_id = ? AND sale_id IS NOT NULL GROUP BY sale_id`, customerId)
      .map((r) => [r.sale_id, r.s]));
  const unlinked = get(`SELECT COALESCE(SUM(amount), 0) AS s FROM customer_payments WHERE customer_id = ? AND sale_id IS NULL`, customerId).s;
  const docs = [];
  if (c.opening_balance > 0) {
    docs.push({ id: null, invoice_no: 'Opening balance', date: c.created_at.slice(0, 10), due_date: null, amount: c.opening_balance, linkedPaid: 0 });
  }
  for (const s of sales) docs.push({ ...s, linkedPaid: linked[s.id] || 0 });
  const today = todayStr();
  return allocate(docs, unlinked).map((d) => ({
    ...d,
    customer_id: c.id,
    customer_name: c.name,
    customer_phone: c.phone,
    status: dueStatus(d.balance, d.due_date, today),
  }));
}

export function customerSummary(customerId) {
  const bills = customerBills(customerId);
  return {
    balance: round2(bills.reduce((a, b) => a + b.balance, 0)),
    overdue: round2(bills.filter((b) => b.status === 'overdue').reduce((a, b) => a + b.balance, 0)),
  };
}

/* =========================================================
   GRN (goods received)
   ========================================================= */
export function createGrn(body) {
  const settings = getSettings();
  const supplier = get('SELECT * FROM suppliers WHERE id = ?', num(body.supplier_id));
  if (!supplier) fail('Please choose a supplier');
  const rate = num(body.exchange_rate);
  if (rate <= 0) fail('Exchange rate must be more than 0');
  const rawItems = (body.items || []).filter((i) => (i.product_id || String(i.name || '').trim()) && num(i.sets) > 0);
  if (!rawItems.length) fail('Add at least one item with a quantity');
  const expenses = (body.expenses || []).filter((e) => String(e.label || '').trim() && num(e.amount_lkr) !== 0);
  const date = body.date || todayStr();

  const calc = computeLanding({ items: rawItems, exchange_rate: rate, cargo_charge_inr: body.cargo_charge_inr, expenses });
  const cargoInBill = body.cargo_in_supplier_bill ? 1 : 0;
  const payable_inr = round2(calc.goods_inr + (cargoInBill ? calc.cargo_inr : 0));
  const paymentType = body.payment_type === 'paid' ? 'paid' : 'credit';
  const due_date = paymentType === 'credit' ? body.due_date || addDays(date, supplier.credit_days) : date;

  const id = tx(() => {
    const grn_no = nextNo('grns', 'grn_no', settings.grn_prefix || 'GRN-', 4);
    const { lastInsertRowid: grnId } = run(
      `INSERT INTO grns (grn_no, date, supplier_id, supplier_invoice_no, cargo_name, bale_no, lr_no, exchange_rate,
         goods_inr, cargo_charge_inr, cargo_in_supplier_bill, payable_inr, expenses_lkr, total_lkr, total_sets, total_pcs,
         payment_type, due_date, notes, effective_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      grn_no, date, supplier.id, body.supplier_invoice_no || null, (body.cargo_name || '').trim() || null,
      (body.bale_no || '').trim() || null, (body.lr_no || '').trim() || null, rate,
      calc.goods_inr, calc.cargo_inr, cargoInBill, payable_inr, calc.expenses_lkr, calc.total_lkr, calc.total_sets, calc.total_pcs,
      paymentType, due_date, body.notes || null, rate);

    for (const e of expenses) {
      run(`INSERT INTO grn_expenses (grn_id, label, amount_lkr) VALUES (?, ?, ?)`, grnId, e.label.trim(), round2(e.amount_lkr));
    }

    for (const it of calc.items) {
      let product = it.product_id ? get('SELECT * FROM products WHERE id = ?', num(it.product_id)) : null;
      if (!product) {
        const code = String(it.code || '').trim() || nextProductCode();
        if (get('SELECT id FROM products WHERE code = ?', code)) fail(`Product code "${code}" already exists`);
        const { lastInsertRowid } = run(
          `INSERT INTO products (code, name, category, pcs_per_set, colors_count, color_names, sizes, supplier_id, reorder_sets)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          code, String(it.name).trim(), (it.category || '').trim() || null, it.pcs_per_set, Math.round(num(it.colors_count)),
          it.color_names || null, it.sizes || null, supplier.id, Math.round(num(it.reorder_sets)));
        product = get('SELECT * FROM products WHERE id = ?', lastInsertRowid);
      }

      // cost is worked out from the receipts by recomputeProductCost (called from moveStock below)
      const mrp = num(it.mrp_per_set) || product.mrp_per_set;
      const expected = num(it.expected_per_set) || product.expected_per_set;
      run(
        `UPDATE products SET pcs_per_set = ?, colors_count = ?, color_names = COALESCE(?, color_names), sizes = COALESCE(?, sizes),
           category = COALESCE(?, category), supplier_id = ?, mrp_per_set = ?, expected_per_set = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        it.pcs_per_set, Math.round(num(it.colors_count)) || product.colors_count, it.color_names || null, it.sizes || null,
        (it.category || '').trim() || null, supplier.id, round2(mrp), round2(expected), product.id);

      run(
        `INSERT INTO grn_items (grn_id, product_id, name, pcs_per_set, colors_count, color_names, sizes, sets, cost_inr_per_set,
           line_inr, landed_lkr, landed_per_set_lkr, landed_per_pcs_lkr, mrp_per_set, expected_per_set)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        grnId, product.id, product.name, it.pcs_per_set, Math.round(num(it.colors_count)), it.color_names || null, it.sizes || null,
        it.sets, it.cost_inr_per_set, it.line_inr, it.landed_lkr, it.landed_per_set_lkr, it.landed_per_pcs_lkr, round2(mrp), round2(expected));

      moveStock(product.id, it.pcs, 'grn', grn_no, `Received ${it.sets} sets`, date);
    }

    if (paymentType === 'paid' && payable_inr > 0) {
      run(
        `INSERT INTO supplier_payments (supplier_id, grn_id, date, amount_inr, exchange_rate, amount_lkr, method, reference, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        supplier.id, grnId, date, payable_inr, rate, round2(payable_inr * rate), body.payment_method || 'Bank transfer',
        body.payment_reference || null, `Paid with ${grn_no}`);
    }
    return grnId;
  });
  // Paid now → cost fixed at this GRN's rate. On credit → the unpaid goods follow today's rate until paid.
  revalueGrns(todayRate());
  return getGrn(id);
}

export const todayRate = () => num(getSettings().default_exchange_rate);

export function getGrn(id) {
  const g = get(
    `SELECT g.*, s.name AS supplier_name, s.phone AS supplier_phone, s.city AS supplier_city
       FROM grns g JOIN suppliers s ON s.id = g.supplier_id WHERE g.id = ?`, id);
  if (!g) fail('GRN not found', 404);
  g.items = all(
    `SELECT gi.*, p.code FROM grn_items gi JOIN products p ON p.id = gi.product_id WHERE gi.grn_id = ? ORDER BY gi.id`, id);
  g.expenses = all('SELECT * FROM grn_expenses WHERE grn_id = ? ORDER BY id', id);
  g.payments = all('SELECT * FROM supplier_payments WHERE grn_id = ? ORDER BY date, id', id);
  const bill = supplierBills(g.supplier_id).find((b) => b.id === g.id);
  g.paid_inr = bill ? bill.paid : 0;
  g.balance_inr = bill ? bill.balance : 0;
  g.pay_status = bill ? bill.status : 'paid';
  return g;
}

export function deleteGrn(id) {
  const g = getGrn(id);
  return tx(() => {
    for (const it of g.items) {
      const pcs = it.sets * it.pcs_per_set;
      const p = get('SELECT stock_pcs, name FROM products WHERE id = ?', it.product_id);
      if (p.stock_pcs < pcs) fail(`Cannot delete: "${p.name}" from this GRN is already sold (only ${p.stock_pcs} pcs left).`);
      moveStock(it.product_id, -pcs, 'grn-delete', g.grn_no, 'GRN deleted');
    }
    run('DELETE FROM supplier_payments WHERE grn_id = ?', id);
    run('DELETE FROM grns WHERE id = ?', id);
    for (const pid of new Set(g.items.map((i) => i.product_id))) recomputeProductCost(pid);
    return { ok: true };
  });
}

/* =========================================================
   SALES
   ========================================================= */
/** approve(action) is called when the bill needs an admin's OK (below cost / over credit limit). */
export function createSale(body, approve) {
  const settings = getSettings();
  const items = (body.items || []).filter((i) => num(i.qty) > 0);
  if (!items.length) fail('The bill is empty');
  const paymentType = body.payment_type === 'credit' ? 'credit' : 'cash';
  const customer = body.customer_id ? get('SELECT * FROM customers WHERE id = ?', num(body.customer_id)) : null;
  if (paymentType === 'credit' && !customer) fail('Choose a customer for a credit bill');
  const date = body.date || todayStr();

  return tx(() => {
    const lines = items.map((i) => {
      const p = get('SELECT * FROM products WHERE id = ?', num(i.product_id));
      if (!p) fail('Product not found');
      const unit = i.unit === 'pcs' ? 'pcs' : 'set';
      const per = unit === 'set' ? p.pcs_per_set : 1;
      const qty = num(i.qty);
      const pcs = Math.round(qty * per);
      if (pcs > p.stock_pcs) {
        fail(`Not enough stock for "${p.name}". Available: ${Math.floor(p.stock_pcs / p.pcs_per_set)} sets + ${p.stock_pcs % p.pcs_per_set} pcs`);
      }
      const price = num(i.price);
      const disc_pct = Math.min(100, Math.max(0, num(i.disc_pct)));
      const disc = round2((qty * price * disc_pct) / 100);
      return {
        p, unit, qty, pcs, price, disc, disc_pct,
        net: qty ? round2((qty * price - disc) / qty) : price,     // price per unit after the line discount
        mrp: round2(p.mrp_per_set / (unit === 'set' ? 1 : p.pcs_per_set)),
        expected: round2(p.expected_per_set / (unit === 'set' ? 1 : p.pcs_per_set)),
        cost: round2(p.cost_per_pcs * per),
        line_total: round2(qty * price - disc),
      };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const discount = Math.min(round2(num(body.discount)), subtotal);
    const total = round2(subtotal - discount);
    const cost_total = round2(lines.reduce((s, l) => s + l.cost * l.qty, 0));
    const paid = paymentType === 'cash' ? total : Math.min(round2(num(body.paid_amount)), total);
    const due_date = paymentType === 'credit' ? body.due_date || addDays(date, customer.credit_days) : null;

    const reasons = [];
    const below = lines.filter((l) => l.cost > 0 && l.net < l.cost);
    if (below.length) reasons.push(`Sell below cost: ${below.map((l) => `${l.p.name} at Rs ${l.net} (cost Rs ${l.cost})`).join('; ')}`);
    if (paymentType === 'credit' && customer.credit_limit > 0) {
      const after = round2(customerSummary(customer.id).balance + total - paid);
      // not approvable here: the Super Admin has to raise the limit first, then the bill goes through
      if (after > customer.credit_limit) {
        fail(`${customer.name} would owe Rs ${after}, over the credit limit of Rs ${customer.credit_limit}. Raise the credit limit first.`, 409);
      }
    }
    if (reasons.length && approve) approve(reasons.join(' · '));

    const invoice_no = nextNo('sales', 'invoice_no', settings.invoice_prefix || 'INV-', 5);

    const { lastInsertRowid: saleId } = run(
      `INSERT INTO sales (invoice_no, date, customer_id, customer_name, payment_type, subtotal, discount, total, paid_at_sale, cost_total, due_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoice_no, date, customer?.id ?? null, customer?.name || (body.customer_name || '').trim() || 'Walk-in customer',
      paymentType, subtotal, discount, total, paid, cost_total, due_date, body.notes || null);

    for (const l of lines) {
      run(
        `INSERT INTO sale_items (sale_id, product_id, code, name, unit, qty, pcs, price, mrp_per_unit, expected_per_unit, cost_per_unit, line_total, disc, disc_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        saleId, l.p.id, l.p.code, l.p.name, l.unit, l.qty, l.pcs, l.price, l.mrp, l.expected, l.cost, l.line_total, l.disc, l.disc_pct);
      moveStock(l.p.id, -l.pcs, 'sale', invoice_no, `${l.qty} ${l.unit}`, date);
    }
    return getSale(saleId);
  });
}

export function getSale(id) {
  const s = get(
    `SELECT s.*, c.phone AS customer_phone, c.address AS customer_address, c.shop_name AS customer_shop
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`, id);
  if (!s) fail('Bill not found', 404);
  s.items = all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', id);
  s.payments = all('SELECT * FROM customer_payments WHERE sale_id = ? ORDER BY date, id', id);
  if (s.customer_id && s.status === 'completed') {
    const bill = customerBills(s.customer_id).find((b) => b.id === s.id);
    s.balance = bill ? bill.balance : 0;
    s.pay_status = bill ? bill.status : 'paid';
    s.customer_balance = customerSummary(s.customer_id).balance;
  } else {
    s.balance = 0;
    s.pay_status = s.status === 'void' ? 'void' : 'paid';
  }
  s.profit = round2(s.total - s.cost_total);
  return s;
}

export function voidSale(id, reason) {
  const s = getSale(id);
  if (s.status === 'void') fail('This bill is already cancelled');
  if (s.payments.length) fail('This bill has payments recorded against it. Delete those payments first.');
  return tx(() => {
    for (const it of s.items) moveStock(it.product_id, it.pcs, 'void', s.invoice_no, 'Bill cancelled');
    run(`UPDATE sales SET status = 'void', notes = TRIM(COALESCE(notes, '') || ' [Cancelled: ' || ? || ']') WHERE id = ?`,
      reason || 'no reason', id);
    return getSale(id);
  });
}
