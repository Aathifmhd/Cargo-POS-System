import { Router } from 'express';
import { find, findOne, insert, setById, updateMany, deleteMany, fail, num, round2, sum, todayStr, inParallel } from '../db.js';
import { supplierLedgers, supplierBills, summarizeSupplier, revalueGrns, costingRate, isLocal, nextPartyCode } from '../services.js';
import { guard } from '../auth.js';
import { cleanCheques, recordCheques } from '../cheques.js';
import { supplierPaidSms, supplierChequesSms } from '../sms.js';

const r = Router();

const FIELDS = ['name', 'origin', 'contact_person', 'phone', 'whatsapp', 'email', 'city', 'state', 'address', 'gst_no', 'bank_details', 'credit_days', 'opening_balance_inr', 'notes', 'active'];

function clean(body) {
  if (!String(body.name || '').trim()) fail('Supplier name is required');
  return {
    ...Object.fromEntries(FIELDS.map((f) => [f, body[f] === '' || body[f] === undefined ? null : body[f]])),
    name: String(body.name).trim(),
    origin: body.origin === 'local' ? 'local' : 'india',   // Indian supplier (₹) or local supplier (Rs)
    credit_days: Math.round(num(body.credit_days, 60)),
    opening_balance_inr: round2(num(body.opening_balance_inr)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

const byActiveName = (a, b) => (b.active - a.active) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

r.get('/', async (req, res) => {
  const [list, grns, ledgers] = await inParallel(
    () => find('suppliers', { deleted: { $ne: 1 } }),
    () => find('grns', {}, { project: { supplier_id: 1, date: 1 } }),
    () => supplierLedgers(),
  );
  const suppliers = list.sort(byActiveName);
  const stats = {};
  for (const g of grns) {
    const t = (stats[g.supplier_id] ??= { grn_count: 0, last_grn_date: null });
    t.grn_count++;
    if (!t.last_grn_date || g.date > t.last_grn_date) t.last_grn_date = g.date;
  }
  res.json(suppliers.map((s) => ({ ...s, grn_count: 0, last_grn_date: null, ...stats[s.id], ...summarizeSupplier(ledgers.get(s.id) || []) })));
});

r.get('/:id', async (req, res) => {
  const s = await findOne('suppliers', { id: num(req.params.id) });
  if (!s) fail('Supplier not found', 404);
  const [bills, payments, grns] = await inParallel(
    () => supplierBills(s.id),
    () => find('supplier_payments', { supplier_id: s.id }, { sort: { date: -1, id: -1 } }),
    () => find('grns', { supplier_id: s.id }, { project: { id: 1, grn_no: 1, payable_inr: 1, total_lkr: 1 } }),
  );
  const grnNo = Object.fromEntries(grns.map((g) => [g.id, g.grn_no]));
  const totals = { grn_count: grns.length, purchased_inr: sum(grns, (g) => g.payable_inr), landed_lkr: sum(grns, (g) => g.total_lkr) };
  res.json({
    ...s, ...summarizeSupplier(bills), ...totals, bills,
    payments: payments.map((p) => ({ ...p, grn_no: p.grn_id != null ? grnNo[p.grn_id] ?? null : null })),
  });
});

r.post('/', async (req, res) => {
  const d = clean(req.body);
  // adding, editing or deleting a supplier always needs the Super Admin's password
  await guard(req, `New supplier ${d.name}${d.opening_balance_inr > 0 ? ` (old balance ₹${d.opening_balance_inr})` : ''}`, 'superadmin', { always: true });
  res.json(await insert('suppliers', { ...Object.fromEntries(FIELDS.map((f) => [f, d[f]])), code: await nextPartyCode('suppliers') }));
});

r.put('/:id', async (req, res) => {
  const d = clean(req.body);
  const old = await findOne('suppliers', { id: num(req.params.id) });
  if (!old) fail('Supplier not found', 404);
  // the currency follows the supplier: once it has GRNs or payments, it can't switch between India (₹) and local (Rs)
  if ((old.origin || 'india') !== d.origin && (await findOne('grns', { supplier_id: old.id }) || await findOne('supplier_payments', { supplier_id: old.id }))) {
    fail(`${old.name} already has GRNs or payments in ${old.origin === 'local' ? 'Rs' : '₹'}, so it can't change type. Add it as a new supplier instead.`);
  }
  const changes = [];
  if ((old.origin || 'india') !== d.origin) changes.push(`type → ${d.origin === 'local' ? 'local supplier (Rs)' : 'Indian supplier (₹)'}`);
  if (old.name !== d.name) changes.push(`name "${old.name}" → "${d.name}"`);
  if (old.credit_days !== d.credit_days) changes.push(`credit days ${old.credit_days} → ${d.credit_days}`);
  if (old.opening_balance_inr !== d.opening_balance_inr) changes.push(`old balance ₹${old.opening_balance_inr} → ₹${d.opening_balance_inr}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  if ((old.bank_details || null) !== d.bank_details) changes.push('bank details changed');
  await guard(req, `Edit supplier ${old.name}${changes.length ? `: ${changes.join(', ')}` : ''}`, 'superadmin', { always: true });
  await setById('suppliers', old.id, Object.fromEntries(FIELDS.map((f) => [f, d[f]])));
  res.json(await findOne('suppliers', { id: old.id }));
});

/**
 * Delete a supplier (Super Admin): only when nothing is due to them. One with GRNs or payments is removed from the
 * lists but kept in the records, so its GRNs, payments and stock history still show who they came from.
 */
r.delete('/:id', async (req, res) => {
  const id = num(req.params.id);
  const s = await findOne('suppliers', { id });
  if (!s || s.deleted) fail('Supplier not found', 404);
  const { balance_inr } = summarizeSupplier(await supplierBills(id));
  if (balance_inr > 0.009) fail(`${s.name} still has dues of ${isLocal(s) ? 'Rs' : '₹'}${round2(balance_inr)}. Settle them first, then delete.`);
  const history = await findOne('grns', { supplier_id: id }) || await findOne('supplier_payments', { supplier_id: id });
  await guard(req, `Delete supplier ${s.name}`, 'superadmin', { always: true });
  if (history) {
    await setById('suppliers', id, { deleted: 1, active: 0 });
  } else {
    await updateMany('products', { supplier_id: id }, { $set: { supplier_id: null } });
    await deleteMany('suppliers', { id });
  }
  res.json({ ok: true, kept_history: Boolean(history) });
});

/* ---------- supplier payments ---------- */
r.post('/:id/payments', async (req, res) => {
  const s = await findOne('suppliers', { id: num(req.params.id) });
  if (!s) fail('Supplier not found', 404);
  if (req.body.method === 'Cheque') {
    const grnId = req.body.grn_id ? num(req.body.grn_id) : null;
    if (grnId && !(await findOne('grns', { id: grnId, supplier_id: s.id }))) fail('That GRN does not belong to this supplier');
    const cheques = await recordCheques({ direction: 'out', party: 'supplier', partyId: s.id, partyName: s.name, billId: grnId,
      cheques: cleanCheques(req.body.cheques), givenOn: req.body.date, notes: req.body.notes || null, user: req.user });
    await supplierChequesSms(s.id, cheques, req.user);   // a local supplier: cheque issued SMS
    return res.json({ cheques });
  }
  const amount = round2(num(req.body.amount_inr));
  if (amount <= 0) fail('Enter the amount paid');
  // payments are recorded at the same rate as the costs: the fixed rate for an Indian supplier, 1 for a local one (Rs)
  const rate = isLocal(s) ? 1 : await costingRate();
  const grnId = req.body.grn_id ? num(req.body.grn_id) : null;
  if (grnId && !(await findOne('grns', { id: grnId, supplier_id: s.id }))) fail('That GRN does not belong to this supplier');
  const p = await insert('supplier_payments', {
    supplier_id: s.id, grn_id: grnId, date: req.body.date || todayStr(), amount_inr: amount, exchange_rate: rate,
    amount_lkr: round2(amount * rate), method: req.body.method || null, reference: req.body.reference || null, notes: req.body.notes || null,
  });
  await revalueGrns();   // notes when the bill becomes fully paid
  await supplierPaidSms(s.id, p, req.user);   // a local supplier: payment SMS
  res.json(p);
});

r.delete('/:id/payments/:pid', async (req, res) => {
  const p = await findOne('supplier_payments', { id: num(req.params.pid), supplier_id: num(req.params.id) });
  if (!p) fail('Payment not found', 404);
  if (p.cheque_id) fail('This was paid by cheque — mark the cheque as returned on the Cheque Desk instead.');
  await guard(req, `Delete supplier payment of ₹${p.amount_inr} (${p.date})`);
  await deleteMany('supplier_payments', { id: p.id, supplier_id: p.supplier_id });
  await revalueGrns();
  res.json({ ok: true });
});

export default r;
