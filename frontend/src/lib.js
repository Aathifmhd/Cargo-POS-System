import { useCallback, useEffect, useState } from 'react';
import { cacheGet, cacheSet, noteOnline, noteOffline, isOnline, enqueue, newId, setTokenGetter } from './offline.js';

/* ---------------- catalogue (Settings → Categories, products & sizes) ---------------- */
/** [{ name, sizes: [], types: [] }] from settings.catalog */
export function parseCatalog(settings) {
  try {
    const list = JSON.parse(settings?.catalog || '[]');
    return Array.isArray(list) ? list.filter((c) => c && c.name).map((c) => {
      return { name: c.name, sizes: c.sizes || [], types: c.types || [], reorder_sets: Math.max(0, Math.round(Number(c.reorder_sets) || 0)) };
    }) : [];
  } catch { return []; }
}
/**
 * A product's stock batches that cost the same, put together (colours, pieces per set and expected price don't
 * split them): [{ id (the oldest batch), ids, cost_per_pcs, expected_per_pcs (the newest batch's), left_pcs, ref, date }],
 * cheapest first. Selling from a group takes the oldest of its batches first.
 */
export function costGroups(batches) {
  const byCost = new Map();
  for (const b of [...(batches || [])].sort((a, c) => (a.date === c.date ? a.id - c.id : a.date < c.date ? -1 : 1))) {
    const k = b.cost_per_pcs != null ? Math.round((Number(b.cost_per_pcs) || 0) * 100) : String(b.cost_code || '');
    if (!byCost.has(k)) byCost.set(k, []);
    byCost.get(k).push(b);
  }
  return [...byCost.values()].map((list) => {
    const newest = list[list.length - 1];
    return {
      id: list[0].id, ids: list.map((b) => b.id), cost_per_pcs: list[0].cost_per_pcs, cost_code: list[0].cost_code,
      expected_per_pcs: newest.expected_per_pcs || list.find((b) => b.expected_per_pcs)?.expected_per_pcs || 0,
      left_pcs: list.reduce((t, b) => t + b.left_pcs, 0),
      ref: list.map((b) => b.ref || 'Stock').join(' + '), date: newest.date, count: list.length,
    };
  }).sort((a, b) => (a.cost_per_pcs ?? 0) - (b.cost_per_pcs ?? 0) || String(a.cost_code || '').localeCompare(String(b.cost_code || '')));
}
/**
 * Low / medium / high cost for one product's stock batches. The badge goes by the cost itself, so batches that cost
 * the same (e.g. the same price, different expected selling price) get the same badge. Over the different costs:
 * the dearest third (at least one) is high, the rest split evenly with the extra one going to low —
 * 2 costs → low, high · 3 → low, medium, high · 5 → low, low, medium, medium, high.
 * Returns batch id → 'low' | 'medium' | 'high' (empty when every batch costs the same).
 */
export function costTiers(batches) {
  const costOf = (b) => Math.round((Number(b.cost_per_pcs) || 0) * 100);   // to the cent
  const costs = [...new Set((batches || []).map(costOf))].sort((a, b) => a - b);
  if (costs.length < 2) return {};
  const high = Math.max(1, Math.floor(costs.length / 3));
  const low = Math.ceil((costs.length - high) / 2);
  const tierOf = Object.fromEntries(costs.map((c, i) => [c, i < low ? 'low' : i < costs.length - high ? 'medium' : 'high']));
  return Object.fromEntries((batches || []).map((b) => [b.id, tierOf[costOf(b)]]));
}

/** A supplier (or its GRN / bill) from Sri Lanka bills in Rs; Indian suppliers in ₹. */
export const isLocalSup = (x) => x?.origin === 'local' || x?.currency === 'LKR';
/** The money format for a supplier's amounts: Rs for a local supplier, ₹ for an Indian one. */
export const supMoney = (x) => (isLocalSup(x) ? lkr : inr);
/** Supplier money that may be in both currencies: "₹ 1,000.00 + Rs 5,000.00" (only the parts that are there). */
export function bothMoney(list, amount, of = (x) => x) {
  let inrT = 0;
  let lkrT = 0;
  for (const x of list || []) { const v = Number(amount(x)) || 0; if (isLocalSup(of(x))) lkrT += v; else inrT += v; }
  if (lkrT && inrT) return `${inr(inrT)} + ${lkr(lkrT)}`;
  return lkrT ? lkr(lkrT) : inr(inrT);
}

