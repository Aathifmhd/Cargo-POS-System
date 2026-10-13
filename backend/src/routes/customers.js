import { Router } from 'express';
import { find, findOne, insert, setById, deleteMany, fail, num, round2, sum, todayStr, inParallel } from '../db.js';
import { customerLedgers, customerBills, summarizeCustomer } from '../services.js';
import { guard } from '../auth.js';

const r = Router();

const FIELDS = ['name', 'shop_name', 'phone', 'whatsapp', 'city', 'address', 'credit_limit', 'credit_days', 'opening_balance', 'notes', 'active'];

function clean(body) {
  if (!String(body.name || '').trim()) fail('Customer name is required');
  return {
    ...Object.fromEntries(FIELDS.map((f) => [f, body[f] === '' || body[f] === undefined ? null : body[f]])),
    name: String(body.name).trim(),
    credit_limit: round2(num(body.credit_limit)),
    credit_days: Math.round(num(body.credit_days, 30)),
    opening_balance: round2(num(body.opening_balance)),
    active: body.active === false || body.active === 0 ? 0 : 1,
  };
}

const byActiveName = (a, b) => (b.active - a.active) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

r.get('/', async (req, res) => {
  const [list, sales, ledgers] = await inParallel(
    () => find('customers'),
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
      sort: { date: -1, id: -1 }, limit: 200, project: { id: 1, invoice_no: 1, date: 1, payment_type: 1, total: 1, paid_at_sale: 1, status: 1, due_date: 1 },
    }),
    () => find('customer_payments', { customer_id: c.id }, { sort: { date: -1, id: -1 } }),
    () => find('sales', { customer_id: c.id, status: 'completed' }, { project: { total: 1, cost_total: 1 } }),
    () => customerBills(c.id),
  );
  const saleNo = Object.fromEntries((await find('sales', { id: { $in: payments.map((p) => p.sale_id).filter((x) => x != null) } }, { project: { id: 1, invoice_no: 1 } }))
    .map((s) => [s.id, s.invoice_no]));
  const totals = { bill_count: done.length, total_bought: sum(done, (s) => s.total), profit: sum(done, (s) => s.total - s.cost_total) };
  res.json({
    ...c, ...summarizeCustomer(bills), ...totals, bills, sales,
    payments: payments.map((p) => ({ ...p, invoice_no: p.sale_id != null ? saleNo[p.sale_id] ?? null : null })),
  });
});

r.post('/', async (req, res) => {
  const d = clean(req.body);
  // adding, editing or deleting a customer always needs the Super Admin's password
  await guard(req, `New customer ${d.name} (credit limit Rs ${d.credit_limit}, old balance Rs ${d.opening_balance})`, 'superadmin', { always: true });
  const c = await insert('customers', Object.fromEntries(FIELDS.map((f) => [f, d[f]])));
  res.json({ ...c, balance: d.opening_balance, overdue: 0 });
});

r.put('/:id', async (req, res) => {
  const d = clean(req.body);
  const old = await findOne('customers', { id: num(req.params.id) });
  if (!old) fail('Customer not found', 404);
  const changes = [];
  if (old.name !== d.name) changes.push(`name "${old.name}" → "${d.name}"`);
  if (old.credit_limit !== d.credit_limit) changes.push(`credit limit Rs ${old.credit_limit} → Rs ${d.credit_limit}`);
  if (old.credit_days !== d.credit_days) changes.push(`credit days ${old.credit_days} → ${d.credit_days}`);
  if (old.opening_balance !== d.opening_balance) changes.push(`old balance Rs ${old.opening_balance} → Rs ${d.opening_balance}`);
  if (old.active !== d.active) changes.push(d.active ? 'made active' : 'made inactive');
  await guard(req, `Edit customer ${old.name}${changes.length ? `: ${changes.join(', ')}` : ''}`, 'superadmin', { always: true });
  await setById('customers', old.id, Object.fromEntries(FIELDS.map((f) => [f, d[f]])));
  res.json(await findOne('customers', { id: old.id }));
});

/** Raise (or set) just the credit limit — used from the till when a credit bill would go over it. Super Admin only. */
r.put('/:id/credit-limit', async (req, res) => {
  const c = await findOne('customers', { id: num(req.params.id) });
  if (!c) fail('Customer not found', 404);
  const limit = round2(num(req.body.credit_limit));
  if (limit < 0) fail('Credit limit cannot be negative');
  const summary = async () => summarizeCustomer(await customerBills(c.id));
  if (limit === c.credit_limit) return res.json({ ...c, ...(await summary()) });
  await guard(req, `Customer ${c.name}: credit limit Rs ${c.credit_limit} → Rs ${limit}${req.body.reason ? ` (${req.body.reason})` : ''}`, 'superadmin');
  await setById('customers', c.id, { credit_limit: limit });
  res.json({ ...(await findOne('customers', { id: c.id })), ...(await summary()) });
});

r.delete('/:id', async (req, res) => {
  const id = num(req.params.id);
  if (await findOne('sales', { customer_id: id }) || await findOne('customer_payments', { customer_id: id })) {
    fail('This customer has bills or payments. Mark them inactive instead of deleting.');
  }
  await guard(req, `Delete customer ${(await findOne('customers', { id }))?.name || `#${id}`}`, 'superadmin', { always: true });
  await deleteMany('customers', { id });
  res.json({ ok: true });
});

/* ---------- customer payments (collections) ---------- */
r.post('/:id/payments', async (req, res) => {
  const c = await findOne('customers', { id: num(req.params.id) });
  if (!c) fail('Customer not found', 404);
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
  await guard(req, `Delete customer payment of Rs ${p.amount} (${p.date})`);
  await deleteMany('customer_payments', { id: p.id, customer_id: p.customer_id });
  res.json({ ok: true });
});

export default r;
