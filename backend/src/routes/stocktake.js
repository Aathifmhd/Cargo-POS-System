import { Router } from 'express';
import ExcelJS from 'exceljs';
import { find, findOne, insert, setById, deleteMany, tx, fail, num, round2, sum, todayStr, stamp, moveStock, lastGrnCost, nextNo, getSettings, setSetting } from '../db.js';
import { guard, audit, rankOf, RANK } from '../auth.js';
import { customerLedgers, supplierLedgers } from '../services.js';
import { cargoLedgers } from '../cheques.js';
import { profitLoss, stampDate } from './reports.js';
import { sheet } from './exports.js';
import { costCode } from '../costcode.js';

/*
 * Settings → Stock Take: count all the stock (once a year, or whenever), item by item.
 * The counts are kept as they are typed (the count can go on over days, by more than one person). Nothing in the
 * stock changes until the stock take is closed (Super Admin): then every item counted that differs from the system is
 * put right — short pieces come off the stock (a loss at their cost), extra pieces go into a "Stock Take" batch at the
 * last GRN cost (a gain). Both show in Sales & Profit → Profit & loss.
 */
const r = Router();
/** The stock take and Start Fresh are the Super Admin's only. */
const superOnly = (req) => { if (rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can do a stock take', 403); };

/*
 * The rows to count. A product whose stock is at one cost is one row (key: its id). A product with pieces at
 * different costs (e.g. two GRNs at different prices) is one row for each cost — high cost, low cost — so each is
 * counted on its own (by the cost code on the stickers) and the stock is valued at its real cost (key: "id:cents").
 */
const TIER_NAME = { low: 'Low cost', medium: 'Medium cost', high: 'High cost' };
const cents = (v) => Math.round((Number(v) || 0) * 100);
function tiersOf(costs) {
  const list = [...new Set(costs)].sort((a, b) => a - b);
  if (list.length < 2) return {};
  const high = Math.max(1, Math.floor(list.length / 3));
  const low = Math.ceil((list.length - high) / 2);
  return Object.fromEntries(list.map((c, i) => [c, i < low ? 'low' : i < list.length - high ? 'medium' : 'high']));
}
async function countRows() {
  const [products, batches, settings] = await Promise.all([
    find('products', { active: { $ne: 0 } }, { project: { id: 1, code: 1, name: 1, category: 1, pcs_per_set: 1, stock_pcs: 1, cost_per_pcs: 1, damaged_pcs: 1 } }),
    find('batches', {}, { project: { id: 1, product_id: 1, kind: 1, cost_per_pcs: 1, left_pcs: 1 } }),
    getSettings(),
  ]);
  const byProduct = new Map();
  for (const b of batches) { if (!byProduct.has(b.product_id)) byProduct.set(b.product_id, []); byProduct.get(b.product_id).push(b); }
  products.sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || a.name.localeCompare(b.name));
  const rows = [];
  for (const p of products) {
    const list = byProduct.get(p.id) || [];
    const groups = new Map();
    for (const b of list.filter((x) => x.kind !== 'short' && x.left_pcs > 0)) {
      const k = cents(b.cost_per_pcs);
      if (!groups.has(k)) groups.set(k, { cost: k / 100, left: 0, ids: [] });
      const g = groups.get(k); g.left += b.left_pcs; g.ids.push(b.id);
    }
    const base = { product_id: p.id, code: p.code, name: p.name, category: p.category, pcs_per_set: p.pcs_per_set, damaged_pcs: p.damaged_pcs || 0 };
    // one cost (or pieces sold without stock still to make good): the product as one row
    if (groups.size < 2 || list.some((x) => x.kind === 'short' && x.left_pcs < 0)) {
      rows.push({ ...base, key: String(p.id), tier: null, stock_pcs: p.stock_pcs, cost_per_pcs: p.cost_per_pcs, cost_code: costCode(p.cost_per_pcs, settings), batch_ids: null });
      continue;
    }
    const tiers = tiersOf([...groups.keys()]);
    for (const [k, g] of [...groups.entries()].sort((a, b) => b[0] - a[0])) {   // dearest first
      rows.push({ ...base, key: `${p.id}:${k}`, tier: tiers[k], stock_pcs: g.left, cost_per_pcs: g.cost, cost_code: costCode(g.cost, settings), batch_ids: g.ids });
    }
  }
  return rows;
}
/** "High cost · KIHI" — how a row's cost is written on the count sheet (empty for a product at one cost). */
const costLabel = (row) => (row.tier ? `${TIER_NAME[row.tier]} · ${row.cost_code}` : '');

r.get('/stocktakes', async (req, res) => {
  superOnly(req);
  const list = await find('stocktakes', {}, { sort: { id: -1 }, project: { counts: 0, lines: 0 } });
  res.json(list);
});

/** One stock take: its counts, and the products to count (what the system says now). */
r.get('/stocktakes/:id', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st) fail('Stock take not found', 404);
  if (st.status === 'closed') return res.json(st);
  const products = await find('products', { active: { $ne: 0 } }, { project: { id: 1, code: 1, name: 1, category: 1, pcs_per_set: 1, stock_pcs: 1, cost_per_pcs: 1, damaged_pcs: 1 }, sort: { name: 1 } });
  res.json({ ...st, products, rows: await countRows() });
});