export const findCategory = (catalog, name) => catalog.find((c) => c.name.toLowerCase() === String(name || '').trim().toLowerCase());

/* ---------------- theme (light by default, or dark) ---------------- */
const THEME_KEY = 'cargo-pos-theme';
export const getThemePref = () => { try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } };
/** Puts data-theme="light|dark" on <html> and remembers the choice on this computer. */
export function applyTheme(pref = getThemePref()) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  const dark = pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.dispatchEvent(new CustomEvent('cargo-pos-theme', { detail: pref }));
}

/* ---------------- roles ---------------- */
export const ROLE_NAME = { cashier: 'Cashier', kp: 'KP', employee: 'Employee', admin: 'Admin', superadmin: 'Super Admin' };
const RANK = { cashier: 0, kp: 0, employee: 0, admin: 1, superadmin: 2 };
export const isAdmin = (u) => (RANK[u?.role] ?? 0) >= 1;
export const isSuper = (u) => u?.role === 'superadmin';
/**
 * What a user may see and do (the server sends each user's permissions; they start from the role and can be changed
 * per user in Users & Security). The Super Admin has them all.
 */
export const PERMS = [
  { key: 'see_cost', label: 'See product costs & profit', text: 'Without it: the cost code only' },
  { key: 'receive_goods', label: 'Receive goods (GRNs)', text: 'GRNs, shipments, Extra & Short — comes with seeing costs' },
  { key: 'suppliers', label: 'Suppliers & paying them', text: 'Suppliers, what they are owed, paying suppliers and cargo' },
  { key: 'reports', label: 'Reports', text: 'Stock value report — comes with seeing costs' },
  { key: 'dues', label: 'Payment Portal', text: 'Collecting from customers' },
  { key: 'cheques', label: 'Cheque Desk', text: 'Cheques received and given' },
  { key: 'settings', label: 'Settings', text: 'Shop details, products, cost code, backups…' },
  { key: 'action_center', label: 'Action Center', text: 'Every activity, approvals and Attention — off unless given' },
];
const STAFF = { see_cost: false, receive_goods: false, suppliers: false, reports: false, dues: true, cheques: true, settings: true, action_center: false };
const ALL = Object.fromEntries(PERMS.map((p) => [p.key, true]));
export const ROLE_PERMS = { superadmin: ALL, admin: { ...ALL, action_center: false }, cashier: STAFF, kp: STAFF, employee: STAFF };
export const can = (u, perm) => (u?.role === 'superadmin' ? true : Boolean((u?.perms || ROLE_PERMS[u?.role] || STAFF)[perm]));
/** Product costs and profit: users with the "see costs" permission; the others see the cost code. */
export const seesCost = (u) => can(u, 'see_cost');

/* ---------------- session ---------------- */
const TOKEN_KEY = 'cargo-pos-token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };
setTokenGetter(getToken);   // the offline outbox sends with the same login

// Set by <ApprovalProvider>: shows the admin-credentials box and resolves to an approval token (or null if cancelled).
let approvalHandler = null;
export const setApprovalHandler = (fn) => { approvalHandler = fn; };

/* ---------------- API ---------------- */
/**
 * One call to the server. Without internet (no answer, or none in time): a GET gets what this device saw last
 * (see offline.js), anything else throws an OfflineError (err.offline) — New Sale and payments then keep it to send later.
 */
