import { Fragment, useEffect, useState } from 'react';
import { api, n, r2, today, niceDate, lkr, inr, supMoney, custName, shrinkPhoto, isLocalSup, PAY_METHODS_CUSTOMER, PAY_METHODS_SUPPLIER, isAdmin, isSuper } from '../lib.js';
import { cachePatch, settleRows } from '../offline.js';
import { Modal, Field, NumInput, DateInput, useToast, Icon, Segmented } from './ui.jsx';
import { useAuth, useSettings } from '../App.jsx';

function useForm(initial) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  return [f, set, setF];
}

/* ================= CUSTOMER ================= */
/**
 * One side of the NIC: take a photo (phone camera) or choose one (album / computer). Shows the picture once there is one.
 * value: a new photo (data URL) · true = the saved one (loaded to show) · null = none.
 */
function NicPhoto({ label, value, customerId, side, onChange }) {
  const toast = useToast();
  const [saved, setSaved] = useState(null);   // the photo already saved, to show
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (value !== true || !customerId) return;
    api.get(`/customers/${customerId}/nic/${side}`).then((p) => setSaved(p.data)).catch(() => setSaved(null));
  }, [value, customerId, side]);
  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { onChange(await shrinkPhoto(file)); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const src = typeof value === 'string' ? value : value === true ? saved : null;
  const id = `nic-${side}`;
  return (
    <div className="nic-photo">
      <div className="nic-photo-label">{label}</div>
      <label htmlFor={id} className={`nic-photo-box ${src ? 'has' : ''}`} title={src ? 'Change the photo' : 'Take or choose a photo'}>
        {src ? <img src={src} alt={label} /> : value === true ? <span className="muted small">Loading…</span> : (
          <span className="nic-photo-empty"><Icon name="camera" size={22} /><b>{busy ? 'Getting the photo…' : 'Add photo'}</b><small>Take a photo or choose one</small></span>
        )}
      </label>
      {/* no "capture": phones offer the camera and the album; computers open the file picker */}
      <input id={id} type="file" accept="image/*" hidden onChange={pick} />
      {value && <div className="row gap-s mt-s">
        <label htmlFor={id} className="btn btn-sm"><Icon name="camera" size={13} /> Change</label>
        <button type="button" className="btn btn-sm btn-ghost text-red" onClick={() => onChange(null)}><Icon name="trash" size={13} /> Remove</button>
      </div>}
    </div>
  );
}

