import { find, findOne, insert, stamp, todayStr, addDays, round2, itemShortPcs } from './db.js';
import { supplierLedgers, customerLedgers, isLocal } from './services.js';

/*
 * Action Center → Attention: things the Super Admin should act on.
 * Some are sent the moment they happen (a returned cheque, a bill sold below cost, a big discount, a large cash
 * refund, wrong passwords); the rest are found by a check that runs every half hour (see attentionSoon).
 * Each is one row in audit_log with level 'attention'. A `key` stops the same thing being sent twice.
 */
export const LIMITS = {
  holdDays: 7,            // a cheque on hold this many days past its date
  overdueDays: 30,        // a customer bill overdue this many days…
  overdueMin: 25000,      // …with at least this much still owed (Rs)
  supplierDueDays: 3,     // a supplier bill due within this many days, still unpaid
  shortDays: 30,          // GRN short pieces not settled after this many days
  discountPct: 10,        // a bill's discounts above this share of the bill
  refundMin: 10000,       // a cash refund above this (Rs)
  wrongPasswords: 3,      // wrong passwords for one username…
  wrongMinutes: 15,       // …within this many minutes
};

const rs = (v) => `Rs ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

/** Send one Attention message (once per key). `user`: who caused it, if anyone. */
export async function attention(action, { key = null, user = null } = {}) {
  if (key && await findOne('audit_log', { key })) return false;
  await insert('audit_log', {
    at: stamp(), user_id: user?.id ?? null, username: user?.username ?? 'System', role: user?.role ?? null,
    action, approved_by: null, level: 'attention', key,
  });
  return true;
}

/* ---------------- sent as it happens ---------------- */

/** A cheque was marked returned: one of ours (we owe again) or a customer's (they owe again). */
export function chequeReturned(ch, user) {
  const amt = ch.party === 'supplier' && ch.currency === 'INR' ? `₹ ${ch.amount}` : rs(ch.amount);
  return ch.direction === 'in'
    ? attention(`Customer cheque returned: ${ch.cheque_no}${ch.bank ? ` (${ch.bank})` : ''} from ${ch.party_name}, ${amt} — ${ch.party_name} owes this again.`, { user })
    : attention(`Our cheque returned: ${ch.cheque_no}${ch.bank ? ` (${ch.bank})` : ''} given to ${ch.party_name}, ${amt} — it is owed to ${ch.party_name} again. Pay them another way.`, { user });
}

/** A bill: sold below cost, a big discount, or a large cash refund. */
export async function billChecks(sale, user) {
  const items = sale.items || [];
  const below = items.filter((i) => i.qty > 0 && i.cost_per_unit > 0 && (i.line_total / i.qty) < i.cost_per_unit);
  if (below.length) {
    await attention(`Sold below cost on ${sale.invoice_no} (${sale.customer_name}): ${below.map((i) => `${i.name} at ${rs(round2(i.line_total / i.qty))} — cost ${rs(i.cost_per_unit)}`).join('; ')}.`, { user });
  }
  const gross = items.filter((i) => i.qty > 0).reduce((t, i) => t + i.qty * i.price, 0);
  const off = items.filter((i) => i.qty > 0).reduce((t, i) => t + (i.disc || 0), 0) + (sale.discount || 0);
  if (gross > 0 && (off / gross) * 100 > LIMITS.discountPct) {
    await attention(`Big discount on ${sale.invoice_no} (${sale.customer_name}): ${rs(off)} off ${rs(gross)} — ${round2((off / gross) * 100)}% (more than ${LIMITS.discountPct}%).`, { user });
  }
  if (sale.total < 0 && sale.payment_type === 'cash' && -sale.total > LIMITS.refundMin) {
    await attention(`Large cash refund on ${sale.invoice_no} (${sale.customer_name}): ${rs(-sale.total)} paid back in cash (more than ${rs(LIMITS.refundMin)}).`, { user });
  }
}

/** Wrong password on the login page: after LIMITS.wrongPasswords in a row, the Super Admin is told. */
export async function wrongPassword(username) {
  const name = String(username || '').trim().slice(0, 60);
  if (!name) return;
  await insert('audit_log', { at: stamp(), user_id: null, username: name, role: null, action: `Wrong password on the login page for "${name}"`, approved_by: null, level: 'failed_login' });
  const since = new Date(Date.now() - LIMITS.wrongMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const lastOk = await findOne('audit_log', { username: name, action: 'Logged in', at: { $gte: since } }, { sort: { id: -1 } });
  const n = (await find('audit_log', { username: name, level: 'failed_login', at: { $gte: lastOk ? lastOk.at : since } })).length;
  if (n === LIMITS.wrongPasswords) {
    await attention(`${n} wrong passwords in a row for "${name}" on the login page (within ${LIMITS.wrongMinutes} minutes). If this wasn't them, someone may be guessing the password.`);
  }
}

