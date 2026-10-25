import { Router } from 'express';
import ExcelJS from 'exceljs';
import { find, fail, round2, sum, todayStr } from '../db.js';
import { supplierLedgers, customerLedgers, summarizeCustomer, summarizeSupplier, isLocal, customerLabel, customerPerson } from '../services.js';
import { cargoLedgers, grnCargoLkr } from '../cheques.js';
import { guard } from '../auth.js';

/*
 * Settings → Download reports: Excel workbooks of the shop's records for a period.
 * GET /api/export?reports=grns,stock,invoices,customers,suppliers,payments,dues&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Dated records (GRNs, bills, payments, cheques, stock movements) are taken from the period;
 * balances, stock on hand and dues are as they stand today.
 */
const r = Router();

export const REPORTS = {
  grns: 'GRN details',
  stock: 'Stock details',
  invoices: 'Invoice details',
  customers: 'Customer details',
  suppliers: 'Supplier details',
  payments: 'Payment details',
  dues: 'Payment due details',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 'YYYY-MM-DD' → 'DD/MM/YYYY' */
const dmy = (s) => (s && DATE.test(String(s).slice(0, 10)) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
/** A saved time (UTC stamp) as Sri Lanka date and time: '25/10/2026 03:45 PM' */
function lkStamp(s) {
  if (!s) return '';
  const d = new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toUpperCase()}`;
}
const inPeriod = (date, from, to) => Boolean(date) && date >= from && date <= to;
const money = '#,##0.00';

/**
 * One sheet: a title row, the period / "as on" line, then a bold header row and the rows.
 * cols: [{ h: 'Header', k: 'key' | (row) => value, w: width, money: true, total: true }]
 */
function sheet(book, name, title, note, cols, rows) {
  const ws = book.addWorksheet(name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.columns = cols.map((c) => ({ width: c.w || 14 }));
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([note]).font = { italic: true, color: { argb: 'FF64748B' } };
  const head = ws.addRow(cols.map((c) => c.h));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
  for (const row of rows) ws.addRow(cols.map((c) => { const v = typeof c.k === 'function' ? c.k(row) : row[c.k]; return v ?? ''; }));
  if (!rows.length) ws.addRow(['No records']).font = { italic: true, color: { argb: 'FF94A3B8' } };
  else if (cols.some((c) => c.total)) {
    const t = ws.addRow(cols.map((c, i) => (c.total ? round2(sum(rows, (row) => Number(typeof c.k === 'function' ? c.k(row) : row[c.k]) || 0)) : i === 0 ? 'TOTAL' : '')));
    t.font = { bold: true };
    t.eachCell((cell) => { cell.border = { top: { style: 'thin' } }; });
  }
  cols.forEach((c, i) => { if (c.money) ws.getColumn(i + 1).numFmt = money; });
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: cols.length } };
  return ws;
}

/* ---------------- the reports ---------------- */
async function grnReport(book, from, to, period) {
  const [grns, items, suppliers, ledgers] = await Promise.all([
    find('grns', { date: { $gte: from, $lte: to } }, { sort: { date: 1, id: 1 } }),
    find('grn_items', {}, { sort: { id: 1 } }),
    find('suppliers'),
    supplierLedgers(),
  ]);
  const sup = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const bill = new Map([...ledgers.values()].flat().filter((b) => b.id != null).map((b) => [b.id, b]));
  const ids = new Set(grns.map((g) => g.id));
  const grnOf = Object.fromEntries(grns.map((g) => [g.id, g]));
  sheet(book, 'GRNs', 'GRN details', period, [
    { h: 'GRN no', k: 'grn_no', w: 12 }, { h: 'Date', k: (g) => dmy(g.date), w: 12 },
    { h: 'Supplier', k: (g) => sup[g.supplier_id]?.name, w: 24 }, { h: 'Buying from', k: (g) => (isLocal(sup[g.supplier_id]) ? 'Local' : 'India'), w: 11 },
    { h: 'Supplier invoice', k: 'supplier_invoice_no', w: 16 }, { h: 'Supplier billed', k: (g) => dmy(g.supplier_bill_date), w: 14 },
    { h: 'Bale no', k: 'bale_no' }, { h: 'LR no', k: 'lr_no' }, { h: 'Cargo company', k: 'cargo_name', w: 16 },
    { h: 'Sets', k: 'total_sets', w: 8, total: true }, { h: 'Pieces', k: 'total_pcs', w: 9, total: true },
    { h: 'Currency', k: 'currency', w: 9 }, { h: 'Goods (bill currency)', k: 'goods_inr', money: true, w: 16 },
    { h: 'Supplier bill (bill currency)', k: 'payable_inr', money: true, w: 18 },
    { h: 'Rate', k: (g) => (g.currency === 'LKR' ? 1 : g.exchange_rate), w: 8 },
    { h: 'Cargo charge (Rs)', k: (g) => grnCargoLkr(g), money: true, total: true, w: 16 },
    { h: 'Other expenses (Rs)', k: 'other_lkr', money: true, total: true, w: 16 },
    { h: 'Total landed cost (Rs)', k: 'total_lkr', money: true, total: true, w: 18 },
    { h: 'Paid (bill currency)', k: (g) => bill.get(g.id)?.paid ?? '', money: true, w: 16 },
    { h: 'Balance (bill currency)', k: (g) => bill.get(g.id)?.balance ?? '', money: true, w: 16 },
    { h: 'Due date', k: (g) => dmy(g.due_date), w: 12 }, { h: 'Notes', k: 'notes', w: 24 },
  ], grns);
  sheet(book, 'GRN items', 'GRN items', period, [
    { h: 'GRN no', k: (it) => grnOf[it.grn_id].grn_no, w: 12 }, { h: 'Date', k: (it) => dmy(grnOf[it.grn_id].date), w: 12 },
    { h: 'Supplier', k: (it) => sup[grnOf[it.grn_id].supplier_id]?.name, w: 22 },
    { h: 'Product', k: 'name', w: 28 }, { h: 'Category', k: 'category', w: 14 }, { h: 'Sizes', k: (it) => (Array.isArray(it.sizes) ? it.sizes.join(', ') : it.sizes), w: 14 },
    { h: 'Pcs per set', k: 'pcs_per_set', w: 10 }, { h: 'Sets', k: 'sets', w: 8, total: true },
    { h: 'Extra sets', k: 'extra_sets', w: 9 }, { h: 'Extra pcs', k: 'extra_pcs', w: 9 }, { h: 'Short sets', k: 'short_sets', w: 9 }, { h: 'Short pcs', k: 'short_pcs', w: 9 },
    { h: 'Billed per set (bill currency)', k: 'cost_inr_per_set', money: true, w: 18 }, { h: 'Line (bill currency)', k: 'line_inr', money: true, total: true, w: 16 },
    { h: 'Cargo per pc (Rs)', k: 'cargo_per_pcs', money: true, w: 14 }, { h: 'Other per pc (Rs)', k: 'other_per_pcs', money: true, w: 14 },
    { h: 'Landed per pc (Rs)', k: 'landed_per_pcs_lkr', money: true, w: 15 }, { h: 'Landed total (Rs)', k: 'landed_lkr', money: true, total: true, w: 16 },
    { h: 'Expected price per set (Rs)', k: 'expected_per_set', money: true, w: 18 },
  ], items.filter((it) => ids.has(it.grn_id)));
}

async function stockReport(book, from, to, period) {
  const [products, batches, moves] = await Promise.all([
    find('products', { active: { $ne: 0 } }, { sort: { name: 1 } }),
    find('batches', { left_pcs: { $gt: 0 } }, { sort: { date: 1, id: 1 } }),
    find('stock_moves', { date: { $gte: from, $lte: to } }, { sort: { date: 1, id: 1 } }),
  ]);
  const prod = Object.fromEntries(products.map((p) => [p.id, p]));
  // one line per product and cost (same-cost batches together), like the Stock page
  const rows = [];
  for (const p of products) {
    const mine = batches.filter((b) => b.product_id === p.id);
    const groups = new Map();
    for (const b of mine) {
      const key = round2(b.cost_per_pcs);
      const g = groups.get(key) || { p, cost: key, pcs: 0, value: 0, expected: 0, from: b.date, refs: [] };
      g.pcs += b.left_pcs; g.value += b.left_pcs * b.cost_per_pcs;
      g.expected += b.left_pcs * (b.expected_per_pcs || p.expected_per_set / (p.pcs_per_set || 1));
      if (b.ref && !g.refs.includes(b.ref)) g.refs.push(b.ref);
      groups.set(key, g);
    }
    if (!groups.size && p.stock_pcs > 0) groups.set(p.cost_per_pcs, { p, cost: p.cost_per_pcs, pcs: p.stock_pcs, value: p.stock_pcs * p.cost_per_pcs, expected: p.stock_pcs * p.expected_per_set / (p.pcs_per_set || 1), refs: [] });
    rows.push(...groups.values());
    // damaged returns kept apart: listed, worth nothing (their cost is written off)
    if (p.damaged_pcs > 0) rows.push({ p, cost: 0, pcs: p.damaged_pcs, value: 0, expected: 0, refs: ['DAMAGED (cost written off)'] });
    // sold without stock: listed with its pieces below zero, worth nothing
    if (p.stock_pcs < 0) rows.push({ p, cost: p.last_cost_per_pcs || p.cost_per_pcs, pcs: p.stock_pcs, value: 0, expected: 0, refs: ['Sold without stock'] });
  }
  sheet(book, 'Stock', 'Stock details', `Stock on hand as on ${dmy(todayStr())}`, [
    { h: 'Code', k: (g) => g.p.code, w: 10 }, { h: 'Product', k: (g) => g.p.name, w: 30 }, { h: 'Category', k: (g) => g.p.category, w: 14 },
    { h: 'Sizes', k: (g) => (Array.isArray(g.p.sizes) ? g.p.sizes.join(', ') : g.p.sizes), w: 14 }, { h: 'Pcs per set', k: (g) => g.p.pcs_per_set, w: 10 },
    { h: 'Pieces in stock', k: 'pcs', w: 12, total: true }, { h: 'Sets', k: (g) => round2(g.pcs / (g.p.pcs_per_set || 1)), w: 8 },
    { h: 'Cost per pc (Rs)', k: 'cost', money: true, w: 14 }, { h: 'Stock value at cost (Rs)', k: (g) => round2(g.value), money: true, total: true, w: 18 },
    { h: 'Value at expected price (Rs)', k: (g) => round2(g.expected), money: true, total: true, w: 18 },
    { h: 'From (GRN / stock)', k: (g) => g.refs.join(', '), w: 20 },
  ], rows);
  sheet(book, 'Stock movements', 'Stock movements', period, [
    { h: 'Date', k: (m) => dmy(m.date), w: 12 }, { h: 'Time', k: (m) => lkStamp(m.created_at).slice(11), w: 10 },
    { h: 'Code', k: (m) => prod[m.product_id]?.code, w: 10 }, { h: 'Product', k: (m) => prod[m.product_id]?.name || `#${m.product_id}`, w: 30 },
    { h: 'Type', k: 'type', w: 12 }, { h: 'Reference', k: 'ref', w: 14 }, { h: 'Pieces in (+) / out (−)', k: 'pcs', w: 14 },
    { h: 'Stock after', k: 'balance', w: 11 }, { h: 'Note', k: 'note', w: 28 },
  ], moves);
}

