import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, lkr, inr, money, niceDate, int, dueText, margin, pct } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, StatusBadge, useToast } from '../components/ui.jsx';
import { SupplierPaymentModal } from '../components/forms.jsx';

export default function GrnView() {
  const { id } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const { data: g, error, reload } = useApi(`/grns/${id}`);
  const [paying, setPaying] = useState(null);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!g) return <Loading />;

  const del = async () => {
    if (!confirm(`Delete ${g.grn_no}? Its stock will be removed and its payments deleted. This cannot be undone.`)) return;
    try { await api.del(`/grns/${g.id}`); toast(`${g.grn_no} deleted`); navigate('/grn'); } catch (e) { toast(e.message, 'error'); }
  };
  const pay = async () => setPaying(await api.get(`/suppliers/${g.supplier_id}`));
  const expectedValue = g.items.reduce((s, i) => s + (i.expected_per_set / (i.pcs_per_set || 1)) * Math.max(0, (i.sets + i.extra_sets - i.short_sets) * i.pcs_per_set + i.extra_pcs - i.short_pcs), 0);

  return (
    <div>
      <PageHeader back="/grn" title={`${g.grn_no} — ${g.supplier_name}`}
        subtitle={<>Received {niceDate(g.date)} · <StatusBadge status={g.pay_status} /> {g.balance_inr > 0 && dueText(g.due_date)}</>}
        actions={<>
          {g.balance_inr > 0 && <button className="btn btn-primary" onClick={pay}><Icon name="wallet" /> Pay supplier</button>}
          <button className="btn" onClick={() => window.open(`/print/grn/${g.id}`, '_blank')}><Icon name="print" /> Print GRN</button>
          <button className="btn btn-danger" onClick={del}><Icon name="trash" /> Delete</button>
        </>} />

      <div className="stats mb">
        <div className="stat"><div className="stat-text"><div className="stat-label">Cargo</div><div className="stat-value" style={{ fontSize: 17 }}>{g.cargo_name || '—'}</div></div></div>
        <div className="stat"><div className="stat-text"><div className="stat-label">Bale no</div><div className="stat-value" style={{ fontSize: 17 }}>{g.bale_no || '—'}</div></div></div>
        <div className="stat"><div className="stat-text"><div className="stat-label">LR no</div><div className="stat-value" style={{ fontSize: 17 }}>{g.lr_no || '—'}</div></div></div>
        <div className="stat"><div className="stat-text"><div className="stat-label">Rate at receipt</div><div className="stat-value" style={{ fontSize: 17 }}>1 ₹ = Rs {g.exchange_rate.toFixed(4)}</div></div></div>
      </div>

      <div className={`alert ${g.settled_at ? 'alert-green' : 'alert-amber'} mb`}>
        <Icon name={g.settled_at ? 'lock' : 'clock'} />
        {g.settled_at ? (
          <span><b>Cost fixed</b> — the supplier bill is paid, so these goods are costed at <b>Rs {(g.effective_rate ?? g.exchange_rate).toFixed(4)}</b> per rupee (the rates you actually paid).</span>
        ) : (
          <span><b>Cost follows the live rate</b> — {inr(g.paid_inr)} paid is fixed at the rates paid; the unpaid {inr(g.balance_inr)} uses today's rate.
            Cost rate now: <b>Rs {(g.effective_rate ?? g.exchange_rate).toFixed(4)}</b> per rupee. It stops moving once the bill is paid.</span>
        )}
      </div>

      <div className="grn-layout">
        <div className="stack">
          <Card title="Items received" pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th className="right">Received</th><th className="right">Bill ₹/set</th><th className="right">Cost / piece</th><th className="right">Expected / piece</th><th className="right">MRP / piece</th><th className="right">Margin</th></tr></thead>
                <tbody>
                  {g.items.map((i) => {
                    const pcs = Math.max(0, (i.sets + i.extra_sets - i.short_sets) * i.pcs_per_set + i.extra_pcs - i.short_pcs);
                    const per = (v) => v / (i.pcs_per_set || 1);
                    return (
                      <tr key={i.id}>
                        <td><b>{i.name}</b><div className="sub">{i.code} · {i.pcs_per_set} pcs/set{i.colors_count ? ` · ${i.colors_count} colours` : ''}{i.sizes ? ` · ${i.sizes}` : ''}</div></td>
                        <td className="right">{int(pcs)} pcs
                          <div className="sub">{int(i.sets)} sets billed</div>
                          {i.extra_pcs > 0 && <div className="sub text-green">+ {int(i.extra_pcs)} extra pcs (billed)</div>}
                          {i.extra_sets > 0 && <div className="sub text-green">+ {int(i.extra_sets)} free sets</div>}
                          {(i.short_sets > 0 || i.short_pcs > 0) && <div className="sub text-red">− {int(i.short_sets * i.pcs_per_set + i.short_pcs)} pcs short</div>}
                        </td>
                        <td className="right">{money(i.cost_inr_per_set)}<div className="sub">{inr(i.line_inr)}</div></td>
                        <td className="right strong">{lkr(i.landed_per_pcs_lkr)}</td>
                        <td className="right">{lkr(per(i.expected_per_set))}</td>
                        <td className="right">{lkr(per(i.mrp_per_set))}</td>
                        <td className={`right ${margin(i.expected_per_set, i.landed_per_set_lkr) < 0 ? 'text-red' : 'text-green'}`}>{pct(margin(i.expected_per_set, i.landed_per_set_lkr))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid grid-2">
            <Card title="Cargo & local charges (LKR)">
              {g.expenses.length === 0 ? <p className="muted">No extra expenses.</p> : g.expenses.map((e) => (
                <div key={e.id} className="list-row"><span>{e.label}</span><b className="mono">{lkr(e.amount_lkr)}</b></div>
              ))}
            </Card>
            <Card title="Supplier payments">
              {g.payments.length === 0 ? <p className="muted">No payment linked to this GRN yet.</p> : g.payments.map((p) => (
                <div key={p.id} className="list-row"><div><div className="t">{p.method}</div><div className="s">{niceDate(p.date)} · rate {p.exchange_rate} {p.reference ? `· ${p.reference}` : ''}</div></div><div className="right"><b>{inr(p.amount_inr)}</b><div className="s">{lkr(p.amount_lkr)}</div></div></div>
              ))}
              <p className="muted small mt-s">Payments made without choosing a GRN are applied to the oldest bills first.</p>
            </Card>
          </div>
          {g.notes && <Card title="Notes"><p>{g.notes}</p></Card>}
        </div>

        <div className="stack">
          <Card title="Cost breakdown">
            <dl className="kv">
              <dt>Goods</dt><dd>{inr(g.goods_inr)}</dd>
              {g.cargo_charge_inr > 0 && <><dt>Cargo charge (₹)</dt><dd>{inr(g.cargo_charge_inr)}</dd></>}
              <dt>Goods in LKR (× {(g.effective_rate ?? g.exchange_rate).toFixed(4)})</dt><dd>{lkr(g.goods_inr * (g.effective_rate ?? g.exchange_rate))}</dd>
              {g.cargo_charge_inr > 0 && <><dt>Cargo in LKR (× {(g.cargo_in_supplier_bill ? g.effective_rate ?? g.exchange_rate : g.exchange_rate).toFixed(4)})</dt><dd>{lkr(g.cargo_charge_inr * (g.cargo_in_supplier_bill ? g.effective_rate ?? g.exchange_rate : g.exchange_rate))}</dd></>}
              <dt>Cargo & local charges</dt><dd>{lkr(g.expenses_lkr)}</dd>
              <dt className="total">Total cost</dt><dd className="total">{lkr(g.total_lkr)}</dd>
              <dt>Expected sales value</dt><dd>{lkr(expectedValue)}</dd>
              <dt>Expected profit</dt><dd className="text-green">{lkr(expectedValue - g.total_lkr)}</dd>
            </dl>
          </Card>
          <Card title="Supplier account">
            <dl className="kv">
              <dt>Payable for this GRN</dt><dd>{inr(g.payable_inr)}</dd>
              <dt>Paid</dt><dd className="text-green">{inr(g.paid_inr)}</dd>
              <dt className="total">Balance</dt><dd className={`total ${g.balance_inr > 0 ? 'text-red' : ''}`}>{inr(g.balance_inr)}</dd>
              <dt>Due date</dt><dd>{niceDate(g.due_date)}</dd>
            </dl>
            <Link to={`/suppliers/${g.supplier_id}`} className="btn btn-block mt">Open {g.supplier_name}</Link>
          </Card>
        </div>
      </div>

      {paying && <SupplierPaymentModal supplier={paying} bills={paying.bills} defaultGrnId={g.id} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reload(); }} />}
    </div>
  );
}