async function request(method, url, body, approval, { timeout } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (approval) headers['X-Approval'] = approval;
  // already known to be offline: straight to what was seen last
  if (method === 'GET' && !isOnline()) { const kept = await cacheGet(url); if (kept !== undefined) return kept; }
  let res;
  try {
    res = await fetch('/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout ?? (method === 'GET' ? 25_000 : 60_000)) });
  } catch {
    noteOffline();
    if (method === 'GET') {
      const kept = await cacheGet(url);
      if (kept !== undefined) return kept;
      throw new Error('No internet — this page has not been opened on this device before. It opens when the internet is back.');
    }
    const err = new Error('No internet connection — this needs the internet. New Sale and payments still work offline.');
    err.offline = true;
    throw err;
  }
  noteOnline();
  const data = await res.json().catch(() => ({}));
  if (method === 'GET' && res.ok) cacheSet(url, data);   // kept for when the internet is gone
  if (res.status === 401 && !url.startsWith('/auth/')) {
    setToken(null);
    window.dispatchEvent(new Event('cargo-pos-logout'));
  }
  // A protected change: ask an admin, then send the same request again with their one-time approval.
  if (res.status === 403 && data.needApproval && approvalHandler) {
    const granted = await approvalHandler(data.action, data.level);
    if (granted) return request(method, url, body, granted);
    throw new Error(`Cancelled — ${data.level === 'superadmin' ? 'Super Admin' : 'admin'} approval was not given`);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}, opts) => request('POST', url, body, null, opts),
  /**
   * A payment that may be made offline: sent now, or — without internet — kept on this device and sent by itself
   * later. Returns the server's answer, or { queued: true } when kept. q: { kind, label, amount } for the waiting list.
   */
  send: async (url, body, q) => {
    const b = { ...body, client_id: body.client_id || newId() };
    const keep = async () => ({ queued: true, item: await enqueue({ url, body: b, ...q }) });
    if (!isOnline()) return keep();
    try { return await request('POST', url, b, null, { timeout: 20_000 }); } catch (e) { if (e.offline) return keep(); throw e; }
  },
  put: (url, body = {}) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** Download a file from the API with the login token (plain links can't send it). */
export async function downloadFile(url, filename, approval) {
  const headers = { Authorization: `Bearer ${getToken()}` };
  if (approval) headers['X-Approval'] = approval;
  const res = await fetch('/api' + url, { headers });
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    if (data.needApproval && approvalHandler) {
      const granted = await approvalHandler(data.action, data.level);
      if (granted) return downloadFile(url, filename, granted);
      throw new Error('Cancelled — admin approval was not given');
    }
    throw new Error(data.error || 'Not allowed');
  }
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function useApi(url) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!url) return;
    setLoading(true);
    api.get(url)
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [url]);
  useEffect(load, [load]);
  return { data, error, loading, reload: load, setData };
}

/* ---------------- numbers & money ---------------- */
export const n = (v) => (v === '' || v == null || isNaN(Number(v)) ? 0 : Number(v));
export const r2 = (v) => Math.round((n(v) + Number.EPSILON) * 100) / 100;

const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const money = (v) => fmt2.format(n(v));
export const lkr = (v) => 'Rs ' + fmt2.format(n(v));
export const inr = (v) => '₹ ' + fmt2.format(n(v));
export const int = (v) => fmt0.format(n(v));
export const pct = (v) => (isFinite(v) ? `${n(v).toFixed(1)}%` : '—');

/** Stock is shown in pieces, e.g. "58 pcs" (the shop sells by the piece). */
export function stockText(pcs) {
  return `${int(n(pcs))} pcs`;
}

/** profit margin on selling price */
export const margin = (price, cost) => (n(price) > 0 ? ((n(price) - n(cost)) / n(price)) * 100 : 0);

