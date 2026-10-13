import { useState } from 'react';
import { api, n, r2, today, lkr, inr, PAY_METHODS_CUSTOMER, PAY_METHODS_SUPPLIER, isAdmin, isSuper } from '../lib.js';
import { Modal, Field, NumInput, useToast, Segmented, Icon } from './ui.jsx';
import { useAuth, useSettings } from '../App.jsx';

function useForm(initial) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  return [f, set, setF];
}

/* ================= CUSTOMER ================= */
export function CustomerForm({ customer, initialName = '', onClose, onSaved }) {
  const toast = useToast();
  const me = useAuth().user;
  const lockedLimit = !isSuper(me);   // credit limit: Super Admin only
  const locked = !isAdmin(me);        // credit days: admins
  const [busy, setBusy] = useState(false);
  const [f, set] = useForm(customer || { name: initialName, shop_name: '', phone: '', whatsapp: '', city: '', address: '', credit_limit: 0, credit_days: 30, opening_balance: 0, notes: '', active: 1 });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = customer ? await api.put(`/customers/${customer.id}`, f) : await api.post('/customers', f);
      toast(customer ? 'Customer updated' : 'Customer added');
      onSaved?.(saved);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={customer ? 'Edit customer' : 'New customer'} subtitle="Shops and people who buy from you" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="cust-form" disabled={busy}>Save customer</button></>}>
      <form id="cust-form" onSubmit={save} className="grid grid-2">
        <Field label="Customer name" required><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Shop / business name"><input className="input" value={f.shop_name || ''} onChange={set('shop_name')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone || ''} onChange={set('phone')} placeholder="07X XXX XXXX" /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp || ''} onChange={set('whatsapp')} /></Field>
        <Field label="City / town"><input className="input" value={f.city || ''} onChange={set('city')} /></Field>
        <Field label="Address"><input className="input" value={f.address || ''} onChange={set('address')} /></Field>
        <Field label={<>Credit limit (Rs) {lockedLimit && <Icon name="shield" size={12} />}</>} hint={lockedLimit ? 'Changing this needs the Super Admin password' : '0 = no limit set'}><NumInput value={f.credit_limit} onChange={set('credit_limit')} /></Field>
        <Field label={<>Credit period (days) {locked && <Icon name="lock" size={12} />}</>} hint={locked ? 'Changing this needs an admin password' : 'Used to set the due date on credit bills'}><NumInput value={f.credit_days} onChange={set('credit_days')} /></Field>
        {!customer && <Field label="Old balance due (Rs)" hint="Amount due before starting this system"><NumInput value={f.opening_balance} onChange={set('opening_balance')} /></Field>}
        <Field label="Notes" className={customer ? 'span-2' : ''}><input className="input" value={f.notes || ''} onChange={set('notes')} /></Field>
        {customer && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active customer</label>}
      </form>
    </Modal>
  );
}

/* ================= SUPPLIER ================= */
export function SupplierForm({ supplier, initialName = '', onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, set] = useForm(supplier || { name: initialName, contact_person: '', phone: '', whatsapp: '', email: '', city: '', state: '', address: '', gst_no: '', bank_details: '', credit_days: 30, opening_balance_inr: 0, notes: '', active: 1 });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = supplier ? await api.put(`/suppliers/${supplier.id}`, f) : await api.post('/suppliers', f);
      toast(supplier ? 'Supplier updated' : 'Supplier added');
      onSaved?.(saved);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal size="lg" title={supplier ? 'Edit supplier' : 'New supplier'} subtitle="Your suppliers in India" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="sup-form" disabled={busy}>Save supplier</button></>}>
      <form id="sup-form" onSubmit={save} className="grid grid-3">
        <Field label="Supplier / company name" required className="span-2"><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact person"><input className="input" value={f.contact_person || ''} onChange={set('contact_person')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone || ''} onChange={set('phone')} placeholder="+91" /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp || ''} onChange={set('whatsapp')} placeholder="+91" /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email || ''} onChange={set('email')} /></Field>
        <Field label="City"><input className="input" value={f.city || ''} onChange={set('city')} placeholder="Surat, Tiruppur…" /></Field>
        <Field label="State"><input className="input" value={f.state || ''} onChange={set('state')} /></Field>
        <Field label="GST number"><input className="input" value={f.gst_no || ''} onChange={set('gst_no')} /></Field>
        <Field label="Address" className="span-2"><input className="input" value={f.address || ''} onChange={set('address')} /></Field>
        <Field label="Credit period (days)" hint="Default time to pay each GRN"><NumInput value={f.credit_days} onChange={set('credit_days')} /></Field>
        <Field label="Bank / payment details" className="span-2"><textarea className="input" rows={2} value={f.bank_details || ''} onChange={set('bank_details')} placeholder="Bank, A/C no, IFSC, UPI…" /></Field>
        {!supplier ? <Field label="Old balance to pay (₹ INR)" hint="Before starting this system"><NumInput value={f.opening_balance_inr} onChange={set('opening_balance_inr')} /></Field> : <div />}
        <Field label="Notes" className="span-2"><input className="input" value={f.notes || ''} onChange={set('notes')} /></Field>
        {supplier && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active supplier</label>}
      </form>
    </Modal>
  );
}

