import { useMemo, useState } from 'react';
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

/** History, shown under the tables: payments made to suppliers / received from customers, newest first. */
function PaymentHistory({ isPay, version, onHide }) {
  const { data, error, loading, reload } = useApi(`/dues/history?kind=${isPay ? 'payables' : 'receivables'}&v=${version}`);
  const [q, setQ] = useState('');
  const fmt = isPay ? inr : lkr;
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data || []).filter((p) => !words.length || words.every((w) => [p.who, p.bill_no, p.method, p.reference, p.notes].join(' ').toLowerCase().includes(w)));
  }, [data, q]);
  const total = rows.reduce((a, p) => a + p.amount, 0);
  return (
    <Card className="dues-history" title={<span className="row gap-s"><Icon name="clock" size={16} /> {isPay ? 'Payments made — history' : 'Payments received — history'} <span className="badge badge-grey">{rows.length}</span></span>}
      actions={<><b className="mono">{fmt(total)}</b><button className="btn btn-sm btn-ghost" onClick={onHide}><Icon name="x" size={14} /> Hide</button></>}>
      <ErrorBox error={error} onRetry={reload} />
      <div className="toolbar"><div className="search"><Icon name="search" size={16} /><input className="input" placeholder={`Search ${isPay ? 'supplier' : 'customer'}, bill, method or reference…`} value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      {loading && !data ? <Loading /> : !rows.length ? (
        <Empty icon="clock" title={q ? 'Nothing matches' : 'No payments yet'} text={q ? `No payment for "${q}".` : isPay ? 'Payments to suppliers are listed here.' : 'Payments from customers are listed here.'} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>{isPay ? 'Supplier' : 'Customer'}</th><th>{isPay ? 'GRN' : 'Bill'}</th><th>Method</th><th>Reference / notes</th><th className="right">Amount</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="hover">
                  <td className="nowrap">{niceDate(p.date)}</td>
                  <td><Link to={isPay ? `/suppliers/${p.who_id}` : `/customers/${p.who_id}`} className="strong">{p.who}</Link></td>
                  <td>{p.bill_no ? <Link to={isPay ? `/grn/${p.bill_id}` : `/sales/${p.bill_id}`}>{p.bill_no}</Link> : <span className="muted">Oldest first</span>}</td>
                  <td>{p.method || '—'}</td>
                  <td>{p.reference || <span className="muted">—</span>}{p.notes && <div className="sub">{p.notes}</div>}</td>
                  <td className="right nowrap"><b className={isPay ? 'text-amber' : 'text-green'}>{fmt(p.amount)}</b>{isPay && p.amount_lkr ? <div className="sub">{lkr(p.amount_lkr)}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Dues() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'receivables';
  const { settings } = useSettings();
  const pay = useApi('/dues/payables');
  const rec = useApi('/dues/receivables');
  const [modal, setModal] = useState(null);
  const [history, setHistory] = useState(false);
  const [version, setVersion] = useState(0);   // bumped after a payment, so the history reloads too
  const showHistory = () => {
    setHistory((h) => !h);
    setTimeout(() => document.querySelector('.dues-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const isPay = tab === 'payables';
  const src = isPay ? pay : rec;
  const fmt = isPay ? inr : lkr;
  const rows = src.data || [];
  // search: supplier / customer, phone, bill or GRN number
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => !words.length || words.every((w) => [r.supplier_name, r.customer_name, r.customer_phone, r.grn_no, r.invoice_no].join(' ').toLowerCase().includes(w)));
  const sum = (k) => rows.filter((r) => !k || r.status === k).reduce((a, b) => a + b.balance, 0);

  const openPay = async (b) => {
    if (isPay) setModal({ type: 'sup', who: await api.get(`/suppliers/${b.supplier_id}`), id: b.id });
    else setModal({ type: 'cus', who: await api.get(`/customers/${b.customer_id}`), id: b.id });
  };
  const done = () => { setModal(null); pay.reload(); rec.reload(); setVersion((v) => v + 1); };

  return (
    <div>
      <PageHeader title="Payment Portal" subtitle="Money to collect from customers, and money to pay suppliers in India — sorted by due date." />
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

      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={isPay ? 'Search supplier or GRN…' : 'Search customer, phone or bill…'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {q && <button className="btn btn-ghost" onClick={() => setQ('')}>Clear</button>}
      </div>

      <ErrorBox error={src.error} onRetry={src.reload} />
      {src.loading && !src.data ? <Loading /> : rows.length > 0 && shown.length === 0 ? (
        <Card><Empty icon="search" title="Nothing matches" text={`No ${isPay ? 'supplier bill' : 'customer bill'} for "${q}".`} action={<button className="btn" onClick={() => setQ('')}>Clear search</button>} /></Card>
      ) : rows.length === 0 ? (
        <Card><Empty icon="check" title={isPay ? 'Nothing to pay suppliers' : 'No customer has dues'} text="Everything is settled. 🎉" /></Card>
      ) : (
        <div className="stack">
          {GROUPS.map((g) => {
            const list = shown.filter((r) => r.status === g.key);
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
                            <button className={`btn btn-sm ${isPay ? 'btn-pay' : 'btn-receive'}`} onClick={() => openPay(b)}><Icon name={isPay ? 'wallet' : 'cash'} size={14} /> {isPay ? 'Pay' : 'Receive'}</button>
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

      <div className="es-history-bar">
        <button className={`btn btn-sm ${history ? '' : 'btn-ghost'}`} onClick={showHistory}><Icon name="clock" size={14} /> {history ? 'Hide history' : 'History'}</button>
      </div>
      {history && <PaymentHistory isPay={isPay} version={version} onHide={() => setHistory(false)} />}

      {modal?.type === 'sup' && <SupplierPaymentModal supplier={modal.who} bills={modal.who.bills} defaultGrnId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
      {modal?.type === 'cus' && <CustomerPaymentModal customer={modal.who} bills={modal.who.bills} defaultSaleId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  );
}
