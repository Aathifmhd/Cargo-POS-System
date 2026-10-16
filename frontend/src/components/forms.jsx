import { useState } from 'react';
import { api, n, r2, today, niceDate, lkr, inr, supMoney, isLocalSup, PAY_METHODS_CUSTOMER, PAY_METHODS_SUPPLIER, isAdmin, isSuper } from '../lib.js';
import { Modal, Field, NumInput, DateInput, useToast, Icon, Segmented } from './ui.jsx';
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
export function SupplierForm({ supplier, initialName = '', initialOrigin = 'india', onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [f, set] = useForm(supplier ? { ...supplier, origin: supplier.origin || 'india' } : { origin: initialOrigin, name: initialName, contact_person: '', phone: '', whatsapp: '', email: '', city: '', state: '', address: '', gst_no: '', bank_details: '', credit_days: 60, opening_balance_inr: 0, notes: '', active: 1 });
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
    <Modal size="lg" title={supplier ? 'Edit supplier' : 'New supplier'} subtitle={f.origin === 'local' ? 'A supplier in Sri Lanka — bills in Rs' : 'A supplier in India — bills in ₹'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="sup-form" disabled={busy}>Save supplier</button></>}>
      <form id="sup-form" onSubmit={save} className="grid grid-3">
        <Field label="Supplier type" className="span-3" hint={supplier ? 'A supplier with GRNs or payments keeps its type' : 'Decides the bill currency on Receive Goods'}>
          <Segmented value={f.origin} onChange={set('origin')} options={[
            { value: 'india', label: '🇮🇳 Indian supplier (₹ INR)' },
            { value: 'local', label: '🇱🇰 Local supplier (Rs LKR)' },
          ]} />
        </Field>
        <Field label="Supplier / company name" required className="span-2"><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Contact person"><input className="input" value={f.contact_person || ''} onChange={set('contact_person')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone || ''} onChange={set('phone')} placeholder={f.origin === 'local' ? '07X XXX XXXX' : '+91'} /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp || ''} onChange={set('whatsapp')} placeholder={f.origin === 'local' ? '07X XXX XXXX' : '+91'} /></Field>
        <Field label="Email"><input className="input" type="email" value={f.email || ''} onChange={set('email')} /></Field>
        <Field label="City"><input className="input" value={f.city || ''} onChange={set('city')} placeholder={f.origin === 'local' ? 'Colombo, Kandy…' : 'Surat, Tiruppur…'} /></Field>
        <Field label="State"><input className="input" value={f.state || ''} onChange={set('state')} /></Field>
        <Field label={f.origin === 'local' ? 'VAT / BR number' : 'GST number'}><input className="input" value={f.gst_no || ''} onChange={set('gst_no')} /></Field>
        <Field label="Address" className="span-2"><input className="input" value={f.address || ''} onChange={set('address')} /></Field>
        <Field label="Credit period (days)" hint="Default time to pay each GRN"><NumInput value={f.credit_days} onChange={set('credit_days')} /></Field>
        <Field label="Bank / payment details" className="span-2"><textarea className="input" rows={2} value={f.bank_details || ''} onChange={set('bank_details')} placeholder={f.origin === 'local' ? 'Bank, branch, A/C no…' : 'Bank, A/C no, IFSC, UPI…'} /></Field>
        {!supplier ? <Field label={f.origin === 'local' ? 'Old balance to pay (Rs)' : 'Old balance to pay (₹ INR)'} hint="Before starting this system"><NumInput value={f.opening_balance_inr} onChange={set('opening_balance_inr')} /></Field> : <div />}
        <Field label="Notes" className="span-2"><input className="input" value={f.notes || ''} onChange={set('notes')} /></Field>
        {supplier && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active supplier</label>}
      </form>
    </Modal>
  );
}

/* ================= PAYMENTS (pay a supplier · receive from a customer) =================
 * Four clear sections: which bill · bill balance, amount and the balance left, date · how · reference & notes.
 */
function PayStep({ title, children }) {
  return (
    <div className="pay-step">
      <div className="pay-step-title">{title}</div>
      {children}
    </div>
  );
}

/** Steps 1–2: which bill, its balance, the amount, what is left — shared by both pop-ups. */
function BillAndAmount({ bills, billKey, billLabel, f, setF, set, money, amountKey, amountLabel, amountHint, verb }) {
  const open = bills.filter((b) => b.balance > 0.009);
  const total = r2(open.reduce((a, b) => a + b.balance, 0));
  const bill = open.find((b) => String(b.id) === String(f[billKey]));
  const due = bill ? bill.balance : total;            // what this payment is set against
  const left = r2(due - n(f[amountKey]));
  return (
    <>
      <PayStep title="For which bill?">
        <select className="input" value={f[billKey]} onChange={(e) => setF((x) => ({ ...x, [billKey]: e.target.value }))}>
          <option value="">All bills · oldest first ({money(total)})</option>
          {open.filter((b) => b.id).map((b) => <option key={b.id} value={b.id}>{billLabel(b)} · {money(b.balance)}</option>)}
        </select>
      </PayStep>
      <PayStep title={`Amount ${verb}`}>
        <div className="grid grid-3">
          <Field label={bill ? 'Bill balance' : 'Total balance'}>
            <div className="input input-static strong">{money(due)}</div>
          </Field>
          <Field label={amountLabel} required hint={amountHint}>
            <NumInput money autoFocus value={f[amountKey]} onChange={set(amountKey)} placeholder="0.00" />
          </Field>
          <Field label="Balance after this" hint={left < 0 ? (bill ? 'The extra goes to their other bills' : 'The extra is kept as an advance') : left === 0 ? 'Fully paid' : ''}>
            <div className={`input input-static strong ${left <= 0 ? 'text-green' : 'text-red'}`}>{money(Math.max(0, left))}</div>
          </Field>
        </div>
        <Field label="Date" className="pay-date"><DateInput value={f.date} onChange={set('date')} /></Field>
      </PayStep>
    </>
  );
}

