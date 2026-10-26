import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, useApi, lkr, inr, supMoney, isLocalSup, money, niceDate, int, dueText, margin, pct } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, StatusBadge, Modal, useToast } from '../components/ui.jsx';
import { SupplierPaymentModal } from '../components/forms.jsx';
import { StickerModal } from '../components/Stickers.jsx';

/**
 * One GRN: items, costs, cargo charge and the supplier account.
 * Shown as a page (/grn/:id) or, with `modal`, as a pop-up over the Shipments (GRN) list.
 */
function GrnScreen({ id, modal, onClose, onChanged }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: g, error, reload } = useApi(`/grns/${id}`);
  const [paying, setPaying] = useState(null);
  // just saved on Receive Goods: ask about the stickers once
  const location = useLocation();
  const [stickers, setStickers] = useState(() => (location.state?.askStickers ? 'asked' : null));
  const closeStickers = () => { setStickers(null); if (location.state?.askStickers) navigate(location.pathname, { replace: true, state: {} }); };
  const changed = () => { reload(); onChanged?.(); };

  if (error) return modal ? <Modal title="GRN" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Modal> : <ErrorBox error={error} onRetry={reload} />;
  if (!g) return modal ? <Modal title="GRN" onClose={onClose}><Loading /></Modal> : <Loading />;
  const cur = supMoney(g);   // ₹ for an Indian supplier's GRN, Rs for a local one
  const local = isLocalSup(g);

  const del = async () => {
    if (!confirm(`Delete ${g.grn_no}? Its stock will be removed and its payments deleted. This cannot be undone.`)) return;
    try {
      await api.del(`/grns/${g.id}`);
      toast(`${g.grn_no} deleted`);
      if (modal) { onChanged?.(); onClose?.(); } else navigate('/grn');
    } catch (e) { toast(e.message, 'error'); }
  };
  const pay = async () => setPaying(await api.get(`/suppliers/${g.supplier_id}`));
  const expectedValue = g.items.reduce((s, i) => s + (i.expected_per_set / (i.pcs_per_set || 1)) * Math.max(0, (i.sets + i.extra_sets - i.short_sets) * i.pcs_per_set + (i.odd_pcs || 0) + i.extra_pcs - i.short_pcs), 0);

  const title = `${g.grn_no} — ${g.supplier_name}`;
  const subtitle = <>Received {niceDate(g.date)} · <StatusBadge status={g.pay_status} /> {g.balance_inr > 0 && dueText(g.due_date)}</>;
  const actions = <>
    <button className="btn btn-danger" onClick={del}><Icon name="trash" /> Delete</button>
    <button className="btn" onClick={() => navigate(`/grn/${g.id}/edit`)} title="Fix a GRN entered wrongly (Super Admin)"><Icon name="edit" /> Edit GRN</button>
    <button className="btn" onClick={() => window.open(`/print/grn/${g.id}`, '_blank')}><Icon name="print" /> Print GRN</button>
    <button className="btn" onClick={() => setStickers('manual')} title="One sticker for each set"><Icon name="tag" /> Print stickers</button>
    {g.balance_inr > 0 && <button className="btn btn-primary" onClick={pay}><Icon name="wallet" /> Pay supplier</button>}
  </>;

  const body = <>
      <div className="stats mb">
        <div className="stat"><div className="stat-text"><div className="stat-label">Supplier billed</div><div className="stat-value" style={{ fontSize: 17 }}>{g.supplier_bill_date ? niceDate(g.supplier_bill_date) : '—'}</div>{g.supplier_invoice_no && <div className="stat-sub">Invoice {g.supplier_invoice_no}</div>}</div></div>
        {!local && <div className="stat"><div className="stat-text"><div className="stat-label">Cargo</div><div className="stat-value" style={{ fontSize: 17 }}>{g.cargo_name || '—'}</div></div></div>}
        <div className="stat"><div className="stat-text"><div className="stat-label">{local ? 'Supplier' : 'Costing rate'}</div><div className="stat-value" style={{ fontSize: 17 }}>{local ? '🇱🇰 Local · bill in Rs' : '1 ₹ = Rs ' + g.exchange_rate.toFixed(4)}</div></div></div>
      </div>

      <div className="alert alert-blue mb">
        <Icon name="lock" />
        <span>{local ? <>A local purchase: the bill is in <b>Rs</b>, so there is no exchange rate.</> : <>Costed at the fixed rate <b>Rs {g.exchange_rate.toFixed(2)} per ₹1</b> (Settings → Exchange rate). The live rate does not change it.</>}
          {g.balance_inr > 0 ? <> Still to pay the supplier: <b>{cur(g.balance_inr)}</b>.</> : <> The supplier bill is paid.</>}</span>
      </div>

      <div className="grn-layout">
        <div className="stack">
          <Card title="Items received" pad={false}>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Product</th><th className="right">Received</th><th className="right">Bill {g.currency === 'LKR' ? 'Rs' : '₹'}/pc</th><th className="right">Cost / piece</th><th className="right">Expected / piece</th><th className="right">Margin</th></tr></thead>
                <tbody>
                  {g.items.map((i) => {
                    const pcs = Math.max(0, (i.sets + i.extra_sets - i.short_sets) * i.pcs_per_set + (i.odd_pcs || 0) + i.extra_pcs - i.short_pcs);
                    const per = (v) => v / (i.pcs_per_set || 1);
                    return (
                      <tr key={i.id}>
                        <td><b>{i.name}</b><div className="sub">{i.code} · {i.pcs_per_set} pcs/set{i.colors_count ? ` · ${i.colors_count} colours` : ''}{i.sizes ? ` · ${i.sizes}` : ''}</div></td>
                        <td className="right">{int(pcs)} pcs
                          <div className="sub">{int(i.sets)} sets billed</div>
                          {i.odd_pcs ? <div className="sub text-amber">{int(i.sets * i.pcs_per_set + i.odd_pcs)} pcs, not {int(i.sets * i.pcs_per_set)}</div> : null}
                          {i.extra_pcs > 0 && <div className="sub text-green">+ {int(i.extra_pcs)} extra pcs (billed)</div>}
                          {i.extra_sets > 0 && <div className="sub text-green">+ {int(i.extra_sets)} free sets</div>}
                          {(i.short_sets > 0 || i.short_pcs > 0) && <div className="sub text-red">− {int(i.short_sets * i.pcs_per_set + i.short_pcs)} pcs short</div>}
                        </td>
                        <td className="right">{money(i.cost_inr_per_set / (i.pcs_per_set || 1))}<div className="sub">{cur(i.line_inr)}</div></td>
                        <td className="right strong">{lkr(i.landed_per_pcs_lkr)}{(i.cargo_lkr > 0 || i.other_lkr > 0) && <div className="sub">incl. {[i.cargo_per_pcs > 0 && `cargo ${lkr(i.cargo_per_pcs)}`, i.other_per_pcs > 0 && `other ${lkr(i.other_per_pcs)}`].filter(Boolean).join(' + ') || 'cargo'}/pc</div>}</td>
                        <td className="right">{lkr(per(i.expected_per_set))}</td>
                        <td className={`right ${margin(i.expected_per_set, i.landed_per_set_lkr) < 0 ? 'text-red' : 'text-green'}`}>{pct(margin(i.expected_per_set, i.landed_per_set_lkr))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <div className="grid grid-2">
            <Card title="Cargo & other expenses (LKR)">
              {!(g.expenses_lkr > 0) ? <p className="muted">No cargo charge or other expenses.</p> : <>
                {g.items.filter((i) => i.cargo_lkr > 0 || i.other_lkr > 0).map((i) => (
                  <div key={`i${i.id}`} className="list-row">
                    <span>{i.name}<div className="sub">{[i.cargo_lkr > 0 && `cargo ${lkr(i.cargo_lkr)}${i.cargo_per_pcs ? ` (${lkr(i.cargo_per_pcs)}/pc)` : ''}`, i.other_lkr > 0 && `other ${lkr(i.other_lkr)}${i.other_per_pcs ? ` (${lkr(i.other_per_pcs)}/pc)` : ''}`].filter(Boolean).join(' · ')}</div></span>
                    <b className="mono">{lkr((i.cargo_lkr || 0) + (i.other_lkr || 0))}</b>
                  </div>
                ))}
                {g.expenses.map((e) => (
                  <div key={e.id} className="list-row"><span>{e.category ? <>Cargo charge – <b>{e.category}</b></> : e.label}</span><b className="mono">{lkr(e.amount_lkr)}</b></div>
                ))}
                <div className="list-row"><b>Total</b><b className="mono">{lkr(g.expenses_lkr)}</b></div>
              </>}
            </Card>
            <Card title="Supplier payments">
              {g.payments.length === 0 ? <p className="muted">No payment linked to this GRN yet.</p> : g.payments.map((p) => (
                <div key={p.id} className="list-row"><div><div className="t">{p.method}</div><div className="s">{niceDate(p.date)} {p.reference ? `· ${p.reference}` : ''}</div></div><div className="right"><b>{cur(p.amount_inr)}</b>{!local && <div className="s">{lkr(p.amount_lkr)}</div>}</div></div>
              ))}
              <p className="muted small mt-s">Payments made without choosing a GRN are applied to the oldest bills first.</p>
            </Card>
          </div>
          {g.notes && <Card title="Notes"><p>{g.notes}</p></Card>}
        </div>

        <div className="stack">
          <Card title="Cost breakdown">
            <dl className="kv">
              <dt>Goods</dt><dd>{cur(g.goods_inr)}</dd>
              {g.cargo_charge_inr > 0 && <><dt>Cargo charge (₹)</dt><dd>{cur(g.cargo_charge_inr)}</dd></>}
              {!local && <><dt>Goods in LKR (× {g.exchange_rate.toFixed(2)})</dt><dd>{lkr(g.goods_inr * g.exchange_rate)}</dd></>}
              {g.cargo_charge_inr > 0 && <><dt>Cargo in LKR (× {g.exchange_rate.toFixed(2)})</dt><dd>{lkr(g.cargo_charge_inr * g.exchange_rate)}</dd></>}
              <dt>Cargo charge</dt><dd>{lkr(g.expenses_lkr - (g.other_lkr || 0))}</dd>
              {g.other_lkr > 0 && <><dt>Other expenses</dt><dd>{lkr(g.other_lkr)}</dd></>}
              <dt className="total">Total cost</dt><dd className="total">{lkr(g.total_lkr)}</dd>
              <dt>Expected sales value</dt><dd>{lkr(expectedValue)}</dd>
              <dt>Expected profit</dt><dd className="text-green">{lkr(expectedValue - g.total_lkr)}</dd>
            </dl>
          </Card>
          <Card title="Supplier account">
            <dl className="kv">
              <dt>Payable for this GRN</dt><dd>{cur(g.payable_inr)}</dd>
              <dt>Paid</dt><dd className="text-green">{cur(g.paid_inr)}</dd>
              <dt className="total">Balance</dt><dd className={`total ${g.balance_inr > 0 ? 'text-red' : ''}`}>{cur(g.balance_inr)}</dd>
              <dt>Due date</dt><dd>{niceDate(g.due_date)}</dd>
            </dl>
            <Link to={`/suppliers/${g.supplier_id}`} className="btn btn-block mt">Open {g.supplier_name}</Link>
          </Card>
        </div>
      </div>

      {stickers && <StickerModal grn={g} asked={stickers === 'asked'} onClose={closeStickers} />}
      {paying && <SupplierPaymentModal supplier={paying} bills={paying.bills} defaultGrnId={g.id} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); changed(); }} />}
  </>;

  if (modal) {
    return (
      <Modal size="xl" title={title} subtitle={subtitle} onClose={onClose}
        footer={<><button className="btn" onClick={onClose}>Close</button><span className="spacer" />{actions}</>}>
        {body}
      </Modal>
    );
  }
  return (
    <div>
      <PageHeader back="/grn" title={title} subtitle={subtitle} actions={actions} />
      {body}
    </div>
  );
}

/** Pop-up used by the Shipments (GRN) list. onChanged refreshes the list after a payment or delete. */
export function GrnModal({ id, onClose, onChanged }) {
  return <GrnScreen id={id} modal onClose={onClose} onChanged={onChanged} />;
}

export default function GrnView() {
  const { id } = useParams();
  return <GrnScreen id={id} />;
}
