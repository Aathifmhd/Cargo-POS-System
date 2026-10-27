import { find, findOne, insert, updateOne, getSettings, round2, addDays, stamp } from './db.js';
import { customerLedgers, customerSummary, customerLabel, isLocal } from './services.js';
import { lankaNow } from './cheques.js';

/*
 * Automatic SMS (smslenz.lk).
 * The account keys stay out of the code and the database: SMSLENZ_USER_ID and SMSLENZ_API_KEY in backend/.env
 * (and in Vercel → Environment Variables). The sender ID, the switches and the wording are in Settings → SMS messages.
 *
 * Sent by themselves: a thank-you after every bill of a registered customer; due reminders on the days before a
 * credit bill is due (once a day, from 10:00 AM); a payment or a cheque to a local supplier.
 * Sent with a button: a customer's returned cheque (Cheque Desk → Returned).
 * Every SMS is written to sms_log; a `key` stops the same reminder going twice.
 */
const API = 'https://smslenz.lk/api';

/** The messages and their switches. {words} in braces are filled in when the SMS is sent. */
export const SMS_DEFAULTS = {
  sms_enabled: '0',
  sms_sender_id: '',
  sms_thanks_on: '1',
  sms_thanks_cash: 'Dear {customer}, thank you for shopping at {shop}. Bill {invoice}: {amount}. We look forward to serving you again.',
  sms_thanks_cash_due: 'Dear {customer}, thank you for shopping at {shop}. Bill {invoice}: {amount} paid. Your balance with us is {balance}.',
  sms_thanks_credit: 'Thank you {customer}! {shop} bill {invoice}: {amount}, {credit} on credit (due {due_date}). Your total balance is now {balance}.',
  sms_due_on: '1',
  sms_due_days: '3',
  sms_due_hour: '10',
  sms_due_text: 'Reminder from {shop}: {amount} on {invoices} is due {days} ({due_date}). Your total balance is {balance}. Thank you.',
  sms_cheque_text: 'Dear {customer}, your cheque #{cheque_no} ({bank}) for {amount} was returned unpaid. Please settle it soon. Balance: {balance}. {shop}',
  sms_sup_pay_on: '1',
  sms_sup_pay_text: 'Dear {supplier}, {shop} has paid you {amount} by {method}{for_grn}. Thank you.',
  sms_sup_cheque_on: '1',
  sms_sup_cheque_text: 'Dear {supplier}, {shop} has issued cheque #{cheque_no} ({bank}) of {amount}, dated {cheque_date}{for_grn}. Thank you.',
};
export const SMS_KEYS = Object.keys(SMS_DEFAULTS);

