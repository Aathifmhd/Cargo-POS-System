import {
  find, findOne, insert, setById, deleteMany, tx, fail, num, round2, sum, todayStr, allocate, byDateId, inParallel, stamp, cargoAdjustsOf, itemShortPcs,
} from './db.js';
import { isLocal, costingRate, revalueGrns, markReturned } from './services.js';

/* =========================================================
   CHEQUES
   A cheque we give (to a cargo company or a supplier) settles the bill when it is handed over; if it comes back
   RETURNED, the payment is undone and the bill is owed again. A cheque we receive (from a customer) only takes their
   due down once it is PASSED. HOLDING (the cheque is held back, not deposited yet) changes no money.
   ========================================================= */
export const CHEQUE_STATUS = ['pending', 'holding', 'passed', 'returned'];
const PARTY = { customer: 'customer_payments', supplier: 'supplier_payments', cargo: 'cargo_payments' };

/** Should this cheque have a payment on the books right now? */
const counts = (ch) => (ch.direction === 'in' ? ch.status === 'passed' : ch.status !== 'returned');

/** Make the payment behind a cheque match its status (create it, or remove it). */
async function syncPayment(ch) {
  const want = counts(ch);
  if (want && !ch.payment_id) {
    const base = { date: ch.direction === 'in' ? (ch.passed_on || todayStr()) : ch.given_on || todayStr(), method: 'Cheque',
      reference: `Cheque ${ch.cheque_no}`, notes: ch.notes || null, cheque_id: ch.id };
    let p;
    if (ch.party === 'customer') {
      p = await insert('customer_payments', { ...base, customer_id: ch.party_id, sale_id: ch.bill_id ?? null, amount: ch.amount });
    } else if (ch.party === 'supplier') {
      const s = await findOne('suppliers', { id: ch.party_id });
      const rate = isLocal(s) ? 1 : await costingRate();
      p = await insert('supplier_payments', { ...base, supplier_id: ch.party_id, grn_id: ch.bill_id ?? null, amount_inr: ch.amount, exchange_rate: rate, amount_lkr: round2(ch.amount * rate) });
    } else {
      p = await insert('cargo_payments', { ...base, cargo_name: ch.party_name, amount: ch.amount });
    }
    await setById('cheques', ch.id, { payment_id: p.id });
    ch.payment_id = p.id;
  } else if (!want && ch.payment_id) {
    await deleteMany(PARTY[ch.party], { id: ch.payment_id });
    await setById('cheques', ch.id, { payment_id: null });
    ch.payment_id = null;
  }
}

/** The cheques of one payment: [{ owner, bank, cheque_no, amount, cheque_date }] — at least one, each with a number, amount and date. */
export function cleanCheques(list) {
  const out = (Array.isArray(list) ? list : []).map((c) => ({
    owner: String(c.owner || '').trim() || null, bank: String(c.bank || '').trim() || null, cheque_no: String(c.cheque_no || '').trim(), amount: round2(num(c.amount)),
    cheque_date: /^\d{4}-\d{2}-\d{2}$/.test(String(c.cheque_date || '')) ? c.cheque_date : null,
  })).filter((c) => c.cheque_no || c.amount);
  if (!out.length) fail('Add the cheque details (number, amount and date)');
  for (const c of out) {
    if (!c.cheque_no) fail('Each cheque needs its cheque number');
    if (!(c.amount > 0)) fail(`Cheque ${c.cheque_no}: enter the amount`);
    if (!c.cheque_date) fail(`Cheque ${c.cheque_no}: enter the cheque date`);
  }
  return out;
}

/**
 * Record the cheques of a payment. direction 'out' (we pay a supplier or cargo) or 'in' (a customer pays us).
 * party: 'customer' | 'supplier' | 'cargo'; partyId (customer / supplier id) or the cargo company name.
 */
export async function recordCheques({ direction, party, partyId = null, partyName, billId = null, cheques, givenOn, notes = null, user = null, clientId = null }) {
  const made = [];
  for (const c of cheques) {
    const ch = await insert('cheques', {
      direction, party, party_id: partyId, party_name: partyName, bill_id: billId, ...c, status: 'pending', given_on: givenOn || todayStr(),
      notes, payment_id: null, history: [{ status: 'pending', at: stamp(), by: user?.username || null }], client_id: clientId,
    });
    await syncPayment(ch);
    made.push(ch);
  }
  if (party === 'supplier') await revalueGrns();
  return made;
}

