import { find, findOne, insert, getSettings, setSetting, round2, inParallel } from './db.js';

/*
 * Live INR → LKR rate.
 * - "auto" mode: fetched every few minutes from free public sources (first one that answers wins).
 * - "manual" mode: an admin typed the rate; it stays until switched back to auto.
 * The current rate is kept in settings.default_exchange_rate and shown on the dashboard for reference.
 * It does NOT change any costs: every cost uses the fixed costing rate (settings.costing_rate, 3.5 by default).
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

export const currentRate = async () => Number((await getSettings()).default_exchange_rate) || 0;

async function applyRate(rate, source) {
  const r = Math.round(rate * 10000) / 10000;
  const old = await currentRate();
  await setSetting('default_exchange_rate', r);
  await setSetting('fx_source', source);
  await setSetting('fx_updated_at', new Date().toISOString());
  const last = await findOne('fx_rates', {}, { sort: { id: -1 } });
  // keep a history point when the rate moves, and at least one per hour
  if (!last || last.rate !== r || Date.now() - new Date(last.at).getTime() > 3600_000) {
    await insert('fx_rates', { at: new Date().toISOString(), rate: r, source });
  }
  if (old !== r) onChange(r);
  return r;
}

export async function refreshRate() {
  const s = await getSettings();
  if (s.fx_mode === 'manual') return fxStatus();
  const errors = [];
  for (const src of SOURCES) {
    try {
      const rate = await src.rate();
      if (!(rate > 1 && rate < 20)) throw new Error(`odd value ${rate}`);   // sanity: INR→LKR is a few rupees
      await applyRate(rate, src.name);
      await setSetting('fx_error', '');
      return fxStatus();
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }
  await setSetting('fx_error', `Could not get the live rate (${errors.join('; ')}). Using the last known rate.`);
  return fxStatus();
}

export async function setManualRate(rate) {
  await setSetting('fx_mode', 'manual');
  await setSetting('fx_error', '');
  await applyRate(rate, 'Entered by hand');
  return fxStatus();
}

export async function setAutoMode() {
  await setSetting('fx_mode', 'auto');
  return refreshRate();
}

export async function fxStatus() {
  const [s, before, first, recent] = await inParallel(
    () => getSettings(),
    () => findOne('fx_rates', { at: { $lte: new Date(Date.now() - 24 * 3600_000).toISOString() } }, { sort: { id: -1 } }),
    () => findOne('fx_rates', {}, { sort: { id: 1 } }),
    () => find('fx_rates', {}, { sort: { id: -1 }, limit: 60, project: { at: 1, rate: 1 } }),
  );
  const rate = Number(s.default_exchange_rate) || 0;
  const dayAgo = before || first;
  const history = recent.reverse();
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
  const s = await getSettings();
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
