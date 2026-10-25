import { Router } from 'express';
import { find, findOne, insert, setById, deleteMany, fail, num, round2, sum, todayStr, inParallel } from '../db.js';
import { customerLedgers, customerBills, summarizeCustomer, customerLabel, relabelCustomers } from '../services.js';
import { guard } from '../auth.js';
import { cleanCheques, recordCheques } from '../cheques.js';

const r = Router();

const FIELDS = ['name', 'shop_name', 'nic_no', 'phone', 'whatsapp', 'city', 'address', 'credit_limit', 'credit_days', 'opening_balance', 'notes', 'active'];

/** Sri Lankan NIC: old (9 digits + V or X) or new (12 digits). */
const NIC = /^(\d{9}[VX]|\d{12})$/;
function clean(body) {
  if (!String(body.name || '').trim()) fail('Customer name is required');
  const nic = String(body.nic_no || '').replace(/\s+/g, '').toUpperCase();
  if (nic && !NIC.test(nic)) fail('The NIC number should be 9 digits and V or X (e.g. 852345678V), or 12 digits (e.g. 198523456789)');
  return {
    ...Object.fromEntries(FIELDS.map((f) => [f, body[f] === '' || body[f] === undefined ? null : body[f]])),
    name: String(body.name).trim(),
    nic_no: nic || null,
    credit_limit: round2(num(body.credit_limit)),
    credit_days: Math.round(num(body.credit_days, 30)),
    opening_balance: round2(num(body.opening_balance)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

// active first, then by shop name (or the person's name when there is no shop name)
/* ---------- NIC photos (front and back), kept apart from the customer so the lists stay light ---------- */
const SIDES = ['front', 'back'];
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
/** From the form: a new photo (data URL), null to remove it, or left out to keep it. */
function photoOf(body, side) {
  const v = body[`nic_${side}`];
  if (v === undefined || v === true) return undefined;
  if (v === null || v === '' || v === false) return null;
  if (typeof v !== 'string' || !PHOTO.test(v)) fail(`The NIC ${side} photo must be a JPG, PNG or WEBP picture`);
  if (v.length > 2_000_000) fail(`The NIC ${side} photo is too large — take it again or choose a smaller picture`);
  return v;
}
const photosOf = (body) => Object.fromEntries(SIDES.map((s) => [s, photoOf(body, s)]));
async function savePhotos(customerId, photos) {
  for (const side of SIDES) {
    if (photos[side] === undefined) continue;
    await deleteMany('customer_ids', { customer_id: customerId, side });
    if (photos[side]) await insert('customer_ids', { customer_id: customerId, side, data: photos[side] });
  }
}
const photoFlags = async (customerId) => {
  const have = await find('customer_ids', { customer_id: customerId }, { project: { side: 1, created_at: 1 } });
  return Object.fromEntries(SIDES.map((s) => [`nic_${s}`, have.find((h) => h.side === s)?.created_at || null]));
};

const byActiveName = (a, b) => (b.active - a.active) || customerLabel(a).localeCompare(customerLabel(b), undefined, { sensitivity: 'base' });

r.get('/', async (req, res) => {
  const [list, sales, ledgers] = await inParallel(
    () => find('customers', { deleted: { $ne: 1 } }),
    () => find('sales', { status: 'completed', customer_id: { $ne: null } }, { project: { customer_id: 1, total: 1, date: 1 } }),
    () => customerLedgers(),
  );
  const customers = list.sort(byActiveName);
  const stats = {};
  for (const s of sales) {
    const t = (stats[s.customer_id] ??= { bill_count: 0, total_bought: 0, last_sale_date: null });
    t.bill_count++;
    t.total_bought += s.total;
    if (!t.last_sale_date || s.date > t.last_sale_date) t.last_sale_date = s.date;
  }
  res.json(customers.map((c) => ({
    ...c, bill_count: 0, total_bought: 0, last_sale_date: null, ...stats[c.id],
    ...summarizeCustomer(ledgers.get(c.id) || []),
  })));
});

r.get('/:id', async (req, res) => {
  const c = await findOne('customers', { id: num(req.params.id) });
  if (!c) fail('Customer not found', 404);
  const [sales, payments, done, bills] = await inParallel(
    () => find('sales', { customer_id: c.id }, {
      sort: { date: -1, id: -1 }, limit: 200, project: { id: 1, invoice_no: 1, date: 1, created_at: 1, payment_type: 1, total: 1, paid_at_sale: 1, status: 1, due_date: 1 },
    }),
    () => find('customer_payments', { customer_id: c.id }, { sort: { date: -1, id: -1 } }),
    () => find('sales', { customer_id: c.id, status: 'completed' }, { project: { total: 1, cost_total: 1 } }),
    () => customerBills(c.id),
  );
  const saleNo = Object.fromEntries((await find('sales', { id: { $in: payments.map((p) => p.sale_id).filter((x) => x != null) } }, { project: { id: 1, invoice_no: 1 } }))
    .map((s) => [s.id, s.invoice_no]));
  const totals = { bill_count: done.length, total_bought: sum(done, (s) => s.total), profit: sum(done, (s) => s.total - s.cost_total) };
  res.json({
    ...c, ...(await photoFlags(c.id)), ...summarizeCustomer(bills), ...totals, bills, sales,
    payments: payments.map((p) => ({ ...p, invoice_no: p.sale_id != null ? saleNo[p.sale_id] ?? null : null })),
  });
});

/** One NIC photo (front or back) of a customer. */
r.get('/:id/nic/:side', async (req, res) => {
  if (!SIDES.includes(req.params.side)) fail('Not found', 404);
  const p = await findOne('customer_ids', { customer_id: num(req.params.id), side: req.params.side });
  if (!p) fail('No photo', 404);
  res.json({ side: p.side, data: p.data, uploaded_at: p.created_at });
});

r.post('/', async (req, res) => {
  const d = clean(req.body);
  const photos = photosOf(req.body);
  // adding, editing or deleting a customer always needs the Super Admin's password
  await guard(req, `New customer ${customerLabel(d)} (credit limit Rs ${d.credit_limit}, old balance Rs ${d.opening_balance})`, 'superadmin', { always: true });
  const c = await insert('customers', Object.fromEntries(FIELDS.map((f) => [f, d[f]])));
  await savePhotos(c.id, photos);
  res.json({ ...c, ...(await photoFlags(c.id)), balance: d.opening_balance, overdue: 0 });
});

r.put('/:id', async (req, res) => {
  const d = clean(req.body);
  const photos = photosOf(req.body);
  const old = await findOne('customers', { id: num(req.params.id) });
  if (!old) fail('Customer not found', 404);
  const changes = [];
  if ((old.shop_name || null) !== (d.shop_name || null)) changes.push(`shop name "${old.shop_name || '—'}" → "${d.shop_name || '—'}"`);
  if (old.name !== d.name) changes.push(`name "${old.name}" → "${d.name}"`);
  if ((old.nic_no || null) !== d.nic_no) changes.push(`NIC number ${old.nic_no || '—'} → ${d.nic_no || '—'}`);
  const had = await photoFlags(old.id);
  for (const s of SIDES) {
    if (photos[s] === undefined) continue;
    if (photos[s]) changes.push(`NIC photo (${s}) ${had[`nic_${s}`] ? 'changed' : 'added'}`);
    else if (had[`nic_${s}`]) changes.push(`NIC photo (${s}) removed`);
  }
  if (old.credit_limit !== d.credit_limit) changes.push(`credit limit Rs ${old.credit_limit} → Rs ${d.credit_limit}`);
  if (old.credit_days !== d.credit_days) changes.push(`credit days ${old.credit_days} → ${d.credit_days}`);
  if (old.opening_balance !== d.opening_balance) changes.push(`old balance Rs ${old.opening_balance} → Rs ${d.opening_balance}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  await guard(req, `Edit customer ${customerLabel(old)}${changes.length ? `: ${changes.join(', ')}` : ''}`, 'superadmin', { always: true });
  await setById('customers', old.id, Object.fromEntries(FIELDS.map((f) => [f, d[f]])));
  await savePhotos(old.id, photos);
  if (customerLabel(old) !== customerLabel(d)) await relabelCustomers([old.id]);   // their bills and cheques show the new name
  res.json({ ...(await findOne('customers', { id: old.id })), ...(await photoFlags(old.id)) });
});

/** Raise (or set) just the credit limit — used from the till when a credit bill would go over it. Super Admin only. */
r.put('/:id/credit-limit', async (req, res) => {
  const c = await findOne('customers', { id: num(req.params.id) });
  if (!c) fail('Customer not found', 404);
  const limit = round2(num(req.body.credit_limit));
  if (limit < 0) fail('Credit limit cannot be negative');
  const summary = async () => summarizeCustomer(await customerBills(c.id));
  if (limit === c.credit_limit) return res.json({ ...c, ...(await summary()) });
  await guard(req, `Customer ${customerLabel(c)}: credit limit Rs ${c.credit_limit} → Rs ${limit}${req.body.reason ? ` (${req.body.reason})` : ''}`, 'superadmin');
  await setById('customers', c.id, { credit_limit: limit });
  res.json({ ...(await findOne('customers', { id: c.id })), ...(await summary()) });
});

/**
 * Delete a customer (Super Admin): only when they owe nothing. One with bills or payments is removed from the lists
 * but kept in the records, so their bills and payments still show who they were.
 */
r.delete('/:id', async (req, res) => {
  const id = num(req.params.id);
  const c = await findOne('customers', { id });
  if (!c || c.deleted) fail('Customer not found', 404);
  const { balance } = summarizeCustomer(await customerBills(id));
  if (balance > 0.009) fail(`${customerLabel(c)} still has dues of Rs ${round2(balance)}. Collect them first, then delete.`);
  const history = await findOne('sales', { customer_id: id }) || await findOne('customer_payments', { customer_id: id });
  await guard(req, `Delete customer ${customerLabel(c)}`, 'superadmin', { always: true });
  if (history) await setById('customers', id, { deleted: 1, active: 0 });
  else { await deleteMany('customers', { id }); await deleteMany('customer_ids', { customer_id: id }); }
  res.json({ ok: true, kept_history: Boolean(history) });
});

/* ---------- customer payments (collections) ---------- */
r.post('/:id/payments', async (req, res) => {
  const c = await findOne('customers', { id: num(req.params.id) });
  if (!c) fail('Customer not found', 404);
  if (req.body.method === 'Cheque') {
    const saleId = req.body.sale_id ? num(req.body.sale_id) : null;
    if (saleId && !(await findOne('sales', { id: saleId, customer_id: c.id }))) fail('That bill does not belong to this customer');
    const cheques = await recordCheques({ direction: 'in', party: 'customer', partyId: c.id, partyName: customerLabel(c), billId: saleId,
      cheques: cleanCheques(req.body.cheques), givenOn: req.body.date, notes: req.body.notes || null, user: req.user });
    return res.json({ cheques, pending: true, ...summarizeCustomer(await customerBills(c.id)) });
  }
  const amount = round2(num(req.body.amount));
  if (amount <= 0) fail('Enter the amount received');
  const saleId = req.body.sale_id ? num(req.body.sale_id) : null;
  if (saleId && !(await findOne('sales', { id: saleId, customer_id: c.id }))) fail('That bill does not belong to this customer');
  const p = await insert('customer_payments', {
    customer_id: c.id, sale_id: saleId, date: req.body.date || todayStr(), amount, method: req.body.method || 'Cash',
    reference: req.body.reference || null, notes: req.body.notes || null,
  });
  res.json({ ...p, ...summarizeCustomer(await customerBills(c.id)) });
});

r.delete('/:id/payments/:pid', async (req, res) => {
  const p = await findOne('customer_payments', { id: num(req.params.pid), customer_id: num(req.params.id) });
  if (!p) fail('Payment not found', 404);
  if (p.cheque_id) fail('This was paid by cheque — mark the cheque as returned on the Cheque Desk instead.');
  await guard(req, `Delete customer payment of Rs ${p.amount} (${p.date})`);
  await deleteMany('customer_payments', { id: p.id, customer_id: p.customer_id });
  res.json({ ok: true });
});

export default r;