/**
 * Mark a cheque passed, returned, holding — or back to waiting (pending).
 * Put back to waiting after it was passed or returned, it is not passed automatically again (no_auto).
 */
export async function setChequeStatus(id, status, user = null, note = null, { passedOn = null } = {}) {
  if (!CHEQUE_STATUS.includes(status)) fail('Choose passed, returned, holding or pending');
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  if (ch.status === status) return ch;
  await tx(async () => {
    const undo = status === 'pending' && ['passed', 'returned'].includes(ch.status);
    ch.status = status;
    if (status === 'passed') ch.passed_on = passedOn || todayStr();
    await setById('cheques', id, {
      status, ...(status === 'passed' ? { passed_on: ch.passed_on } : {}), ...(undo ? { no_auto: 1 } : {}),
      history: [...(ch.history || []), { status, at: stamp(), by: user?.username || null, note: note || null }],
    });
    await syncPayment(ch);
  });
  if (ch.party === 'supplier') await revalueGrns();
  return findOne('cheques', { id });
}

/**
 * Correct a cheque entered wrongly (owner, bank, number, amount, date, notes). A cheque that is on the books
 * (given, or a customer's passed one) has its payment corrected too.
 */
export async function updateCheque(id, body, user = null) {
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  const [c] = cleanCheques([{ owner: body.owner ?? ch.owner, bank: body.bank ?? ch.bank, cheque_no: body.cheque_no ?? ch.cheque_no, amount: body.amount ?? ch.amount, cheque_date: body.cheque_date ?? ch.cheque_date }]);
  const notes = body.notes !== undefined ? String(body.notes || '').trim() || null : ch.notes;
  const newDate = c.cheque_date !== ch.cheque_date;   // a new cheque date: it passes automatically on that date again
  const changes = Object.entries({ ...c, notes }).filter(([k, v]) => v !== (ch[k] ?? null)).map(([k]) => k);
  if (!changes.length) return ch;
  await tx(async () => {
    await setById('cheques', id, { ...c, notes, ...(newDate ? { no_auto: 0 } : {}), history: [...(ch.history || []), { status: ch.status, at: stamp(), by: user?.username || null, note: `Edited: ${changes.join(', ')}` }] });
    if (ch.payment_id) {
      const base = { reference: `Cheque ${c.cheque_no}`, notes };
      if (ch.party === 'customer') await setById('customer_payments', ch.payment_id, { ...base, amount: c.amount });
      else if (ch.party === 'cargo') await setById('cargo_payments', ch.payment_id, { ...base, amount: c.amount });
      else {
        const p = await findOne('supplier_payments', { id: ch.payment_id });
        await setById('supplier_payments', ch.payment_id, { ...base, amount_inr: c.amount, amount_lkr: round2(c.amount * (p?.exchange_rate || 1)) });
      }
    }
  });
  if (ch.party === 'supplier') await revalueGrns();
  return findOne('cheques', { id });
}

/** Remove a cheque entered by mistake — and the payment it made, so the bill is owed again. */
export async function deleteCheque(id) {
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  await tx(async () => {
    if (ch.payment_id) await deleteMany(PARTY[ch.party], { id: ch.payment_id });
    await deleteMany('cheques', { id });
  });
  if (ch.party === 'supplier') await revalueGrns();
  return { ok: true };
}

/* =========================================================
   AUTO-PASS: a waiting cheque passes by itself at 3:00 PM (Sri Lanka time) on its cheque date.
   Cheques on hold, and ones put back to waiting by hand, are left alone.
   ========================================================= */
