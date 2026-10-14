import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, n, r2, lkr, money, today, addDays, int, margin, pct, niceDate, costTiers } from '../lib.js';
import { Icon, Modal, Field, NumInput, CostBadge, useToast, Loading } from '../components/ui.jsx';
import { CustomerForm } from '../components/forms.jsx';
import { useAuth, useSettings } from '../App.jsx';
import { isAdmin, isSuper } from '../lib.js';

const DRAFT_KEY = 'cargo-pos-draft';
const HELD_KEY = 'cargo-pos-held';
const LAST_KEY = 'cargo-pos-last-sale';
const readLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Billing keys — shown in the help box and in Settings. */
export const POS_KEYS = [
  ['F1', 'Back to the code box'],
  ['Enter', 'Next box · add the line'],
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
  ['F4', 'Customer'],
  ['F8', 'Bill discount'],
  ['F10', 'Take payment (same as Enter Enter)'],
  ['F7 / Ctrl + H', 'Hold the bill'],
  ['F5', 'Held bills'],
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
const blankEntry = { q: '', pid: null, bid: null, unit: 'pcs', qty: '1', price: '', disc_pct: '' };   // sold by the piece only; bid = the stock batch
const typingIn = (el) => el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);

export default function POS() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
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
  const [edit, setEdit] = useState(null);          // { i, qty, price } while a bill line is being edited
  const [showCost, setShowCost] = useState(() => readLS('pos-show-cost', true));
  const [held, setHeld] = useState(() => readLS(HELD_KEY, []));
  const [modal, setModal] = useState(null);        // 'customer' | 'pay' | 'credit' | 'held' | 'keys' | {newCustomer}
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
  useEffect(() => { writeLS('pos-show-cost', showCost); }, [showCost]);
  useEffect(() => { writeLS(DRAFT_KEY, { lines, customerId, billDisc }); }, [lines, customerId, billDisc]);
  useEffect(() => { writeLS(HELD_KEY, held); }, [held]);
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
  const batchOf = (pid, bid) => (bid != null ? (byId[pid]?.batches || []).find((b) => b.id === bid) || null : null);
  const curB = cur ? batchOf(cur.id, entry.bid) : null;

  /* ---------- matches for the code box ---------- */
  const hits = useMemo(() => {
    const s = entry.q.trim().toLowerCase();
    if (!s || entry.pid) return [];
    const all = (products || []).filter((p) => s === '*' || p.code.toLowerCase().includes(s) || p.name.toLowerCase().includes(s) || (p.category || '').toLowerCase().includes(s));
    return all.sort((a, b) => (a.code.toLowerCase() === s ? -1 : 0) - (b.code.toLowerCase() === s ? -1 : 0) || (b.stock_pcs > 0) - (a.stock_pcs > 0)).slice(0, 60);
  }, [products, entry.q, entry.pid]);
  // one row per stock batch when a product was bought at different costs (cheapest first, badged low / medium / high)
  const hitRows = useMemo(() => hits.flatMap((p) => {
    const bs = p.batches || [];
    if (bs.length < 2) return [{ p, b: bs[0] || null, tier: null }];
    const tiers = costTiers(bs);
    return bs.map((b) => ({ p, b, tier: tiers[b.id] }));
  }), [hits]);

  const inBillPcs = (pid, except = -1, bid = null) => lines.reduce((s, l, i) => (l.product_id === pid && i !== except && byId[pid] && (bid == null || l.batch_id === bid) ? s + n(l.qty) * unitInfo(byId[pid], l.unit).per : s), 0);
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
  const pick = (p, b = null) => {
    if (!p) return;
    const unit = 'pcs';
    const u = unitInfo(p, unit, b);
    setEntry({ q: p.code, pid: p.id, bid: b?.id ?? null, unit, qty: '1', price: String(u.expected || u.mrp || ''), disc_pct: '' });
    setHi(0);
    if (freePcs(p, b) <= 0) toast(`"${p.name}"${b ? ` (${b.ref})` : ''} has no stock left`, 'error');
    focus('tQty');
  };
  const commit = () => {
    const p = cur;
    if (!p) { toast('Scan or type a product code first', 'error'); return toCode(); }
    const qty = n(entry.qty);
    if (qty <= 0) { toast('Enter a quantity', 'error'); return focus('tQty'); }
    const per = unitInfo(p, entry.unit).per;
    const free = freePcs(p, curB);
    if (qty * per > free) { toast(`Only ${pcsText(Math.max(0, free))} of ${p.name}${curB ? ` (${curB.ref})` : ''} left`, 'error'); return focus('tQty'); }
    const line = { product_id: p.id, batch_id: curB?.id ?? null, unit: entry.unit, qty, price: n(entry.price), disc_pct: n(entry.disc_pct) };
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product_id === line.product_id && (l.batch_id ?? null) === line.batch_id && l.unit === line.unit && n(l.price) === line.price && n(l.disc_pct) === line.disc_pct);
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
        if (row) return pick(row.p, row.b);
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
    setEdit({ i, unit: lines[i].unit, qty: String(lines[i].qty), price: String(lines[i].price) });
    focus(field);
  };
  const saveEdit = () => {
    if (!edit) return;
    const l = lines[edit.i];
    const p = byId[l.product_id];
    const qty = n(edit.qty);
    if (qty <= 0) return toast('Quantity must be more than 0', 'error');
    if (p && qty * unitInfo(p, edit.unit).per > freePcs(p, batchOf(p.id, l.batch_id), edit.i)) return toast(`Not enough stock of ${p.name}`, 'error');
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
    let sub = 0, lineDisc = 0, cost = 0, mrp = 0, pcs = 0;
    const rows = lines.map((l) => {
      const p = byId[l.product_id];
      if (!p) return null;
      const b = batchOf(p.id, l.batch_id);
      const u = unitInfo(p, l.unit, b);
      const c = lineCalc(l);
      sub += c.gross; lineDisc += c.disc; cost += u.cost * n(l.qty); mrp += u.mrp * n(l.qty); pcs += n(l.qty) * u.per;
      return { ...l, p, b, u, ...c, under: u.cost > 0 && c.net < u.cost };
    });
    const afterLines = sub - lineDisc;
    const bd = String(billDisc).trim().endsWith('%') ? (afterLines * n(String(billDisc).replace('%', ''))) / 100 : n(billDisc);
    const net = r2(afterLines - bd);
    return { rows, sub: r2(sub), lineDisc: r2(lineDisc), billDisc: r2(bd), net, cost: r2(cost), gp: r2(net - cost), saved: r2(mrp - net), pcs };
  }, [lines, byId, billDisc]);
  const owed = customer?.balance || 0;
  const overLimit = customer && customer.credit_limit > 0 && owed + T.net > customer.credit_limit;

  /* ---------- held bills ---------- */
  const snapshot = () => ({ id: Date.now(), at: new Date().toISOString(), label: customer?.name || 'Walk-in customer', lines, customerId, billDisc, by: user.name });
  const clearBill = () => { setLines([]); setBillDisc(''); setCustomerId(null); setEntry(blankEntry); setSel(-1); setEdit(null); };
  const hold = () => {
    if (!lines.length) return toast('Nothing on the bill to hold', 'error');
    setHeld((h) => [...h, snapshot()]);
    toast(`Bill held for ${customer?.name || 'walk-in customer'} — F5 brings it back`);
    clearBill();
    toCode();
  };
  const resume = (b) => {
    setHeld((h) => [...h.filter((x) => x.id !== b.id), ...(lines.length ? [snapshot()] : [])]);
    setLines(b.lines); setCustomerId(b.customerId); setBillDisc(b.billDisc || '');
    setModal(null);
    toCode();
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
        paid_amount: type === 'credit' ? n(paid) : T.net, due_date: type === 'credit' ? due : null,
        items: lines.map((l) => ({ product_id: l.product_id, batch_id: l.batch_id ?? null, unit: l.unit, qty: n(l.qty), price: n(l.price), disc_pct: n(l.disc_pct) })),
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
      toast(`Credit limit for ${customer.name} raised to ${lkr(newLimit)}`);
      await complete('credit', { paid, due });
    } catch (e) { toast(e.message, 'error'); }
  };
  const reprint = () => {
    const id = readLS(LAST_KEY, null);
    if (!id) return toast('No bill made on this computer yet', 'error');
    window.open(`/print/sale/${id}`, '_blank');
  };

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('.modal')) return;
      const k = e.key;
      const typing = typingIn(document.activeElement);
      const take = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (k === '`' || e.code === 'Backquote') return take(() => setShowCost((s) => !s));
      if (k === 'F1') return take(toCode);
      if (k === 'F4') return take(() => { setAfter(null); setModal('customer'); });
      if (k === 'F5') return take(() => setModal('held'));
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
        if (k === '+' || k === '=') return take(() => update(sel, { qty: n(lines[sel].qty) + 1 }));
        if (k === '-') return take(() => update(sel, { qty: Math.max(1, n(lines[sel].qty) - 1) }));
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

  return (
    <div className="till">
      {/* ================= HEADER BAND ================= */}
      <div className="till-head">

        <div className={`till-who ${customer ? 'named' : ''}`} role="button" onClick={() => { setAfter(null); setModal('customer'); }} title="Change customer (F4)">
          <b>{customer ? customer.name.toUpperCase() : 'WALK-IN CUSTOMER'}</b>
          <em>{customer
            ? <>{customer.shop_name ? `${customer.shop_name} · ` : ''}{customer.phone || 'no phone'} · due {money(owed)}{customer.credit_limit > 0 ? ` of ${money(customer.credit_limit)}` : ''}{overLimit ? ' · OVER LIMIT' : ''}</>
            : 'no account · press F4 to choose'}</em>
          <span>cashier <b>{user.name}</b></span>
          <span className="till-whobtn">{customer ? 'Change' : 'Choose'} customer <i>F4</i></span>
        </div>

        <div className="till-date">
          <div><b>{now.toLocaleDateString('en-GB', { weekday: 'long' })}</b> <span>{now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
          <div className="till-clock">{now.toLocaleTimeString('en-GB', { hour12: true })}</div>
        </div>
        <div className="till-no">
          <span>BILL NO</span>
          <b>{nextNo || '—'}</b>
          <button className={`till-gp ${showCost ? 'on' : ''}`} onClick={() => setShowCost((s) => !s)} title="Show / hide cost and profit ( ` key )">
            <Icon name={showCost ? 'eye' : 'eyeOff'} size={12} /> {showCost ? 'COST SHOWN' : 'COST HIDDEN'} <kbd>`</kbd>
          </button>
        </div>
      </div>

      {/* ================= ENTRY ROW ================= */}
      <div className={`till-entry ${cur ? 'live' : ''}`}>
        <label className="f-code"><span>SCAN / INPUT CODE <i>F1</i></span>
          <input id="tCode" ref={codeRef} autoFocus autoComplete="off" placeholder="code or name · * lists all" value={entry.q}
            onChange={(e) => { setEntry({ ...blankEntry, q: e.target.value }); setHi(0); }} onKeyDown={entryKey('tCode')} onFocus={() => setSel(-1)} />
        </label>
        <div className="f-item"><span>ITEM</span>
          <div className={`till-item ${cur ? 'has' : ''}`}>
            {cur ? <>
              <b>{cur.name.toUpperCase()}</b>
              <em>{cur.code}{cur.sizes ? ` · ${cur.sizes}` : ''}{curB && (cur.batches || []).length > 1 ? ` · ${batchText(curB)}` : ''} · stock {pcsText(freePcs(cur, curB))}</em>
            </> : <i>scan or key a code — F1</i>}
          </div>
        </div>
        <label className="f-qty"><span>QTY (PCS)</span>
          <input id="tQty" inputMode="decimal" autoComplete="off" value={entry.qty} onFocus={(e) => e.target.select()}
            onChange={(e) => setEntry({ ...entry, qty: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={entryKey('tQty')} />
        </label>
        {showCost && <div className="f-ro"><span>COST</span><div className="till-ro cost">{cur ? money(eu.cost) : '—'}</div></div>}
        <div className="f-ro"><span>MRP</span>
          <div className="till-ro click" onClick={() => cur && setEntry({ ...entry, price: String(eu.mrp) })} title="Use MRP">{cur ? money(eu.mrp) : '—'}</div></div>
        <div className="f-ro"><span>EXPECTED</span>
          <div className="till-ro click exp" onClick={() => cur && setEntry({ ...entry, price: String(eu.expected) })} title="Use the expected price">{cur ? money(eu.expected) : '—'}</div></div>
        <label className="f-price"><span>LAST PRICE</span>
          <input id="tPrice" className={eUnder && showCost ? 'under' : ''} inputMode="decimal" autoComplete="off" value={entry.price} onFocus={(e) => e.target.select()}
            onChange={(e) => setEntry({ ...entry, price: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={entryKey('tPrice')} />
        </label>
        <label className="f-dis"><span>DIS %</span>
          <input id="tDis" inputMode="decimal" autoComplete="off" value={entry.disc_pct} placeholder="0" onFocus={(e) => e.target.select()}
            onChange={(e) => setEntry({ ...entry, disc_pct: e.target.value.replace(/[^\d.]/g, '') })} onKeyDown={entryKey('tDis')} />
        </label>
        <div className="f-amt"><span>AMOUNT</span><div className={`till-amt ${eUnder && showCost ? 'under' : ''}`}>{cur ? money(eAmt) : '0.00'}</div></div>
        <button className="till-add" onClick={commit} disabled={!cur}>ADD<i>Enter</i></button>
      </div>

      {/* ================= MATCH LIST ================= */}
      <div className="till-hitwrap">
        {hitRows.length > 0 && (
          <div className="till-hits">
            <table>
              <thead><tr><th>CODE</th><th>ITEM</th><th>STOCK FROM</th><th>SIZES</th><th className="n">IN STOCK</th><th className="n">COST / PC</th><th className="n">EXPECTED / PC</th><th className="n">MRP / PC</th></tr></thead>
              <tbody>
                {hitRows.map(({ p, b, tier }, i) => {
                  const u = unitInfo(p, 'pcs', b);
                  const stock = b ? b.left_pcs : p.stock_pcs;
                  const many = (p.batches || []).length > 1;
                  return (
                    <tr key={`${p.id}-${b?.id ?? 0}`} className={`${i === hi ? 'on' : ''} ${many ? 'batch' : ''}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(p, b); }}>
                      <td className="c">{p.code}</td>
                      <td className="d">{p.name}{tier && <> <CostBadge tier={tier} /></>}</td>
                      <td className="s">{many ? batchText(b) : p.category || '—'}</td>
                      <td className="s">{p.sizes || '—'}</td>
                      <td className={`n ${stock <= 0 ? 'neg' : !many && stock < p.reorder_sets * p.pcs_per_set ? 'low' : ''}`}>{stock <= 0 ? 'none' : pcsText(stock)}</td>
                      <td className="n cost">{money(u.costPc)}</td>
                      <td className="p">{money(u.expectedPc)}</td>
                      <td className="n">{money(u.mrpPc)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ================= BILL + SUMMARY ================= */}
      <div className="till-main">
        <div className="till-lines" ref={billRef}>
          <table className="till-tbl">
            <thead><tr><th className="c">#</th><th className="c">CODE</th><th>ITEM</th><th className="n">QTY (PCS)</th><th className="n">MRP</th><th className="n">PRICE</th><th className="n">DIS</th><th className="n">AMOUNT</th><th className="x"></th></tr></thead>
            <tbody>
              {T.rows.length === 0 && <tr><td colSpan={9} className="till-empty">Scan or key an item code above. The newest line sits at the top.</td></tr>}
              {T.rows.map((r, i) => r && (
                <tr key={i} className={`${i === sel ? 'on' : ''} ${edit?.i === i ? 'editing' : ''}`} onClick={(e) => { if (!typingIn(e.target) && e.target.tagName !== 'BUTTON') { setSel(i); document.activeElement?.blur(); } }}>
                  <td className="c">{T.rows.length - i}</td>
                  <td className="c">{r.p.code}</td>
                  <td className="d">
                    <b>{r.p.name.toUpperCase()}</b>
                    <em>{r.p.sizes ? `${r.p.sizes} · ` : ''}{r.b && (r.p.batches || []).length > 1 ? `${batchText(r.b)} · ` : ''}{showCost ? `cost ${money(r.u.costPc)} · ` : ''}expected {money(r.u.expectedPc)}</em>
                    {showCost && r.under && <span className="tag bad">under cost</span>}
                  </td>
                  <td className="n q">{edit?.i === i
                    ? <input id="lnQty" className="ln-in" inputMode="decimal" value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} onKeyDown={editKey} onFocus={(e) => e.target.select()} />
                    : <b>{r.qty}</b>}</td>
                  <td className="n mrp">{money(r.u.mrp)}</td>
                  <td className={`n pr ${showCost && r.under ? 'under' : ''}`}>{edit?.i === i
                    ? <input id="lnPrice" className="ln-in" inputMode="decimal" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} onKeyDown={editKey} onFocus={(e) => e.target.select()} />
                    : money(r.price)}
                    {showCost && edit?.i !== i && <em className={r.under ? 'loss' : ''}>{pct(margin(r.net, r.u.cost))}</em>}</td>
                  <td className="n ds">{r.disc ? <><b>{r.disc_pct}%</b><em>{money(r.disc)}</em></> : '—'}</td>
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
              <input id="tBillDisc" value={billDisc} placeholder="0 or 5%" onFocus={(e) => e.target.select()} onChange={(e) => setBillDisc(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); toCode(); } }} /></div>
            {T.sub > 0 && (T.lineDisc || T.billDisc) > 0 && <div className="sum-line faint"><span>Total discount</span><b>{(((T.lineDisc + T.billDisc) / T.sub) * 100).toFixed(2)}%</b></div>}
            {T.saved > 0 && <div className="sum-line saved"><span>Saves vs MRP</span><b>{money(T.saved)}</b></div>}
          </div>
          <div className="sum-net"><span>NET TOTAL</span><b>{money(T.net)}</b></div>
          {showCost && lines.length > 0 && <div className={`sum-gp ${T.gp < 0 ? 'neg' : ''}`}><span>GP</span><b>{money(T.gp)}</b><i>{pct(margin(T.net, T.cost))}</i></div>}
          {overLimit && <div className="sum-over">Over their limit — due {money(owed)} of {money(customer.credit_limit)}. To bill on credit, the Super Admin must raise the limit.</div>}
          <div className="sum-acts">
            <button className="sum-pay" onClick={openPay} disabled={!lines.length}><b>TAKE PAYMENT</b><span>{lkr(T.net)} · Enter Enter · cash or credit</span></button>
            <div className="sum-more">
              <button onClick={hold} disabled={!lines.length}>Hold bill <i>F7</i></button>
              <button onClick={() => setModal('held')}>Held bills{held.length > 0 && <b className="count-dot">{held.length}</b>} <i>F5</i></button>
              <button onClick={() => { if (!lines.length || confirm('Clear this bill?')) clearBill(); }} disabled={!lines.length && !customerId}>Clear bill <i>Ctrl+Del</i></button>
              <button onClick={reprint}>Last bill <i>F12</i></button>
              <button onClick={() => setModal('keys')}>All keys <i>?</i></button>
            </div>
          </div>
        </div>
      </div>

      {/* ================= POP-UPS ================= */}
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
        <Modal title="Held bills" subtitle="Bills put aside on this computer (F7). Pick one to carry on with it." onClose={() => { setModal(null); toCode(); }}>
          {held.length === 0 ? <p className="muted">No bills on hold.</p> : (
            <div className="stack-s">{held.map((b, idx) => (
              <div key={b.id} className="held-row">
                <span className="held-no">{idx + 1}</span>
                <div className="spacer"><div className="strong">{b.label}</div>
                  <div className="muted small">{b.lines.length} lines · {new Date(b.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · by {b.by}</div></div>
                <b className="mono">{lkr(b.lines.reduce((s, l) => s + lineCalc(l).amount, 0))}</b>
                <button className="btn btn-sm btn-primary" autoFocus={idx === 0} onClick={() => resume(b)}>Continue</button>
                <button className="btn btn-sm btn-icon btn-ghost" title="Delete" onClick={() => confirm('Delete this held bill?') && setHeld((h) => h.filter((x) => x.id !== b.id))}><Icon name="trash" size={15} /></button>
              </div>))}
            </div>
          )}
        </Modal>
      )}
      {modal === 'keys' && (
        <Modal title="Billing keys" onClose={() => { setModal(null); toCode(); }}>
          <div className="keys-grid">{POS_KEYS.map(([k, l]) => <div key={k} className="key-row"><kbd>{k}</kbd><span>{l}</span></div>)}</div>
          <p className="muted small mt">Anywhere in the app: <kbd>F2</kbd> Dashboard · <kbd>F3</kbd> New sale · <kbd>F9</kbd> Bills · <kbd>F7</kbd> Take a payment</p>
        </Modal>
      )}
      {done && (
        <DoneModal sale={done.sale} change={done.change} onClose={() => { setDone(null); toCode(); }}
          onView={() => navigate(`/sales/${done.sale.id}`)} footer={settings.invoice_footer} />
      )}
    </div>
  );
}

