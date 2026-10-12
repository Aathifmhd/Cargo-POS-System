import { all, get, run, getSettings, round2 } from './db.js';

/*
 * Live INR → LKR rate.
 * - "auto" mode: fetched every few minutes from free public sources (first one that answers wins).
 * - "manual" mode: an admin typed the rate; it stays until switched back to auto.
 * The current rate is kept in settings.default_exchange_rate, so GRNs and supplier payments start from it,
 * and unpaid (credit) GRNs are revalued with it — see revalueGrns() in services.js.
 */

const REFRESH_MS = 5 * 60_000;
let onChange = () => {};
export const setOnRateChange = (fn) => { onChange = fn; };

const UA = { 'User-Agent': 'Mozilla/5.0 (CargoPOS)' };
async function json(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const SOURCES = [
  {
    name: 'Yahoo Finance (live)',
    async rate() {
      // no direct INR/LKR pair, so cross the two USD quotes
      const q = async (s) => (await json(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=5m&range=1d`)).chart.result[0].meta.regularMarketPrice;
      const [usdLkr, usdInr] = await Promise.all([q('LKR=X'), q('INR=X')]);
      return usdLkr / usdInr;
    },
  },
  {
    name: 'ExchangeRate-API (daily)',
    async rate() { return (await json('https://open.er-api.com/v6/latest/INR')).rates.LKR; },
  },
  {
    name: 'Currency API (daily)',
    async rate() { return (await json('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/inr.json')).inr.lkr; },
  },
];

const setSetting = (k, v) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v ?? ''));
export const currentRate = () => Number(getSettings().default_exchange_rate) || 0;

function applyRate(rate, source) {
  const r = Math.round(rate * 10000) / 10000;
  const old = currentRate();
  setSetting('default_exchange_rate', r);
  setSetting('fx_source', source);
  setSetting('fx_updated_at', new Date().toISOString());
  const last = get('SELECT rate, at FROM fx_rates ORDER BY id DESC LIMIT 1');
  // keep a history point when the rate moves, and at least one per hour
  if (!last || last.rate !== r || Date.now() - new Date(last.at).getTime() > 3600_000) {
    run('INSERT INTO fx_rates (at, rate, source) VALUES (?, ?, ?)', new Date().toISOString(), r, source);
  }
  if (old !== r) onChange(r);
  return r;
}

export async function refreshRate() {
  const s = getSettings();
  if (s.fx_mode === 'manual') return fxStatus();
  const errors = [];
  for (const src of SOURCES) {
    try {
      const rate = await src.rate();
      if (!(rate > 1 && rate < 20)) throw new Error(`odd value ${rate}`);   // sanity: INR→LKR is a few rupees
      applyRate(rate, src.name);
      setSetting('fx_error', '');
      return fxStatus();
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  setSetting('fx_error', `Could not get the live rate (${errors.join('; ')}). Using the last known rate.`);
  return fxStatus();
}

export function setManualRate(rate) {
  setSetting('fx_mode', 'manual');
  setSetting('fx_error', '');
  applyRate(rate, 'Entered by hand');
  return fxStatus();
}

export async function setAutoMode() {
  setSetting('fx_mode', 'auto');
  return refreshRate();
}

export function fxStatus() {
  const s = getSettings();
  const rate = currentRate();
  const dayAgo = get(`SELECT rate FROM fx_rates WHERE at <= ? ORDER BY id DESC LIMIT 1`, new Date(Date.now() - 24 * 3600_000).toISOString())
    || get('SELECT rate FROM fx_rates ORDER BY id ASC LIMIT 1');
  const history = all(`SELECT at, rate FROM fx_rates ORDER BY id DESC LIMIT 60`).reverse();
  return {
    rate,
    mode: s.fx_mode || 'auto',
    source: s.fx_source || 'Settings',
    updated_at: s.fx_updated_at || null,
    error: s.fx_error || null,
    change: dayAgo ? round2((rate - dayAgo.rate) * 10000) / 10000 : 0,
    change_pct: dayAgo && dayAgo.rate ? round2(((rate - dayAgo.rate) / dayAgo.rate) * 100) : 0,
    history,
    refresh_seconds: REFRESH_MS / 1000,
  };
}

/**
 * Refresh when the stored rate is older than the refresh interval. Used on reads, because on
 * serverless hosting (Vercel) a background timer only runs while an instance happens to be alive.
 */
let inFlight = null;
export async function ensureFreshRate() {
  const s = getSettings();
  const age = s.fx_updated_at ? Date.now() - new Date(s.fx_updated_at).getTime() : Infinity;
  if (s.fx_mode === 'manual' || age < REFRESH_MS) return fxStatus();
  inFlight ??= refreshRate().finally(() => { inFlight = null; });
  return inFlight;
}

export function startFxTimer() {
  const tick = () => refreshRate().catch((e) => console.error('FX refresh failed:', e.message));
  tick();
  setInterval(tick, REFRESH_MS).unref?.();
}
