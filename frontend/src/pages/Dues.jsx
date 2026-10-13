import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi, lkr, inr, niceDate, dueText } from '../lib.js';
import { PageHeader, Card, Loading, ErrorBox, Empty, Stat, Tabs, Icon } from '../components/ui.jsx';
import { SupplierPaymentModal, CustomerPaymentModal } from '../components/forms.jsx';
import { whatsappReminder } from './CustomerView.jsx';
import { useSettings } from '../App.jsx';

const GROUPS = [
  { key: 'overdue', title: 'Overdue — act now', tone: 'red' },
  { key: 'due-soon', title: 'Due within 7 days', tone: 'amber' },
  { key: 'open', title: 'Later', tone: 'blue' },
];

export default function Dues() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'receivables';
  const { settings } = useSettings();
  const pay = useApi('/dues/payables');
  const rec = useApi('/dues/receivables');
  const [modal, setModal] = useState(null);

  const isPay = tab === 'payables';
  const src = isPay ? pay : rec;
  const fmt = isPay ? inr : lkr;
  const rows = src.data || [];
  const sum = (k) => rows.filter((r) => !k || r.status === k).reduce((a, b) => a + b.balance, 0);

  const openPay = async (b) => {
    if (isPay) setModal({ type: 'sup', who: await api.get(`/suppliers/${b.supplier_id}`), id: b.id });
    else setModal({ type: 'cus', who: await api.get(`/customers/${b.customer_id}`), id: b.id });
  };
  const done = () => { setModal(null); pay.reload(); rec.reload(); };

  return (
    <div>
      <PageHeader title="Payments Due" subtitle="Money to collect from customers, and money to pay suppliers in India — sorted by due date." />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: 'receivables', label: 'To collect from customers', count: rec.data?.length },
        { value: 'payables', label: 'To pay suppliers', count: pay.data?.length },
      ]} />

      <div className="stats mb">
        <Stat icon="wallet" tone="blue" label={isPay ? 'Total to pay' : 'Total to collect'} value={fmt(sum())} />
        <Stat icon="alert" tone="red" label="Overdue" value={fmt(sum('overdue'))} />
        <Stat icon="clock" tone="amber" label="Due in 7 days" value={fmt(sum('due-soon'))} />
        <Stat icon="check" tone="green" label="Not due yet" value={fmt(sum('open'))} />
      </div>

      <ErrorBox error={src.error} onRetry={src.reload} />
      {src.loading && !src.data ? <Loading /> : rows.length === 0 ? (
        <Card><Empty icon="check" title={isPay ? 'Nothing to pay suppliers' : 'No customer has dues'} text="Everything is settled. 🎉" /></Card>
      ) : (
        <div className="stack">
          {GROUPS.map((g) => {
            const list = rows.filter((r) => r.status === g.key);
            if (!list.length) return null;
            return (
              <Card key={g.key} title={<span className="row gap-s"><span className={`badge badge-${g.tone}`}>{list.length}</span> {g.title}</span>} actions={<b className="mono">{fmt(list.reduce((a, b) => a + b.balance, 0))}</b>} pad={false}>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>{isPay ? 'Supplier' : 'Customer'}</th><th>{isPay ? 'GRN · Bale' : 'Bill'}</th><th>Date</th><th>Due date</th><th className="right">Amount</th><th className="right">Balance</th><th></th></tr></thead>
                    <tbody>
                      {list.map((b) => (
                        <tr key={`${b.supplier_id || b.customer_id}-${b.id}`} className="hover">
                          <td><Link to={isPay ? `/suppliers/${b.supplier_id}` : `/customers/${b.customer_id}`} className="strong">{b.supplier_name || b.customer_name}</Link>{b.customer_phone && <div className="sub">{b.customer_phone}</div>}</td>
                          <td>{isPay ? (b.id ? <Link to={`/grn/${b.id}`}>{b.grn_no}</Link> : b.grn_no) : (b.id ? <Link to={`/sales/${b.id}`}>{b.invoice_no}</Link> : b.invoice_no)}</td>
                          <td>{niceDate(b.date)}</td>
                          <td>{niceDate(b.due_date)}<div className={`sub ${b.status === 'overdue' ? 'text-red' : ''}`}>{dueText(b.due_date)}</div></td>
                          <td className="right">{fmt(b.amount)}</td>
                          <td className="right strong">{fmt(b.balance)}</td>
                          <td className="nowrap right">
                            {!isPay && b.customer_phone && b.status === 'overdue' && (
                              <a className="btn btn-sm btn-ghost" title="Send WhatsApp reminder" target="_blank" rel="noreferrer"
                                href={whatsappReminder({ name: b.customer_name, phone: b.customer_phone }, b.balance, settings.shop_name)}><Icon name="phone" size={15} /></a>
                            )}
                            <button className="btn btn-sm" onClick={() => openPay(b)}>{isPay ? 'Pay' : 'Receive'}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
          <span className="muted small">Amounts for suppliers are in Indian Rupees (₹). Customer amounts are in Sri Lankan Rupees (Rs).</span>
        </div>
      )}

      {modal?.type === 'sup' && <SupplierPaymentModal supplier={modal.who} bills={modal.who.bills} defaultGrnId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
      {modal?.type === 'cus' && <CustomerPaymentModal customer={modal.who} bills={modal.who.bills} defaultSaleId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  );
}