async function invoiceReport(book, from, to, period) {
  const sales = await find('sales', { date: { $gte: from, $lte: to } }, { sort: { date: 1, id: 1 } });
  const [items, customers, ledgers] = await Promise.all([
    sales.length ? find('sale_items', { sale_id: { $in: sales.map((s) => s.id) } }, { sort: { id: 1 } }) : [],
    find('customers'),
    customerLedgers(),
  ]);
  const cus = Object.fromEntries(customers.map((c) => [c.id, c]));
  const bill = new Map([...ledgers.values()].flat().filter((b) => b.id != null).map((b) => [b.id, b]));
  const saleOf = Object.fromEntries(sales.map((s) => [s.id, s]));
  const status = (s) => (s.status === 'void' ? 'Cancelled' : s.total < 0 ? 'Return' : 'Completed');
  sheet(book, 'Invoices', 'Invoice details', period, [
    { h: 'Invoice no', k: 'invoice_no', w: 12 }, { h: 'Date', k: (s) => dmy(s.date), w: 12 }, { h: 'Time', k: (s) => lkStamp(s.created_at).slice(11), w: 10 },
    { h: 'Customer (shop)', k: 'customer_name', w: 24 }, { h: 'Customer name', k: (s) => customerPerson(cus[s.customer_id]), w: 18 },
    { h: 'Type', k: (s) => (s.payment_type === 'credit' ? 'Credit' : 'Cash'), w: 8 }, { h: 'Status', k: status, w: 11 },
    { h: 'Items', k: (s) => items.filter((i) => i.sale_id === s.id).length, w: 7 },
    { h: 'Subtotal (Rs)', k: 'subtotal', money: true, total: true, w: 14 }, { h: 'Discount (Rs)', k: 'discount', money: true, total: true, w: 12 },
    { h: 'Total (Rs)', k: (s) => (s.status === 'void' ? 0 : s.total), money: true, total: true, w: 14 },
    { h: 'Paid at billing (Rs)', k: (s) => (s.status === 'void' ? 0 : s.paid_at_sale), money: true, total: true, w: 15 },
    { h: 'Cost (Rs)', k: (s) => (s.status === 'void' ? 0 : s.cost_total), money: true, total: true, w: 14 },
    { h: 'Profit (Rs)', k: (s) => (s.status === 'void' ? 0 : round2(s.total - s.cost_total)), money: true, total: true, w: 14 },
    { h: 'Balance due now (Rs)', k: (s) => bill.get(s.id)?.balance ?? 0, money: true, total: true, w: 15 },
    { h: 'Due date', k: (s) => dmy(s.due_date), w: 12 }, { h: 'Notes', k: 'notes', w: 22 },
  ], sales);
  sheet(book, 'Invoice items', 'Invoice items', period, [
    { h: 'Invoice no', k: (i) => saleOf[i.sale_id].invoice_no, w: 12 }, { h: 'Date', k: (i) => dmy(saleOf[i.sale_id].date), w: 12 },
    { h: 'Customer', k: (i) => saleOf[i.sale_id].customer_name, w: 22 }, { h: 'Code', k: 'code', w: 10 }, { h: 'Product', k: 'name', w: 30 },
    { h: 'Unit', k: 'unit', w: 7 }, { h: 'Qty', k: 'qty', w: 7, total: true }, { h: 'Pieces', k: 'pcs', w: 8, total: true },
    { h: 'Price (Rs)', k: 'price', money: true, w: 12 }, { h: 'Discount', k: (i) => (i.disc_pct ? `${i.disc_pct}%` : i.disc || ''), w: 9 },
    { h: 'Line total (Rs)', k: 'line_total', money: true, total: true, w: 14 }, { h: 'Cost per unit (Rs)', k: 'cost_per_unit', money: true, w: 14 },
    { h: 'Profit (Rs)', k: (i) => round2(i.line_total - i.cost_per_unit * i.qty), money: true, total: true, w: 13 },
    { h: 'Cancelled', k: (i) => (saleOf[i.sale_id].status === 'void' ? 'Yes' : ''), w: 9 },
  ], items);
}

