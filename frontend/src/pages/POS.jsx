import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, n, r2, lkr, money, today, addDays, int, margin, pct, niceDate, costTiers, costGroups, seesCost, codeOf } from '../lib.js';
import { Icon, Modal, Field, NumInput, DateInput, CostBadge, useToast, Loading, useListKeys } from '../components/ui.jsx';
import { printBill, billDesign, SizeChoice, PrintChoiceModal } from '../components/Bill.jsx';
import { useNarrow, usePhone } from '../components/mobile.js';
import { CustomerForm } from '../components/forms.jsx';
import { useAuth, useSettings } from '../App.jsx';
import { isAdmin, isSuper, custName, custPerson, niceTime, costCode } from '../lib.js';

const DRAFT_KEY = 'cargo-pos-draft';
const HELD_KEY = 'cargo-pos-held';   // older: bills held on this computer only (moved to the shared list once)
const LAST_KEY = 'cargo-pos-last-sale';
const readLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Billing keys — shown in the help box and in Settings. */
export const POS_KEYS = [
  ['F1', 'Back to the code box'],
  ['Enter', 'Next box · add the line'],
  ['- in front of the qty', 'A return from the customer (e.g. -2): back into stock'],
  ['← →', 'Previous / next box'],
  ['Esc', 'Clear the entry row'],
  ['* in code box', 'List every product'],
  ['↓ (empty code box)', 'Go to the bill'],
  ['↑ ↓', 'Move on the bill'],
  ['Space', 'Edit the line (qty · price)'],
  ['← → (editing)', 'Move between qty and price'],
  ['Enter (editing)', 'Keep the change · Esc to cancel'],
  ['P', 'Edit the price on the line'],
  ['Enter Enter', 'Take payment → choose Cash or Credit'],
  ['+ / −', 'Quantity up / down'],
  ['Delete', 'Remove the line'],
  ['Ctrl + ↑ ↓', 'Move the line'],
  ['`', 'Show / hide cost and profit'],
  ['F3', 'Price history — what this customer paid for the product before (F3 again to close)'],
  ['F4', 'Customer'],
  ['F8', 'Bill discount'],
  ['F10', 'Take payment (same as Enter Enter)'],
  ['F7 / Ctrl + H', 'Hold the bill'],
  ['F5 / Ctrl + R', 'Held bills'],
  ['F12', 'Reprint the last bill'],
  ['Ctrl + Delete', 'Clear the bill'],
  ['?', 'This list'],
];

/** per-unit numbers for a product — from its stock batch when one is picked (each batch has its own cost and prices) */
function unitInfo(p, unit, b = null) {
  const per = unit === 'set' ? p.pcs_per_set : 1;
  const costPc = b ? b.cost_per_pcs : p.cost_per_pcs;
  const expectedPc = b?.expected_per_pcs || p.expected_per_set / p.pcs_per_set;
  const mrpPc = b?.mrp_per_pcs || p.mrp_per_set / p.pcs_per_set;
  return {
    cost: r2(costPc * per), expected: r2(expectedPc * per), mrp: r2(mrpPc * per), per,
    // always per piece too, so a set price can be read as a piece price
    costPc: r2(costPc), expectedPc: r2(expectedPc), mrpPc: r2(mrpPc),
  };
}
/** "GRN-0003 · 09 Oct" — where a batch came from */
const batchText = (b) => (b ? `${b.ref || 'Stock'}${b.date ? ` · ${niceDate(b.date)}` : ''}` : '');
const lineCalc = (l) => {
  const gross = n(l.qty) * n(l.price);
  const disc = r2((gross * n(l.disc_pct)) / 100);
  return { gross, disc, amount: r2(gross - disc), net: n(l.qty) ? (gross - disc) / n(l.qty) : n(l.price) };
};
const pcsText = (pcs) => `${int(pcs)} pcs`;
const blankEntry = { q: '', pid: null, bid: null, damaged: false, unit: 'pcs', qty: '1', price: '', disc_pct: '' };   // damaged: selling damaged pieces   // sold by the piece only; bid = the stock batch
// one click in a box selects all of it, ready to type over (the mouse coming up would otherwise drop the selection)
const selectAll = {
  onFocus: (e) => { e.target.dataset.fresh = '1'; e.target.select(); },
  onMouseUp: (e) => { if (e.target.dataset.fresh) { e.preventDefault(); delete e.target.dataset.fresh; } },
  onBlur: (e) => { delete e.target.dataset.fresh; },
};
const typingIn = (el) => el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);