const rs = (v) => `Rs ${Number(v || 0).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
const on = (v) => String(v) === '1';

/** 07X XXX XXXX, 7XXXXXXXX, 947XXXXXXXX, +94 7X… → +947XXXXXXXX (null if it is not a Sri Lankan number). */
export function smsNumber(raw) {
  let d = String(raw || '').replace(/[^\d]/g, '');
  if (d.startsWith('0094')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = `94${d.slice(1)}`;
  else if (d.length === 9) d = `94${d}`;
  return /^94\d{9}$/.test(d) ? `+${d}` : null;
}

/** Fill {words} in a message; unknown ones are left out. */
export const fill = (text, vars) => String(text || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k]))).replace(/\s{2,}/g, ' ').trim();

const keys = () => ({ user_id: process.env.SMSLENZ_USER_ID, api_key: process.env.SMSLENZ_API_KEY });
const senderOf = (s) => String(s.sms_sender_id || process.env.SMSLENZ_SENDER_ID || '').trim() || 'SMSlenzDEMO';
export const smsReady = () => Boolean(keys().user_id && keys().api_key);

async function call(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...keys(), ...body }), signal: AbortSignal.timeout(8000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !json?.success) throw new Error(json?.message || `SMS service answered ${res.status}`);
  return json.data || {};
}

/**
 * Send one SMS and log it. Never throws for a bill or a payment (an SMS must not stop the shop) unless `strict`.
 * kind: thanks | due | cheque | sup_pay | sup_cheque | test
 */
export async function sendSms({ kind, phone, name, message, ref = null, key = null, user = null, strict = false }, settings = null) {
  const s = settings || await getSettings();
  const to = smsNumber(phone);
  const log = { at: stamp(), kind, to: to || String(phone || ''), name: name || null, message, ref, key, by: user?.username || 'System', ok: false, error: null, pages: null };
  try {
    if (!smsReady()) throw new Error('The SMS keys are not set (SMSLENZ_USER_ID, SMSLENZ_API_KEY)');
    if (!to) throw new Error(`"${phone || ''}" is not a mobile number`);
    if (!message) throw new Error('The message is empty');
    const data = await call('send-sms', { sender_id: senderOf(s), contact: to, message: message.slice(0, 1500) });
    log.ok = true;
    log.pages = data.pages ?? null;
  } catch (e) {
    log.error = e.name === 'TimeoutError' ? 'The SMS service did not answer in time' : e.message;
  }
  await insert('sms_log', log).catch((e) => console.error('SMS log failed:', e.message));
  if (strict && !log.ok) { const err = new Error(log.error); err.status = 400; throw err; }
  return log;
}

/** Credit left on the SMS account, and whether it is active. */
export async function smsAccount() {
  if (!smsReady()) return { ready: false };
  try {
    const d = await call('account-status', {});
    return { ready: true, status: d.status, balance: d.sms_credit_balance, plan: d.active_plan, senders: (d.sender_id_balances || []).map((x) => x.sender_id) };
  } catch (e) {
    return { ready: true, error: e.message };
  }
}

const phoneOf = (p) => p?.phone || p?.whatsapp || null;

/* ---------------- customers ---------------- */

/** After a bill: thank a registered customer (cash, cash with older dues, or credit with the balance). */
export async function billThanks(sale, user = null) {
  try {
    if (!sale?.customer_id || !(sale.total > 0)) return null;
    const s = await getSettings();
    if (!on(s.sms_enabled) || !on(s.sms_thanks_on)) return null;
    const c = await findOne('customers', { id: sale.customer_id });
    if (!phoneOf(c)) return null;
    const { balance } = await customerSummary(c.id);
    const credit = round2(sale.total - (sale.paid_at_sale || 0));
    const vars = {
      shop: s.shop_name, customer: customerLabel(c), invoice: sale.invoice_no, amount: rs(sale.total), paid: rs(sale.paid_at_sale),
      credit: rs(credit), balance: rs(balance), due_date: dmy(sale.due_date),
    };
    const text = sale.payment_type === 'credit' && credit > 0.009 ? s.sms_thanks_credit : balance > 0.009 ? s.sms_thanks_cash_due : s.sms_thanks_cash;
    return await sendSms({ kind: 'thanks', phone: phoneOf(c), name: vars.customer, message: fill(text, vars), ref: sale.invoice_no, user }, s);
  } catch (e) { console.error('Thank-you SMS failed:', e.message); return null; }
}

/** Cheque Desk → Returned → "Send message to inform": tell the customer their cheque came back. */
export async function chequeReturnedSms(ch, user) {
  const s = await getSettings();
  const c = await findOne('customers', { id: ch.party_id });
  if (!c) { const e = new Error('Customer not found'); e.status = 404; throw e; }
  if (!phoneOf(c)) { const e = new Error(`${customerLabel(c)} has no phone number — add it on the customer first`); e.status = 400; throw e; }
  const { balance } = await customerSummary(c.id);
  const vars = { shop: s.shop_name, customer: customerLabel(c), cheque_no: ch.cheque_no, bank: ch.bank || 'bank', amount: rs(ch.amount), cheque_date: dmy(ch.cheque_date), balance: rs(balance) };
  return sendSms({ kind: 'cheque', phone: phoneOf(c), name: vars.customer, message: fill(s.sms_cheque_text, vars), ref: `Cheque ${ch.cheque_no}`, user, strict: true }, s);
}

/** Due reminders: bills due in the next few days (one SMS a customer a day), from the set hour in Sri Lanka. */
export async function dueReminders({ force = false } = {}) {
  const s = await getSettings();
  if (!on(s.sms_enabled) || !on(s.sms_due_on) || !smsReady()) return { sent: 0, skipped: 'off' };
  const now = lankaNow();
  if (!force && now.hour < (Number(s.sms_due_hour) || 10)) return { sent: 0, skipped: 'too early' };
  const days = Math.max(1, Math.min(14, Number(s.sms_due_days) || 3));
  const today = now.date;
  const last = addDays(today, days);
  const done = new Set((await find('sms_log', { kind: 'due', key: { $regex: `:${today}$` } }, { project: { key: 1 } })).map((x) => x.key));
  let sent = 0;
  let failed = 0;
  for (const [cid, bills] of await customerLedgers()) {
    // bills still owed, due 1…days days from today (not today, not overdue)
    const soon = bills.filter((b) => b.id != null && b.balance > 0.009 && b.due_date && b.due_date > today && b.due_date <= last);
    if (!soon.length) continue;
    const key = `due:${cid}:${today}`;
    if (done.has(key) || await findOne('sms_log', { key, ok: true })) continue;
    const phone = soon[0].customer_phone || phoneOf(await findOne('customers', { id: cid }, { project: { phone: 1, whatsapp: 1 } }));
    if (!phone) continue;
    const first = soon.map((b) => b.due_date).sort()[0];
    const left = Math.round((new Date(`${first}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
    const vars = {
      shop: s.shop_name, customer: soon[0].customer_name, amount: rs(soon.reduce((t, b) => t + b.balance, 0)), invoices: soon.map((b) => b.invoice_no).join(', '),
      due_date: dmy(first), days: left === 1 ? 'tomorrow' : `in ${left} days`, balance: rs(bills.reduce((t, b) => t + (b.balance || 0), 0)),
    };
    const log = await sendSms({ kind: 'due', phone, name: vars.customer, message: fill(s.sms_due_text, vars), ref: vars.invoices, key }, s);
    if (log.ok) sent++; else failed++;
  }
  return { sent, failed };
}