/** The count sheet (Excel): Product code, Product, Cost (high / low, for a product at more than one cost), System stock, Actual count (empty — to fill in on paper). */
r.get('/stocktakes/:id/sheet', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st) fail('Stock take not found', 404);
  const rows = await countRows();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet('Count sheet', { views: [{ state: 'frozen', ySplit: 3 }], pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '3:3' } });
  ws.columns = [{ width: 14 }, { width: 46 }, { width: 20 }, { width: 20 }, { width: 20 }];
  ws.addRow([`${st.no} — ${st.title}`]).font = { bold: true, size: 14 };
  ws.addRow([`Count date ${st.date.slice(8, 10)}/${st.date.slice(5, 7)}/${st.date.slice(0, 4)} · counted by: ______________________`]).font = { color: { argb: 'FF475569' } };
  const head = ws.addRow(['Product Code', 'Product', 'Cost', 'System Stock Count', 'Actual Count']);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } }; c.alignment = { vertical: 'middle', horizontal: 'center' }; });
  const thin = { style: 'thin', color: { argb: 'FF94A3B8' } };
  for (const p of rows) {
    const row = ws.addRow([p.code, p.name, costLabel(p), p.stock_pcs, '']);
    row.height = 22;
    row.eachCell({ includeEmpty: true }, (c, i) => { c.border = { top: thin, bottom: thin, left: thin, right: thin }; c.alignment = { vertical: 'middle', horizontal: i >= 3 ? 'center' : 'left' }; });
    if (p.tier) row.getCell(3).font = { bold: true, color: { argb: p.tier === 'high' ? 'FFB91C1C' : p.tier === 'low' ? 'FF15803D' : 'FFB45309' } };
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${st.no}-count-sheet.xlsx"`);
  res.send(Buffer.from(await book.xlsx.writeBuffer()));
});

/**
 * Upload the count sheet with the Actual Count filled in (the same Excel as the download). Each row with a product code
 * and a count sets that product's count; empty counts are skipped (they don't clear a count already typed).
 */
