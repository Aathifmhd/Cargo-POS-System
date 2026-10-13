import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi, lkr, money, niceDate, int, margin, pct } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Badge, StatusBadge, Modal, useToast } from '../components/ui.jsx';
import { CustomerPaymentModal } from '../components/forms.jsx';

/** Loads one bill and the actions on it (receive payment, print, cancel) — shared by the page and the pop-up. */
function useSale(id, onChanged) {
  const toast = useToast();
  const { data: s, error, reload } = useApi(`/sales/${id}`);
  const [paying, setPaying] = useState(null);
  const changed = () => { reload(); onChanged?.(); };
  const cancel = async () => {
    const reason = prompt('Why are you cancelling this bill? Stock will be returned.');
    if (reason == null) return;
    try { await api.post(`/sales/${s.id}/void`, { reason }); toast('Bill cancelled, stock returned'); changed(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const receive = async () => setPaying(await api.get(`/customers/${s.customer_id}`));
  const print = () => window.open(`/print/sale/${s.id}`, '_blank');
  const paymentModal = paying && (
    <CustomerPaymentModal customer={paying} bills={paying.bills} defaultSaleId={s.id} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); changed(); }} />
  );
  return { s, error, reload, cancel, receive, print, paymentModal };
}

const subtitleOf = (s) => (
  <>{niceDate(s.date)} · {s.customer_name} · <Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type === 'cash' ? 'Cash' : 'Credit'}</Badge> <StatusBadge status={s.pay_status} /></>
);

function SaleActions({ s, receive, print, cancel }) {
  return <>
    {s.status === 'completed' && <button className="btn btn-danger" onClick={cancel}><Icon name="x" /> Cancel bill</button>}
    <button className="btn" onClick={print}><Icon name="print" /> Print bill</button>
    {s.status === 'completed' && s.balance > 0 && <button className="btn btn-primary" onClick={receive}><Icon name="cash" /> Receive payment</button>}
  </>;
}

/** The bill: items (per piece) and the summary. */
function SaleDetails({ s }) {
  return (
    <>
      {s.status === 'void' && <div className="alert alert-red mb"><Icon name="alert" /> This bill was cancelled and its stock returned. {s.notes}</div>}
      <div className="grn-layout">
        <Card title="Items" pad={false}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Product</th><th className="right">Qty</th><th className="right">Price</th><th className="right">MRP</th><th className="right">Expected</th><th className="right">Cost</th><th className="right">Margin</th><th className="right">Amount</th></tr></thead>
              <tbody>
                {s.items.map((i) => (
                  <tr key={i.id}>
                    <td><b>{i.name}</b><div className="sub">{i.code}</div></td>
                    <td className="right nowrap">{int(i.pcs)} pcs</td>
                    <td className="right">{money(i.price / (i.pcs / i.qty || 1))}</td>
                    <td className="right muted">{money(i.mrp_per_unit / (i.pcs / i.qty || 1))}</td>
                    <td className="right muted">{money(i.expected_per_unit / (i.pcs / i.qty || 1))}</td>
                    <td className="right muted">{money(i.cost_per_unit / (i.pcs / i.qty || 1))}</td>
                    <td className={`right ${i.price < i.cost_per_unit ? 'text-red' : 'text-green'}`}>{pct(margin(i.price, i.cost_per_unit))}</td>
                    <td className="right strong">{money(i.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="stack">
          <Card title="Bill summary">
            <dl className="kv">
              <dt>Subtotal</dt><dd>{lkr(s.subtotal)}</dd>
              {s.discount > 0 && <><dt>Discount</dt><dd>- {lkr(s.discount)}</dd></>}
              <dt className="total">Total</dt><dd className="total">{lkr(s.total)}</dd>
              <dt>Cost of goods</dt><dd>{lkr(s.cost_total)}</dd>
              <dt>Profit</dt><dd className={s.profit < 0 ? 'text-red' : 'text-green'}>{lkr(s.profit)} ({pct(margin(s.total, s.cost_total))})</dd>
              {s.payment_type === 'credit' && <>
                <dt>Paid at sale</dt><dd>{lkr(s.paid_at_sale)}</dd>
                <dt>Due date</dt><dd>{niceDate(s.due_date)}</dd>
                <dt>Still to pay</dt><dd className={s.balance > 0 ? 'text-red' : 'text-green'}>{lkr(s.balance)}</dd>
              </>}
            </dl>
          </Card>
          {s.customer_id && (
            <Card title="Customer">
              <div className="stack-s">
                <Link to={`/customers/${s.customer_id}`} className="strong">{s.customer_name}</Link>
                {s.customer_shop && <span className="muted">{s.customer_shop}</span>}
                {s.customer_phone && <span className="row gap-s"><Icon name="phone" size={14} /> {s.customer_phone}</span>}
                {s.customer_balance != null && <span>Total they owe now: <b className={s.customer_balance > 0 ? 'text-red' : ''}>{lkr(s.customer_balance)}</b></span>}
              </div>
            </Card>
          )}
          {s.payments.length > 0 && (
            <Card title="Payments for this bill">
              {s.payments.map((p) => <div key={p.id} className="list-row"><div><div className="t">{p.method}</div><div className="s">{niceDate(p.date)} {p.reference}</div></div><b>{lkr(p.amount)}</b></div>)}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** Pop-up view of a bill, used by Sales & Bills. onChanged lets the list refresh after a payment or cancel. */
export function SaleModal({ id, onClose, onChanged }) {
  const { s, error, reload, cancel, receive, print, paymentModal } = useSale(id, onChanged);
  return (
    <Modal size="xl" title={s ? `Bill ${s.invoice_no}` : 'Bill'} subtitle={s ? subtitleOf(s) : null} onClose={onClose}
      footer={s ? <><span className="spacer" /><SaleActions s={s} receive={receive} print={print} cancel={cancel} /></> : null}>
      {error ? <ErrorBox error={error} onRetry={reload} /> : !s ? <Loading /> : <SaleDetails s={s} />}
      {paymentModal}
    </Modal>
  );
}

/** Full page (/sales/:id), still used by links from other screens. */
export default function SaleView() {
  const { id } = useParams();
  const { s, error, reload, cancel, receive, print, paymentModal } = useSale(id);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!s) return <Loading />;
  return (
    <div>
      <PageHeader back="/sales" title={`Bill ${s.invoice_no}`} subtitle={subtitleOf(s)} actions={<SaleActions s={s} receive={receive} print={print} cancel={cancel} />} />
      <SaleDetails s={s} />
      {paymentModal}
    </div>
  );
}