export const AUTO_PASS_HOUR = 15;
/** Now in Sri Lanka: { date: 'YYYY-MM-DD', hour } (the server may run in another time zone). */
export function lankaNow(at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
/** The last cheque date that has reached 3:00 PM: today from 3 PM, else yesterday. */
export function autoPassUpTo(at = new Date()) {
  const { date, hour } = lankaNow(at);
  if (hour >= AUTO_PASS_HOUR) return date;
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export async function autoPassCheques(at = new Date()) {
  const due = await find('cheques', { status: 'pending', no_auto: { $ne: 1 }, cheque_date: { $lte: autoPassUpTo(at) } }, { project: { id: 1, cheque_date: 1 } });
  for (const ch of due) {
    await setChequeStatus(ch.id, 'passed', { username: 'Auto' }, 'Passed automatically at 3:00 PM on the cheque date', { passedOn: ch.cheque_date });
  }
  return due.length;
}
let lastAuto = 0;
/** Run the auto-pass at most once a minute, before a request is answered. */
export async function autoPassSoon() {
  if (Date.now() - lastAuto < 60_000) return;
  lastAuto = Date.now();
  try { await autoPassCheques(); } catch (e) { lastAuto = 0; console.error('Auto-pass of cheques failed:', e.message); }
}

/* =========================================================
   CARGO — what is owed to each cargo company (the cargo charges of the GRNs, paid in bulk, oldest first)
   ========================================================= */
/** A GRN's cargo charge in Rs: the items' cargo (and older shared cargo lines), plus cargo paid in ₹ on the oldest GRNs. */
export const grnCargoLkr = (g) => round2((g.cargo_charge_inr || 0) * (g.exchange_rate || 0) + (g.expenses_lkr || 0) - (g.other_lkr || 0));
const cargoKey = (name) => String(name || '').trim().toLowerCase();

export async function cargoLedgers() {
  const [grns, pays, cheques, settled, cargos] = await inParallel(
    () => find('grns', {}, { project: { id: 1, grn_no: 1, date: 1, currency: 1, cargo_id: 1, cargo_name: 1, cargo_charge_inr: 1, exchange_rate: 1, expenses_lkr: 1, other_lkr: 1, supplier_id: 1, total_pcs: 1 } }),
    () => find('cargo_payments'),
    () => find('cheques', { party: 'cargo' }, { project: { id: 1, party_name: 1, cheque_no: 1, amount: 1, history: 1, status: 1, bank: 1, given_on: 1 } }),
    // Extra & Short settled with the cargo
    () => find('grn_items', { $or: [{ short_status: { $in: ['cargo', 'received'] } }, { extra_status: { $in: ['cargo', 'billed', 'next'] } }] }),
    () => find('cargos', {}, { project: { id: 1, name: 1 } }),
  );
  const returned = cheques.filter((ch) => ch.status === 'returned');
  const chequeOf = Object.fromEntries(cheques.map((ch) => [ch.id, ch]));
  const companies = new Map();
  const of = (name) => {
    const key = cargoKey(name);
    if (!companies.has(key)) companies.set(key, { key, cargo_name: String(name || '').trim() || 'Cargo not named', grns: [], payments: [] });
    return companies.get(key);
  };
  for (const k of cargos) of(k.name).cargo_id = k.id;   // every cargo company, even before its first shipment
  // the Extra & Short settlements, on the shipment they belong to: "Paid with next bill" goes onto that cargo's next shipment
  const sorted = grns.sort(byDateId);
  const grnById = new Map(sorted.map((g) => [g.id, g]));
  const adjust = new Map();   // grn id → [{ label, amount }]
  const pending = [];         // "next bill" with no later shipment yet
  for (const it of settled) for (const { kind, amount } of cargoAdjustsOf(it)) {
    const g = grnById.get(it.grn_id);
    if (!g) continue;
    const short = kind === 'short' || kind === 'received';
    const label = kind === 'short' ? `${it.name}: ${itemShortPcs(it)} pcs short — lost by the cargo (${g.grn_no})`
      : kind === 'received' ? `${it.name}: ${itemShortPcs(it)} short pcs received later — their cargo charge (${g.grn_no})`
        : `${it.name}: ${it.extra_pcs} extra pcs — paid to the cargo${kind === 'next' ? ' with the next bill' : ''} (${g.grn_no})`;
    // on the shipment they belong to (older "next bill" extras: onto that cargo's next shipment)
    if (short || kind === 'billed') { adjust.set(g.id, [...(adjust.get(g.id) || []), { label, amount }]); continue; }
    const after = sorted.find((x) => cargoKey(x.cargo_name) === cargoKey(g.cargo_name) && byDateId(x, g) > 0);
    if (after) adjust.set(after.id, [...(adjust.get(after.id) || []), { label, amount }]);
    else pending.push({ g, it, label, amount });
  }
  for (const g of sorted) {
    if (g.currency === 'LKR') continue;   // a local supplier's transport is not owed to a cargo company
    const adj = adjust.get(g.id) || [];
    const base = grnCargoLkr(g);
    const amount = round2(base + sum(adj, (a) => a.amount));
    if (base > 0.009 || adj.length) { const c = of(g.cargo_name); if (!c.cargo_id) c.cargo_name = String(g.cargo_name || '').trim() || c.cargo_name; c.grns.push({ ...g, amount, cargo_lkr: base, adjustments: adj }); }
  }
  // extras to pay with the next bill, before the next shipment has come: a line of its own
  for (const x of pending) {
    of(x.g.cargo_name).grns.push({ id: `x${x.it.id}`, grn_no: `${x.g.grn_no} extras`, date: x.it.extra_date || x.g.date, total_pcs: x.it.extra_pcs, amount: x.amount, cargo_lkr: 0, adjustments: [{ label: x.label, amount: x.amount }], pending: true });
  }
  for (const c of companies.values()) c.grns.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  // each payment says how its cheque stands (waiting, holding, passed)
  for (const p of pays.sort(byDateId)) {
    const ch = p.cheque_id ? chequeOf[p.cheque_id] : null;
    of(p.cargo_name).payments.push(ch ? { ...p, cheque_status: ch.status, cheque_bank: ch.bank || null } : p);
  }
  return [...companies.values()].map((c) => {
    const bills = markReturned(allocate(c.grns.map((g) => ({ id: g.id, grn_no: g.grn_no, date: g.date, pcs: g.total_pcs, amount: g.amount, cargo_lkr: g.cargo_lkr, adjustments: g.adjustments, pending: g.pending || false, linkedPaid: 0 })), sum(c.payments, (p) => p.amount)), returned.filter((ch) => cargoKey(ch.party_name) === c.key));
    // which payments paid which shipment (oldest payments to the oldest shipments): "Paid by cheque" and the cheques' status
    let pi = 0; let left = c.payments[0]?.amount || 0;
    for (const b of bills) {
      let need = round2(b.amount - b.balance);
      const by = [];
      while (need > 0.009 && pi < c.payments.length) {
        const p = c.payments[pi];
        const take = Math.min(need, left);
        if (take > 0.009) by.push(p);
        need = round2(need - take); left = round2(left - take);
        if (left <= 0.009) { pi++; left = c.payments[pi]?.amount || 0; }
      }
      b.paid_by_cheque = by.length > 0 && by.every((p) => p.cheque_status);
      b.cheque_statuses = [...new Set(by.filter((p) => p.cheque_status).map((p) => p.cheque_status))];
    }
    const total = round2(sum(bills, (b) => b.amount));
    const paid = round2(sum(c.payments, (p) => p.amount));
    // returned cheques are listed with the payments too (they paid nothing)
    const back = returned.filter((ch) => cargoKey(ch.party_name) === c.key).map((ch) => {
      const at = (ch.history || []).filter((h) => h.status === 'returned').pop()?.at;
      return { id: `r${ch.id}`, date: at ? String(at).slice(0, 10) : ch.given_on, method: 'Cheque', reference: `Cheque ${ch.cheque_no}`, amount: ch.amount, cheque_status: 'returned', cheque_bank: ch.bank || null, returned: true };
    });
    return {
      key: c.key, cargo_id: c.cargo_id ?? null, cargo_name: c.cargo_name, named: Boolean(c.key), shipments: bills.filter((b) => !b.pending).length, total, paid,
      balance: round2(sum(bills, (b) => b.balance)), credit: round2(Math.max(0, paid - total)),
      last_date: bills.length ? bills[bills.length - 1].date : null, bills,
      cheques_returned: bills.flatMap((b) => b.cheques_returned || []), payments: [...c.payments, ...back].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1)).reverse(),
    };
  }).sort((a, b) => b.balance - a.balance || a.cargo_name.localeCompare(b.cargo_name));
}

/** Pay a cargo company: cash (one payment) or cheques (one payment per cheque, settled when handed over). */
export async function payCargo({ cargo_name, date, method, amount, reference, notes, cheques }, user) {
  const name = String(cargo_name || '').trim();
  if (!name || name === 'Cargo not named') fail('Choose the cargo company');
  if (method === 'Cheque') {
    const list = cleanCheques(cheques);
    return tx(() => recordCheques({ direction: 'out', party: 'cargo', partyName: name, cheques: list, givenOn: date, notes, user }));
  }
  const amt = round2(num(amount));
  if (!(amt > 0)) fail('Enter the amount paid');
  return [await insert('cargo_payments', { cargo_name: name, date: date || todayStr(), amount: amt, method: method || 'Cash', reference: reference || null, notes: notes || null, cheque_id: null })];
}
