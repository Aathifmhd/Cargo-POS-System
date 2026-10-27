import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, inr, lkr, supMoney, isLocalSup, niceDate, dueText, niceTime } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, StatusBadge, Stat, Tabs, Modal, useToast } from '../components/ui.jsx';
import { SupplierForm, SupplierPaymentModal } from '../components/forms.jsx';

/**
 * One supplier: balances, GRNs, payments and details.
 * Shown as a page (/suppliers/:id) or, with `modal`, as a pop-up over the Suppliers list.
 */
function SupplierScreen({ id, modal, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: s, error, reload } = useApi(`/suppliers/${id}`);
  const [tab, setTab] = useState('bills');
  const [editing, setEditing] = useState(false);
  const [paying, setPaying] = useState(null); // grn id or true
  const changed = () => { reload(); onChanged?.(); };

  if (error) return modal ? <Modal title="Supplier" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Modal> : <ErrorBox error={error} onRetry={reload} />;
  if (!s) return modal ? <Modal title="Supplier" onClose={onClose}><Loading /></Modal> : <Loading />;
  const cur = supMoney(s);   // ₹ for an Indian supplier, Rs for a local one

  const delPayment = async (p) => {
    if (!confirm(`Delete payment of ${cur(p.amount_inr)} on ${niceDate(p.date)}?`)) return;
    try { await api.del(`/suppliers/${s.id}/payments/${p.id}`); toast('Payment deleted'); changed(); } catch (e) { toast(e.message, 'error'); }
  };
  const delSupplier = async () => {
    if (!confirm(`Delete ${s.name}?\n\nTheir GRNs and payments stay in the records; they just leave the supplier list.`)) return;
    try {
      await api.del(`/suppliers/${s.id}`);
      toast('Supplier deleted');
      if (modal) { onChanged?.(); onClose?.(); } else navigate('/suppliers');
    } catch (e) { toast(e.message, 'error'); }
  };
  const openBills = s.bills.filter((b) => b.balance > 0);
  const subtitle = [s.code, s.contact_person, s.city, s.state, s.phone].filter(Boolean).join(' · ');

  const actions = <>
    {/* only a supplier with nothing due can be deleted (Super Admin) */}
    <button className="btn btn-danger" onClick={delSupplier} disabled={s.balance_inr > 0.009}
      title={s.balance_inr > 0.009 ? `${cur(s.balance_inr)} is still due — settle it before deleting` : 'Delete this supplier (Super Admin)'}><Icon name="trash" /> Delete</button>
    <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>
    <Link className="btn" to="/grn/new"><Icon name="truck" /> New GRN</Link>
    <button className="btn btn-primary" onClick={() => setPaying(true)} disabled={s.balance_inr <= 0}><Icon name="wallet" /> Record payment</button>
  </>;

  const body = <>
    <div className="stats mb">
      <Stat icon="wallet" tone={s.overdue_inr > 0 ? 'red' : 'amber'} label="To pay" value={cur(s.balance_inr)} sub={s.overdue_inr > 0 ? `${cur(s.overdue_inr)} overdue` : s.next_due ? dueText(s.next_due) : 'All settled'} />
      <Stat icon="layers" label="Total purchased" value={cur(s.purchased_inr)} sub={`${s.grn_count} shipments`} />
      <Stat icon="truck" tone="blue" label="Total cost" value={lkr(s.landed_lkr)} />
      <Stat icon="clock" tone="violet" label="Credit period" value={`${s.credit_days} days`} />
    </div>

    <div className="grn-layout">
      <div>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bills', label: 'GRNs & balances', count: s.bills.length }, { value: 'payments', label: 'Payments made', count: s.payments.length }]} />
        {tab === 'bills' ? (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>GRN</th><th>Date</th><th className="right">Amount</th><th className="right">Paid</th><th className="right">Balance</th><th>Due</th><th></th></tr></thead>
                <tbody>
                  {s.bills.length === 0 && <tr><td colSpan={7} className="muted center">No GRNs yet.</td></tr>}
                  {[...s.bills].reverse().map((b) => (
                    <tr key={b.id ?? 'open'}>
                      <td className="strong">{b.id ? <Link to={`/grn/${b.id}`}>{b.grn_no}</Link> : b.grn_no}</td>
                      <td>{niceDate(b.date)}</td>
                      <td className="right">{cur(b.amount)}</td>
                      <td className="right text-green">{cur(b.paid)}</td>
                      <td className="right strong">{b.balance > 0 ? cur(b.balance) : '—'}</td>
                      <td><StatusBadge status={b.status} />{b.balance > 0 && b.due_date && <div className="sub">{dueText(b.due_date)}</div>}</td>
                      <td>{b.balance > 0 && <button className="btn btn-sm btn-pay" onClick={() => setPaying(b.id || true)}><Icon name="wallet" size={14} /> Pay</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Date</th><th>Method</th><th>For</th><th className="right">INR</th><th className="right">LKR</th><th></th></tr></thead>
                <tbody>
                  {s.payments.length === 0 && <tr><td colSpan={6} className="muted center">No payments yet.</td></tr>}
                  {s.payments.map((p) => (
                    <tr key={p.id}>
                      <td className="nowrap">{niceDate(p.date)}{p.created_at && <div className="sub">{niceTime(p.created_at)}</div>}</td>
                      <td>{p.method}<div className="sub">{p.reference}</div></td>
                      <td>{p.grn_no || 'Oldest bills'}</td>
                      <td className="right strong">{cur(p.amount_inr)}</td>
                      <td className="right">{lkr(p.amount_lkr)}</td>
                      <td><button className="btn btn-icon btn-sm btn-ghost" onClick={() => delPayment(p)} title="Delete"><Icon name="trash" size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      <div className="stack">
        <Card title="Supplier details">
          <dl className="info-list">
            <dt>Supplier code</dt><dd><b>{s.code || '—'}</b></dd>
            <dt>Contact</dt><dd>{s.contact_person || '—'}</dd>
            <dt>Phone</dt><dd>{s.phone || '—'}</dd>
            <dt>WhatsApp</dt><dd>{s.whatsapp ? <a href={`https://wa.me/${s.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">{s.whatsapp}</a> : '—'}</dd>
            <dt>Email</dt><dd>{s.email || '—'}</dd>
            <dt>Address</dt><dd>{[s.address, s.city, s.state].filter(Boolean).join(', ') || '—'}</dd>
            <dt>GST no</dt><dd>{s.gst_no || '—'}</dd>
            <dt>Bank details</dt><dd>{s.bank_details || '—'}</dd>
            <dt>Notes</dt><dd>{s.notes || '—'}</dd>
          </dl>
        </Card>
        {openBills.length === 0 && s.grn_count === 0 && <button className="btn btn-danger" onClick={delSupplier}><Icon name="trash" /> Delete supplier</button>}
      </div>
    </div>

    {editing && <SupplierForm supplier={s} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); changed(); }}
      onDeleted={() => { setEditing(false); if (modal) { onChanged?.(); onClose?.(); } else navigate('/suppliers'); }} />}
    {paying && <SupplierPaymentModal supplier={s} bills={s.bills} defaultGrnId={paying === true ? null : paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); changed(); }} />}
  </>;

  if (modal) {
    return (
      <Modal size="xl" title={s.name} subtitle={subtitle} onClose={onClose}
        footer={<><button className="btn" onClick={onClose}>Close</button><span className="spacer" />{actions}</>}>
        {body}
      </Modal>
    );
  }
  return (
    <div>
      <PageHeader back="/suppliers" title={s.name} subtitle={subtitle} actions={actions} />
      {body}
    </div>
  );
}

/** Pop-up used by the Suppliers list. onChanged refreshes the list after an edit, payment or delete. */
export function SupplierModal({ id, onClose, onChanged }) {
  return <SupplierScreen id={id} modal onClose={onClose} onChanged={onChanged} />;
}

export default function SupplierView() {
  const { id } = useParams();
  return <SupplierScreen id={id} />;
}