r.post('/stocktakes/:id/upload', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st || st.status !== 'open') fail('This stock take is not open');
  const b64 = String(req.body?.file || '').replace(/^data:[^,]*,/, '');
  if (!b64) fail('Choose the filled-in count sheet (Excel)');
  const book = new ExcelJS.Workbook();
  try { await book.xlsx.load(Buffer.from(b64, 'base64')); } catch { fail('That file is not an Excel count sheet (.xlsx)'); }
  const ws = book.worksheets[0];
  if (!ws) fail('The Excel file is empty');
  // the header row: "Product Code" and "Actual Count"
  const text = (c) => { const v = c?.value; return String(v && typeof v === 'object' ? v.result ?? v.text ?? (v.richText || []).map((x) => x.text).join('') : v ?? '').trim(); };
  let headRow = 0; let codeCol = 0; let countCol = 0; let costCol = 0;
  ws.eachRow((row, i) => {
    if (headRow) return;
    row.eachCell((c, col) => {
      const t = text(c).toLowerCase();
      if (t === 'product code') codeCol = col;
      if (t === 'actual count') countCol = col;
      if (t === 'cost') costCol = col;
    });
    if (codeCol && countCol) headRow = i; else { codeCol = 0; countCol = 0; costCol = 0; }
  });
  if (!headRow) fail('Can\'t find the "Product Code" and "Actual Count" columns — use the count sheet downloaded from this stock take');
  // a product's rows by its code; a product at more than one cost is told apart by the Cost column
  const byCode = new Map();
  for (const row of await countRows()) {
    const c = String(row.code).trim().toLowerCase();
    if (!byCode.has(c)) byCode.set(c, []);
    byCode.get(c).push(row);
  }
  const counts = { ...(st.counts || {}) };
  const unknown = []; const bad = [];
  let set = 0; let empty = 0;
  for (let i = headRow + 1; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const code = text(row.getCell(codeCol));
    if (!code) continue;
    const raw = text(row.getCell(countCol));
    if (raw === '') { empty++; continue; }
    const options = byCode.get(code.toLowerCase());
    if (!options) { unknown.push(code); continue; }
    const cost = costCol ? text(row.getCell(costCol)).toLowerCase() : '';
    const hit = options.length === 1 ? options[0] : options.find((o) => costLabel(o).toLowerCase() === cost);
    if (!hit) { unknown.push(`${code}${cost ? ` (${cost})` : ''}`); continue; }
    const n = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) { bad.push(`${code} (${raw})`); continue; }
    counts[hit.key] = { pcs: Math.round(n), by: req.user.username, at: stamp(), from: 'excel' };
    set++;
  }
  await setById('stocktakes', st.id, { counts });
  res.json({ set, empty, unknown, bad, counted: Object.keys(counts).length });
});

r.post('/stocktakes', async (req, res) => {
  superOnly(req);
  if (await findOne('stocktakes', { status: 'open' })) fail('A stock take is already open — finish or discard it first');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? req.body.date : todayStr();
  const title = String(req.body?.title || '').trim() || `Stock take ${date.slice(0, 4)}`;
  const no = await nextNo('stocktakes', 'no', 'STK-', 4);
  const st = await insert('stocktakes', { no, title, date, status: 'open', counts: {}, started_by: req.user.username, note: null, lines: [], short_value: 0, over_value: 0, closed_at: null, closed_by: null });
  res.json(st);
});

/** Save one row's count (pieces); an empty count clears it. key: the row (a product id, or "id:cents" for one of its costs). */
r.put('/stocktakes/:id/count', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st || st.status !== 'open') fail('This stock take is not open');
  const key = String(req.body?.key ?? req.body?.product_id ?? '');
  if (!/^\d+(:\d+)?$/.test(key)) fail('Choose a product to count');
  if (!(await findOne('products', { id: num(key.split(':')[0]) }, { project: { id: 1 } }))) fail('Product not found', 404);
  const v = req.body?.counted;
  const counts = { ...(st.counts || {}) };
  if (v === '' || v === null || v === undefined) delete counts[key];
  else {
    const n = Math.round(num(v, -1));
    if (n < 0) fail('The count can\'t be below 0');
    counts[key] = { pcs: n, by: req.user.username, at: stamp() };
  }
  await setById('stocktakes', st.id, { counts });
  res.json({ ok: true, counted: Object.keys(counts).length });
});

r.delete('/stocktakes/:id', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st) fail('Stock take not found', 404);
  if (st.status !== 'open') fail('A closed stock take can\'t be discarded');
  await guard(req, `Discard stock take ${st.no} (${st.title}) — ${Object.keys(st.counts || {}).length} items counted`);
  await deleteMany('stocktakes', { id: st.id });
  res.json({ ok: true });
});

