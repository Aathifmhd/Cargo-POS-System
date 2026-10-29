import { useEffect, useState } from 'react';

/*
 * Working without internet (a weak or lost connection, for a few hours).
 *
 *  - Every screen's data is kept on this device as it was last seen (IndexedDB), so pages still open offline.
 *  - New Sale and the Payment Portal keep working: a bill or payment made offline waits here (the outbox) and is
 *    sent by itself, in order, when the internet is back. Each carries its own id, so sending it twice never
 *    makes it twice (the server answers with the one already made).
 *  - Offline bills are numbered per device — OFF1-0001, OFF1-0002 … on Device 1 — so two phones never clash.
 * Everything else that changes data needs the internet and says so.
 */

/* ---------------- a small IndexedDB store ---------------- */
const DB_NAME = 'cargo-pos-offline';
let dbp = null;
function db() {
  dbp ??= new Promise((ok, no) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('cache'); r.result.createObjectStore('outbox'); };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
  return dbp;
}
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((ok, no) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => ok(out?.result);
    t.onerror = () => no(t.error);
  });
}
const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key)).catch(() => undefined);
const idbSet = (store, key, v) => run(store, 'readwrite', (s) => s.put(v, key)).catch(() => {});
const idbDel = (store, key) => run(store, 'readwrite', (s) => s.delete(key)).catch(() => {});
const idbAll = (store) => run(store, 'readonly', (s) => s.getAll()).catch(() => []);

/* ---------------- what each screen last saw ---------------- */
// one user's data is not shown to another on a shared device: the cache is kept per login
const userKey = () => { try { return `${localStorage.getItem('cargo-pos-user') || ''}${localStorage.getItem('cargo-pos-view') === '1' ? ':v' : ''}`; } catch { return ''; } };
export const cacheGet = (url) => idbGet('cache', `${userKey()}|${url}`);
export const cacheSet = (url, data) => idbSet('cache', `${userKey()}|${url}`, data);
/** Change what a screen last saw (e.g. the stock after an offline bill), so the next offline bill sees it too. */
export async function cachePatch(url, fn) {
  const v = await cacheGet(url);
  if (v !== undefined) await cacheSet(url, fn(v));
}

/**
 * The dues lists after an offline payment: `amount` off one party's bills — the bill chosen first, then the oldest —
 * and the bills paid off leave the list. rows: the Payment Portal's list; partyKey: 'customer_id' or 'supplier_id'.
 */
export function settleRows(rows, partyKey, partyId, billId, amount) {
  let left = Number(amount) || 0;
  const out = rows.map((r) => ({ ...r }));
  const when = (r) => String(r.due_date || r.date || '');
  const order = out.map((r, i) => [r, i]).filter(([r]) => r[partyKey] === partyId)
    .sort(([a], [b]) => (a.id === billId ? -1 : b.id === billId ? 1 : when(a).localeCompare(when(b))));
  for (const [r] of order) {
    if (left <= 0.009) break;
    const take = Math.min(r.balance, left);
    r.balance = Math.round((r.balance - take) * 100) / 100;
    if (r.balance_after_cheques != null) r.balance_after_cheques = Math.max(0, Math.round((r.balance_after_cheques - take) * 100) / 100);
    left -= take;
  }
  return out.filter((r) => r[partyKey] !== partyId || r.balance > 0.009);
}

/* ---------------- online / offline ---------------- */
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
const subs = new Set();
const tell = () => subs.forEach((f) => f());
export const isOnline = () => online;
export function noteOnline() {
  if (online) return;
  online = true; tell();
  sync();
}
export function noteOffline() {
  if (!online) return;
  online = false; tell();
  ping();
}
// while offline, check every 15 seconds whether the internet is back
let pinging = null;
function ping() {
  if (pinging) return;
  pinging = setInterval(async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (r.ok) { clearInterval(pinging); pinging = null; noteOnline(); }
    } catch { /* still offline */ }
  }, 15_000);
}
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok && noteOnline()).catch(() => {}); });
  window.addEventListener('offline', noteOffline);
  if (!online) ping();
}

/** A request that failed for lack of internet (no answer, or no answer in time). */
export class OfflineError extends Error {
  constructor() { super('No internet connection'); this.offline = true; }
}

/* ---------------- the outbox: bills and payments made offline ---------------- */
export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);
/** Keep a bill or payment to send when the internet is back. item: { url, body (with client_id), kind, label, amount } */
export async function enqueue(item) {
  const it = { ...item, id: item.body.client_id, at: Date.now(), status: 'pending', error: null };
  await idbSet('outbox', it.id, it);
  tell();
  return it;
}
export const outbox = async () => (await idbAll('outbox')).sort((a, b) => a.at - b.at);

let syncing = false;
let token = () => null;
export const setTokenGetter = (fn) => { token = fn; };
/** Send what waits in the outbox, oldest first. Stops at the first sign of no internet. */
export async function sync() {
  if (syncing || !online) return;
  syncing = true; tell();
  let sent = 0;
  try {
    for (const it of await outbox()) {
      if (it.status !== 'pending') continue;
      let res;
      try {
        res = await fetch(`/api${it.url}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, 'X-Offline': '1' },
          body: JSON.stringify(it.body), signal: AbortSignal.timeout(30_000),
        });
      } catch { noteOffline(); break; }
      const data = await res.json().catch(() => ({}));
      if (res.ok) { await idbDel('outbox', it.id); sent++; continue; }
      if (res.status === 401 || res.status >= 500) break;   // logged out, or the server is struggling: try again later
      await idbSet('outbox', it.id, { ...it, status: 'failed', error: data.error || `Refused (${res.status})` });
    }
  } finally {
    syncing = false; tell();
    if (sent) window.dispatchEvent(new CustomEvent('cargo-pos-synced', { detail: { sent } }));
  }
}
/** A failed item: try it again, or throw it away. */
export async function retry(id) {
  const it = await idbGet('outbox', id);
  if (it) await idbSet('outbox', id, { ...it, status: 'pending', error: null });
  tell();
  return sync();
}
export async function discard(id) { await idbDel('outbox', id); tell(); }

/** { online, syncing, items } — for the banner, and for screens that show what is waiting. */
export function useOffline() {
  const [state, setState] = useState({ online, syncing, items: [] });
  useEffect(() => {
    let live = true;
    const update = () => outbox().then((items) => live && setState({ online, syncing, items }));
    subs.add(update);
    update();
    return () => { live = false; subs.delete(update); };
  }, []);
  return state;
}

/* ---------------- offline bill numbers (per device) ---------------- */
const DEVICE_KEY = 'cargo-pos-device';
const SEQ_KEY = 'cargo-pos-offline-seq';
export const deviceNo = () => { try { return Number(localStorage.getItem(DEVICE_KEY)) || null; } catch { return null; } };
export const setDeviceNo = (n) => { try { localStorage.setItem(DEVICE_KEY, String(n)); } catch { /* private mode */ } };
const seq = () => { try { return Number(localStorage.getItem(SEQ_KEY)) || 0; } catch { return 0; } };
/** The number the next offline bill on this device will get. */
export const peekOfflineNo = () => (deviceNo() ? `OFF${deviceNo()}-${String(seq() + 1).padStart(4, '0')}` : null);
/** Take that number (it is never given again on this device). */
export function takeOfflineNo() {
  const no = peekOfflineNo();
  if (no) { try { localStorage.setItem(SEQ_KEY, String(seq() + 1)); } catch { /* private mode */ } }
  return no;
}
/** "YYYY-MM-DD HH:MM:SS" (UTC), like the server's time stamps. */
export const stampNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