async function customerReport(book, from, to, period) {
  const [customers, sales, ledgers] = await Promise.all([
    find('customers', { deleted: { $ne: 1 } }),
    find('sales', { status: 'completed', customer_id: { $ne: null } }, { project: { customer_id: 1, total: 1, cost_total: 1, date: 1 } }),
    customerLedgers(),
  ]);
  const rows = customers.map((c) => {
    const mine = sales.filter((s) => s.customer_id === c.id);
    const inP = mine.filter((s) => inPeriod(s.date, from, to));
    return { c, ...summarizeCustomer(ledgers.get(c.id) || []), bills: inP.length, bought: round2(sum(inP, (s) => s.total)), profit: round2(sum(inP, (s) => s.total - s.cost_total)), last: mine.map((s) => s.date).sort().pop() };
  }).sort((a, b) => customerLabel(a.c).localeCompare(customerLabel(b.c)));
  sheet(book, 'Customers', 'Customer details', `Bills and profit for ${period.toLowerCase()}; balances as on ${dmy(todayStr())}`, [
    { h: 'Shop / business', k: (x) => customerLabel(x.c), w: 26 }, { h: 'Customer name', k: (x) => x.c.name, w: 20 }, { h: 'NIC number', k: (x) => x.c.nic_no, w: 15 },
    { h: 'Phone', k: (x) => x.c.phone, w: 14 }, { h: 'WhatsApp', k: (x) => x.c.whatsapp, w: 14 }, { h: 'City', k: (x) => x.c.city, w: 14 }, { h: 'Address', k: (x) => x.c.address, w: 26 },
    { h: 'Credit limit (Rs)', k: (x) => x.c.credit_limit, money: true, w: 14 }, { h: 'Credit days', k: (x) => x.c.credit_days, w: 10 },
    { h: 'Bills in period', k: 'bills', w: 10, total: true }, { h: 'Bought in period (Rs)', k: 'bought', money: true, total: true, w: 16 },
    { h: 'Profit in period (Rs)', k: 'profit', money: true, total: true, w: 16 },
    { h: 'Owes now (Rs)', k: 'balance', money: true, total: true, w: 14 }, { h: 'Overdue (Rs)', k: 'overdue', money: true, total: true, w: 13 },
    { h: 'Cheques waiting (Rs)', k: 'cheques_pending', money: true, total: true, w: 15 },
    { h: 'Last bill', k: (x) => dmy(x.last), w: 12 }, { h: 'Active', k: (x) => (x.c.active ? 'Yes' : 'No'), w: 8 }, { h: 'Notes', k: (x) => x.c.notes, w: 22 },
  ], rows);
}