/* ---------------- found by the regular check ---------------- */
export async function scanAttention() {
  const today = todayStr();
  let sent = 0;
  const send = async (action, key) => { if (await attention(action, { key })) sent++; };

  // cheques on hold long past their date
  for (const ch of await find('cheques', { status: 'holding', cheque_date: { $lte: addDays(today, -LIMITS.holdDays) } })) {
    await send(`Cheque on hold too long: ${ch.cheque_no} ${ch.direction === 'in' ? 'from' : 'to'} ${ch.party_name}, ${rs(ch.amount)} — dated ${dmy(ch.cheque_date)}, still on hold. Pass it, return it or release it.`, `hold:${ch.id}:${ch.cheque_date}`);
  }
  // big customer bills long overdue
  for (const b of [...(await customerLedgers()).values()].flat()) {
    if (b.id == null || b.balance < LIMITS.overdueMin || !b.due_date || b.due_date > addDays(today, -LIMITS.overdueDays)) continue;
    await send(`Big bill overdue: ${b.invoice_no} — ${b.customer_name} owes ${rs(b.balance)}, due ${dmy(b.due_date)} (more than ${LIMITS.overdueDays} days overdue).`, `overdue:${b.id}`);
  }
  // supplier bills due in the next few days, still unpaid
  const suppliers = Object.fromEntries((await find('suppliers', {}, { project: { id: 1, origin: 1 } })).map((s) => [s.id, s]));
  for (const b of [...(await supplierLedgers()).values()].flat()) {
    if (b.id == null || b.balance <= 0.009 || !b.due_date || b.due_date < today || b.due_date > addDays(today, LIMITS.supplierDueDays)) continue;
    const amt = isLocal(suppliers[b.supplier_id]) ? rs(b.balance) : `₹ ${b.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
    await send(`Supplier payment due soon: ${b.grn_no} — ${amt} to ${b.supplier_name}, due ${dmy(b.due_date)}.`, `supdue:${b.id}:${b.due_date}`);
  }
  // GRN short pieces never settled
  const old = await find('grns', { date: { $lte: addDays(today, -LIMITS.shortDays) } }, { project: { id: 1, grn_no: 1, date: 1 } });
  if (old.length) {
    const grnOf = Object.fromEntries(old.map((g) => [g.id, g]));
    for (const it of await find('grn_items', { grn_id: { $in: old.map((g) => g.id) }, short_status: null })) {
      const pcs = itemShortPcs(it);
      if (pcs <= 0) continue;
      const g = grnOf[it.grn_id];
      await send(`GRN short not settled: ${pcs} pcs of ${it.name} short on ${g.grn_no} (${dmy(g.date)}) — still not settled after ${LIMITS.shortDays} days. See Extra & Short.`, `short:${it.id}`);
    }
  }
  return sent;
}

let lastScan = 0;
/** Run the regular check at most every half hour, while the app is being used. */
export async function attentionSoon() {
  if (Date.now() - lastScan < 30 * 60_000) return;
  lastScan = Date.now();
  try { await scanAttention(); } catch (e) { lastScan = 0; console.error('Attention check failed:', e.message); }
}