/** Close: put the stock right for every counted item that differs. Always the Super Admin's password. */
r.post('/stocktakes/:id/close', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st || st.status !== 'open') fail('This stock take is not open');
  const counts = st.counts || {};
  if (!Object.keys(counts).length) fail('Nothing has been counted yet');
  const rows = await countRows();
  const todo = rows.filter((x) => !counts[x.key]);
  if (todo.length) fail(`${todo.length} row${todo.length === 1 ? ' is' : 's are'} not counted yet — type a count for every product${todo.some((x) => x.tier) ? ' and each of its costs' : ''} (0 when there is none)`);
  const counted = rows.map((x) => ({ x, counted: counts[x.key].pcs, d: counts[x.key].pcs - x.stock_pcs }));
  const diffs = counted.filter((c) => c.d !== 0);
  const items = new Set(rows.map((x) => x.product_id)).size;
  await guard(req, `Close stock take ${st.no} (${st.title}): ${items} items counted, ${diffs.length} differ`, 'superadmin', { always: true });
  const note = String(req.body?.note || '').trim() || null;
  const lines = [];
  await tx(async () => {
    for (const { x, counted: pcs, d } of diffs) {
      const at = x.tier ? ` (${TIER_NAME[x.tier].toLowerCase()} ${x.cost_code})` : '';
      let cost;
      if (d < 0) {
        // short on the floor: off the stock at their cost — from that cost's batches when the product is at more than one cost
        const taken = await moveStock(x.product_id, d, 'stocktake', st.no, `Stock take — short ${-d} pcs${at}`, todayStr(), { reasonCode: 'stocktake', ...(x.batch_ids ? { batchIds: x.batch_ids } : {}) });
        cost = sum(taken, (t) => Math.abs(t.pcs) * t.cost_per_pcs) / -d;
      } else {
        // more than the system: into a "Stock Take" batch — at that cost, or at the last GRN cost (no GRN batch is touched)
        cost = x.tier ? x.cost_per_pcs : await lastGrnCost(await findOne('products', { id: x.product_id }));
        await moveStock(x.product_id, d, 'stocktake', st.no, `Stock take — ${d} pcs more${at}`, todayStr(), { newBatch: { kind: 'count', ref: st.no, cost_per_pcs: cost }, reasonCode: 'stocktake' });
      }
      lines.push({ key: x.key, product_id: x.product_id, code: x.code, name: x.name, category: x.category, tier: x.tier, cost_code: x.cost_code, was: x.stock_pcs, counted: pcs, diff: d, cost_per_pcs: round2(cost), value: round2(Math.abs(d) * cost) });
    }
    const agreed = counted.filter((c) => c.d === 0).map(({ x }) => ({ key: x.key, product_id: x.product_id, code: x.code, name: x.name, category: x.category, tier: x.tier, cost_code: x.cost_code, was: x.stock_pcs, counted: x.stock_pcs, diff: 0, cost_per_pcs: round2(x.cost_per_pcs), value: 0 }));
    await setById('stocktakes', st.id, {
      status: 'closed', closed_at: stamp(), closed_by: req.user.username, note, lines: [...lines, ...agreed],
      period_from: (await getSettings()).fresh_start_at || null,   // this period began at the last Start Fresh (or the start)
      items_counted: items, items_differ: lines.length,
      short_value: round2(sum(lines.filter((l) => l.diff < 0), (l) => l.value)), over_value: round2(sum(lines.filter((l) => l.diff > 0), (l) => l.value)),
    });
  });
  res.json(await findOne('stocktakes', { id: st.id }));
});

/* =========================================================
   START FRESH (after a finished stock take, once): the sales and the profit & loss start again from now.
   Nothing is deleted — dues, cheques, stock and every bill carry over; the period closed is kept (its summary,
   and its Profit & loss can still be opened and downloaded).
   ========================================================= */
const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
/** The window of a stock take's period: from the last Start Fresh before it, to its own Start Fresh (or now). */
const periodWin = (st) => (st.period ? { after: st.period.from_stamp || null, before: st.period.to_stamp || null } : { after: st.period_from || null, before: null });