async function supplierReport(book, from, to, period) {
  const [suppliers, grns, ledgers] = await Promise.all([
    find('suppliers', { deleted: { $ne: 1 } }, { sort: { name: 1 } }),
    find('grns', {}, { project: { supplier_id: 1, payable_inr: 1, total_lkr: 1, date: 1 } }),
    supplierLedgers(),
  ]);
  const rows = suppliers.map((s) => {
    const mine = grns.filter((g) => g.supplier_id === s.id);
    const inP = mine.filter((g) => inPeriod(g.date, from, to));
    return { s, ...summarizeSupplier(ledgers.get(s.id) || []), grns: inP.length, billed: round2(sum(inP, (g) => g.payable_inr)), landed: round2(sum(inP, (g) => g.total_lkr)), last: mine.map((g) => g.date).sort().pop() };
  });
  sheet(book, 'Suppliers', 'Supplier details', `GRNs for ${period.toLowerCase()}; balances as on ${dmy(todayStr())}`, [
    { h: 'Supplier', k: (x) => x.s.name, w: 26 }, { h: 'Buying from', k: (x) => (isLocal(x.s) ? 'Local (Rs)' : 'India (₹)'), w: 12 },
    { h: 'Contact person', k: (x) => x.s.contact_person, w: 18 }, { h: 'Phone', k: (x) => x.s.phone, w: 14 }, { h: 'WhatsApp', k: (x) => x.s.whatsapp, w: 14 },
    { h: 'Email', k: (x) => x.s.email, w: 20 }, { h: 'City', k: (x) => x.s.city, w: 14 }, { h: 'State', k: (x) => x.s.state, w: 12 }, { h: 'Address', k: (x) => x.s.address, w: 24 },
    { h: 'GST no', k: (x) => x.s.gst_no, w: 14 }, { h: 'Bank details', k: (x) => x.s.bank_details, w: 22 }, { h: 'Credit days', k: (x) => x.s.credit_days, w: 10 },
    { h: 'GRNs in period', k: 'grns', w: 10, total: true }, { h: 'Billed in period (₹ / Rs)', k: 'billed', money: true, w: 18 },
    { h: 'Landed cost in period (Rs)', k: 'landed', money: true, total: true, w: 18 },
    { h: 'To pay now (₹ / Rs)', k: 'balance_inr', money: true, w: 16 }, { h: 'Overdue (₹ / Rs)', k: 'overdue_inr', money: true, w: 14 },
    { h: 'Next due', k: (x) => dmy(x.next_due), w: 12 }, { h: 'Last GRN', k: (x) => dmy(x.last), w: 12 }, { h: 'Active', k: (x) => (x.s.active ? 'Yes' : 'No'), w: 8 },
  ], rows);
}

