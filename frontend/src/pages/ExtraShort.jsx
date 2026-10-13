import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, lkr, inr, niceDate, int } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Stat, Segmented } from '../components/ui.jsx';

/** One GRN line's extra / short numbers, worked out from what was billed vs. what arrived. */
function lineFigures(r) {
  const pcPrice = r.cost_inr_per_set / (r.pcs_per_set || 1);          // ₹ per piece on the bill
  const shortPcs = r.short_sets * r.pcs_per_set + r.short_pcs;
  const freePcs = r.extra_sets * r.pcs_per_set;                      // older GRNs: free extra sets
  return {
    billedPcs: r.sets * r.pcs_per_set + r.extra_pcs,
    receivedPcs: Math.max(0, (r.sets + r.extra_sets - r.short_sets) * r.pcs_per_set + r.extra_pcs - r.short_pcs),
    extraPcs: r.extra_pcs + freePcs,
    shortPcs,
    extraInr: r.extra_pcs * pcPrice,                                 // added to the supplier bill
    shortInr: shortPcs * pcPrice,                                    // paid for but not received
    shortLkr: shortPcs * pcPrice * r.exchange_rate,
  };
}

export default function ExtraShort() {
  const [kind, setKind] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ ...(kind !== 'all' && { kind }), ...(from && { from }), ...(to && { to }) }).toString();
  const { data, error, loading, reload } = useApi(`/grns/extra-short${qs ? `?${qs}` : ''}`);

  const rows = (data || []).map((r) => ({ ...r, f: lineFigures(r) }));
  const totals = rows.reduce((t, r) => ({
    extraPcs: t.extraPcs + r.f.extraPcs, shortPcs: t.shortPcs + r.f.shortPcs,
    extraInr: t.extraInr + r.f.extraInr, shortInr: t.shortInr + r.f.shortInr, shortLkr: t.shortLkr + r.f.shortLkr,
  }), { extraPcs: 0, shortPcs: 0, extraInr: 0, shortInr: 0, shortLkr: 0 });
  const grnCount = new Set(rows.map((r) => r.grn_id)).size;

  return (
    <div>
      <PageHeader title="Extra & Short" subtitle="Bales that didn't match the supplier's bill: extra pieces received, or pieces missing." />
      <div className="toolbar wrap">
        <Segmented value={kind} onChange={setKind} options={[
          { value: 'all', label: 'All' },
          { value: 'extra', label: 'Extra', icon: 'plus' },
          { value: 'short', label: 'Short', icon: 'minus' },
        ]} />
        <span className="spacer" />
        <label className="row gap-s small muted">From <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row gap-s small muted">To <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {(from || to) && <button className="btn btn-ghost" onClick={() => { setFrom(''); setTo(''); }}>Clear dates</button>}
      </div>
      <ErrorBox error={error} onRetry={reload} />

      {data && rows.length > 0 && (
        <div className="stats">
          <Stat icon="layers" label="GRNs affected" value={int(grnCount)} sub={`${rows.length} product lines`} />
          <Stat icon="plus" tone="green" label="Extra pieces" value={`${int(totals.extraPcs)} pcs`} sub={`${inr(totals.extraInr)} added to bills`} />
          <Stat icon="minus" tone="red" label="Short pieces" value={`${int(totals.shortPcs)} pcs`} sub={`${inr(totals.shortInr)} paid, not received`} />
          <Stat icon="wallet" tone="amber" label="Value of shorts" value={lkr(totals.shortLkr)} sub="At each GRN's exchange rate" />
        </div>
      )}

      <Card pad={false}>
        {loading && !data ? <Loading /> : !rows.length ? (
          <Empty icon="layers" title="Nothing extra or short" text="When a bale has extra pieces, or sets or pieces are missing, enter them on Receive Goods. They will be listed here."
            action={<Link to="/grn/new" className="btn btn-primary">Receive goods</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>GRN</th><th>Supplier</th><th>Cargo · Bale · LR</th><th>Product</th>
                <th className="right">Billed</th><th className="right">Extra</th><th className="right">Short</th><th className="right">Received</th><th className="right">Value</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="strong nowrap">{r.grn_no}<div className="sub">{niceDate(r.date)}</div></td>
                    <td>{r.supplier_name}</td>
                    <td>{r.cargo_name || '—'}<div className="sub">Bale {r.bale_no || '—'} · LR {r.lr_no || '—'}</div></td>
                    <td><b>{r.name}</b><div className="sub">{r.code}{r.sizes ? ` · ${r.sizes}` : ''}</div></td>
                    <td className="right">{int(r.f.billedPcs)} pcs</td>
                    <td className="right">{r.f.extraPcs ? <span className="text-green strong">+{int(r.f.extraPcs)} pcs</span> : '—'}</td>
                    <td className="right">{r.f.shortPcs ? <span className="text-red strong">−{int(r.f.shortPcs)} pcs</span> : '—'}</td>
                    <td className="right strong">{int(r.f.receivedPcs)} pcs</td>
                    <td className="right">
                      {r.f.extraInr > 0 && <div className="text-green">+{inr(r.f.extraInr)}</div>}
                      {r.f.shortInr > 0 && <div className="text-red">−{inr(r.f.shortInr)}<div className="sub">{lkr(r.f.shortLkr)}</div></div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