/** Can this stock take start fresh? The newest finished one, used once, with no stock take open. */
async function freshCheck(st) {
  if (!st || st.status !== 'closed') fail('Finish the stock count first');
  if (st.fresh_at) fail(`${st.no} has already been used to start fresh (${dmy(stampDate(st.fresh_at))})`);
  if (await findOne('stocktakes', { status: 'open' })) fail('A stock take is open — finish or discard it first');
  if (await findOne('stocktakes', { status: 'closed', id: { $gt: st.id } })) fail('Only the newest finished stock take can start fresh');
}
/** What the period closing comes to, and what carries over into the new one. */
async function freshPicture(st) {
  const win = periodWin(st);
  const now = stamp();
  const pl = await profitLoss('2000-01-01', todayStr(), { after: win.after, before: null });
  const [cl, sl, cargo, cheques, batches, damaged] = await Promise.all([
    customerLedgers(), supplierLedgers(), cargoLedgers(),
    find('cheques', { status: { $in: ['pending', 'holding'] } }, { project: { amount: 1, direction: 1 } }),
    find('batches', { left_pcs: { $gt: 0 } }, { project: { left_pcs: 1, cost_per_pcs: 1 } }),
    find('damaged', { left_pcs: { $gt: 0 } }, { project: { left_pcs: 1 } }),
  ]);
  const owed = (m) => [...m.values()].flat().filter((b) => b.balance > 0.009);
  const pay = owed(sl);
  return {
    period: { from_stamp: win.after, to_stamp: now, from: stampDate(win.after), to: todayStr() },
    summary: pl.summary, by_reason: pl.by_reason,
    carry: {
      stock_value: round2(sum(batches, (b) => b.left_pcs * b.cost_per_pcs)), stock_pcs: sum(batches, (b) => b.left_pcs), damaged_pcs: sum(damaged, (d) => d.left_pcs),
      to_collect: round2(sum(owed(cl), (b) => b.balance)),
      to_pay_inr: round2(sum(pay.filter((b) => b.currency !== 'LKR'), (b) => b.balance)), to_pay_lkr: round2(sum(pay.filter((b) => b.currency === 'LKR'), (b) => b.balance)),
      to_pay_cargo: round2(sum(cargo, (c) => Math.max(0, c.balance))),
      cheques_in: round2(sum(cheques.filter((c) => c.direction === 'in'), (c) => c.amount)), cheques_out: round2(sum(cheques.filter((c) => c.direction === 'out'), (c) => c.amount)),
      cheques_count: cheques.length,
    },
  };
}