async function paymentReport(book, from, to, period) {
  const inRange = { date: { $gte: from, $lte: to } };
  const [cp, sp, kp, cheques, customers, suppliers, sales, grns] = await Promise.all([
    find('customer_payments', inRange), find('supplier_payments', inRange), find('cargo_payments', inRange),
    find('cheques', { $or: [{ given_on: { $gte: from, $lte: to } }, { cheque_date: { $gte: from, $lte: to } }] }, { sort: { cheque_date: 1, id: 1 } }),
    find('customers'), find('suppliers'), find('sales', {}, { project: { id: 1, invoice_no: 1 } }), find('grns', {}, { project: { id: 1, grn_no: 1 } }),
  ]);
  const cus = Object.fromEntries(customers.map((c) => [c.id, c]));
  const sup = Object.fromEntries(suppliers.map((s) => [s.id, s]));
  const inv = Object.fromEntries(sales.map((s) => [s.id, s.invoice_no]));
  const grn = Object.fromEntries(grns.map((g) => [g.id, g.grn_no]));
  // cash, bank transfer, card… (everything not paid by cheque); cheques have their own sheet
  const cash = [
    ...cp.filter((p) => !p.cheque_id).map((p) => ({ ...p, dir: 'Received', party: 'Customer', who: customerLabel(cus[p.customer_id]), bill: p.sale_id ? inv[p.sale_id] : 'Oldest bills', cur: 'Rs', amt: p.amount, lkr: p.amount })),
    ...sp.filter((p) => !p.cheque_id).map((p) => ({ ...p, dir: 'Paid', party: 'Supplier', who: sup[p.supplier_id]?.name, bill: p.grn_id ? grn[p.grn_id] : 'Oldest bills', cur: isLocal(sup[p.supplier_id]) ? 'Rs' : '₹', amt: p.amount_inr, lkr: p.amount_lkr })),
    ...kp.filter((p) => !p.cheque_id).map((p) => ({ ...p, dir: 'Paid', party: 'Cargo', who: p.cargo_name, bill: 'Oldest shipments', cur: 'Rs', amt: p.amount, lkr: p.amount })),
  ].sort((a, b) => (a.date === b.date ? String(a.created_at).localeCompare(String(b.created_at)) : a.date < b.date ? -1 : 1));
  sheet(book, 'Cash payments', 'Payment details — cash, bank transfer and card', period, [
    { h: 'Date', k: (p) => dmy(p.date), w: 12 }, { h: 'Time', k: (p) => lkStamp(p.created_at).slice(11), w: 10 },
    { h: 'Received / paid', k: 'dir', w: 12 }, { h: 'Party', k: 'party', w: 10 }, { h: 'Name', k: 'who', w: 24 }, { h: 'For', k: 'bill', w: 14 },
    { h: 'Method', k: 'method', w: 13 }, { h: 'Reference', k: 'reference', w: 16 },
    { h: 'Currency', k: 'cur', w: 8 }, { h: 'Amount', k: 'amt', money: true, w: 14 },
    { h: 'Received (Rs)', k: (p) => (p.dir === 'Received' ? p.lkr : ''), money: true, total: true, w: 14 },
    { h: 'Paid (Rs)', k: (p) => (p.dir === 'Paid' ? p.lkr : ''), money: true, total: true, w: 14 }, { h: 'Notes', k: 'notes', w: 22 },
  ], cash);
  const STATUS = { pending: 'Waiting', holding: 'On hold', passed: 'Passed', returned: 'Returned' };
  const billNo = (c) => (c.party === 'customer' ? inv[c.bill_id] : c.party === 'supplier' ? grn[c.bill_id] : '') || '';
  sheet(book, 'Cheques', 'Payment details — cheques', `${period} (cheques given or received, or dated, in the period)`, [
    { h: 'Received / given', k: (c) => (c.direction === 'in' ? 'Received' : 'Given'), w: 13 }, { h: 'Party', k: (c) => ({ customer: 'Customer', supplier: 'Supplier', cargo: 'Cargo' })[c.party], w: 10 },
    { h: 'Name', k: 'party_name', w: 24 }, { h: 'For', k: billNo, w: 12 },
    { h: 'Cheque no', k: 'cheque_no', w: 13 }, { h: 'Owner', k: 'owner', w: 20 }, { h: 'Bank', k: 'bank', w: 20 },
    { h: 'Cheque date', k: (c) => dmy(c.cheque_date), w: 12 }, { h: 'Given / received on', k: (c) => dmy(c.given_on), w: 14 },
    { h: 'Status', k: (c) => STATUS[c.status] || c.status, w: 10 }, { h: 'Passed on', k: (c) => dmy(c.passed_on), w: 12 },
    { h: 'Currency', k: (c) => (c.party === 'supplier' && !isLocal(sup[c.party_id]) ? '₹' : 'Rs'), w: 8 },
    { h: 'Received (amount)', k: (c) => (c.direction === 'in' ? c.amount : ''), money: true, total: true, w: 15 },
    { h: 'Given (amount)', k: (c) => (c.direction === 'out' ? c.amount : ''), money: true, total: true, w: 15 },
    { h: 'Recorded at', k: (c) => lkStamp(c.created_at), w: 19 }, { h: 'Notes', k: 'notes', w: 22 },
  ], cheques);
}