/* ---------------- customer picker (F4) ---------------- */
function CustomerPicker({ customers, current, creditOnly, onPick, onNew, onClose }) {
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
    <Modal title={creditOnly ? 'Who is this credit bill for?' : 'Choose customer'} subtitle="Type a name, shop, phone or town · ↑ ↓ · Enter" onClose={onClose}
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
            <span><b>{c.name}</b>{!c.walk && <small>{[c.shop_name, c.city, c.phone].filter(Boolean).join(' · ')}</small>}</span>
            {!c.walk && <span className="right">{c.balance > 0 ? <b className="text-red">due {money(c.balance)}</b> : <small>no dues</small>}{c.credit_limit > 0 && <small>limit {money(c.credit_limit)}</small>}</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------- take payment (F10) ---------------- */
function PayModal({ total, busy, onPay, onClose }) {
  const [got, setGot] = useState('');
  const change = n(got) - total;
  const go = (e) => { e.preventDefault(); if (n(got) && change < 0) return; onPay(n(got) || total); };
  return (
    <Modal size="sm" title="Take payment — cash" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" form="pay-form" disabled={busy || (n(got) > 0 && change < 0)}><Icon name="check" /> {busy ? 'Saving…' : 'Finish bill (Enter)'}</button></>}>
      <form id="pay-form" className="stack" onSubmit={go}>
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

/* ---------------- take payment: cash or credit? ---------------- */
function PayTypeModal({ total, customer, onChoose, onClose }) {
  const [type, setType] = useState('cash');   // cash is the default
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
    <Modal size="sm" title="Take payment" subtitle={`${lkr(total)} · how is the customer paying?`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Back</button><button className="btn btn-primary" onClick={() => onChoose(type)}><Icon name="arrowRight" /> Continue (Enter)</button></>}>
      <div className="paytype" ref={boxRef} tabIndex={-1} onKeyDown={onKey} role="radiogroup" aria-label="Payment type">
        <button tabIndex={-1} className={`pt-card ${type === 'cash' ? 'on' : ''}`} onClick={() => setType('cash')} onDoubleClick={() => onChoose('cash')}>
          <span className="pt-icon"><Icon name="cash" size={24} /></span>
          <b>Cash</b><small>Paid now in full</small><kbd>1</kbd>
        </button>
        <button tabIndex={-1} className={`pt-card credit ${type === 'credit' ? 'on' : ''}`} onClick={() => setType('credit')} onDoubleClick={() => onChoose('credit')}>
          <span className="pt-icon"><Icon name="clock" size={24} /></span>
          <b>Credit</b><small>{customer ? `On ${customer.name}'s account` : 'Registered customers only'}</small><kbd>2</kbd>
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- on account (credit) ---------------- */
function CreditModal({ customer, total, busy, canRaise, onConfirm, onRaise, onChangeCustomer, onClose }) {
  const [paid, setPaid] = useState('');
  const [due, setDue] = useState(addDays(today(), customer.credit_days || 0));
  const [raising, setRaising] = useState(false);
  const after = r2(customer.balance + total - n(paid));
  const over = customer.credit_limit > 0 && after > customer.credit_limit;
  const suggested = Math.ceil(after / 1000) * 1000;
  const [newLimit, setNewLimit] = useState(String(suggested));
  useEffect(() => { if (!raising) setNewLimit(String(suggested)); }, [suggested, raising]);

  const submit = (e) => {
    e.preventDefault();
    if (!over) return onConfirm(paid, due);
    if (!raising) return setRaising(true);
    if (n(newLimit) < after) return;
    onRaise(n(newLimit), paid, due);
  };
  return (
    <Modal size="sm" title={`On account — ${customer.name}`} subtitle={customer.shop_name || ''} onClose={onClose}
      footer={<>
        <button className="btn" onClick={raising ? () => setRaising(false) : onClose}>Back</button>
        <button className="btn btn-primary" form="credit-form" disabled={busy || (raising && n(newLimit) < after)}>
          <Icon name={over ? 'shield' : 'check'} /> {busy ? 'Saving…' : !over ? 'Put on account (Enter)' : raising ? 'Raise limit & bill (Enter)' : 'Raise credit limit… (Enter)'}
        </button>
      </>}>
      <form id="credit-form" className="stack" onSubmit={submit}>
        <div className="pay-total amber"><span>This bill</span><b>{lkr(total)}</b></div>
        <div className="row gap-s small">
          <span className="muted">Customer:</span> <b>{customer.name}</b>
          <button type="button" className="link-btn" style={{ marginLeft: 'auto' }} onClick={onChangeCustomer}>Change customer</button>
        </div>
        {!raising && (
          <div className="grid grid-2">
            <Field label="Paid now (advance)"><NumInput autoFocus value={paid} onChange={setPaid} placeholder="0.00" /></Field>
            <Field label="Payment due on"><input type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          </div>
        )}
        <dl className="kv">
          <dt>Due now</dt><dd>{lkr(customer.balance)}</dd>
          <dt>Due after this bill</dt><dd className={over ? 'text-red' : ''}>{lkr(after)}</dd>
          <dt>Credit limit</dt><dd>{customer.credit_limit > 0 ? lkr(customer.credit_limit) : 'No limit set'}</dd>
        </dl>
        {over && !raising && (
          <div className="alert alert-red small"><Icon name="alert" size={16} />
            <span>This bill takes {customer.name} <b>{lkr(after - customer.credit_limit)}</b> over the credit limit. To bill it on credit, the credit limit must be increased{canRaise ? '' : ' with the Super Admin password'}.</span>
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

/* ---------------- bill saved: a little printer prints the receipt ---------------- */
function DoneModal({ sale, change, onClose, onView }) {
  const [printed, setPrinted] = useState(false);
  useEffect(() => { const t = setTimeout(() => setPrinted(true), 1900); return () => clearTimeout(t); }, []);
  useEffect(() => {
    const k = (e) => { if (e.key.toLowerCase() === 'p' && !typingIn(document.activeElement)) { e.preventDefault(); window.open(`/print/sale/${sale.id}`, '_blank'); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [sale.id]);
  const credit = sale.payment_type === 'credit';
  return (
    <Modal size="sm" title={printed ? 'Bill saved ✔' : 'Printing bill…'} subtitle={`${sale.invoice_no} · ${sale.customer_name}`} onClose={onClose}
      footer={<>
        <button className="btn" onClick={onView}>View bill</button>
        <button className="btn" onClick={() => window.open(`/print/sale/${sale.id}`, '_blank')}><Icon name="print" /> Print (P)</button>
        <button className="btn btn-primary" autoFocus onClick={onClose}>Next sale (Enter)</button>
      </>}>
      <div className={`printer-scene ${printed ? 'done' : ''}`} aria-hidden="true">
        <div className="printer">
          <div className="printer-top"><span className="printer-light" /></div>
          <div className="printer-slot" />
        </div>
        <div className="receipt-clip">
          <div className="receipt">
            <div className="rc-head">{sale.invoice_no}</div>
            <div className="rc-sub">{niceDate(sale.date)} · {sale.customer_name}</div>
            <div className="rc-lines">{sale.items.slice(0, 4).map((i) => (
              <div key={i.id} className="rc-line"><span>{i.qty} × {i.name}</span><span>{money(i.line_total)}</span></div>
            ))}{sale.items.length > 4 && <div className="rc-line muted"><span>+ {sale.items.length - 4} more</span><span /></div>}</div>
            <div className="rc-total"><span>TOTAL</span><span>{money(sale.total)}</span></div>
            <div className="rc-foot">{credit ? 'ON ACCOUNT' : 'PAID · CASH'}</div>
            <div className="rc-zigzag" />
          </div>
        </div>
      </div>
      <dl className={`kv done-kv ${printed ? 'show' : ''}`}>
        <dt>Bill total</dt><dd>{lkr(sale.total)}</dd>
        <dt>Type</dt><dd>{credit ? 'On account' : 'Cash'}</dd>
        {credit && <><dt>Paid now</dt><dd>{lkr(sale.paid_at_sale)}</dd><dt>Due on</dt><dd>{niceDate(sale.due_date)}</dd></>}
        {change != null && <><dt className="total">Balance to give</dt><dd className="total">{lkr(change)}</dd></>}
      </dl>
    </Modal>
  );
}
