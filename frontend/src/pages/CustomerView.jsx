import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, lkr, niceDate, dueText } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, StatusBadge, Stat, Tabs, Badge, Modal, useToast } from '../components/ui.jsx';
import { CustomerForm, CustomerPaymentModal } from '../components/forms.jsx';
import { SaleModal } from './SaleView.jsx';
import { useSettings } from '../App.jsx';

export function whatsappReminder(c, amount, shop) {
  const phone = (c.whatsapp || c.phone || '').replace(/\D/g, '').replace(/^0/, '94');
  const msg = `Dear ${c.name}, this is a friendly reminder from ${shop} that your outstanding balance is ${lkr(amount)}. Kindly arrange the payment at your earliest convenience. Thank you!`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

/**
 * One customer: their dues, their bills, payments and details.
 * Shown as a page (/customers/:id) or, with `modal`, as a pop-up over the Customers list.
 */
function CustomerScreen({ id, modal, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [openSale, setOpenSale] = useState(null);
  const { settings } = useSettings();
  const { data: c, error, reload } = useApi(`/customers/${id}`);
  const [tab, setTab] = useState('open');
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(null);
  const changed = () => { reload(); onChanged?.(); };

  if (error) return modal ? <Modal title="Customer" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Modal> : <ErrorBox error={error} onRetry={reload} />;
  if (!c) return modal ? <Modal title="Customer" onClose={onClose}><Loading /></Modal> : <Loading />;

  const delPayment = async (p) => {
    if (!confirm(`Delete payment of ${lkr(p.amount)} on ${niceDate(p.date)}?`)) return;
    try { await api.del(`/customers/${c.id}/payments/${p.id}`); toast('Payment deleted'); changed(); } catch (e) { toast(e.message, 'error'); }
  };
  const delCustomer = async () => {
    if (!confirm(`Delete customer ${c.name}?`)) return;
    try {
      await api.del(`/customers/${c.id}`);
      toast('Customer deleted');
      if (modal) { onChanged?.(); onClose?.(); } else navigate('/customers');
    } catch (e) { toast(e.message, 'error'); }
  };
  const openBills = c.bills.filter((b) => b.balance > 0);
  const limitUsed = c.credit_limit > 0 ? Math.min(100, (c.balance / c.credit_limit) * 100) : 0;
  const subtitle = [c.shop_name, c.city, c.phone].filter(Boolean).join(' · ');

  const actions = <>
    <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>
    {c.balance > 0 && (c.phone || c.whatsapp) && <a className="btn" href={whatsappReminder(c, c.balance, settings.shop_name)} target="_blank" rel="noreferrer"><Icon name="phone" /> WhatsApp reminder</a>}
    <button className="btn btn-primary" onClick={() => setPaying(true)} disabled={c.balance <= 0}><Icon name="cash" /> Receive payment</button>
  </>;

  const body = <>
    <div className="stats mb">
      <Stat icon="wallet" tone={c.overdue > 0 ? 'red' : 'blue'} label="To collect" value={lkr(c.balance)} sub={c.overdue > 0 ? `${lkr(c.overdue)} overdue` : 'Nothing overdue'} />
      <Stat icon="receipt" label="Total bought" value={lkr(c.total_bought)} sub={`${c.bill_count} bills`} />
      <Stat icon="chart" tone="green" label="Profit from customer" value={lkr(c.profit)} />
      <Stat icon="clock" tone="violet" label="Credit limit" value={c.credit_limit > 0 ? lkr(c.credit_limit) : 'No limit'} sub={c.credit_limit > 0 ? `${limitUsed.toFixed(0)}% used · ${c.credit_days} days` : `${c.credit_days} days credit`} />
    </div>

    <div className="grn-layout">
      <div>
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'open', label: 'Unpaid bills', count: openBills.length },
          { value: 'sales', label: 'All bills', count: c.sales.length },
          { value: 'payments', label: 'Payments received', count: c.payments.length },
        ]} />
        <Card pad={false}>
          <div className="table-wrap">
            {tab === 'open' && (
              <table className="table">
                <thead><tr><th>Bill</th><th>Date</th><th className="right">Amount</th><th className="right">Paid</th><th className="right">Balance</th><th>Due</th><th></th></tr></thead>
                <tbody>
                  {openBills.length === 0 && <tr><td colSpan={7} className="center muted">No unpaid bills. 🎉</td></tr>}
                  {openBills.map((b) => (
                    <tr key={b.id ?? 'ob'}>
                      <td className="strong">{b.id ? <button type="button" className="link-btn" style={{ marginLeft: 0 }} onClick={() => setOpenSale(b.id)}>{b.invoice_no}</button> : b.invoice_no}</td>
                      <td>{niceDate(b.date)}</td>
                      <td className="right">{lkr(b.amount)}</td>
                      <td className="right text-green">{lkr(b.paid)}</td>
                      <td className="right strong">{lkr(b.balance)}</td>
                      <td><StatusBadge status={b.status} /><div className="sub">{dueText(b.due_date)}</div></td>
                      <td><button className="btn btn-sm btn-receive" onClick={() => setPaying(b.id || true)}><Icon name="cash" size={14} /> Receive</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'sales' && (
              <table className="table">
                <thead><tr><th>Bill</th><th>Date</th><th>Type</th><th className="right">Total</th><th></th></tr></thead>
                <tbody>
                  {c.sales.length === 0 && <tr><td colSpan={5} className="center muted">No bills yet.</td></tr>}
                  {c.sales.map((s) => (
                    <tr key={s.id} className={`click ${s.status === 'void' ? 'void' : ''}`} onClick={() => setOpenSale(s.id)}>
                      <td className="strong">{s.invoice_no}</td><td>{niceDate(s.date)}</td>
                      <td><Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type}</Badge></td>
                      <td className="right strong">{lkr(s.total)}</td><td>{s.status === 'void' && <Badge>Cancelled</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {tab === 'payments' && (
              <table className="table">
                <thead><tr><th>Date</th><th>Method</th><th>For bill</th><th className="right">Amount</th><th></th></tr></thead>
                <tbody>
                  {c.payments.length === 0 && <tr><td colSpan={5} className="center muted">No payments yet.</td></tr>}
                  {c.payments.map((p) => (
                    <tr key={p.id}>
                      <td>{niceDate(p.date)}</td><td>{p.method}<div className="sub">{p.reference}</div></td><td>{p.invoice_no || 'Oldest bills'}</td>
                      <td className="right strong">{lkr(p.amount)}</td>
                      <td><button className="btn btn-icon btn-sm btn-ghost" onClick={() => delPayment(p)}><Icon name="trash" size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </div>
      <div className="stack">
        <Card title="Customer details">
          <dl className="info-list">
            <dt>Shop</dt><dd>{c.shop_name || '—'}</dd>
            <dt>Phone</dt><dd>{c.phone || '—'}</dd>
            <dt>WhatsApp</dt><dd>{c.whatsapp || '—'}</dd>
            <dt>Address</dt><dd>{[c.address, c.city].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Notes</dt><dd>{c.notes || '—'}</dd>
          </dl>
        </Card>
        <Link to="/pos" className="btn btn-block"><Icon name="cart" /> New sale</Link>
        {c.bill_count === 0 && c.payments.length === 0 && <button className="btn btn-danger" onClick={delCustomer}><Icon name="trash" /> Delete customer</button>}
      </div>
    </div>

    {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }} />}
    {paying && <CustomerPaymentModal customer={c} bills={c.bills} defaultSaleId={paying === true ? null : paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); changed(); }} />}
    {openSale && <SaleModal id={openSale} onClose={() => setOpenSale(null)} />}
  </>;

  if (modal) {
    return (
      <Modal size="xl" title={c.name} subtitle={subtitle} onClose={onClose}
        footer={<><button className="btn" onClick={onClose}>Close</button><span className="spacer" />{actions}</>}>
        {body}
      </Modal>
    );
  }
  return (
    <div>
      <PageHeader back="/customers" title={c.name} subtitle={subtitle} actions={actions} />
      {body}
    </div>
  );
}

/** Pop-up used by the Customers list. onChanged refreshes the list after an edit, payment or delete. */
export function CustomerModal({ id, onClose, onChanged }) {
  return <CustomerScreen id={id} modal onClose={onClose} onChanged={onChanged} />;
}

export default function CustomerView() {
  const { id } = useParams();
  return <CustomerScreen id={id} />;
}