r.get('/stocktakes/:id/fresh', async (req, res) => {
  if (rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can start fresh', 403);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  await freshCheck(st);
  res.json({ no: st.no, title: st.title, ...(await freshPicture(st)) });
});

r.post('/stocktakes/:id/fresh', async (req, res) => {
  superOnly(req);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  await freshCheck(st);
  await guard(req, `START FRESH after ${st.no} (${st.title}) — the sales and the profit & loss start again from now`, 'superadmin', { always: true });
  const pic = await freshPicture(st);
  const at = pic.period.to_stamp;
  await setById('stocktakes', st.id, { fresh_at: at, fresh_by: req.user.username, period: { ...pic.period, summary: pic.summary, by_reason: pic.by_reason, carry: pic.carry } });
  await setSetting('fresh_start_at', at);
  await setSetting('fresh_start_no', st.no);
  await audit(req.user, `Started fresh after ${st.no}: closed the period ${dmy(pic.period.from) || 'from the start'} – ${dmy(pic.period.to)} (sales Rs ${pic.summary.sales}, net profit Rs ${pic.summary.net_profit})`, null, 'superadmin');
  res.json(await findOne('stocktakes', { id: st.id }, { project: { counts: 0, lines: 0 } }));
});

/** The stock take's Excel: its period's Profit & loss, and the stock as counted. */
r.get('/stocktakes/:id/report', async (req, res) => {
  if (rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can download the Profit & loss', 403);
  const st = await findOne('stocktakes', { id: num(req.params.id) });
  if (!st || st.status !== 'closed') fail('Finish the stock count first');
  const win = periodWin(st);
  const pl = await profitLoss('2000-01-01', stampDate(win.before) || todayStr(), win);
  const s = pl.summary;
  const period = `Period: ${win.after ? dmy(stampDate(win.after)) : 'the start'} to ${win.before ? dmy(stampDate(win.before)) : dmy(todayStr())}${st.fresh_at ? '' : ' (still running — not started fresh yet)'}`;
  const book = new ExcelJS.Workbook();
  book.creator = 'Cargo POS';
  const REASON = { damaged: 'Damaged return', undercost: 'Sold under cost', short: 'GRN short (lost)', stock: 'Stock correction', missing: "Missing — can't find", sample: 'Free sample given',
    gift: 'Gift / promotion', shopuse: 'Used by the shop', counting: 'Counting mistake', other: 'Other', stocktake: 'Stock take — short' };
  const GAIN = { extra: 'Extra kept free', stockfound: 'Stock found', add_found: 'Found stock', add_counting: 'Counting mistake', add_supplierfree: 'Free goods from supplier', add_other: 'Other', repaired: 'Damaged piece repaired', stocktake_over: 'Stock take — more' };
  sheet(book, 'Profit & loss', `Profit & loss — ${st.no} ${st.title}`, period, [{ h: 'What', k: 'what', w: 40 }, { h: 'Amount (Rs)', k: 'amount', w: 18, money: true }], [
    { what: 'Sales', amount: s.sales }, { what: 'Cost of the goods sold', amount: s.cost }, { what: 'Profit on the bills', amount: s.invoice_profit },
    { what: 'Extra pieces kept free', amount: s.extra_profit }, { what: 'Stock found / more on counts', amount: s.stock_gain }, { what: 'GROSS PROFIT', amount: s.gross_profit },
    ...pl.by_reason.map((x) => ({ what: `Loss — ${REASON[x.reason] || x.reason} (${x.count})`, amount: -x.amount })),
    { what: 'TOTAL LOSSES', amount: -s.losses }, { what: 'NET PROFIT', amount: s.net_profit },
  ]);
  sheet(book, 'Bills', 'Profit on each bill', period, [
    { h: 'Bill', k: 'invoice_no', w: 12 }, { h: 'Date', k: (b) => dmy(b.date), w: 12 }, { h: 'Customer', k: 'customer_name', w: 26 }, { h: 'Type', k: (b) => (b.payment_type === 'credit' ? 'Credit' : 'Cash'), w: 8 },
    { h: 'Total (Rs)', k: 'total', money: true, total: true, w: 14 }, { h: 'Cost (Rs)', k: 'cost', money: true, total: true, w: 14 }, { h: 'Profit (Rs)', k: 'profit', money: true, total: true, w: 14 },
    { h: 'Losses in it (Rs)', k: 'losses', money: true, total: true, w: 15 }, { h: 'After losses (Rs)', k: 'net', money: true, total: true, w: 15 },
  ], pl.invoices.slice().reverse());
  sheet(book, 'Losses', 'Losses, with their reason', period, [
    { h: 'Date', k: (l) => dmy(l.date), w: 12 }, { h: 'Reason', k: (l) => REASON[l.reason] || l.reason, w: 22 }, { h: 'Bill / GRN', k: 'ref', w: 14 }, { h: 'Code', k: 'code', w: 10 },
    { h: 'Product', k: 'name', w: 28 }, { h: 'Pcs', k: 'pcs', w: 7, total: true }, { h: 'Loss (Rs)', k: 'amount', money: true, total: true, w: 14 }, { h: 'Details', k: 'note', w: 40 },
  ], pl.losses);
  sheet(book, 'Gains', 'Extra pieces kept free & stock found', period, [
    { h: 'Date', k: (g) => dmy(g.date), w: 12 }, { h: 'What', k: (g) => GAIN[g.reason] || g.reason, w: 24 }, { h: 'GRN / ref', k: 'ref', w: 14 }, { h: 'Product', k: 'name', w: 28 },
    { h: 'Pcs', k: 'pcs', w: 7, total: true }, { h: 'Profit (Rs)', k: 'amount', money: true, total: true, w: 14 }, { h: 'Details', k: 'note', w: 36 },
  ], pl.gains);
  sheet(book, 'Stock after the count', `Stock after the count — ${st.no}`, `Counted and finished ${dmy(stampDate(st.closed_at))} by ${st.closed_by}${st.note ? ` · ${st.note}` : ''}`, [
    { h: 'Product Code', k: 'code', w: 13 }, { h: 'Product', k: 'name', w: 32 }, { h: 'Category', k: 'category', w: 14 }, { h: 'Cost', k: (l) => costLabel(l), w: 18 },
    { h: 'System said', k: 'was', w: 12, total: true }, { h: 'Counted', k: 'counted', w: 10, total: true }, { h: 'Difference', k: 'diff', w: 11, total: true },
    { h: 'Cost / pc (Rs)', k: 'cost_per_pcs', money: true, w: 14 }, { h: 'Stock value (Rs)', k: (l) => round2(l.counted * (l.cost_per_pcs || 0)), money: true, total: true, w: 16 },
    { h: 'Difference value (Rs)', k: (l) => (l.diff < 0 ? -l.value : l.value), money: true, total: true, w: 18 },
  ], (st.lines || []).slice().sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')) || a.name.localeCompare(b.name) || (b.cost_per_pcs || 0) - (a.cost_per_pcs || 0)));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${st.no}-profit-loss-and-stock.xlsx"`);
  res.send(Buffer.from(await book.xlsx.writeBuffer()));
});

export default r;