export function CustomerForm({ customer, initialName = '', onClose, onSaved }) {
  const toast = useToast();
  const me = useAuth().user;
  const lockedLimit = !isSuper(me);   // credit limit: Super Admin only
  const locked = !isAdmin(me);        // credit days: admins
  const [busy, setBusy] = useState(false);
  const [f, set, setF] = useForm(customer
    ? { ...customer, nic_no: customer.nic_no || '', nic_front: customer.nic_front ? true : null, nic_back: customer.nic_back ? true : null }
    : { name: '', shop_name: initialName, nic_no: '', nic_front: null, nic_back: null, phone: '', whatsapp: '', city: '', address: '', credit_limit: 0, credit_days: 30, opening_balance: 0, notes: '', active: 1 });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      // a saved photo left as it is (true) is not sent again
      const body = { ...f, nic_front: f.nic_front === true ? undefined : f.nic_front, nic_back: f.nic_back === true ? undefined : f.nic_back };
      const saved = customer ? await api.put(`/customers/${customer.id}`, body) : await api.post('/customers', body);
      toast(customer ? 'Customer updated' : 'Customer added');
      onSaved?.(saved);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={customer ? 'Edit customer' : 'New customer'} subtitle="Shops and people who buy from you" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="cust-form" disabled={busy}>Save customer</button></>}>
      <form id="cust-form" onSubmit={save} className="grid grid-2">
        <Field label="Shop / business name" hint="The main name — shown first everywhere"><input className="input" autoFocus value={f.shop_name || ''} onChange={set('shop_name')} /></Field>
        <Field label="Customer name" required hint="The person — shown under the shop name"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone || ''} onChange={set('phone')} placeholder="07X XXX XXXX" /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp || ''} onChange={set('whatsapp')} /></Field>
        <Field label="City / town"><input className="input" value={f.city || ''} onChange={set('city')} /></Field>
        <Field label="Address"><input className="input" value={f.address || ''} onChange={set('address')} /></Field>
        <Field label={<>Credit limit (Rs) {lockedLimit && <Icon name="shield" size={12} />}</>} hint={lockedLimit ? 'Changing this needs the Super Admin password' : '0 = no limit set'}><NumInput value={f.credit_limit} onChange={set('credit_limit')} /></Field>
        <Field label={<>Credit period (days) {locked && <Icon name="lock" size={12} />}</>} hint={locked ? 'Changing this needs an admin password' : 'Used to set the due date on credit bills'}><NumInput value={f.credit_days} onChange={set('credit_days')} /></Field>
        {!customer && <Field label="Old balance due (Rs)" hint="Amount due before starting this system"><NumInput value={f.opening_balance} onChange={set('opening_balance')} /></Field>}
        <Field label="Notes" className={customer ? 'span-2' : ''}><input className="input" value={f.notes || ''} onChange={set('notes')} /></Field>
        <div className="span-2 nic-block">
          <Field label="NIC number" hint="Old: 9 digits and V (852345678V) · New: 12 digits">
            <input className="input" value={f.nic_no || ''} onChange={(e) => setF((x) => ({ ...x, nic_no: e.target.value.toUpperCase() }))} placeholder="e.g. 852345678V" maxLength={14} autoComplete="off" />
          </Field>
          <div className="nic-photos">
            <NicPhoto label="NIC front" side="front" value={f.nic_front} customerId={customer?.id} onChange={(v) => setF((x) => ({ ...x, nic_front: v }))} />
            <NicPhoto label="NIC back" side="back" value={f.nic_back} customerId={customer?.id} onChange={(v) => setF((x) => ({ ...x, nic_back: v }))} />
          </div>
        </div>
        {customer && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active customer</label>}
      </form>
    </Modal>
  );
}

