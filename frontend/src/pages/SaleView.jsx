import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, useApi, lkr, money, niceDate, int, margin, pct } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Badge, StatusBadge, useToast } from '../components/ui.jsx';
import { CustomerPaymentModal } from '../components/forms.jsx';

export default function SaleView() {
  const { id } = useParams();
  const toast = useToast();
  const { data: s, error, reload } = useApi(`/sales/${id}`);
  const [paying, setPaying] = useState(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!s) return <Loading />;

  const cancel = async () => {
    const reason = prompt('Why are you cancelling this bill? Stock will be returned.');
    if (reason == null) return;
    try { await api.post(`/sales/${s.id}/void`, { reason }); toast('Bill cancelled, stock returned'); reload(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const receive = async () => {
    const c = await api.get(`/customers/${s.customer_id}`);
    setPaying(c);
  };

  return (
    <div>
      <PageHeader back="/sales" title={`Bill ${s.invoice_no}`}
        subtitle={<>{niceDate(s.date)} · {s.customer_name} · <Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type === 'cash' ? 'Cash' : 'Credit'}</Badge> <StatusBadge status={s.pay_status} /></>}
        actions={<>
          {s.status === 'completed' && s.balance > 0 && <button className="btn btn-primary" onClick={receive}><Icon name="cash" /> Receive payment</button>}
          <button className="btn" onClick={() => window.open(`/print/sale/${s.id}`, '_blank')}><Icon name="print" /> Print bill</button>
          {s.status === 'completed' && <button className="btn btn-danger" onClick={cancel}><Icon name="x" /> Cancel bill</button>}
        </>} />

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
                    <td className="right nowrap">{i.qty} {i.unit === 'set' ? 'set' : 'pcs'}<div className="sub">{int(i.pcs)} pcs</div></td>
                    <td className="right">{money(i.price)}</td>
                    <td className="right muted">{money(i.mrp_per_unit)}</td>
                    <td className="right muted">{money(i.expected_per_unit)}</td>
                    <td className="right muted">{money(i.cost_per_unit)}</td>
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

      {paying && <CustomerPaymentModal customer={paying} bills={paying.bills} defaultSaleId={s.id} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reload(); }} />}
    </div>
  );
}
