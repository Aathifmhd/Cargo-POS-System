import { useCallback, useEffect, useState } from 'react';

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

/** "12 sets + 3 pcs" */
export function stockText(pcs, perSet) {
  pcs = n(pcs);
  perSet = Math.max(1, n(perSet));
  if (perSet === 1) return `${int(pcs)} pcs`;
  const sets = Math.trunc(pcs / perSet);
  const loose = pcs - sets * perSet;
  return loose ? `${int(sets)} sets + ${loose} pcs` : `${int(sets)} sets`;
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
    const line_inr = r2(sets * n(it.cost_inr_per_set));
    return { sets, pcs_per_set: pcsPerSet, line_inr, pcs: sets * pcsPerSet };
  });
  const goods_inr = r2(lines.reduce((s, l) => s + l.line_inr, 0));
  const cargo_inr = n(cargo_charge_inr);
  const expenses_lkr = r2((expenses || []).reduce((s, e) => s + n(e.amount_lkr), 0));
  const overhead = cargo_inr * rate + expenses_lkr;
  const total_pcs = lines.reduce((s, l) => s + l.pcs, 0);
  const total_sets = lines.reduce((s, l) => s + l.sets, 0);
  const out = lines.map((l) => {
    const share = goods_inr > 0 ? l.line_inr / goods_inr : total_pcs > 0 ? l.pcs / total_pcs : 0;
    const landed = l.line_inr * rate + share * overhead;
    return {
      ...l,
      landed_lkr: r2(landed),
      landed_per_set_lkr: l.sets ? r2(landed / l.sets) : 0,
      landed_per_pcs_lkr: l.pcs ? r2(landed / l.pcs) : 0,
    };
  });
  const total_lkr = r2((goods_inr + cargo_inr) * rate + expenses_lkr);
  return {
    items: out, goods_inr, cargo_inr, expenses_lkr, total_sets, total_pcs, total_lkr,
    // how many rupees (LKR) it really costs to land 1 INR of goods
    landing_factor: goods_inr > 0 ? total_lkr / goods_inr : 0,
  };
}

export const PAY_METHODS_SUPPLIER = ['Bank transfer', 'Hawala', 'Cash', 'Cheque', 'UPI / Online'];
export const PAY_METHODS_CUSTOMER = ['Cash', 'Bank transfer', 'Cheque', 'Card', 'Online'];