let lastDue = 0;
/** Run the due reminders at most every 10 minutes while the app is used (Vercel's daily job runs them too). */
export async function dueRemindersSoon() {
  if (Date.now() - lastDue < 10 * 60_000) return;
  lastDue = Date.now();
  try { await dueReminders(); } catch (e) { lastDue = 0; console.error('Due reminder SMS failed:', e.message); }
}

/* ---------------- local suppliers ---------------- */

async function localSupplier(id) {
  const sup = await findOne('suppliers', { id });
  return sup && isLocal(sup) && phoneOf(sup) ? sup : null;
}
const forGrn = async (grnId) => {
  const g = grnId ? await findOne('grns', { id: grnId }, { project: { grn_no: 1, supplier_invoice_no: 1 } }) : null;
  return g ? ` for ${g.supplier_invoice_no ? `your bill ${g.supplier_invoice_no}` : g.grn_no}` : '';
};

/** A payment (not by cheque) to a local supplier. */
export async function supplierPaidSms(supplierId, p, user = null) {
  try {
    const s = await getSettings();
    if (!on(s.sms_enabled) || !on(s.sms_sup_pay_on)) return null;
    const sup = await localSupplier(supplierId);
    if (!sup) return null;
    const vars = { shop: s.shop_name, supplier: sup.name, amount: rs(p.amount_inr), method: (p.method || 'cash').toLowerCase(), for_grn: await forGrn(p.grn_id) };
    return await sendSms({ kind: 'sup_pay', phone: phoneOf(sup), name: sup.name, message: fill(s.sms_sup_pay_text, vars), ref: p.reference || null, user }, s);
  } catch (e) { console.error('Supplier payment SMS failed:', e.message); return null; }
}

/** Cheques given to a local supplier: one SMS a cheque. */
export async function supplierChequesSms(supplierId, cheques, user = null) {
  try {
    const s = await getSettings();
    if (!on(s.sms_enabled) || !on(s.sms_sup_cheque_on)) return;
    const sup = await localSupplier(supplierId);
    if (!sup) return;
    for (const ch of cheques) {
      const vars = { shop: s.shop_name, supplier: sup.name, cheque_no: ch.cheque_no, bank: ch.bank || 'bank', amount: rs(ch.amount), cheque_date: dmy(ch.cheque_date), for_grn: await forGrn(ch.bill_id) };
      await sendSms({ kind: 'sup_cheque', phone: phoneOf(sup), name: sup.name, message: fill(s.sms_sup_cheque_text, vars), ref: `Cheque ${ch.cheque_no}`, user }, s);
    }
  } catch (e) { console.error('Supplier cheque SMS failed:', e.message); }
}

/** New settings get their default wording once (safe on every start; what the shop changed stays). */
export async function setupSms() {
  for (const [key, value] of Object.entries(SMS_DEFAULTS)) await updateOne('settings', { key }, { $setOnInsert: { key, value } }, { upsert: true });
}