export default function POS() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const seeCost = seesCost(user);   // Cashier, KP, Employee: no cost or profit — the cost code only
  const { settings } = useSettings();
  const [products, setProducts] = useState(null);
  const [customers, setCustomers] = useState([]);
  const draft = useMemo(() => readLS(DRAFT_KEY, null), []);
  const [lines, setLines] = useState(draft?.lines || []);
  const [customerId, setCustomerId] = useState(draft?.customerId || null);
  const [billDisc, setBillDisc] = useState(draft?.billDisc || '');
  const [entry, setEntry] = useState(blankEntry);
  const [hi, setHi] = useState(0);
  const [sel, setSel] = useState(-1);
  const narrow = useNarrow();   // a phone: the match list goes right under the code box
  const [priceHist, setPriceHist] = useState(null);   // F3: { product } — the prices it was sold at before
  const [edit, setEdit] = useState(null);          // { i, qty, price } while a bill line is being edited
  const [showCostPref, setShowCost] = useState(() => readLS('pos-show-cost', true));
  // held bills are shared: every user, on every computer, sees the same list (kept on the server)
  const [held, setHeld] = useState([]);
  const loadHeld = () => api.get('/held/bill').then((l) => setHeld(l.map((h) => ({ ...h.data, id: h.id, at: h.at, by: h.by, label: h.label })))).catch(() => {});
  useEffect(() => {
    // bills held on this computer before: onto the shared list, once
    const old = readLS(HELD_KEY, []);
    const move = Array.isArray(old) && old.length
      ? Promise.all(old.map((b) => api.post('/held/bill', { label: b.label, summary: { lines: (b.lines || []).length }, data: { lines: b.lines || [], customerId: b.customerId ?? null, billDisc: b.billDisc || '' } }))).then(() => localStorage.removeItem(HELD_KEY)).catch(() => {})
      : Promise.resolve();
    move.then(loadHeld);
    const t = setInterval(loadHeld, 20000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line
  const [modal, setModal] = useState(null);        // 'customer' | 'pay' | 'credit' | 'held' | 'keys' | {newCustomer}
  const [askReturn, setAskReturn] = useState(null);   // a return waiting for "normal or damaged?": (damaged) => void
  const [after, setAfter] = useState(null);        // what to open after picking a customer
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [nextNo, setNextNo] = useState('');
  const [now, setNow] = useState(new Date());
  const codeRef = useRef();
  const billRef = useRef();

  const loadProducts = () => api.get('/products').then(setProducts).catch((e) => toast(e.message, 'error'));
  const loadCustomers = () => api.get('/customers').then((c) => setCustomers(c.filter((x) => x.active))).catch(() => {});
  const loadNo = () => api.get('/sales/next-no').then((d) => setNextNo(d.invoice_no)).catch(() => {});
  useEffect(() => { loadProducts(); loadCustomers(); loadNo(); }, []); // eslint-disable-line
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { writeLS('pos-show-cost', showCostPref); }, [showCostPref]);
  const showCost = showCostPref && seeCost;
  useEffect(() => { writeLS(DRAFT_KEY, { lines, customerId, billDisc }); }, [lines, customerId, billDisc]);
  useEffect(() => { if (sel >= lines.length) setSel(lines.length - 1); }, [lines.length, sel]);
  useEffect(() => { billRef.current?.querySelector('tr.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const byId = useMemo(() => Object.fromEntries((products || []).map((p) => [p.id, p])), [products]);
  // everything is sold by the piece: a line or held bill from before (in sets) becomes the same quantity in pieces
  useEffect(() => {
    if (!lines.some((l) => l.unit === 'set' && byId[l.product_id])) return;
    setLines((ls) => ls.map((l) => {
      const p = byId[l.product_id];
      if (l.unit !== 'set' || !p) return l;
      return { ...l, unit: 'pcs', qty: n(l.qty) * p.pcs_per_set, price: r2(n(l.price) / p.pcs_per_set) };
    }));
  }, [lines, byId]);
  const customer = customers.find((c) => c.id === customerId);
  const cur = entry.pid ? byId[entry.pid] : null;
  // the stock batch a line (or the entry) sells from: the same product bought at different costs is kept apart
  // a product's stock, one group per cost (batches that cost the same are sold as one)
  const groupsOf = (p) => costGroups(p?.batches);
  const batchOf = (pid, bid) => (bid != null ? groupsOf(byId[pid]).find((g) => g.ids.includes(bid)) || null : null);
  const curB = cur ? batchOf(cur.id, entry.bid) : null;

  /* ---------- matches for the code box ---------- */
  const hits = useMemo(() => {
    const s = entry.q.trim().toLowerCase();
    if (!s || entry.pid) return [];
    const all = (products || []).filter((p) => s === '*' || p.code.toLowerCase().includes(s) || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s));
    return all.sort((a, b) => (a.code.toLowerCase() === s ? -1 : 0) - (b.code.toLowerCase() === s ? -1 : 0) || (b.stock_pcs > 0) - (a.stock_pcs > 0)).slice(0, 60);
  }, [products, entry.q, entry.pid]);
  // one row per cost when a product was bought at different costs (cheapest first, badged low / medium / high)
  const hitRows = useMemo(() => hits.flatMap((p) => {
    const gs = costGroups(p.batches);
    const dmg = p.damaged?.pcs > 0 ? [{ p, b: null, tier: null, damaged: true }] : [];
    if (gs.length < 2) return [{ p, b: gs[0] || null, tier: null }, ...dmg];
    const tiers = costTiers(gs);
    return [...gs.map((g) => ({ p, b: g, tier: tiers[g.id] })), ...dmg];
  }), [hits]);

  const inBillDamaged = (pid, except = -1) => lines.reduce((s, l, i) => (l.product_id === pid && i !== except && l.damaged && n(l.qty) > 0 && byId[pid] ? s + n(l.qty) * unitInfo(byId[pid], l.unit).per : s), 0);
  const inBillPcs = (pid, except = -1, bid = null) => lines.reduce((s, l, i) => (l.product_id === pid && i !== except && !l.damaged && byId[pid] && (bid == null || l.batch_id === bid || (batchOf(pid, bid)?.ids || []).includes(l.batch_id)) ? s + n(l.qty) * unitInfo(byId[pid], l.unit).per : s), 0);
  // pieces still free to bill: of the batch when one is picked, never more than the product has
  const freePcs = (p, b, except = -1) => Math.min(p.stock_pcs - inBillPcs(p.id, except), b ? b.left_pcs - inBillPcs(p.id, except, b.id) : Infinity);
  // Move the cursor straight away, so fast typing / a barcode scanner never lands in the wrong box.
  // (Only boxes that appear after a re-render — the line editor — wait for the next tick.)
  const focus = (id) => {
    const find = () => (typeof id === 'string' ? document.getElementById(id) : id.current);
    const go = () => { const el = find(); if (!el) return false; el.focus(); el.select?.(); return true; };
    if (!go()) setTimeout(go, 0);
    requestAnimationFrame(() => { const el = find(); if (el && document.activeElement === el) el.select?.(); });
  };
  const toCode = () => { setSel(-1); setEdit(null); focus(codeRef); };

  /* ---------- entry row ---------- */
  const pick = (p, b = null, damaged = false) => {
    if (!p) return;
    const unit = 'pcs';
    const u = unitInfo(p, unit, b);
    // damaged pieces: the price starts at their cost — sell it under cost as agreed with the customer
    const price = damaged ? p.damaged?.cost_per_pcs : u.expected;
    setEntry({ q: p.code, pid: p.id, bid: damaged ? null : b?.id ?? null, damaged, unit, qty: '1', price: price ? price.toFixed(2) : '', disc_pct: '' });
    setHi(0);
    if (damaged) { toast(`Selling damaged ${p.name} — ${pcsText(p.damaged.pcs)} damaged left. Type the agreed price.`); return focus('tQty'); }
    if (p.stock_pcs - inBillPcs(p.id) <= 0) toast(`"${p.name}" shows no stock — it can still be billed (sold without stock)`);
    focus('tQty');
  };
  const commit = (returnDamaged) => {
    const p = cur;
    if (!p) { toast('Scan or type a product code first', 'error'); return toCode(); }
    const qty = n(entry.qty);
    if (!qty) { toast('Enter a quantity (put - in front for a return, e.g. -2)', 'error'); return focus('tQty'); }
    const per = unitInfo(p, entry.unit).per;
    // a return: ask whether it is damaged (kept apart, a loss) or normal (back to stock)
    if (qty < 0 && returnDamaged === undefined) return setAskReturn(() => (d) => commit(d));
    const damaged = qty < 0 ? Boolean(returnDamaged) : Boolean(entry.damaged);
    if (damaged && qty > 0) {
      const left = (p.damaged?.pcs || 0) - inBillDamaged(p.id);
      if (qty * per > left) { toast(`Only ${pcsText(Math.max(0, left))} damaged ${p.name} left`, 'error'); return focus('tQty'); }
    }
    // more than is in stock is allowed (a stock or billing mistake): the line is marked "sold without stock"
    const free = p.stock_pcs - inBillPcs(p.id);
    if (!damaged && qty > 0 && qty * per > free) toast(`${pcsText(qty * per - Math.max(0, free))} of ${p.name} sold without stock — the Super Admin is told`);
    const line = { product_id: p.id, batch_id: damaged && qty > 0 ? null : curB?.id ?? null, damaged, unit: entry.unit, qty, price: n(entry.price), disc_pct: n(entry.disc_pct) };
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product_id === line.product_id && Math.sign(n(l.qty)) === Math.sign(line.qty) && Boolean(l.damaged) === damaged && (l.batch_id ?? null) === line.batch_id && l.unit === line.unit && n(l.price) === line.price && n(l.disc_pct) === line.disc_pct);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: n(l.qty) + qty } : l));
      return [line, ...ls];   // newest line on top
    });
    setEntry(blankEntry);
    toCode();
  };
  const ORDER = ['tCode', 'tQty', 'tPrice', 'tDis'];
  const entryKey = (id) => (e) => {
    const i = ORDER.indexOf(id);
    const el = e.target;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length;
    if (e.key === 'Escape') { e.preventDefault(); setEntry(blankEntry); return toCode(); }
    if (id === 'tCode') {
      if (e.key === 'ArrowDown' && hitRows.length) { e.preventDefault(); return setHi((h) => Math.min(h + 1, hitRows.length - 1)); }
      if (e.key === 'ArrowUp' && hitRows.length) { e.preventDefault(); return setHi((h) => Math.max(h - 1, 0)); }
      if (e.key === 'ArrowDown' && !entry.q && lines.length) { e.preventDefault(); el.blur(); return setSel(0); }
      if (e.key === 'Enter' && !e.ctrlKey) {
        e.preventDefault();
        if (cur) return focus('tQty');
        if (!entry.q.trim()) return doubleEnter();
        // an exact code picks its highlighted row (the cheapest batch first); otherwise the highlighted row
        const exact = hitRows[hi]?.p.code.toLowerCase() === entry.q.trim().toLowerCase() ? hitRows[hi] : hitRows.find((r) => r.p.code.toLowerCase() === entry.q.trim().toLowerCase());
        const row = exact || hitRows[hi];
        if (row) return pick(row.p, row.b, row.damaged);
        if (entry.q.trim()) toast(`Nothing matches “${entry.q}”`, 'error');
        return;
      }
    }
    if (e.key === 'Enter' && !e.ctrlKey && id !== 'tCode') { e.preventDefault(); return id === 'tDis' ? commit() : focus(ORDER[i + 1]); }
    if (e.key === 'ArrowRight' && atEnd && i < ORDER.length - 1 && (id !== 'tCode' || cur)) { e.preventDefault(); return focus(ORDER[i + 1]); }
    if (e.key === 'ArrowLeft' && atStart && i > 0) { e.preventDefault(); return focus(ORDER[i - 1]); }
  };

  /* ---------- bill lines ---------- */
  const update = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const remove = (i) => { setLines((ls) => ls.filter((_, j) => j !== i)); setEdit(null); };
  const moveLine = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= lines.length) return;
    setLines((ls) => { const c = [...ls]; [c[i], c[j]] = [c[j], c[i]]; return c; });
    setSel(j);
  };
  // Space on a bill line: Qty · Price become editable in the row; ← → moves between them.
  const EDIT_ORDER = ['lnQty', 'lnPrice'];
  const startEdit = (i, field = 'lnQty') => {
    setSel(i);
    setEdit({ i, unit: lines[i].unit, qty: String(lines[i].qty), price: n(lines[i].price).toFixed(2) });
    focus(field);
  };
  const saveEdit = () => {
    if (!edit) return;
    const l = lines[edit.i];
    const p = byId[l.product_id];
    const qty = n(edit.qty);
    if (!qty) return toast('Quantity can\'t be 0 (put - in front for a return)', 'error');
    if (qty < 0 && n(l.qty) > 0) {
      const e = edit;
      return setAskReturn(() => (d) => { update(e.i, { unit: e.unit, qty, price: n(e.price), damaged: d, batch_id: d ? l.batch_id : l.batch_id }); setEdit(null); });
    }
    if (l.damaged && qty > 0 && p && qty * unitInfo(p, edit.unit).per > (p.damaged?.pcs || 0) - inBillDamaged(p.id, edit.i)) return toast(`Only ${pcsText((p.damaged?.pcs || 0) - inBillDamaged(p.id, edit.i))} damaged ${p.name} left`, 'error');
    update(edit.i, { unit: edit.unit, qty, price: n(edit.price) });
    setEdit(null);
  };
  const editKey = (e) => {
    const id = e.target.id;
    const i = EDIT_ORDER.indexOf(id);
    const el = e.target;
    const isInput = el.tagName === 'INPUT';
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'Enter') { stop(); return saveEdit(); }
    if (e.key === 'Escape') { stop(); return setEdit(null); }
    const atStart = !isInput || el.selectionStart === 0;
    const atEnd = !isInput || el.selectionEnd === el.value.length;
    if ((e.key === 'ArrowRight' && atEnd) || (e.key === 'Tab' && !e.shiftKey)) { stop(); return focus(EDIT_ORDER[Math.min(i + 1, EDIT_ORDER.length - 1)]); }
    if ((e.key === 'ArrowLeft' && atStart) || (e.key === 'Tab' && e.shiftKey)) { stop(); return focus(EDIT_ORDER[Math.max(i - 1, 0)]); }
  };
  // Enter twice quickly (with nothing being typed) = take payment
  const lastEnter = useRef(0);
  const doubleEnter = () => {
    const now = Date.now();
    if (now - lastEnter.current < 600) { lastEnter.current = 0; openPay(); return true; }
    lastEnter.current = now;
    return false;
  };

  /* ---------- totals ---------- */
  const T = useMemo(() => {
    let sub = 0, lineDisc = 0, cost = 0, pcs = 0;
    const avail = {};
    const noStock = new Map();
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      const p = byId[l.product_id];
      if (!p || n(l.qty) <= 0 || l.damaged) continue;
      const want = n(l.qty) * unitInfo(p, l.unit).per;
      const have = avail[p.id] ?? Math.max(0, p.stock_pcs);
      const take = Math.min(have, want);
      avail[p.id] = have - take;
      if (want > take) noStock.set(i, want - take);
    }
    const rows = lines.map((l, i) => {
      const p = byId[l.product_id];
      if (!p) return null;
      const b = batchOf(p.id, l.batch_id);
      const u0 = unitInfo(p, l.unit, b);
      const u = l.damaged ? { ...u0, cost: 0, costPc: 0, dmgCost: r2((p.damaged?.cost_per_pcs ?? u0.costPc) * u0.per) } : u0;
      const c = lineCalc(l);
      sub += c.gross; lineDisc += c.disc; cost += u.cost * n(l.qty); pcs += n(l.qty) * u.per;
      return { ...l, p, b, u, ...c, back: n(l.qty) < 0, under: n(l.qty) > 0 && u.cost > 0 && c.net < u.cost, noStock: noStock.get(i) || 0 };
    });
    const afterLines = sub - lineDisc;
    const bd = String(billDisc).trim().endsWith('%') ? (afterLines * n(String(billDisc).replace('%', ''))) / 100 : n(billDisc);
    const net = r2(afterLines - bd);
    return { rows, sub: r2(sub), lineDisc: r2(lineDisc), billDisc: r2(bd), net, cost: r2(cost), gp: r2(net - cost), pcs };
  }, [lines, byId, billDisc]);
  const owed = customer?.balance || 0;
  const overLimit = customer && customer.credit_limit > 0 && owed + T.net > customer.credit_limit;

  /* ---------- held bills ---------- */
  const snapshot = () => ({ label: customer?.name || 'Walk-in customer', summary: { lines: lines.length }, data: { lines, customerId, billDisc } });
  const clearBill = () => { setLines([]); setBillDisc(''); setCustomerId(null); setEntry(blankEntry); setSel(-1); setEdit(null); };
  const hold = async () => {
    if (!lines.length) return toast('Nothing on the bill to hold', 'error');
    try {
      await api.post('/held/bill', snapshot());
      toast(`Bill held for ${customer?.name || 'walk-in customer'} — F5 brings it back (on any computer)`);
      clearBill();
      loadHeld();
      toCode();
    } catch (e) { toast(e.message, 'error'); }
  };
  const resume = async (b) => {
    try {
      const got = await api.post(`/held/bill/${b.id}/take`, {});   // off the list for everyone
      if (lines.length) await api.post('/held/bill', snapshot());     // the bill on the screen is held in its place
      setLines(got.data.lines || []); setCustomerId(got.data.customerId ?? null); setBillDisc(got.data.billDisc || '');
      setModal(null);
      toCode();
    } catch (e) { toast(e.message, 'error'); }
    loadHeld();
  };
  const dropHeld = async (b) => {
    if (!confirm('Delete this held bill?')) return;
    try { await api.del(`/held/bill/${b.id}`); } catch (e) { toast(e.message, 'error'); }
    loadHeld();
  };

  /* ---------- finish ---------- */
  const complete = async (type, { paid, due } = {}) => {
    if (busy) return;
    if (!lines.length) return toast('The bill is empty', 'error');
    if (isAdmin(user) && T.rows.some((r) => r?.under) && !confirm('Some lines are priced BELOW cost. Continue?')) return;
    setBusy(true);
    try {
      const sale = await api.post('/sales', {
        customer_id: customerId, payment_type: type, discount: T.billDisc,
        paid_amount: type === 'credit' ? (T.net < 0 ? 0 : n(paid)) : T.net, due_date: type === 'credit' ? due : null,
        items: lines.map((l) => ({ product_id: l.product_id, batch_id: l.batch_id ?? null, batch_ids: batchOf(l.product_id, l.batch_id)?.ids || null, damaged: Boolean(l.damaged), unit: l.unit, qty: n(l.qty), price: n(l.price), disc_pct: n(l.disc_pct) })),
      });
      writeLS(LAST_KEY, sale.id);
      setDone({ sale, change: type === 'cash' && n(paid) > 0 ? r2(n(paid) - sale.total) : null });
      setModal(null);
      clearBill();
      localStorage.removeItem(DRAFT_KEY);
      loadProducts(); loadCustomers(); loadNo();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  /** Take payment: first ask Cash or Credit (Cash is the default). */
  const openPay = () => {
    if (!lines.length) return toast('The bill is empty', 'error');
    if (edit) saveEdit();
    setModal('paytype');
  };
  /** Credit is only for registered customers — never walk-in. */
  const openCredit = () => {
    if (!lines.length) return toast('The bill is empty', 'error');
    if (!customer) {
      setAfter('credit');
      setModal('customer-credit');   // the pop-up itself explains that walk-in customers can't buy on credit
      return;
    }
    setModal('credit');
  };
  /** Over the limit: the Super Admin raises it, then the bill goes through. */
  const raiseLimitAndBill = async (newLimit, paid, due) => {
    try {
      const c = await api.put(`/customers/${customer.id}/credit-limit`, { credit_limit: newLimit, reason: `to bill Rs ${money(T.net)} on credit` });
      setCustomers((cs) => cs.map((x) => (x.id === c.id ? { ...x, ...c } : x)));
      toast(`Credit limit for ${custName(customer)} raised to ${lkr(newLimit)}`);
      await complete('credit', { paid, due });
    } catch (e) { toast(e.message, 'error'); }
  };
  const [reprinting, setReprinting] = useState(null);   // the last bill, to print again
  const reprint = () => {
    const id = readLS(LAST_KEY, null);
    if (!id) return toast('No bill made on this computer yet', 'error');
    api.get(`/sales/${id}`).then(setReprinting).catch((e) => toast(e.message, 'error'));
  };

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'F3') {
        e.preventDefault(); e.stopPropagation();
        if (priceHist) return setPriceHist(null);
        if (document.querySelector('.modal')) return;
        // the product being added, else the line picked on the bill, else the last line
        const line = sel >= 0 ? lines[sel] : lines[lines.length - 1];
        const p = cur || (line ? byId[line.product_id] : null);
        if (!p) return toast('Scan or pick a product first — F3 shows what it was sold for before', 'error');
        return setPriceHist({ product: p });
      }
      if (document.querySelector('.modal')) return;
      const k = e.key;
      const typing = typingIn(document.activeElement);
      const take = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (k === '`' || e.code === 'Backquote') return take(() => setShowCost((s) => !s));
      if (k === 'F1') return take(toCode);
      if (k === 'F4') return take(() => { setAfter(null); setModal('customer'); });
      if (k === 'F5' || (e.ctrlKey && k.toLowerCase() === 'r')) return take(() => { loadHeld(); setModal('held'); });
      if (k === 'F7' || (e.ctrlKey && k.toLowerCase() === 'h')) return take(hold);
      if (k === 'F8') return take(() => focus('tBillDisc'));
      if (k === 'F10') return take(openPay);
      if (k === 'F12') return take(reprint);
      if (e.ctrlKey && k === 'Delete') return take(() => { if (lines.length && confirm('Clear this bill?')) clearBill(); });
      if (k === '?' && !typing) return take(() => setModal('keys'));
      if (k === 'Enter' && !typing && sel < 0 && !e.ctrlKey) return take(doubleEnter);
      if (sel >= 0 && !typing && lines[sel] && !edit) {
        if (k === 'ArrowDown') return take(() => (e.ctrlKey ? moveLine(sel, 1) : setSel(Math.min(sel + 1, lines.length - 1))));
        if (k === 'ArrowUp') return take(() => (e.ctrlKey ? moveLine(sel, -1) : sel === 0 ? toCode() : setSel(sel - 1)));
        if (k === ' ') return take(() => startEdit(sel, 'lnQty'));
        if (k === 'Enter') return take(doubleEnter);
        if (k.toLowerCase() === 'p') return take(() => startEdit(sel, 'lnPrice'));
        if (k === '+' || k === '=') return take(() => update(sel, { qty: n(lines[sel].qty) < 0 ? n(lines[sel].qty) - 1 : n(lines[sel].qty) + 1 }));
        if (k === '-') return take(() => update(sel, { qty: n(lines[sel].qty) < 0 ? Math.min(-1, n(lines[sel].qty) + 1) : Math.max(1, n(lines[sel].qty) - 1) }));
        if (k === 'Delete' || k === 'Backspace') return take(() => remove(sel));
        if (k === 'Escape') return take(toCode);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!products) return <Loading />;

  const eu = cur ? unitInfo(cur, entry.unit, curB) : null;
  const eAmt = lineCalc(entry).amount;
  const eUnder = cur && eu.cost > 0 && lineCalc(entry).net < eu.cost;

  // the products that match what is typed (code or name; * lists all)
  const hitList = hitRows.length > 0 && (
      <div className="till-hits">
        <table>
          <thead><tr><th>CODE</th><th>ITEM</th><th>STOCK FROM</th><th>SIZES</th><th className="n">IN STOCK</th>{showCost && <th className="n">COST / PC</th>}<th className="n">EXPECTED / PC</th></tr></thead>
          <tbody>
            {hitRows.map(({ p, b, tier, damaged }, i) => {
              if (damaged) {
                return (
                  <tr key={`${p.id}-dmg`} className={`${i === hi ? 'on' : ''} batch dmg`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(p, null, true); }}>
                    <td className="c">{p.code}</td>
                    <td className="d">{p.name} <span className="cost-code hit-code">{codeOf(p.damaged, p.damaged.cost_per_pcs, settings)}</span> <span className="dmg-badge">Damaged</span></td>
                    <td className="s">Damaged returns</td>
                    <td className="s">{p.sizes || '—'}</td>
                    <td className="n">{pcsText(p.damaged.pcs)}</td>
                    {showCost && <td className="n cost">{money(p.damaged.cost_per_pcs)}</td>}
                    <td className="p">sell under cost</td>
                  </tr>
                );
              }
              const u = unitInfo(p, 'pcs', b);
              const stock = b ? b.left_pcs : p.stock_pcs;
              const many = groupsOf(p).length > 1;
              return (
                <tr key={`${p.id}-${b?.id ?? 0}`} className={`${i === hi ? 'on' : ''} ${many ? 'batch' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(p, b); }}>
                  <td className="c">{p.code}</td>
                  <td className="d">{p.name} <span className="cost-code hit-code">{codeOf(b || p, u.costPc, settings)}</span>{tier && <> <CostBadge tier={tier} /></>}</td>
                  <td className="s">{many ? batchText(b) : p.category || '—'}</td>
                  <td className="s">{p.sizes || '—'}</td>
                  <td className={`n ${stock <= 0 ? 'neg' : !many && stock < p.reorder_sets * p.pcs_per_set ? 'low' : ''}`}>{stock < 0 ? `−${pcsText(-stock)}` : stock === 0 ? 'none' : pcsText(stock)}</td>
                  {showCost && <td className="n cost">{money(u.costPc)}</td>}
                  <td className="p">{money(u.expectedPc)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
  );

  return (
    <div className={`till ${lines.length ? 'has-lines' : ''}`}>
      {/* ================= HEADER BAND ================= */}
      <div className="till-head">

        <div className={`till-who ${customer ? 'named' : ''}`} role="button" onClick={() => { setAfter(null); setModal('customer'); }} title="Change customer (F4)">
          <b>{customer ? custName(customer).toUpperCase() : 'WALK-IN CUSTOMER'}</b>
          <em>{customer
            ? <>{custPerson(customer) ? `${custPerson(customer)} · ` : ''}{customer.phone || 'no phone'} · due {money(owed)}{customer.credit_limit > 0 ? ` of ${money(customer.credit_limit)}` : ''}{overLimit ? ' · OVER LIMIT' : ''}</>
            : narrow ? 'no account · tap to choose' : 'no account · press F4 to choose'}</em>
          <span>cashier <b>{user.name}</b></span>
          <span className="till-whobtn">{customer ? 'Change' : 'Choose'} customer <i>F4</i></span>
        </div>

        {/* phones: the bill's buttons beside the customer (the summary at the bottom is not shown on a phone) */}
        {narrow && (
          <div className="head-acts">
            <button onClick={hold} disabled={!lines.length}><Icon name="pause" size={16} /><span>Hold</span></button>
            <button onClick={() => { loadHeld(); setModal('held'); }}><Icon name="clock" size={16} /><span>Held</span>{held.length > 0 && <b className="count-dot">{held.length}</b>}</button>
            <button onClick={() => { if (!lines.length || confirm('Clear this bill?')) clearBill(); }} disabled={!lines.length && !customerId}><Icon name="trash" size={16} /><span>Clear</span></button>
            <button onClick={reprint}><Icon name="print" size={16} /><span>Last bill</span></button>
          </div>
        )}

        <div className="till-date">
          <div><b>{now.toLocaleDateString('en-GB', { weekday: 'long' })}</b> <span>{now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          <div className="till-clock">{now.toLocaleTimeString('en-GB', { hour12: true })}</div>
        </div>
        <div className="till-no">
          <span>BILL NO</span>
          <b>{nextNo || '—'}</b>
          {seeCost && <button className={`till-gp ${showCost ? 'on' : ''}`} onClick={() => setShowCost((s) => !s)} title="Show / hide cost and profit ( ` key )">
            <Icon name={showCost ? 'eye' : 'eyeOff'} size={12} /> {showCost ? 'COST SHOWN' : 'COST HIDDEN'} <kbd>`</kbd>
          </button>}
        </div>
      </div>

      {/* ================= ENTRY ROW ================= */}
      <div className={`till-entry ${cur ? 'live' : ''}`}>
        <label className="f-code"><span>SCAN / INPUT CODE <i>F1</i></span>
          <input id="tCode" ref={codeRef} autoFocus autoComplete="off" placeholder="code or name · * lists all" value={entry.q}
            onChange={(e) => { setEntry({ ...blankEntry, q: e.target.value }); setHi(0); }} onKeyDown={entryKey('tCode')} onFocus={() => setSel(-1)} />
        </label>
        {narrow && hitList && <div className="till-hitwrap mobile">{hitList}</div>}
        <div className="f-item"><span>ITEM</span>
          <div className={`till-item ${cur ? 'has' : ''}`}>
            {cur ? <>
              <b>{cur.name.toUpperCase()}</b>
              <em>{cur.code}{cur.sizes ? ` · ${cur.sizes}` : ''}{curB && groupsOf(cur).length > 1 ? ` · ${batchText(curB)}` : ''} · stock {freePcs(cur, curB) > 0 ? pcsText(freePcs(cur, curB)) : 'none — sells without stock'}</em>
            </> : <i>{narrow ? 'search above, then tap a product' : 'scan or key a code — F1'}</i>}
          </div>
        </div>
        <label className="f-qty"><span>QTY (PCS)</span>
          <input id="tQty" inputMode="decimal" autoComplete="off" value={entry.qty} {...selectAll}
            onChange={(e) => setEntry({ ...entry, qty: e.target.value.replace(/[^\d.-]/g, '').replace(/(?!^)-/g, '') })} onKeyDown={entryKey('tQty')} />
        </label>
        {showCost && <div className="f-ro"><span>COST</span><div className="till-ro cost">{cur ? money(eu.cost) : '—'}</div></div>}
        <div className="f-ro"><span>EXPECTED</span>
          <div className="till-ro click exp" onClick={() => cur && setEntry({ ...entry, price: eu.expected.toFixed(2) })} title="Use the expected price">{cur ? money(eu.expected) : '—'}</div></div>
        <label className="f-price"><span>LAST PRICE</span>
          <input id="tPrice" className={eUnder && showCost ? 'under' : ''} inputMode="decimal" autoComplete="off" value={entry.price} {...selectAll}
            onChange={(e) => setEntry({ ...entry, price: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={entryKey('tPrice')} />
        </label>
        <label className="f-dis"><span>DIS %</span>
          <input id="tDis" inputMode="decimal" autoComplete="off" value={entry.disc_pct} placeholder="0" {...selectAll}
            onChange={(e) => setEntry({ ...entry, disc_pct: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={entryKey('tDis')} />
        </label>
        <div className="f-amt"><span>AMOUNT</span><div className={`till-amt ${eUnder && showCost ? 'under' : ''}`}>{cur ? money(eAmt) : '0.00'}</div></div>
        <button className="till-add" onClick={() => commit()} disabled={!cur}><span className="ta-plus">+</span>ADD<i>Enter</i></button>
      </div>

      {/* ================= MATCH LIST (on a phone it is right under the code box) ================= */}
      {!narrow && <div className="till-hitwrap">{hitList}</div>}

      {/* ================= BILL + SUMMARY ================= */}
      <div className="till-main">
        <div className="till-lines" ref={billRef}>
          <table className="till-tbl">
            <thead><tr><th className="c">#</th><th className="c">CODE</th><th>ITEM</th><th className="n">QTY (PCS)</th><th className="n">EXPECTED</th><th className="n">PRICE</th><th className="n">DIS</th><th className="n">AMOUNT</th><th className="x"></th></tr></thead>
            <tbody>
              {T.rows.length === 0 && <tr><td colSpan={9} className="till-empty">Scan or key an item code above. The newest line sits at the top.</td></tr>}
              {T.rows.map((r, i) => r && (
                <tr key={i} className={`${i === sel ? 'on' : ''} ${edit?.i === i ? 'editing' : ''} ${r.back ? 'return' : ''}`} onClick={(e) => { if (!typingIn(e.target) && e.target.tagName !== 'BUTTON') { setSel(i); document.activeElement?.blur(); } }}>
                  <td className="c">{T.rows.length - i}</td>
                  <td className="c">{r.p.code}</td>
                  <td className="d">
                    <b>{r.p.name.toUpperCase()}</b>
                    <em>{r.p.sizes ? `${r.p.sizes} · ` : ''}{r.b && groupsOf(r.p).length > 1 ? `${batchText(r.b)} · ` : ''}{showCost ? `cost ${money(r.u.costPc)} · ` : ''}code <span className="cost-code">{r.damaged ? codeOf(r.p.damaged, r.u.dmgCost / r.u.per, settings) : codeOf(r.b || r.p, r.u.costPc, settings)}</span> · expected {money(r.u.expectedPc)}</em>
                    {r.back && !r.damaged && <span className="tag return">RETURN · back to stock</span>}
                    {r.back && r.damaged && <span className="tag damaged">RETURN · DAMAGED — not to stock</span>}
                    {!r.back && r.damaged && <span className="tag damaged">DAMAGED · cost written off</span>}
                    {r.noStock > 0 && <span className="tag nostock" title="More than the stock shows — kept at the last GRN cost; the Super Admin is told">SOLD WITHOUT STOCK · {pcsText(r.noStock)}</span>}
                    {showCost && r.under && <span className="tag bad">under cost</span>}
                  </td>
                  <td className="n q">{edit?.i === i
                    ? <input id="lnQty" className="ln-in" inputMode="decimal" value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} onKeyDown={editKey} {...selectAll} />
                    : <b>{r.qty}</b>}</td>
                  <td className="n mrp">{money(r.u.expected)}</td>
                  <td className={`n pr ${showCost && r.under ? 'under' : ''}`}>{edit?.i === i
                    ? <input id="lnPrice" className="ln-in" inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} onKeyDown={editKey} {...selectAll} />
                    : money(r.price)}
                    {showCost && edit?.i !== i && <em className={r.under ? 'loss' : ''}>{pct(margin(r.net, r.u.cost))}</em>}</td>
                  <td className={`n ds ${r.disc ? '' : 'no-disc'}`}>{r.disc ? <><b>{r.disc_pct}%</b><em>{money(r.disc)}</em></> : '—'}</td>
                  <td className="n am"><b>{money(r.amount)}</b></td>
                  <td className="x">{edit?.i === i ? <>
                    <button className="ln-ok" onClick={saveEdit} title="Keep (Enter)">✓</button>
                    <button className="ln-no" onClick={() => setEdit(null)} title="Cancel (Esc)">✕</button>
                  </> : <>
                    <button onClick={() => startEdit(i)} title="Edit qty / price (Space)">✎</button>
                    <button onClick={() => remove(i)} title="Remove (Delete)">✕</button>
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="till-sum">
          <div className="sum-top"><span>INVOICE SUMMARY</span><b>{lines.length} item{lines.length === 1 ? '' : 's'} · {T.pcs} pcs</b></div>
          <div className="sum-block">
            <div className="sum-line"><span>Sub total</span><b>{money(T.sub)}</b></div>
            <div className={`sum-line ${T.lineDisc ? 'off' : ''}`}><span>Line discounts</span><b>{T.lineDisc ? `− ${money(T.lineDisc)}` : '0.00'}</b></div>
            <div className="sum-line edit"><span>Bill discount <i>F8</i></span>
              <input id="tBillDisc" value={billDisc} placeholder="0 or 5%" {...selectAll} onChange={(e) => setBillDisc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); toCode(); } }} /></div>
            {T.sub > 0 && (T.lineDisc || T.billDisc) > 0 && <div className="sum-line faint"><span>Total discount</span><b>{(((T.lineDisc + T.billDisc) / T.sub) * 100).toFixed(2)}%</b></div>}
          </div>
          <div className="sum-net"><span>NET TOTAL</span><b>{money(T.net)}</b></div>
          {showCost && lines.length > 0 && <div className={`sum-gp ${T.gp < 0 ? 'neg' : ''}`}><span>GP</span><b>{money(T.gp)}</b><i>{pct(margin(T.net, T.cost))}</i></div>}
          {overLimit && <div className="sum-over">Over their limit — due {money(owed)} of {money(customer.credit_limit)}. To bill on credit, the Super Admin must raise the limit.{customer.cheques_pending > 0 ? ` Their cheques of ${money(customer.cheques_pending)} count only once passed (Cheque Desk).` : ''}</div>}
          <div className="sum-acts">
            <button className="sum-pay" onClick={openPay} disabled={!lines.length}><b>TAKE PAYMENT</b><span>{lkr(T.net)} · Enter Enter · cash or credit</span></button>
            <div className="sum-more">
              <button onClick={hold} disabled={!lines.length}>Hold bill <i>F7</i></button>
              <button onClick={() => { loadHeld(); setModal('held'); }}>Held bills{held.length > 0 && <b className="count-dot">{held.length}</b>} <i>F5</i></button>
              <button onClick={() => { if (!lines.length || confirm('Clear this bill?')) clearBill(); }} disabled={!lines.length && !customerId}>Clear bill <i>Ctrl+Del</i></button>
              <button onClick={reprint}>Last bill <i>F12</i></button>
              <button onClick={() => setModal('keys')}>All keys <i>?</i></button>
            </div>
          </div>
        </div>
      </div>

      {/* ================= POP-UPS ================= */}
      {askReturn && (
        <ReturnKind onChoose={(d) => { const go = askReturn; setAskReturn(null); go(d); }} onClose={() => { setAskReturn(null); focus('tQty'); }} />
      )}
      {(modal === 'customer' || modal === 'customer-credit') && (
        <CustomerPicker customers={customers} current={customerId} creditOnly={modal === 'customer-credit'}
          onPick={(id) => { setCustomerId(id); setModal(after === 'credit' && id ? 'credit' : null); setAfter(null); if (after !== 'credit' || !id) toCode(); }}
          onNew={(name) => setModal({ newCustomer: name })} onClose={() => { setModal(null); setAfter(null); toCode(); }} />
      )}
      {modal?.newCustomer != null && (
        <CustomerForm initialName={modal.newCustomer}
          onClose={() => { if (after === 'credit') setModal('customer-credit'); else { setModal(null); toCode(); } }}
          onSaved={(c) => { setCustomers((cs) => [...cs, { ...c, balance: c.opening_balance || 0 }]); setCustomerId(c.id); setModal(after === 'credit' ? 'credit' : null); setAfter(null); }} />
      )}
      {modal === 'paytype' && (
        <PayTypeModal total={T.net} customer={customer} onClose={() => { setModal(null); toCode(); }}
          onChoose={(type) => (type === 'cash' ? setModal('pay') : openCredit())} />
      )}
      {modal === 'pay' && <PayModal total={T.net} busy={busy} onClose={() => { setModal(null); toCode(); }} onPay={(received) => complete('cash', { paid: received })} />}
      {modal === 'credit' && customer && (
        <CreditModal customer={customer} total={T.net} busy={busy} canRaise={isSuper(user)} onClose={() => { setModal(null); toCode(); }}
          onConfirm={(paid, due) => complete('credit', { paid, due })}
          onRaise={(newLimit, paid, due) => raiseLimitAndBill(newLimit, paid, due)}
          onChangeCustomer={() => { setAfter('credit'); setModal('customer-credit'); }} />
      )}
      {modal === 'held' && (
        <Modal title="Held bills" onClose={() => { setModal(null); toCode(); }}>
          <HeldBills held={held} onResume={resume} onDelete={dropHeld} />
        </Modal>
      )}
      {modal === 'keys' && (
        <Modal title="Billing keys" onClose={() => { setModal(null); toCode(); }}>
          <div className="keys-grid">{POS_KEYS.map(([k, l]) => <div key={k} className="key-row"><kbd>{k}</kbd><span>{l}</span></div>)}</div>
          <p className="muted small mt">Anywhere in the app: <kbd>F2</kbd> Dashboard · <kbd>F9</kbd> Bills · <kbd>F7</kbd> Take a payment</p>
        </Modal>
      )}
      {priceHist && <PriceHistoryModal product={priceHist.product} customer={customer}
        onUse={cur && cur.id === priceHist.product.id ? (price) => { setEntry((x) => ({ ...x, price: Number(price).toFixed(2) })); setPriceHist(null); focus('tPrice'); } : null}
        onClose={() => setPriceHist(null)} />}
      {/* phones: Take Payment always one tap away */}
      {narrow && lines.length > 0 && !modal && (
        <button className="pay-bar" onClick={openPay}>
          <span className="pb-left"><b>TAKE PAYMENT</b><small>{lines.length} item{lines.length === 1 ? '' : 's'} · {T.pcs} pcs</small></span>
          <span className="pb-total">{lkr(T.net)}</span>
        </button>
      )}
      {reprinting && <PrintChoiceModal sale={reprinting} onClose={() => { setReprinting(null); toCode(); }} />}
      {done && (
        <DoneModal sale={done.sale} change={done.change} onClose={() => { setDone(null); toCode(); }}
          onView={() => navigate(`/sales/${done.sale.id}`)} footer={settings.invoice_footer} />
      )}
    </div>
  );
}

/* ---------------- held bills: ↑ ↓ to pick, Enter to carry on, Delete to remove ---------------- */
function HeldBills({ held, onResume, onDelete }) {
  const phone = usePhone();
  const [hi, setHi] = useListKeys(held.length, { onEnter: (i) => onResume(held[i]), onDelete: (i) => onDelete(held[i]) });
  if (!held.length) return <p className="muted">No bills on hold.</p>;
  return (
    <>
      <div className="stack-s key-list">{held.map((b, idx) => (
        <div key={b.id} className={`held-row ${idx === hi ? 'on' : ''}`} onMouseEnter={() => setHi(idx)} onClick={() => onResume(b)} role="button" title="Carry on with this bill">
          <span className="held-no">{idx + 1}</span>
          <div className="spacer"><div className="strong">{b.label}</div>
            <div className="muted small">{b.lines.length} lines · {new Date(b.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · by {b.by}</div></div>
          <b className="mono">{lkr(b.lines.reduce((s, l) => s + lineCalc(l).amount, 0))}</b>
          <button className="btn btn-sm btn-icon btn-ghost" tabIndex={-1} title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(b); }}><Icon name="trash" size={15} /></button>
        </div>))}
      </div>
      {!phone && <p className="muted small mt-s"><kbd>↑</kbd> <kbd>↓</kbd> to pick · <kbd>Enter</kbd> to carry on · <kbd>Delete</kbd> to remove · <kbd>Esc</kbd> to close</p>}
    </>
  );
}

/* ---------------- a return: normal or damaged? ---------------- */
/** ← → picks Normal or Damaged, Enter chooses it (the highlighted one), Esc goes back. */
export function ReturnKind({ onChoose, onClose }) {
  const [sel, setSel] = useState(0);   // 0 = normal, 1 = damaged
  const phone = usePhone();
  const refs = [useRef(), useRef()];
  const opened = useRef(Date.now());   // an Enter still held from adding the line doesn't choose
  useEffect(() => { refs[sel].current?.focus(); }, [sel]);   // eslint-disable-line
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); setSel(e.key === 'ArrowLeft' ? 0 : 1); }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        if (e.repeat || Date.now() - opened.current < 350) return;
        onChoose(document.activeElement === refs[1].current);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onChoose]); // eslint-disable-line
  return (
    <Modal size="sm" title="What kind of return is this?" subtitle={phone ? 'Tap one' : '← → to pick · Enter to choose'} onClose={onClose}>
      <div className="return-kinds">
        <button type="button" ref={refs[0]} className={`return-kind normal ${sel === 0 ? 'on' : ''}`} onFocus={() => setSel(0)} onClick={() => onChoose(false)}>
          <b>Normal return</b><small>In good condition — goes back into the stock</small>
        </button>
        <button type="button" ref={refs[1]} className={`return-kind damaged ${sel === 1 ? 'on' : ''}`} onFocus={() => setSel(1)} onClick={() => onChoose(true)}>
          <b>Damaged return</b><small>Kept apart as damaged stock — its cost is counted as a loss</small>
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- customer picker (F4) ---------------- */
function CustomerPicker({ customers, current, creditOnly, onPick, onNew, onClose }) {
  const phone = usePhone();
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const found = customers.filter((c) => !s || `${c.name} ${c.shop_name || ''} ${c.phone || ''} ${c.city || ''}`.toLowerCase().includes(s));
    // credit bills are never for walk-in customers
    return (creditOnly ? found : [{ id: null, name: 'Walk-in customer', walk: true }, ...found]).slice(0, 40);
  }, [customers, q, creditOnly]);
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    if (e.key === 'Enter') { e.preventDefault(); const c = list[Math.min(hi, list.length - 1)]; if (c) onPick(c.id); }
  };
  return (
    <Modal title={creditOnly ? 'Who is this credit bill for?' : 'Choose customer'} subtitle={phone ? 'Type a shop, name, phone or town — tap to choose' : 'Type a shop, name, phone or town · ↑ ↓ · Enter'} onClose={onClose}
      footer={<>
        <button className="btn btn-primary" onClick={() => onNew(q.trim())} style={{ marginRight: 'auto' }}>
          <Icon name="plus" size={16} /> {q.trim() ? `Add customer “${q.trim()}”` : 'Add customer'}
        </button>
        <button className="btn" onClick={onClose}>Close</button>
      </>}>
      {creditOnly && <div className="alert alert-amber small mb"><Icon name="info" size={16} /> Credit is only for registered customers — walk-in customers must pay cash.</div>}
      <input className="input input-lg" autoFocus placeholder="Search customer…" value={q} onChange={(e) => { setQ(e.target.value); setHi(creditOnly ? 0 : 1); }} onKeyDown={key} />
      <div className="pick-list">
        {list.length === 0 && <p className="muted center mt">No customer found — add them with the button below.</p>}
        {list.map((c, i) => (
          <button key={c.id ?? 'walk'} className={`pick-row ${i === hi ? 'on' : ''} ${c.id === current ? 'cur' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => onPick(c.id)}>
            <span><b>{c.walk ? c.name : custName(c)}</b>{!c.walk && <small>{[custPerson(c), c.city, c.phone].filter(Boolean).join(' · ')}</small>}</span>
            {!c.walk && <span className="right">{c.balance > 0 ? <b className="text-red">due {money(c.balance)}</b> : <small>no dues</small>}{c.credit_limit > 0 && <small>limit {money(c.credit_limit)}</small>}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------- take payment (F10) ---------------- */
function PayModal({ total, busy, onPay, onClose }) {
  const phone = usePhone();
  const [got, setGot] = useState('');
  const settled = useSettled();
  const done = useRef(false);   // one bill per pop-up, however many times the button is pressed
  useEffect(() => { if (!busy) done.current = false; }, [busy]);   // a save that failed can be tried again
  const pay = (v) => { if (!settled() || done.current) return; done.current = true; onPay(v); };
  // returns worth more than the sale: give the money back — the button is pressed on purpose (it does not take the focus)
  if (total < 0) {
    return (
      <Modal size="sm" title="Refund — cash" onClose={onClose}
        footer={<><button className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" disabled={busy} onClick={() => pay(total)} onKeyDown={noHeldEnter}><Icon name="check" /> {busy ? 'Saving…' : 'Refund & finish'}</button></>}>
        <div className="stack">
          <div className="pay-total refund"><span>Give back to the customer</span><b>{lkr(-total)}</b></div>
          <p className="muted small">The returned pieces go back into stock, and the bill is saved as a cash refund.</p>
        </div>
      </Modal>
    );
  }
  const change = n(got) - total;
  const go = (e) => { e.preventDefault(); if (n(got) && change < 0) return; pay(n(got) || total); };
  return (
    <Modal size="sm" title="Take payment — cash" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" form="pay-form" disabled={busy || (n(got) > 0 && change < 0)}><Icon name="check" /> {busy ? 'Saving…' : phone ? 'Finish bill' : 'Finish bill (Enter)'}</button></>}>
      <form id="pay-form" className="stack" onSubmit={go} onKeyDown={noHeldEnter}>
        <div className="pay-total"><span>To pay</span><b>{lkr(total)}</b></div>
        <Field label="Cash received" hint="Leave empty if they paid the exact amount">
          <NumInput className="input-lg" autoFocus value={got} onChange={setGot} placeholder={money(total)} />
        </Field>
        <div className="row gap-s wrap">
          {[total, Math.ceil(total / 100) * 100, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000, Math.ceil(total / 5000) * 5000]
            .filter((v, i, a) => a.indexOf(v) === i).map((v) => <button type="button" key={v} className="chip" onClick={() => setGot(String(v))}>{money(v)}</button>)}
        </div>
        <div className={`pay-change ${n(got) && change < 0 ? 'short' : ''}`}>
          <span>{n(got) && change < 0 ? 'Still short' : 'Balance to give'}</span><b>{n(got) ? lkr(Math.abs(change)) : '—'}</b>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Payment pop-ups finish a bill on Enter. An Enter from before the pop-up opened (the Enter Enter that opened
 * payment, or a key held down) must never finish it: for a moment after opening, and for a held key, Enter is ignored.
 */
const SETTLE_MS = 700;
function useSettled() {
  const opened = useRef(Date.now());
  return () => Date.now() - opened.current > SETTLE_MS;
}
/** onKeyDown for a pay pop-up: swallow a held-down Enter (it would press the finish button again and again). */
const noHeldEnter = (e) => { if (e.key === 'Enter' && e.repeat) { e.preventDefault(); e.stopPropagation(); } };

/* ---------------- take payment: cash or credit? ---------------- */
function PayTypeModal({ total, customer, onChoose, onClose }) {
  const [type, setType] = useState('cash');   // cash is the default
  const phone = usePhone();   // a phone: tapping Cash or Credit goes on straight away
  const boxRef = useRef();
  // Keys are read from the pop-up itself (it takes the focus), never from the window — so the Enter
  // that opened it can't also answer it.
  useEffect(() => { boxRef.current?.focus(); }, []);
  const onKey = (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.key)) { e.preventDefault(); setType((t) => (t === 'cash' ? 'credit' : 'cash')); }
    else if (e.key === '1' || e.key.toLowerCase() === 'c') { e.preventDefault(); setType('cash'); }
    else if (e.key === '2' || e.key.toLowerCase() === 'r') { e.preventDefault(); setType('credit'); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) onChoose(type); }
  };
  return (
    <Modal size="sm" title={total < 0 ? 'Refund' : 'Take payment'} subtitle={total < 0 ? `${lkr(-total)} to give back · how?` : `${lkr(total)} · how is the customer paying?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Back</button>{!phone && <button className="btn btn-primary" onClick={() => onChoose(type)}><Icon name="arrowRight" /> Continue (Enter)</button>}</>}>
      <div className="paytype" ref={boxRef} tabIndex={-1} onKeyDown={onKey} role="radiogroup" aria-label="Payment type">
        <button tabIndex={-1} className={`pt-card ${type === 'cash' ? 'on' : ''}`} onClick={() => (phone ? onChoose('cash') : setType('cash'))} onDoubleClick={() => onChoose('cash')}>
          <span className="pt-icon"><Icon name="cash" size={24} /></span>
          <b>Cash</b><small>{total < 0 ? 'Give the money back now' : 'Paid now in full'}</small><kbd>1</kbd>
        </button>
        <button tabIndex={-1} className={`pt-card credit ${type === 'credit' ? 'on' : ''}`} onClick={() => (phone ? onChoose('credit') : setType('credit'))} onDoubleClick={() => onChoose('credit')}>
          <span className="pt-icon"><Icon name="clock" size={24} /></span>
          <b>{total < 0 ? 'To account' : 'Credit'}</b><small>{total < 0 ? (customer ? `Off what ${custName(customer)} owes` : 'Registered customers only') : customer ? `On ${custName(customer)}'s account` : 'Registered customers only'}</small><kbd>2</kbd>
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- on account (credit) ---------------- */
function CreditModal({ customer, total, busy, canRaise, onConfirm, onRaise, onChangeCustomer, onClose }) {
  const phone = usePhone();
  const key = phone ? '' : ' (Enter)';
  const [paid, setPaid] = useState('');
  const [due, setDue] = useState(addDays(today(), customer.credit_days || 0));
  const [raising, setRaising] = useState(false);
  const refund = total < 0;   // returns worth more than the sale: the money stays on the customer's account
  const after = r2(customer.balance + total - (refund ? 0 : n(paid)));
  const over = customer.credit_limit > 0 && after > customer.credit_limit;
  const suggested = Math.ceil(after / 1000) * 1000;
  const [newLimit, setNewLimit] = useState(String(suggested));
  useEffect(() => { if (!raising) setNewLimit(String(suggested)); }, [suggested, raising]);

  const settled = useSettled();
  const done = useRef(false);   // one bill per pop-up
  useEffect(() => { if (!busy) done.current = false; }, [busy]);   // a save that failed can be tried again
  const submit = (e) => {
    e.preventDefault();
    if (!settled() || done.current) return;
    if (!over) { done.current = true; return onConfirm(paid, due); }
    if (!raising) return setRaising(true);
    if (n(newLimit) < after) return;
    onRaise(n(newLimit), paid, due);
  };
  return (
    <Modal size="sm" title={refund ? `Return to account — ${custName(customer)}` : `On account — ${custName(customer)}`} subtitle={custPerson(customer) || ''} onClose={onClose}
      footer={<>
        <button className="btn" onClick={raising ? () => setRaising(false) : onClose}>Back</button>
        <button className="btn btn-primary" form="credit-form" disabled={busy || (raising && n(newLimit) < after)}>
          <Icon name={over ? 'shield' : 'check'} /> {busy ? 'Saving…' : `${refund ? 'Credit to account' : !over ? 'Put on account' : raising ? 'Raise limit & bill' : 'Raise credit limit…'}${key}`}
        </button>
      </>}>
      <form id="credit-form" className="stack" onSubmit={submit} onKeyDown={noHeldEnter}>
        {refund
          ? <div className="pay-total refund"><span>Comes off what they owe</span><b>{lkr(-total)}</b></div>
          : <div className="pay-total amber"><span>This bill</span><b>{lkr(total)}</b></div>}
        <div className="row gap-s small">
          <span className="muted">Customer:</span> <b>{custName(customer)}</b>
          <button type="button" className="link-btn" style={{ marginLeft: 'auto' }} onClick={onChangeCustomer}>Change customer</button>
        </div>
        {!raising && !refund && (
          <div className="grid grid-2">
            <Field label="Paid now (advance)"><NumInput autoFocus value={paid} onChange={setPaid} placeholder="0.00" /></Field>
            <Field label="Payment due on"><DateInput value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
        )}
        <dl className="kv">
          <dt>Due now</dt><dd>{lkr(customer.balance)}{customer.cheques_pending > 0 && <div className="sub muted">incl. {lkr(customer.cheques_pending)} in cheques not passed yet</div>}</dd>
          <dt>{refund ? 'Due after this return' : 'Due after this bill'}</dt><dd className={over ? 'text-red' : ''}>{lkr(after)}</dd>
          <dt>Credit limit</dt><dd>{customer.credit_limit > 0 ? lkr(customer.credit_limit) : 'No limit set'}</dd>
        </dl>
        {over && !raising && (
          <div className="alert alert-red small"><Icon name="alert" size={16} />
            <span>This bill takes {custName(customer)} <b>{lkr(after - customer.credit_limit)}</b> over the credit limit. To bill it on credit, the credit limit must be increased{canRaise ? '' : ' with the Super Admin password'}.</span>
          </div>
        )}
        {raising && (
          <div className="limit-box">
            <div className="row gap-s"><Icon name="shield" /> <b>Increase credit limit</b></div>
            <Field label="New credit limit (Rs)" hint={`At least ${lkr(after)} to bill this · current limit ${lkr(customer.credit_limit)}`}>
              <NumInput className="input-lg" autoFocus value={newLimit} onChange={setNewLimit} />
            </Field>
            {!canRaise && <p className="muted small">After you press Enter, the Super Admin types their password to approve the new limit. The bill is then saved.</p>}
          </div>
        )}
      </form>
    </Modal>
  );
}

/* ---------------- F3: what the product was sold for before (to this customer, or to anyone) ---------------- */
export function PriceHistoryModal({ product, customer, onUse, onClose }) {
  const phone = usePhone();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api.get(`/sales/price-history?product_id=${product.id}${customer ? `&customer_id=${customer.id}` : ''}`).then(setData).catch((e) => setError(e.message));
  }, [product.id, customer?.id]);
  const lines = data?.lines || [];
  const [hi, setHi] = useListKeys(lines.length, { onEnter: (i) => onUse?.(lines[i].per_pcs) });
  return (
    <Modal size="lg" title={`Price history — ${product.code}`} onClose={onClose}
      subtitle={<>{product.name} · {customer ? <b>{custName(customer)}</b> : <span><b>Walk-in customer</b> — walk-in sales first, then registered customers</span>}</>}
      footer={<><span className="muted small">{phone ? (onUse ? 'Tap a price to use it' : '') : `${onUse ? '↑ ↓ and Enter to use a price · ' : ''}F3 or Esc to close`}</span><span className="spacer" /><button className="btn" onClick={onClose}>Close (F3)</button></>}>
      {error ? <p className="text-red">{error}</p> : !data ? <Loading /> : !lines.length ? (
        <p className="muted">{customer ? `${custName(customer)} has not bought this product before.` : 'This product has not been sold yet.'}</p>
      ) : (
        <>
          <table className="table key-list ph-table">
            <thead><tr><th>Date</th><th>Bill</th>{!customer && <th>Customer</th>}<th className="right">Qty</th><th className="right">Price</th><th className="right">Dis</th><th className="right">Per piece</th></tr></thead>
            <tbody>{lines.map((l, i) => [
              // walk-in: a heading over the walk-in sales, and one over the registered customers' (when there are none yet, it says so)
              !customer && l.group !== lines[i - 1]?.group && (
                <tr key={`g-${l.group}`} className="ph-group"><td colSpan={7}>{l.group === 'walkin' ? 'Walk-in customers' : <>Registered customers{!lines.some((x) => x.group === 'walkin') && <span className="muted"> · no walk-in sales of this product yet</span>}</>}</td></tr>
              ),
              <tr key={`${l.sale_id}-${i}`} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onClick={() => onUse?.(l.per_pcs)} style={onUse ? { cursor: 'pointer' } : undefined}>
                <td>{niceDate(l.date)}{l.created_at ? <span className="muted small"> {niceTime(l.created_at)}</span> : null}</td>
                <td>{l.invoice_no}{l.payment_type === 'credit' && <span className="muted small"> · credit</span>}</td>
                {!customer && <td>{l.customer_name}</td>}
                <td className="right">{int(l.qty)} {l.unit}</td>
                <td className="right">{money(l.price)}</td>
                <td className="right">{l.disc_pct ? `${l.disc_pct}%` : '—'}</td>
                <td className="right strong">{money(l.per_pcs)}</td>
              </tr>,
            ])}</tbody>
          </table>
        </>
      )}
    </Modal>
  );
}

/* ---------------- bill saved: print it — A5 (usual) or 80 mm, ← → to choose, Enter to print ---------------- */
export function DoneModal({ sale, change, onClose, onView }) {
  const phone = usePhone();   // a phone: tapping A5 or 80 mm prints
  const { settings } = useSettings();
  const toast = useToast();
  const [size, setSize] = useState(() => billDesign(settings).default_size);
  const [busy, setBusy] = useState(false);
  const credit = sale.payment_type === 'credit';
  const refund = sale.total < 0;
  const print = async (sz) => {
    if (busy) return;
    setBusy(true);
    try {
      const how = await printBill(sale, sz, settings);
      if (how === 'sent') toast(`${sale.invoice_no} sent to the ${sz === '80' ? '80 mm' : 'A5'} printer`);
    } catch (e) { toast(e.message, 'error'); }
    onClose();   // on to the next sale
  };
  return (
    <Modal size="md" title="Bill saved ✔ — print it?" subtitle={`${sale.invoice_no} · ${sale.customer_name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onView}>View bill</button>
        <button className="btn" onClick={onClose}>{phone ? "Don't print" : "Don't print (Esc)"}</button>
        <span className="spacer" />
        {!phone && <button className="btn btn-primary" disabled={busy} onClick={() => print(size)}><Icon name="print" /> Print {size === '80' ? '80 mm' : 'A5'} (Enter)</button>}
      </>}>
      <SizeChoice value={size} onChange={setSize} onPick={print} />
      <div className="done-sum">
        <div><span>{refund ? 'Refund' : 'Bill total'}</span><b>{lkr(refund ? -sale.total : sale.total)}</b></div>
        <div><span>Type</span><b>{refund ? (credit ? 'Off their account' : 'Cash given back') : credit ? 'On account' : 'Cash'}</b></div>
        {credit && !refund && <><div><span>Paid now</span><b>{lkr(sale.paid_at_sale)}</b></div><div><span>Due on</span><b>{niceDate(sale.due_date)}</b></div></>}
        {change != null && <div className="total"><span>Balance to give</span><b>{lkr(change)}</b></div>}
      </div>
    </Modal>
  );
}