/* ---------------- PAY SUPPLIER ---------------- */
export function SupplierPaymentModal({ supplier, bills = [], defaultGrnId, onClose, onSaved }) {
  const { settings } = useSettings();
  const toast = useToast();
  const preset = bills.find((b) => b.id === defaultGrnId && b.balance > 0.009);
  const [f, set, setF] = useForm({ date: today(), grn_id: preset?.id ?? '', amount_inr: '', method: 'Bank transfer', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  // recorded at the fixed costing rate, like every cost — a local supplier is paid in Rs (no rate)
  const local = isLocalSup(supplier);
  const rate = local ? 1 : n(settings.costing_rate) || 3.5;
  const cur = supMoney(supplier);

  const save = async (e) => {
    e.preventDefault();
    if (!(n(f.amount_inr) > 0)) return toast('Enter the amount you are paying', 'error');
    setBusy(true);
    try {
      await api.post(`/suppliers/${supplier.id}/payments`, { ...f, grn_id: f.grn_id || null });
      toast(`Paid ${cur(f.amount_inr)} to ${supplier.name}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Pay ${supplier.name}`} subtitle={local ? 'Money you pay the supplier, in Sri Lankan Rupees (Rs)' : 'Money you pay the supplier, in Indian Rupees (₹)'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="sp-form" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : n(f.amount_inr) > 0 ? `Make payment · ${cur(f.amount_inr)}` : 'Make payment'}</button></>}>
      <form id="sp-form" onSubmit={save} className="pay-form">
        <BillAndAmount bills={bills} billKey="grn_id" billLabel={(b) => b.grn_no} f={f} setF={setF} set={set} money={cur}
          amountKey="amount_inr" amountLabel={local ? 'Amount paying (Rs)' : 'Amount paying (₹)'} verb="paying"
          amountHint={!local && n(f.amount_inr) > 0 ? `= ${lkr(r2(n(f.amount_inr) * rate))} at Rs ${rate.toFixed(2)} per ₹1` : ''} />
        <PayStep title="How are you paying?">
          <select className="input" value={f.method} onChange={set('method')}>{PAY_METHODS_SUPPLIER.map((m) => <option key={m}>{m}</option>)}</select>
        </PayStep>
        <PayStep title="Reference & notes">
          <div className="grid grid-2">
            <Field label="Reference / slip no" hint="Optional"><input className="input" value={f.reference} onChange={set('reference')} /></Field>
            <Field label="Notes" hint="Optional"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
          </div>
        </PayStep>
      </form>
    </Modal>
  );
}

/* ---------------- RECEIVE FROM CUSTOMER ---------------- */
export function CustomerPaymentModal({ customer, bills = [], defaultSaleId, onClose, onSaved }) {
  const toast = useToast();
  const preset = bills.find((b) => b.id === defaultSaleId && b.balance > 0.009);
  const [f, set, setF] = useForm({ date: today(), sale_id: preset?.id ?? '', amount: '', method: 'Cash', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (!(n(f.amount) > 0)) return toast('Enter the amount you are receiving', 'error');
    setBusy(true);
    try {
      await api.post(`/customers/${customer.id}/payments`, { ...f, sale_id: f.sale_id || null });
      toast(`Received ${lkr(f.amount)} from ${customer.name}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Receive from ${customer.name}`} subtitle="Money the customer pays you, in Sri Lankan Rupees (Rs)" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="cp-form" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : n(f.amount) > 0 ? `Receive payment · ${lkr(f.amount)}` : 'Receive payment'}</button></>}>
      <form id="cp-form" onSubmit={save} className="pay-form">
        <BillAndAmount bills={bills} billKey="sale_id" billLabel={(b) => `${b.invoice_no} · ${niceDate(b.date)}`} f={f} setF={setF} set={set} money={lkr}
          amountKey="amount" amountLabel="Amount receiving (Rs)" verb="receiving" />
        <PayStep title="How are they paying?">
          <select className="input" value={f.method} onChange={set('method')}>{PAY_METHODS_CUSTOMER.map((m) => <option key={m}>{m}</option>)}</select>
        </PayStep>
        <PayStep title="Reference & notes">
          <div className="grid grid-2">
            <Field label="Reference / cheque no" hint="Optional"><input className="input" value={f.reference} onChange={set('reference')} /></Field>
            <Field label="Notes" hint="Optional"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
          </div>
        </PayStep>
      </form>
    </Modal>
  );
}
