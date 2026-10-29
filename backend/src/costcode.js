/*
 * Who may see what a product costs: users with the "see costs" permission (Admins and the Super Admin by default; set
 * per user in Users & Security). For everyone else every cost and profit figure is taken out of what the server sends —
 * they get the cost code instead (the shop's letters, of the cost per piece + the amount set). The other permissions
 * open the parts of the system (checkPaths).
 */
import { getSettings, findOne, setSetting } from './db.js';
import { can } from './auth.js';

/** The cost code (see Settings → Cost code): the code word's ten letters are 1…9, 0; a repeated digit is the repeat letter. */
export function costCode(cost, settings = {}) {
  const word = String(settings.cost_code_word || 'KNIGHTCLUB').toUpperCase();
  const rep = String(settings.cost_code_repeat || 'S').toUpperCase();
  const value = Math.round(Math.abs(Number(cost) || 0) + (Number(settings.cost_code_add ?? 300) || 0));
  let out = '';
  let prev = null;
  for (const d of String(value)) {
    if (d === prev) { out += rep; prev = null; continue; }
    out += word[(Number(d) + 9) % 10] || '?';
    prev = d;
  }
  return out;
}

/** Fields that tell what something cost (or made) — never sent to a Cashier, KP or Employee. */
const HIDDEN = new Set([
  'cost_per_pcs', 'last_cost_per_pcs', 'opening_cost_per_pcs', 'cost_per_set', 'cost_total', 'cost_per_unit', 'cost',
  'landed_lkr', 'landed_per_pcs_lkr', 'landed_per_set_lkr', 'cost_inr_per_set', 'line_inr', 'goods_inr', 'total_lkr',
  'profit', 'gross_profit', 'net_profit', 'invoice_profit', 'damaged_cost', 'damage_sold_cost', 'cost_value', 'margin',
]);

/** In the discreet view (see frontend lib.js) also: who the goods came from, and the import rate. */
const DISCREET_HIDDEN = new Set(['supplier_name', 'supplier_code', 'supplier_phone', 'supplier_city', 'exchange_rate', 'effective_rate']);

function strip(v, settings, discreet = false) {
  if (Array.isArray(v)) return v.map((x) => strip(x, settings, discreet));
  if (!v || typeof v !== 'object' || v instanceof Date || Buffer.isBuffer(v)) return v;
  const out = {};
  // a cost per piece becomes its cost code
  if (typeof v.cost_per_pcs === 'number' && v.cost_code === undefined) out.cost_code = costCode(v.cost_per_pcs, settings);
  for (const [k, x] of Object.entries(v)) {
    if (HIDDEN.has(k) || (discreet && DISCREET_HIDDEN.has(k))) continue;
    out[k] = strip(x, settings, discreet);
  }
  return out;
}

export const seesCost = (user) => can(user, 'see_cost');

/*
 * The discreet view is one switch for the whole shop (settings.discreet_view): when someone turns it on, on any
 * device, every user's screens become the counter view, and costs and supplier details leave every answer.
 * Each answer says how it stands (X-View-State), so the other devices follow with their next call.
 */
let view = { on: false, at: 0 };
export async function viewOn() {
  if (Date.now() - view.at < 5000) return view.on;
  const row = await findOne('settings', { key: 'discreet_view' });
  view = { on: row?.value === '1', at: Date.now() };
  return view.on;
}
export async function setView(on) {
  await setSetting('discreet_view', on ? '1' : '0');
  view = { on, at: Date.now() };
}

/** Express middleware (after the login check): for users who can't see costs, take them out of every answer. */
export async function hideCosts(req, res, next) {
  try {
    const discreet = await viewOn();   // the discreet view: as for a cashier, whoever is logged in
    res.set('X-View-State', discreet ? '1' : '0');
    if (!req.user || (seesCost(req.user) && !discreet)) return next();
    const settings = await getSettings();
    const json = res.json.bind(res);
    res.json = (body) => json(strip(body, settings, discreet));
    next();
  } catch (e) { next(e); }
}

/** A part of the system only users with this permission may open (see auth.js PERMS). */
export const needs = (perm, what) => (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: `You don't have permission for ${what}. Ask the Super Admin.` }));

/** The API paths each permission opens (checked before the routes). */
const PATHS = [
  [/^\/(grns)(\/|$)/, 'receive_goods', 'receiving goods (GRNs)'],
  [/^\/(suppliers)(\/|$)/, 'suppliers', 'suppliers'],
  [/^\/(cargo)(\/|$)/, 'suppliers', 'cargo payments'],
  [/^\/dues\/payables/, 'suppliers', 'supplier dues'],
  [/^\/dues\/history/, 'dues', 'the Payment Portal'],
  [/^\/dues\//, 'dues', 'the Payment Portal'],
  [/^\/reports\/(stock|shipments)/, 'reports', 'Reports'],
  [/^\/cheques/, 'cheques', 'the Cheque Desk'],
  [/^\/bad-debts/, 'dues', 'the Payment Portal'],
];
export function checkPaths(req, res, next) {
  const hit = PATHS.find(([re]) => re.test(req.path));
  if (!hit) return next();
  // the payment history of suppliers and cargo is part of the suppliers permission
  if (hit[1] === 'dues' && req.path === '/dues/history' && ['payables', 'cargo'].includes(String(req.query.kind))) return needs('suppliers', 'supplier and cargo payments')(req, res, next);
  return needs(hit[1], hit[2])(req, res, next);
}