async function duesReport(book) {
  const asOn = `As on ${dmy(todayStr())}`;
  const [cl, sl, cargo] = await Promise.all([customerLedgers(), supplierLedgers(), cargoLedgers()]);
  const due = (b) => ({ overdue: 'Overdue', 'due-soon': 'Due in 7 days', open: 'Not due yet', paid: 'Paid' })[b.status] || b.status;
  const receive = [...cl.values()].flat().filter((b) => b.balance > 0.009).sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9'));
  sheet(book, 'To receive', 'Payment due — to collect from customers', asOn, [
    { h: 'Customer (shop)', k: 'customer_name', w: 24 }, { h: 'Customer name', k: 'customer_person', w: 18 }, { h: 'Phone', k: 'customer_phone', w: 14 },
    { h: 'Bill', k: 'invoice_no', w: 14 }, { h: 'Bill date', k: (b) => dmy(b.date), w: 12 }, { h: 'Due date', k: (b) => dmy(b.due_date), w: 12 },
    { h: 'Status', k: due, w: 13 }, { h: 'Bill amount (Rs)', k: 'amount', money: true, total: true, w: 15 }, { h: 'Paid (Rs)', k: 'paid', money: true, total: true, w: 13 },
    { h: 'Balance (Rs)', k: 'balance', money: true, total: true, w: 14 }, { h: 'Cheques waiting (Rs)', k: (b) => b.cheque_pending || 0, money: true, total: true, w: 15 },
    { h: 'After cheques (Rs)', k: (b) => b.balance_after_cheques ?? b.balance, money: true, total: true, w: 15 },
    { h: 'Returned cheques', k: (b) => (b.cheques_returned || []).map((c) => `${c.cheque_no} (${c.amount})`).join(', '), w: 20 },
  ], receive);
  const pay = [...sl.values()].flat().filter((b) => b.balance > 0.009).sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9'));
  sheet(book, 'To pay suppliers', 'Payment due — to pay suppliers', `${asOn} · Indian suppliers in ₹, local suppliers in Rs`, [
    { h: 'Supplier', k: 'supplier_name', w: 24 }, { h: 'Currency', k: (b) => (b.currency === 'LKR' ? 'Rs' : '₹'), w: 8 },
    { h: 'GRN', k: 'grn_no', w: 14 }, { h: 'Bale no', k: 'bale_no', w: 10 }, { h: 'GRN date', k: (b) => dmy(b.date), w: 12 }, { h: 'Due date', k: (b) => dmy(b.due_date), w: 12 },
    { h: 'Status', k: due, w: 13 }, { h: 'Bill amount', k: 'amount', money: true, w: 14 }, { h: 'Paid', k: 'paid', money: true, w: 13 },
    { h: 'Balance', k: 'balance', money: true, w: 14 },
    { h: 'Returned cheques', k: (b) => (b.cheques_returned || []).map((c) => `${c.cheque_no} (${c.amount})`).join(', '), w: 20 },
  ], pay);
  sheet(book, 'To pay cargo', 'Payment due — to pay cargo companies', asOn, [
    { h: 'Cargo company', k: 'cargo_name', w: 24 }, { h: 'Shipments', k: 'shipments', w: 10, total: true }, { h: 'Last shipment', k: (c) => dmy(c.last_date), w: 13 },
    { h: 'Cargo charges (Rs)', k: 'total', money: true, total: true, w: 16 }, { h: 'Paid (Rs)', k: 'paid', money: true, total: true, w: 14 },
    { h: 'To pay (Rs)', k: 'balance', money: true, total: true, w: 14 },
    { h: 'Unpaid shipments', k: (c) => c.bills.filter((b) => b.balance > 0.009).map((b) => `${b.grn_no} (${b.balance})`).join(', '), w: 30 },
  ], cargo.filter((c) => c.balance > 0.009));
}

