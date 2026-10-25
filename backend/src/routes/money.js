import { Router } from 'express';
import { find, findOne, deleteMany, fail, num } from '../db.js';
import { revalueGrns, customerLabel } from '../services.js';
import { guard } from '../auth.js';
import { cargoLedgers, payCargo, setChequeStatus, updateCheque, deleteCheque } from '../cheques.js';
import { chequeReturned } from '../attention.js';

const r = Router();

/* ---------------- cargo: what is owed to each cargo company ---------------- */
r.get('/cargo', async (req, res) => res.json(await cargoLedgers()));

r.post('/cargo/payments', async (req, res) => {
  res.json(await payCargo(req.body || {}, req.user));
});

r.delete('/cargo/payments/:id', async (req, res) => {
  const p = await findOne('cargo_payments', { id: num(req.params.id) });
  if (!p) fail('Payment not found', 404);
  if (p.cheque_id) fail('This was paid by cheque — mark the cheque as returned on the Cheque Desk instead.');
  await guard(req, `Delete cargo payment of Rs ${p.amount} to ${p.cargo_name} (${p.date})`);
  await deleteMany('cargo_payments', { id: p.id });
  res.json({ ok: true });
});

/* ---------------- cheques (Cheque Desk) ---------------- */
r.get('/cheques', async (req, res) => {
  const list = await find('cheques', {}, { sort: { cheque_date: 1, id: 1 }, limit: 2000 });
  // the bill each cheque was given for (GRN or bill number)
  const grnIds = list.filter((c) => c.party === 'supplier' && c.bill_id).map((c) => c.bill_id);
  const saleIds = list.filter((c) => c.party === 'customer' && c.bill_id).map((c) => c.bill_id);
  const supIds = [...new Set(list.filter((c) => c.party === 'supplier').map((c) => c.party_id))];
  const [grns, sales, sups] = await Promise.all([
    grnIds.length ? find('grns', { id: { $in: grnIds } }, { project: { id: 1, grn_no: 1 } }) : [],
    saleIds.length ? find('sales', { id: { $in: saleIds } }, { project: { id: 1, invoice_no: 1 } }) : [],
    supIds.length ? find('suppliers', { id: { $in: supIds } }, { project: { id: 1, origin: 1 } }) : [],
  ]);
  // amounts are in Rs, except a cheque to an Indian supplier (₹)
  const indian = new Set(sups.filter((s) => s.origin !== 'local').map((s) => s.id));
  const grnNo = Object.fromEntries(grns.map((g) => [g.id, g.grn_no]));
  const invNo = Object.fromEntries(sales.map((s) => [s.id, s.invoice_no]));
  res.json(list.map((c) => ({ ...c, currency: c.party === 'supplier' && indian.has(c.party_id) ? 'INR' : 'LKR', bill_no: c.party === 'supplier' ? grnNo[c.bill_id] || null : c.party === 'customer' ? invNo[c.bill_id] || null : null })));
});

const STATUS_TEXT = { passed: 'passed', returned: 'returned', holding: 'put on hold', pending: 'back to waiting' };
r.post('/cheques/:id/status', async (req, res) => {
  const id = num(req.params.id);
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  const status = String(req.body?.status || '');
  await guard(req, `Cheque ${ch.cheque_no} (${ch.direction === 'in' ? 'from' : 'to'} ${ch.party_name}, Rs ${ch.amount}) ${STATUS_TEXT[status] || status}`);
  const done = await setChequeStatus(id, status, req.user, req.body?.note);
  // a returned cheque goes to Action Center → Attention
  if (status === 'returned' && ch.status !== 'returned') {
    const sup = ch.party === 'supplier' ? await findOne('suppliers', { id: ch.party_id }, { project: { origin: 1 } }) : null;
    await chequeReturned({ ...done, currency: sup && sup.origin !== 'local' ? 'INR' : 'LKR' }, req.user);
  }
  res.json(done);
});

// correcting a cheque entered wrongly needs an admin; deleting one always needs the Super Admin's password
r.put('/cheques/:id', async (req, res) => {
  const id = num(req.params.id);
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  await guard(req, `Edit cheque ${ch.cheque_no} (${ch.direction === 'in' ? 'from' : 'to'} ${ch.party_name}, Rs ${ch.amount})`, 'superadmin', { always: true });
  res.json(await updateCheque(id, req.body || {}, req.user));
});

r.delete('/cheques/:id', async (req, res) => {
  const id = num(req.params.id);
  const ch = await findOne('cheques', { id });
  if (!ch) fail('Cheque not found', 404);
  await guard(req, `Delete cheque ${ch.cheque_no} (${ch.direction === 'in' ? 'from' : 'to'} ${ch.party_name}, Rs ${ch.amount})`, 'superadmin', { always: true });
  res.json(await deleteCheque(id));
});

/**
 * Payment Portal → History → Undo: take back a payment (any method), always with the Super Admin's password.
 * A payment made by cheque is undone with its cheque (it leaves the Cheque Desk too). What it paid is owed again.
 */
const PAY_TABLE = { receivables: 'customer_payments', payables: 'supplier_payments', cargo: 'cargo_payments' };
r.delete('/payments/:kind/:id', async (req, res) => {
  const table = PAY_TABLE[req.params.kind];
  if (!table) fail('Unknown payment', 404);
  const p = await findOne(table, { id: num(req.params.id) });
  if (!p) fail('Payment not found', 404);
  const who = req.params.kind === 'cargo' ? p.cargo_name
    : req.params.kind === 'payables' ? (await findOne('suppliers', { id: p.supplier_id }))?.name || '—'
      : customerLabel(await findOne('customers', { id: p.customer_id })) || '—';
  const amount = req.params.kind === 'payables' ? p.amount_inr : p.amount;
  await guard(req, `Undo payment of ${amount} (${p.method || 'payment'}${p.reference ? `, ${p.reference}` : ''}) ${req.params.kind === 'receivables' ? 'from' : 'to'} ${who} on ${p.date}`, 'superadmin', { always: true });
  if (p.cheque_id && await findOne('cheques', { id: p.cheque_id })) await deleteCheque(p.cheque_id);
  else {
    await deleteMany(table, { id: p.id });
    if (req.params.kind === 'payables') await revalueGrns();
  }
  res.json({ ok: true, cheque_removed: Boolean(p.cheque_id) });
});

export default r;