/* ================= SUPPLIER ================= */
export function SupplierForm({ supplier, initialName = '', initialOrigin = 'india', onClose, onSaved, onDeleted }) {
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
      footer={<>
        {supplier && onDeleted && (() => {
          // only a supplier with nothing due can go; deleting always needs the Super Admin's password
          const due = n(supplier.balance_inr) > 0.009;
          const remove = async () => {
            if (!confirm(`Delete ${supplier.name}?\n\nTheir GRNs and payments stay in the records; they just leave the supplier list.`)) return;
            setBusy(true);
            try { await api.del(`/suppliers/${supplier.id}`); toast(`${supplier.name} deleted`); onDeleted(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
          };
          return (
            <button type="button" className="btn btn-danger" disabled={busy || due} onClick={remove}
              title={due ? `${supMoney(supplier)(supplier.balance_inr)} is still due — settle it before deleting` : 'Delete this supplier (Super Admin)'}>
              <Icon name="trash" size={15} /> Delete
            </button>
          );
        })()}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="sup-form" disabled={busy}>Save supplier</button>
      </>}>
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

/**
 * Which bill · how they pay (`method`, shown second) · its balance, the amount and what is left, the date.
 * `fixed`: paid by cheque — the amount is the cheques' total, not typed.
 */
function BillAndAmount({ bills, billKey, billLabel, f, setF, set, money, amountKey, amountLabel, amountHint, verb, method, fixed = false }) {
  const open = bills.filter((b) => b.balance > 0.009);
  // the balance shown: after the customer's cheques still waiting to be passed (they are not paid yet)
  const after = (b) => b.balance_after_cheques ?? b.balance;
  const total = r2(open.reduce((a, b) => a + after(b), 0));
  const bill = open.find((b) => String(b.id) === String(f[billKey]));
  const due = bill ? after(bill) : total;             // what this payment is set against
  const left = r2(due - n(f[amountKey]));
  const waiting = r2((bill ? [bill] : open).reduce((a, b) => a + (b.cheque_pending || 0), 0));
  const returned = (bill ? [bill] : open).flatMap((b) => b.cheques_returned || []);
  return (
    <>
      <PayStep title="For which bill?">
        <select className="input" value={f[billKey]} onChange={(e) => setF((x) => ({ ...x, [billKey]: e.target.value }))}>
          <option value="">All bills · oldest first ({money(total)})</option>
          {open.filter((b) => b.id).map((b) => <option key={b.id} value={b.id}>{billLabel(b)} · {money(after(b))}{b.cheque_pending > 0 ? ` (+ ${money(b.cheque_pending)} cheque waiting)` : ''}</option>)}
        </select>
        {(waiting > 0 || returned.length > 0) && (
          <div className="row gap-s wrap mt-s">
            {waiting > 0 && <span className="chq-wait">{money(waiting)} by cheque · waiting to pass</span>}
            {returned.map((c) => <ChequeReturned key={c.id} c={c} money={money} />)}
          </div>
        )}
      </PayStep>
      {method}
      <PayStep title={`Amount ${verb}`}>
        <div className="grid grid-3">
          <Field label={bill ? 'Bill balance' : 'Total balance'} hint={waiting > 0 ? `After the ${money(waiting)} cheque waiting` : ''}>
            <div className="input input-static strong">{money(due)}</div>
          </Field>
          <Field label={amountLabel} required={!fixed} hint={fixed ? 'The total of the cheques above' : amountHint}>
            {fixed
              ? <div className="input input-static strong">{money(n(f[amountKey]))}</div>
              : <NumInput money autoFocus value={f[amountKey]} onChange={set(amountKey)} placeholder="0.00" />}
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

/** "Cheque 12345 returned · Rs 75,000.00" — a cheque that came back, so its bill is owed again. */
export function ChequeReturned({ c, money = lkr }) {
  return <span className="chq-returned" title={c.returned_on ? `Returned on ${niceDate(c.returned_on)}` : 'Returned'}>Cheque {c.cheque_no} returned · {money(c.amount)}</span>;
}

/* ---------------- CHEQUES: one payment can be split over several cheques ---------------- */
const blankCheque = (amount = '') => ({ owner: '', bank: '', cheque_no: '', amount, cheque_date: today() });
/** Banks offered as you type the cheque's bank (any other name can be typed). */
export const BANKS = ['Bank of Ceylon (BOC)', "People's Bank", 'Commercial Bank', 'Hatton National Bank (HNB)', 'Sampath Bank', 'Seylan Bank',
  'National Savings Bank (NSB)', 'NDB Bank', 'DFCC Bank', 'Nations Trust Bank', 'Pan Asia Bank', 'Union Bank', 'Cargills Bank', 'Amana Bank',
  'HSBC', 'Standard Chartered', 'Regional Development Bank (RDB)', 'Sanasa Development Bank'];
export const BankList = () => <datalist id="bank-list">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>;
/** Paid by cheque: the payment amount is the total of the cheques (it is not typed). */
function useCheques(f, setF, amountKey) {
  const [rows, setRows] = useState([blankCheque()]);
  const cheque = f.method === 'Cheque';
  useEffect(() => {
    if (cheque) setF((x) => ({ ...x, [amountKey]: r2(rows.reduce((t, c) => t + n(c.amount), 0)) || '' }));
  }, [cheque]); // eslint-disable-line
  const change = (next) => {
    setRows(next);
    setF((x) => ({ ...x, [amountKey]: r2(next.reduce((t, c) => t + n(c.amount), 0)) || '' }));
  };
  const total = r2(rows.reduce((t, c) => t + n(c.amount), 0));
  return { cheque, rows, change, total };
}
/** Cheque details: owner, bank, number, amount, date — one row per cheque. */
function ChequeRows({ ch, money, ownerPlaceholder }) {
  const upd = (i, patch) => ch.change(ch.rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  return (
    <div className="cheque-rows">
      <BankList />
      {ch.rows.map((r, i) => (
        <div key={i} className="cheque-row">
          <span className="cheque-no-label">Cheque {ch.rows.length > 1 ? i + 1 : ''}</span>
          <Field label="Cheque owner"><input className="input" value={r.owner} placeholder={ownerPlaceholder} onChange={(e) => upd(i, { owner: e.target.value })} /></Field>
          <Field label="Bank"><input className="input" list="bank-list" value={r.bank} placeholder="Which bank's cheque" onChange={(e) => upd(i, { bank: e.target.value })} /></Field>
          <Field label="Cheque number" required><input className="input" value={r.cheque_no} inputMode="numeric" onChange={(e) => upd(i, { cheque_no: e.target.value })} /></Field>
          <Field label="Amount" required><NumInput money value={r.amount} onChange={(v) => upd(i, { amount: v })} placeholder="0.00" /></Field>
          <Field label="Cheque date" required><DateInput value={r.cheque_date} onChange={(e) => upd(i, { cheque_date: e.target.value })} /></Field>
          {ch.rows.length > 1 && (
            <button type="button" className="btn btn-icon btn-sm btn-ghost cheque-remove" title="Remove this cheque" onClick={() => ch.change(ch.rows.filter((_, k) => k !== i))}><Icon name="x" size={14} /></button>
          )}
        </div>
      ))}
      <div className="row gap-s">
        <button type="button" className="btn btn-sm" onClick={() => ch.change([...ch.rows, blankCheque()])}><Icon name="plus" size={14} /> Add another cheque</button>
        <span className="spacer" />
        <span className="muted small">{ch.rows.length} cheque{ch.rows.length === 1 ? '' : 's'} · total <b>{money(ch.total)}</b></span>
      </div>
    </div>
  );
}
/** Checks the cheques before saving; returns an error message, or null. */
const chequeProblem = (ch) => {
  for (const [i, c] of ch.rows.entries()) {
    const name = ch.rows.length > 1 ? `Cheque ${i + 1}` : 'The cheque';
    if (!String(c.cheque_no).trim()) return `${name}: enter the cheque number`;
    if (!(n(c.amount) > 0)) return `${name}: enter the amount`;
    if (!c.cheque_date) return `${name}: enter the cheque date`;
  }
  return null;
};

/** Before a payment is saved: what will be recorded, and a clear Yes. */
function ConfirmPay({ title, rows, amount, cheques, money, note, okLabel, busy, onConfirm, onBack }) {
  return (
    <Modal size="sm" title={title} subtitle="Check the details, then complete the payment" onClose={onBack}
      footer={<><button className="btn" onClick={onBack} disabled={busy}>Back</button>
        <button className="btn btn-primary" autoFocus onClick={onConfirm} disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : okLabel}</button></>}>
      <div className="stack">
        <div className="pay-total"><span>Amount</span><b>{amount}</b></div>
        <dl className="kv">{rows.filter(Boolean).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
        {cheques?.length > 0 && (
          <div className="confirm-cheques">
            {cheques.map((c, i) => (
              <div key={i} className="confirm-cheque">
                <div className="confirm-cheque-main">
                  <b className="mono">#{c.cheque_no}</b>
                  <span className="sub">{[c.owner, c.bank].filter(Boolean).join(' · ') || '—'}</span>
                </div>
                <div className="confirm-cheque-amt">
                  <b>{money(n(c.amount))}</b>
                  <span className="sub">Dated {niceDate(c.cheque_date)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {note && <p className="muted small">{note}</p>}
      </div>
    </Modal>
  );
}

/* ---------------- PAY SUPPLIER ---------------- */
export function SupplierPaymentModal({ supplier, bills = [], defaultGrnId, onClose, onSaved }) {
  const { settings } = useSettings();
  const toast = useToast();
  const preset = bills.find((b) => b.id === defaultGrnId && b.balance > 0.009);
  // recorded at the fixed costing rate, like every cost — a local supplier is paid in Rs (no rate), often by cheque
  const local = isLocalSup(supplier);
  const methods = local ? PAY_METHODS_SUPPLIER : PAY_METHODS_SUPPLIER.filter((m) => m !== 'Cheque');
  const [f, set, setF] = useForm({ date: today(), grn_id: preset?.id ?? '', amount_inr: '', method: local ? 'Cash' : 'Bank transfer', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);   // the "complete this payment?" pop-up
  const rate = local ? 1 : n(settings.costing_rate) || 3.5;
  const cur = supMoney(supplier);
  const ch = useCheques(f, setF, 'amount_inr');

  const save = (e) => {
    e.preventDefault();
    if (ch.cheque && chequeProblem(ch)) return toast(chequeProblem(ch), 'error');
    if (!(n(f.amount_inr) > 0)) return toast('Enter the amount you are paying', 'error');
    setReview(true);
  };
  const complete = async () => {
    setBusy(true);
    try {
      const r = await api.send(`/suppliers/${supplier.id}/payments`, { ...f, grn_id: Number(f.grn_id) > 0 ? f.grn_id : null, ...(ch.cheque ? { cheques: ch.rows } : {}) },
        { kind: 'supplier-payment', label: `Paid ${supplier.name}${ch.cheque ? ' (cheque)' : ''}`, amount: ch.cheque ? ch.total : n(f.amount_inr), money: local ? 'LKR' : 'INR' });
      if (r.queued) {
        await cachePatch('/dues/payables', (rows) => settleRows(rows, 'supplier_id', supplier.id, Number(f.grn_id) || null, ch.cheque ? ch.total : n(f.amount_inr)));
        toast(`No internet — the payment to ${supplier.name} is saved on this device and is sent by itself when the internet is back`);
      }
      else toast(ch.cheque ? `${ch.rows.length} cheque${ch.rows.length === 1 ? '' : 's'} (${cur(ch.total)}) given to ${supplier.name} — see the Cheque Desk` : `Paid ${cur(f.amount_inr)} to ${supplier.name}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (<>
    <Modal size={ch.cheque ? 'lg' : 'md'} title={`Pay ${supplier.name}`} subtitle={local ? 'Money you pay the supplier, in Sri Lankan Rupees (Rs)' : 'Money you pay the supplier, in Indian Rupees (₹)'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="sp-form" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : n(f.amount_inr) > 0 ? `Make payment · ${cur(f.amount_inr)}` : 'Make payment'}</button></>}>
      <form id="sp-form" onSubmit={save} className="pay-form">
        <BillAndAmount bills={bills} billKey="grn_id" billLabel={(b) => b.grn_no} f={f} setF={setF} set={set} money={cur}
          amountKey="amount_inr" amountLabel={local ? 'Amount paying (Rs)' : 'Amount paying (₹)'} verb="paying" fixed={ch.cheque}
          amountHint={!local && n(f.amount_inr) > 0 ? `= ${lkr(r2(n(f.amount_inr) * rate))} at Rs ${rate.toFixed(2)} per ₹1` : ''}
          method={(
            <PayStep title="How are you paying?">
              <select className="input" value={f.method} onChange={set('method')}>{methods.map((m) => <option key={m}>{m}</option>)}</select>
              {ch.cheque && <>
                <ChequeRows ch={ch} money={cur} ownerPlaceholder="Whose cheque is this?" />
                <p className="muted small">Each cheque settles its part of the bill when you hand it over. If one comes back, mark it <b>Returned</b> on the Cheque Desk and that amount is owed again.</p>
              </>}
            </PayStep>
          )} />
        <PayStep title={ch.cheque ? 'Notes' : 'Reference & notes'}>
          <div className={ch.cheque ? '' : 'grid grid-2'}>
            {!ch.cheque && <Field label="Reference / slip no" hint="Optional"><input className="input" value={f.reference} onChange={set('reference')} /></Field>}
            <Field label="Notes" hint="Optional"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
          </div>
        </PayStep>
      </form>
    </Modal>
    {review && <ConfirmPay title={`Pay ${supplier.name}?`} amount={cur(n(f.amount_inr))} money={cur} busy={busy} onBack={() => setReview(false)} onConfirm={complete}
      okLabel={ch.cheque ? `Yes, give ${ch.rows.length === 1 ? 'the cheque' : `${ch.rows.length} cheques`}` : 'Yes, complete payment'}
      rows={[['To', supplier.name], ['For', bills.find((b) => String(b.id) === String(f.grn_id))?.grn_no || 'Oldest bills first'], ['How', f.method], ['Date', niceDate(f.date)],
        !local && ['In Rs', lkr(r2(n(f.amount_inr) * rate))], f.reference && !ch.cheque && ['Reference', f.reference]]}
      cheques={ch.cheque ? ch.rows : null} note={ch.cheque ? 'Each cheque settles its part when handed over; a returned cheque is owed again.' : ''} />}
  </>);
}

/* ---------------- RECEIVE FROM CUSTOMER ---------------- */
export function CustomerPaymentModal({ customer, bills = [], defaultSaleId, onClose, onSaved }) {
  const toast = useToast();
  const preset = bills.find((b) => b.id === defaultSaleId && b.balance > 0.009);
  const [f, set, setF] = useForm({ date: today(), sale_id: preset?.id ?? '', amount: '', method: 'Cash', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);   // the "complete this payment?" pop-up
  const ch = useCheques(f, setF, 'amount');

  const save = (e) => {
    e.preventDefault();
    if (ch.cheque && chequeProblem(ch)) return toast(chequeProblem(ch), 'error');
    if (!(n(f.amount) > 0)) return toast('Enter the amount you are receiving', 'error');
    setReview(true);
  };
  const complete = async () => {
    setBusy(true);
    try {
      const r = await api.send(`/customers/${customer.id}/payments`, { ...f, sale_id: Number(f.sale_id) > 0 ? f.sale_id : null, ...(ch.cheque ? { cheques: ch.rows } : {}) },
        { kind: 'customer-payment', label: `Received from ${custName(customer)}${ch.cheque ? ' (cheque)' : ''}`, amount: ch.cheque ? ch.total : n(f.amount), money: 'LKR' });
      if (r.queued) {
        // cash and transfers bring the due down now; a cheque only once it is passed (as online)
        if (!ch.cheque) {
          await cachePatch('/dues/receivables', (rows) => settleRows(rows, 'customer_id', customer.id, Number(f.sale_id) || null, n(f.amount)));
          await cachePatch('/customers', (list) => list.map((c) => (c.id === customer.id ? { ...c, balance: Math.max(0, (c.balance || 0) - n(f.amount)) } : c)));
        }
        toast(`No internet — ${lkr(ch.cheque ? ch.total : f.amount)} from ${custName(customer)} is saved on this device and is sent by itself when the internet is back`);
      }
      else toast(ch.cheque ? `Cheque${ch.rows.length === 1 ? '' : 's'} of ${lkr(ch.total)} from ${custName(customer)} recorded — their due comes down when it is passed` : `Received ${lkr(f.amount)} from ${custName(customer)}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (<>
    <Modal size={ch.cheque ? 'lg' : 'md'} title={`Receive from ${custName(customer)}`} subtitle="Money the customer pays you, in Sri Lankan Rupees (Rs)" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="cp-form" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : ch.cheque ? `Record cheque${ch.rows.length === 1 ? '' : 's'}${n(f.amount) > 0 ? ` · ${lkr(f.amount)}` : ''}` : n(f.amount) > 0 ? `Receive payment · ${lkr(f.amount)}` : 'Receive payment'}</button></>}>
      <form id="cp-form" onSubmit={save} className="pay-form">
        <BillAndAmount bills={bills} billKey="sale_id" billLabel={(b) => `${b.invoice_no} · ${niceDate(b.date)}`} f={f} setF={setF} set={set} money={lkr}
          amountKey="amount" amountLabel="Amount receiving (Rs)" verb="receiving" fixed={ch.cheque}
          method={(
            <PayStep title="How are they paying?">
              <select className="input" value={f.method} onChange={set('method')}>{PAY_METHODS_CUSTOMER.map((m) => <option key={m}>{m}</option>)}</select>
              {ch.cheque && <>
                <ChequeRows ch={ch} money={lkr} ownerPlaceholder={customer.shop_name || customer.name} />
                <div className="alert alert-amber small"><Icon name="clock" size={16} /><span>A cheque does not clear the bill yet: <b>{custName(customer)}'s due comes down when the cheque is marked Passed</b> on the Cheque Desk.</span></div>
              </>}
            </PayStep>
          )} />
        <PayStep title={ch.cheque ? 'Notes' : 'Reference & notes'}>
          <div className={ch.cheque ? '' : 'grid grid-2'}>
            {!ch.cheque && <Field label="Reference" hint="Optional"><input className="input" value={f.reference} onChange={set('reference')} /></Field>}
            <Field label="Notes" hint="Optional"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
          </div>
        </PayStep>
      </form>
    </Modal>
    {review && <ConfirmPay title={ch.cheque ? `Record ${custName(customer)}'s cheque${ch.rows.length === 1 ? '' : 's'}?` : `Receive from ${custName(customer)}?`} amount={lkr(n(f.amount))} money={lkr} busy={busy}
      onBack={() => setReview(false)} onConfirm={complete} okLabel={ch.cheque ? 'Yes, record cheque' + (ch.rows.length === 1 ? '' : 's') : 'Yes, complete payment'}
      rows={[['From', custName(customer)], ['For', bills.find((b) => String(b.id) === String(f.sale_id))?.invoice_no || 'Oldest bills first'], ['How', f.method], ['Date', niceDate(f.date)], f.reference && !ch.cheque && ['Reference', f.reference]]}
      cheques={ch.cheque ? ch.rows : null} note={ch.cheque ? `${custName(customer)}'s due comes down when the cheque is marked Passed on the Cheque Desk.` : ''} />}
  </>);
}

/* ---------------- PAY CARGO (bulk: oldest shipments first) ---------------- */
export const PAY_METHODS_CARGO = ['Cheque', 'Cash', 'Bank transfer'];
export function CargoPaymentModal({ companies = [], initial = '', onClose, onSaved }) {
  const toast = useToast();
  const named = companies.filter((c) => c.named);
  const [f, set, setF] = useForm({ cargo: initial || (named.find((c) => c.balance > 0) || named[0])?.key || '', date: today(), amount: '', method: 'Cheque', reference: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState(false);   // the "complete this payment?" pop-up
  const ch = useCheques(f, setF, 'amount');
  const co = named.find((c) => c.key === f.cargo);
  const left = r2((co?.balance || 0) - n(f.amount));

  const save = (e) => {
    e.preventDefault();
    if (!co) return toast('Choose the cargo company', 'error');
    if (ch.cheque && chequeProblem(ch)) return toast(chequeProblem(ch), 'error');
    if (!(n(f.amount) > 0)) return toast('Enter the amount you are paying', 'error');
    setReview(true);
  };
  const complete = async () => {
    setBusy(true);
    try {
      await api.post('/cargo/payments', { cargo_name: co.cargo_name, date: f.date, method: f.method, amount: f.amount, reference: f.reference, notes: f.notes, ...(ch.cheque ? { cheques: ch.rows } : {}) });
      toast(ch.cheque ? `${ch.rows.length} cheque${ch.rows.length === 1 ? '' : 's'} (${lkr(ch.total)}) given to ${co.cargo_name} — see the Cheque Desk` : `Paid ${lkr(f.amount)} to ${co.cargo_name}`);
      onSaved?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  return (<>
    <Modal size={ch.cheque ? 'lg' : 'md'} title="Pay cargo" subtitle="Cargo charges are paid in bulk — the oldest shipments are settled first" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" form="cg-form" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : n(f.amount) > 0 ? `Make payment · ${lkr(f.amount)}` : 'Make payment'}</button></>}>
      <form id="cg-form" onSubmit={save} className="pay-form">
        <PayStep title="Which cargo company?">
          <select className="input" value={f.cargo} onChange={set('cargo')}>
            {!named.length && <option value="">No cargo company on the GRNs yet</option>}
            {named.map((c) => <option key={c.key} value={c.key}>{c.cargo_name} · to pay {lkr(c.balance)}</option>)}
          </select>
          {co?.balance > 0.009 && co.cheques_returned?.length > 0 && (
            <div className="row gap-s wrap mt-s">{co.cheques_returned.map((c) => <ChequeReturned key={c.id} c={c} />)}</div>
          )}
        </PayStep>
        <PayStep title="How are you paying?">
          <select className="input" value={f.method} onChange={set('method')}>{PAY_METHODS_CARGO.map((m) => <option key={m}>{m}</option>)}</select>
          {ch.cheque && <>
            <ChequeRows ch={ch} money={lkr} ownerPlaceholder="Whose cheque is this?" />
            <p className="muted small">Split the payment over several cheques with different dates if you need to. Each cheque settles its part when handed over; a <b>Returned</b> cheque (Cheque Desk) is owed again.</p>
          </>}
        </PayStep>
        <PayStep title="Amount paying">
          <div className="grid grid-3">
            <Field label="To pay"><div className="input input-static strong">{lkr(co?.balance || 0)}</div></Field>
            <Field label="Amount paying (Rs)" required={!ch.cheque} hint={ch.cheque ? 'The total of the cheques above' : ''}>
              {ch.cheque
                ? <div className="input input-static strong">{lkr(n(f.amount))}</div>
                : <NumInput money autoFocus value={f.amount} onChange={set('amount')} placeholder="0.00" />}
            </Field>
            <Field label="Balance after this" hint={left < 0 ? 'The extra is kept as an advance' : left === 0 ? 'Fully paid' : ''}>
              <div className={`input input-static strong ${left <= 0 ? 'text-green' : 'text-red'}`}>{lkr(Math.max(0, left))}</div>
            </Field>
          </div>
          <Field label="Date" className="pay-date"><DateInput value={f.date} onChange={set('date')} /></Field>
        </PayStep>
        <PayStep title={ch.cheque ? 'Notes' : 'Reference & notes'}>
          <div className={ch.cheque ? '' : 'grid grid-2'}>
            {!ch.cheque && <Field label="Reference / slip no" hint="Optional"><input className="input" value={f.reference} onChange={set('reference')} /></Field>}
            <Field label="Notes" hint="Optional"><input className="input" value={f.notes} onChange={set('notes')} /></Field>
          </div>
        </PayStep>
      </form>
    </Modal>
    {review && <ConfirmPay title={`Pay ${co?.cargo_name}?`} amount={lkr(n(f.amount))} money={lkr} busy={busy} onBack={() => setReview(false)} onConfirm={complete}
      okLabel={ch.cheque ? `Yes, give ${ch.rows.length === 1 ? 'the cheque' : `${ch.rows.length} cheques`}` : 'Yes, complete payment'}
      rows={[['To', co?.cargo_name], ['For', 'Oldest shipments first'], ['How', f.method], ['Date', niceDate(f.date)], ['Still to pay after', lkr(Math.max(0, left))], f.reference && !ch.cheque && ['Reference', f.reference]]}
      cheques={ch.cheque ? ch.rows : null} note={ch.cheque ? 'Each cheque settles its part when handed over; a returned cheque is owed again.' : ''} />}
  </>);
}
