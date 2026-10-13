import { useCallback, useEffect, useState } from 'react';

/* ---------------- catalogue (Settings → Categories, products & sizes) ---------------- */
/** [{ name, sizes: [], types: [] }] from settings.catalog */
export function parseCatalog(settings) {
  try {
    const list = JSON.parse(settings?.catalog || '[]');
    return Array.isArray(list) ? list.filter((c) => c && c.name).map((c) => ({ name: c.name, sizes: c.sizes || [], types: c.types || [], reorder_sets: Math.max(0, Math.round(Number(c.reorder_sets) || 0)) })) : [];
  } catch { return []; }
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
export const ROLE_NAME = { cashier: 'Cashier', admin: 'Admin', superadmin: 'Super Admin' };
const RANK = { cashier: 0, admin: 1, superadmin: 2 };
export const isAdmin = (u) => (RANK[u?.role] ?? 0) >= 1;
export const isSuper = (u) => u?.role === 'superadmin';

/* ---------------- session ---------------- */
const TOKEN_KEY = 'cargo-pos-token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

// Set by <ApprovalProvider>: shows the admin-credentials box and resolves to an approval token (or null if cancelled).
let approvalHandler = null;
export const setApprovalHandler = (fn) => { approvalHandler = fn; };

/* ---------------- API ---------------- */
async function request(method, url, body, approval) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (approval) headers['X-Approval'] = approval;
  const res = await fetch('/api' + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
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
  post: (url, body = {}) => request('POST', url, body),
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
  const d = new Date(s.slice(0, 10) + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
    const cost = n(it.cost_inr_per_set);
    const q = (v) => Math.max(0, Math.round(n(v)));
    // extra pieces are billed by the supplier at the per-piece price;
    // shorts are still paid in full, so their cost is spread over the pieces that did arrive
    const extra_pcs = q(it.extra_pcs);
    const extra_sets = q(it.extra_sets); // older GRNs only: free sets, not billed
    const short_sets = q(it.short_sets);
    const short_pcs = q(it.short_pcs);
    const line_inr = r2(sets * cost + extra_pcs * (cost / pcsPerSet));
    return {
      sets, pcs_per_set: pcsPerSet, line_inr, extra_sets, extra_pcs, short_sets, short_pcs,
      set_pcs: sets * pcsPerSet,                       // pieces in the billed sets
      billed_pcs: sets * pcsPerSet + extra_pcs,        // pieces on the supplier's bill
      pcs: Math.max(0, (sets + extra_sets - short_sets) * pcsPerSet + extra_pcs - short_pcs), // pieces really received
      // the supplier's price for one piece, in LKR
      bill_per_pcs_lkr: r2((n(it.cost_inr_per_set) / pcsPerSet) * rate),
    };
  });
  const goods_inr = r2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = n(cargo_charge_inr);
  const expenses_lkr = r2((expenses || []).reduce((s, e) => s + n(e.amount_lkr), 0));
  const overhead = cargo_inr * rate + expenses_lkr;
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + Math.max(0, l.sets + l.extra_sets - l.short_sets), 0);
  // a line's landed cost is spread over every piece received (billed + free)
  const out = lines.map((l) => {
    const share = goods_inr > 0 ? l.line_inr / goods_inr : total_pcs > 0 ? l.pcs / total_pcs : 0;
    const landed = l.line_inr * rate + share * overhead;
    const perPcs = l.pcs ? landed / l.pcs : 0;
    return {
      ...l,
      landed_lkr: r2(landed),
      landed_per_set_lkr: r2(perPcs * l.pcs_per_set),
      landed_per_pcs_lkr: r2(perPcs),
    };
  });
  const total_lkr = r2((goods_inr + cargo_inr) * rate + expenses_lkr);
  return {
    items: out, goods_inr, cargo_inr, expenses_lkr, total_sets, total_pcs, total_lkr,
    // how many rupees (LKR) it really costs to land 1 INR of goods
    landing_factor: goods_inr > 0 ? total_lkr / goods_inr : 0,
  };
}

export const PAY_METHODS_SUPPLIER = ['Bank transfer', 'Cash', 'Cheque', 'UPI / Online'];
export const PAY_METHODS_CUSTOMER = ['Cash', 'Bank transfer', 'Cheque', 'Card', 'Online'];

/* ---------------- automatic selling price & MRP (Settings → Price & billing) ---------------- */
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