/* ================= PAY SUPPLIER ================= */
export function SupplierPaymentModal({ supplier, bills = [], defaultGrnId, onClose, onSaved }) {
  const { settings } = useSettings();
  const toast = useToast();
  const open = bills.filter((b) => b.balance > 0.009);
  const preset = open.find((b) => b.id === defaultGrnId);
  const total = r2(open.reduce((a, b) => a + b.balance, 0));
  const [f, set, setF] = useForm({
    date: today(), grn_id: preset?.id ?? '', amount_inr: preset ? preset.balance : '',
    method: 'Bank transfer', reference: '', notes: '',
  });
  const [busy, setBusy] = useState(false);
  // recorded at the fixed costing rate, like every cost
  const rate = n(settings.costing_rate) || 3.5;
  const lkrAmt = r2(n(f.amount_inr) * rate);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/suppliers/${supplier.id}/payments`, { ...f, grn_id: f.grn_id || null });
      toast(`Payment of ${inr(f.amount_inr)} saved`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Pay ${supplier.name}`} subtitle={`Total still to pay: ${inr(total)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="sp-form" disabled={busy}>Save payment</button></>}>
      <form id="sp-form" onSubmit={save} className="grid grid-2">
        <Field label="Pay for which GRN?" className="span-2" hint="Leave as 'Oldest first' to settle the oldest bills automatically">
          <select className="input" value={f.grn_id} onChange={(e) => {
            const b = open.find((x) => String(x.id) === e.target.value);
            setF((x) => ({ ...x, grn_id: e.target.value, amount_inr: b ? b.balance : x.amount_inr }));
          }}>
            <option value="">Oldest first (automatic)</option>
            {open.filter((b) => b.id).map((b) => <option key={b.id} value={b.id}>{b.grn_no} · balance {inr(b.balance)}</option>)}
          </select>
        </Field>
        <Field label="Amount paid (₹ INR)" required hint={n(f.amount_inr) > 0 ? `= ${lkr(lkrAmt)} at Rs ${rate.toFixed(2)} per ₹1` : ''}>
          <NumInput autoFocus value={f.amount_inr} onChange={set('amount_inr')} />
        </Field>
        <Field label="Paid by">
          <select className="input" value={f.method} onChange={set('method')}>{PAY_METHODS_SUPPLIER.map((m) => <option key={m}>{m}</option>)}</select>
        </Field>
        <Field label="Date"><input type="date" className="input" value={f.date} onChange={set('date')} /></Field>
        <Field label="Reference / slip no"><input className="input" value={f.reference} onChange={set('reference')} /></Field>
        <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
        {total > 0 && <div className="span-2 row gap-s"><button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, grn_id: '', amount_inr: total }))}>Pay full balance {inr(total)}</button></div>}
      </form>
    </Modal>
  );
}

/* ================= RECEIVE FROM CUSTOMER ================= */
export function CustomerPaymentModal({ customer, bills = [], defaultSaleId, onClose, onSaved }) {
  const toast = useToast();
  const open = bills.filter((b) => b.balance > 0.009);
  const preset = open.find((b) => b.id === defaultSaleId);
  const total = r2(open.reduce((a, b) => a + b.balance, 0));
  const [f, set, setF] = useForm({ date: today(), sale_id: preset?.id ?? '', amount: preset ? preset.balance : '', method: 'Cash', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/customers/${customer.id}/payments`, { ...f, sale_id: f.sale_id || null });
      toast(`Received ${lkr(f.amount)} from ${customer.name}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Receive payment — ${customer.name}`} subtitle={`Due: ${lkr(total)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="cp-form" disabled={busy}>Save payment</button></>}>
      <form id="cp-form" onSubmit={save} className="grid grid-2">
        <Field label="For which bill?" className="span-2" hint="'Oldest first' settles the oldest bills automatically">
          <select className="input" value={f.sale_id} onChange={(e) => {
            const b = open.find((x) => String(x.id) === e.target.value);
            setF((x) => ({ ...x, sale_id: e.target.value, amount: b ? b.balance : x.amount }));
          }}>
            <option value="">Oldest first (automatic)</option>
            {open.filter((b) => b.id).map((b) => <option key={b.id} value={b.id}>{b.invoice_no} · {b.date} · balance {lkr(b.balance)}</option>)}
          </select>
        </Field>
        <Field label="Amount received (Rs)" required><NumInput autoFocus value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Date"><input type="date" className="input" value={f.date} onChange={set('date')} /></Field>
        <Field label="Received by" className="span-2">
          <Segmented value={f.method} onChange={set('method')} options={PAY_METHODS_CUSTOMER.map((m) => ({ value: m, label: m }))} />
        </Field>
        <Field label="Reference / cheque no"><input className="input" value={f.reference} onChange={set('reference')} /></Field>
        <Field label="Notes"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
        {total > 0 && <div className="span-2"><button type="button" className="btn btn-sm" onClick={() => setF((x) => ({ ...x, sale_id: '', amount: total }))}>Full balance {lkr(total)}</button></div>}
      </form>
    </Modal>
  );
}