/* ---------------- dates ---------------- */
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(dateStr, days) {
  const d = new Date((dateStr || today()) + 'T00:00:00');
  d.setDate(d.getDate() + n(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function niceDate(s) {
  if (!s) return '—';
  const v = String(s).slice(0, 10);   // 'YYYY-MM-DD' → 'DD/MM/YYYY'
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '—';
}
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}
/** "Overdue 5 days" / "Due in 3 days" / "Due today" */
export function dueText(due) {
  if (!due) return 'No due date';
  const d = daysBetween(today(), due);
  if (d < 0) return `Overdue ${-d} day${d === -1 ? '' : 's'}`;
  if (d === 0) return 'Due today';
  return `Due in ${d} day${d === 1 ? '' : 's'}`;
}

/* ---------------- landed cost (mirrors backend/services.js) ---------------- */
export function computeLanding({ items, exchange_rate, cargo_charge_inr, expenses }) {
  const rate = n(exchange_rate);
  const lines = items.map((it) => {
    const sets = Math.max(0, Math.round(n(it.sets)));
    const pcsPerSet = Math.max(1, Math.round(n(it.pcs_per_set) || 1));
    // the supplier's price: per piece on Receive Goods, per set on saved GRNs
    const cost = it.cost_inr_per_pcs !== undefined ? n(it.cost_inr_per_pcs) * pcsPerSet : n(it.cost_inr_per_set);
    const q = (v) => Math.max(0, Math.round(n(v)));
    // extra pieces are billed by the supplier at the per-piece price;
    // shorts are still paid in full; they keep their own cost (a loss on Extra & Short until they arrive)
    const extra_pcs = q(it.extra_pcs);
    const extra_sets = q(it.extra_sets); // older GRNs only: free sets, not billed
    const short_sets = q(it.short_sets);
    const short_pcs = q(it.short_pcs);
    // the total pieces changed by hand (one set with fewer pieces than the others): billed and received that many
    const odd_pcs = Math.max(-sets * pcsPerSet, Math.round(n(it.odd_pcs)));
    const line_inr = r2(sets * cost + (odd_pcs + extra_pcs) * (cost / pcsPerSet));
    // other expenses are entered per piece, over every piece paid for (arrived + shorts); the cargo charge over the pieces received
    const paidPcs = Math.max(0, (sets + extra_sets - short_sets) * pcsPerSet + odd_pcs + extra_pcs - short_pcs) + short_sets * pcsPerSet + short_pcs;
    // the cargo charge is only for the pieces that came (short or extra pieces: the pieces received; none: all of them)
    const recvPcs = Math.max(0, (sets + extra_sets - short_sets) * pcsPerSet + odd_pcs + extra_pcs - short_pcs);
    const given = (v) => v !== undefined && v !== null && v !== '';
    const charge = (perPc, total, over) => (given(perPc) ? r2(Math.max(0, n(perPc)) * over) : r2(Math.max(0, n(total))));
    return {
      category: it.category || '', cargo_lkr: charge(it.cargo_per_pcs, it.cargo_lkr, recvPcs), other_lkr: charge(it.other_per_pcs, it.other_lkr, paidPcs), paid_pcs: paidPcs, cargo_pcs: recvPcs, sets, pcs_per_set: pcsPerSet, line_inr, extra_sets, extra_pcs, short_sets, short_pcs, odd_pcs,
      set_pcs: sets * pcsPerSet + odd_pcs,             // pieces in the billed sets (as changed by hand)
      billed_pcs: sets * pcsPerSet + odd_pcs + extra_pcs, // pieces on the supplier's bill
      pcs: Math.max(0, (sets + extra_sets - short_sets) * pcsPerSet + odd_pcs + extra_pcs - short_pcs), // pieces really received
      // the supplier's price for one piece, in LKR
      bill_per_pcs_lkr: r2((cost / pcsPerSet) * rate),
    };
  });
  const goods_inr = r2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = n(cargo_charge_inr);
  // every charge: the items' own cargo and other expenses, and any older shared ones
  const other_lkr = r2(lines.reduce((s, l) => s + l.other_lkr, 0));
  const expenses_lkr = r2((expenses || []).reduce((s, e) => s + n(e.amount_lkr), 0) + lines.reduce((s, l) => s + l.cargo_lkr, 0) + other_lkr);
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + Math.max(0, l.sets + l.extra_sets - l.short_sets), 0);
  // a line's landed cost is spread over every piece received (billed + free)
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
  spread(cargo_inr * rate, all);
  for (const e of expenses || []) {
    const cat = String(e.category || '').trim().toLowerCase();
    const mine = cat ? all.filter((i) => String(lines[i].category || '').trim().toLowerCase() === cat) : [];
    spread(n(e.amount_lkr), mine.length ? mine : all);
  }
  const out = lines.map((l, i) => {
    const landed = l.line_inr * rate + overheadOf[i];
    // cost per piece is over every piece paid for, so short pieces don't make the others dearer
    const basis = l.pcs + l.short_sets * l.pcs_per_set + l.short_pcs;
    const perPcs = basis ? landed / basis : 0;
    return {
      ...l,
      landed_lkr: r2(landed),
      landed_per_set_lkr: r2(perPcs * l.pcs_per_set),
      landed_per_pcs_lkr: r2(perPcs),
    };
  });
  const total_lkr = r2((goods_inr + cargo_inr) * rate + expenses_lkr);
  return {
    items: out, goods_inr, cargo_inr, expenses_lkr, other_lkr, total_sets, total_pcs, total_lkr,
    // how many rupees (LKR) it really costs to land 1 INR of goods
    landing_factor: goods_inr > 0 ? total_lkr / goods_inr : 0,
  };
}

export const PAY_METHODS_SUPPLIER = ['Bank transfer', 'Cash', 'Cheque', 'UPI / Online'];
export const PAY_METHODS_CUSTOMER = ['Cash', 'Bank transfer', 'Cheque', 'Card', 'Online'];

/* ---------------- automatic expected selling price (Settings → Price & billing; MRP is no longer shown) ---------------- */
/** The pricing rules from settings: % added to the landed cost, and the step prices are rounded up to. */
export const priceRules = (settings) => ({
  selling: n(settings?.selling_markup_percent ?? 30),
  mrp: n(settings?.mrp_markup_percent ?? 40),
  round: Math.max(1, n(settings?.price_round_to) || 1),
});
const roundUp = (v, step) => Math.ceil(v / step - 1e-9) * step;
/** Prices per piece and per set worked out from the landed cost per piece. */
export function autoPrices(costPerPcs, pcsPerSet, rules) {
  if (!(costPerPcs > 0)) return null;
  const pps = Math.max(1, Math.round(n(pcsPerSet) || 1));
  const expectedPcs = roundUp(costPerPcs * (1 + rules.selling / 100), rules.round);
  const mrpPcs = roundUp(costPerPcs * (1 + rules.mrp / 100), rules.round);
  return { expected_per_pcs: expectedPcs, mrp_per_pcs: mrpPcs, expected_per_set: expectedPcs * pps, mrp_per_set: mrpPcs * pps };
}

/** Customers go by their shop / business name; the person's name comes second (custPerson, null without a shop name). */
export const custName = (c) => String(c?.shop_name || '').trim() || c?.name || '';
export const custPerson = (c) => (String(c?.shop_name || '').trim() ? c.name : null);

/**
 * Times. Every record is stamped when it is saved (created_at, "YYYY-MM-DD HH:MM:SS" in UTC);
 * these show it on this computer's clock: "03:45 PM" and "25/10/2026 · 03:45 PM".
 */
export const fromStamp = (s) => (s ? new Date(String(s).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(String(s)) ? '' : 'Z')) : null);
export function niceTime(s) {
  const d = fromStamp(s);
  return !d || Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true }).toUpperCase();
}
export function niceDateTime(s) {
  const d = fromStamp(s);
  if (!d || Number.isNaN(d.getTime())) return '—';
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${niceDate(day)} · ${niceTime(s)}`;
}

/**
 * A photo picked or taken on the phone, made small enough to save: at most 1600 px on its longest side, as a JPEG.
 * Resolves to a data URL ("data:image/jpeg;base64,…").
 */
export function shrinkPhoto(file, max = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || 'image/')) return reject(new Error('Choose a photo (JPG or PNG)'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be opened — try another one')); };
    img.src = url;
  });
}

/**
 * The shop's cost code. The ten letters of the code word stand for 1 to 9 and then 0 — with KNIGHTCLUB, K is 1, N is 2 …
 * U is 9, B is 0. A digit that repeats the one before it is written as the repeat letter instead (and the run starts
 * again), so 1000 reads KBSB. The code is of the cost per piece + the amount set to add (Rs 300) — staff can read it,
 * a customer can't; the real cost shown elsewhere doesn't change.
 */
export function costCode(cost, settings = {}, { add = true } = {}) {
  const word = String(settings.cost_code_word || 'KNIGHTCLUB').toUpperCase();
  const rep = String(settings.cost_code_repeat || 'S').toUpperCase();
  const value = Math.round(Math.abs(Number(cost) || 0) + (add ? Number(settings.cost_code_add ?? 300) || 0 : 0));
  let out = '';
  let prev = null;
  for (const d of String(value)) {
    if (d === prev) { out += rep; prev = null; continue; }
    out += word[(Number(d) + 9) % 10] || '?';
    prev = d;
  }
  return out;
}
/** A code read back to the number it stands for (null when it isn't a code). */
export function costDecode(code, settings = {}) {
  const word = String(settings.cost_code_word || 'KNIGHTCLUB').toUpperCase();
  const rep = String(settings.cost_code_repeat || 'S').toUpperCase();
  let out = '';
  let prev = null;
  for (const ch of String(code || '').toUpperCase().replace(/[^A-Z]/g, '')) {
    if (ch === rep) { if (prev === null) return null; out += prev; prev = null; continue; }
    const i = word.indexOf(ch);
    if (i < 0) return null;
    prev = String((i + 1) % 10);
    out += prev;
  }
  return out ? Number(out) : null;
}

/** The cost code to show for something: the one the server sent (Cashier, KP, Employee), or worked out from its cost. */
export const codeOf = (obj, cost, settings) => obj?.cost_code ?? costCode(cost, settings);