const BUILD = { grns: grnReport, stock: stockReport, invoices: invoiceReport, customers: customerReport, suppliers: supplierReport, payments: paymentReport, dues: duesReport };

r.get('/export', async (req, res) => {
  const list = String(req.query.reports || '').split(',').map((x) => x.trim()).filter((x) => REPORTS[x]);
  if (!list.length) fail('Choose at least one report');
  const from = DATE.test(String(req.query.from)) ? req.query.from : '2000-01-01';
  const to = DATE.test(String(req.query.to)) ? req.query.to : todayStr();
  if (from > to) fail('The "from" date is after the "to" date');
  await guard(req, `Download reports: ${list.map((k) => REPORTS[k]).join(', ')} (${dmy(from)} – ${dmy(to)})`);
  const book = new ExcelJS.Workbook();
  book.creator = 'Cargo POS';
  book.created = new Date();
  const period = `Period: ${dmy(from)} to ${dmy(to)}`;
  for (const key of list) await BUILD[key](book, from, to, period);
  const name = list.length === 1 ? REPORTS[list[0]].toLowerCase().replace(/\s+/g, '-') : 'reports';
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="cargo-pos-${name}-${from}-to-${to}.xlsx"`);
  res.send(Buffer.from(await book.xlsx.writeBuffer()));
});

export default r;
