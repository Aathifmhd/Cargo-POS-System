import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, lkr, inr, niceDate, int } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Stat, Segmented, Modal } from '../components/ui.jsx';

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

/** Pop-up with everything about one line: the shipment, the product, the quantities and the money. */
function LineModal({ r, onClose }) {
  const f = r.f;
  const pcPrice = r.cost_inr_per_set / (r.pcs_per_set || 1);
  const kind = f.extraPcs && f.shortPcs ? 'Extra and short' : f.extraPcs ? 'Extra pieces' : 'Short pieces';
  return (
    <Modal size="lg" title={r.name} subtitle={<>{r.grn_no} · {niceDate(r.date)} · <span className={f.shortPcs ? 'text-red' : 'text-green'}>{kind}</span></>} onClose={onClose}
      footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></>}>
      <div className="es-detail">
        <div className="es-qty">
          <div><span>Billed</span><b>{int(f.billedPcs)} pcs</b><small>{int(r.sets)} sets × {r.pcs_per_set}{r.extra_pcs ? ` + ${int(r.extra_pcs)}` : ''}</small></div>
          <div className="plus"><span>Extra</span><b>{f.extraPcs ? `+${int(f.extraPcs)}` : '0'} pcs</b><small>{r.extra_sets ? 'incl. free sets' : 'billed by the supplier'}</small></div>
          <div className="minus"><span>Short</span><b>{f.shortPcs ? `−${int(f.shortPcs)}` : '0'} pcs</b><small>paid, not received</small></div>
          <div className="got"><span>Received</span><b>{int(f.receivedPcs)} pcs</b><small>added to stock</small></div>
        </div>
        <div className="grid grid-2">
          <div>
            <h4 className="es-h">Shipment</h4>
            <dl className="kv">
              <dt>GRN</dt><dd>{r.grn_no}</dd>
              <dt>Date</dt><dd>{niceDate(r.date)}</dd>
              <dt>Supplier</dt><dd>{r.supplier_name}</dd>
              <dt>Cargo</dt><dd>{r.cargo_name || '—'}</dd>
              <dt>Exchange rate</dt><dd>Rs {Number(r.exchange_rate).toFixed(4)}</dd>
            </dl>
          </div>
          <div>
            <h4 className="es-h">Product & money</h4>
            <dl className="kv">
              <dt>Code</dt><dd>{r.code}</dd>
              <dt>Sizes</dt><dd>{r.sizes || '—'}</dd>
              <dt>Billed per piece</dt><dd>{inr(pcPrice)}</dd>
              {f.extraInr > 0 && <><dt>Extra added to bill</dt><dd className="text-green">+{inr(f.extraInr)}</dd></>}
              {f.shortInr > 0 && <><dt>Short — paid, not received</dt><dd className="text-red">{inr(f.shortInr)} · {lkr(f.shortLkr)}</dd></>}
              <dt>Cost per piece</dt><dd className="strong">{lkr(r.landed_per_pcs_lkr)}</dd>
            </dl>
          </div>
        </div>
        {f.shortPcs > 0 && <div className="alert alert-amber small"><Icon name="info" size={16} /> The shorts were paid in full, so their cost is shared by the {int(f.receivedPcs)} pieces that arrived.</div>}
      </div>
    </Modal>
  );
}

export default function ExtraShort() {
  const [kind, setKind] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const qs = new URLSearchParams({ ...(kind !== 'all' && { kind }), ...(from && { from }), ...(to && { to }) }).toString();
  const { data, error, loading, reload } = useApi(`/grns/extra-short${qs ? `?${qs}` : ''}`);

  const [q, setQ] = useState('');
  const [supplierId, setSupplierId] = useState('');
  // the suppliers that have extra or short lines, for the filter
  const suppliers = useMemo(() => [...new Map((data || []).map((r) => [r.supplier_id, r.supplier_name])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1])), [data]);
  const [open, setOpen] = useState(null);   // the line shown in the pop-up
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data || []).map((r) => ({ ...r, f: lineFigures(r) })).filter((r) => {
      if (supplierId && String(r.supplier_id) !== supplierId) return false;
      if (!words.length) return true;
      const text = [r.grn_no, r.supplier_name, r.name, r.code, r.cargo_name, r.sizes].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [data, q, supplierId]);
  const filtered = Boolean(q || supplierId || from || to || kind !== 'all');
  const clearAll = () => { setQ(''); setSupplierId(''); setFrom(''); setTo(''); setKind('all'); };
  const totals = rows.reduce((t, r) => ({
    extraPcs: t.extraPcs + r.f.extraPcs, shortPcs: t.shortPcs + r.f.shortPcs,
    extraInr: t.extraInr + r.f.extraInr, shortInr: t.shortInr + r.f.shortInr, shortLkr: t.shortLkr + r.f.shortLkr,
  }), { extraPcs: 0, shortPcs: 0, extraInr: 0, shortInr: 0, shortLkr: 0 });
  const grnCount = new Set(rows.map((r) => r.grn_id)).size;

  return (
    <div>
      <PageHeader title="Extra & Short" subtitle="Bales that didn't match the supplier's bill: extra pieces received, or pieces missing." />
      <ErrorBox error={error} onRetry={reload} />

      {data && rows.length > 0 && (
        <div className="stats es-stats">
          <Stat icon="layers" label="GRNs affected" value={int(grnCount)} sub={`${rows.length} product lines`} />
          <Stat icon="plus" tone="green" label="Extra pieces" value={`${int(totals.extraPcs)} pcs`} sub={`${inr(totals.extraInr)} added to bills`} />
          <Stat icon="minus" tone="red" label="Short pieces" value={`${int(totals.shortPcs)} pcs`} sub={`${inr(totals.shortInr)} paid, not received`} />
          <Stat icon="wallet" tone="amber" label="Value of shorts" value={lkr(totals.shortLkr)} sub="At each GRN's exchange rate" />
        </div>
      )}

      <div className="toolbar wrap es-toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search GRN, product, supplier or cargo…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Segmented value={kind} onChange={setKind} options={[
          { value: 'all', label: 'All' },
          { value: 'extra', label: 'Extra', icon: 'plus' },
          { value: 'short', label: 'Short', icon: 'minus' },
        ]} />
        <select className="input es-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">All suppliers</option>
          {suppliers.map(([id, name]) => <option key={id} value={String(id)}>{name}</option>)}
        </select>
        <label className="row gap-s small muted">From <input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row gap-s small muted">To <input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && <button className="btn btn-ghost" onClick={clearAll}>Clear filters</button>}
      </div>

      <Card pad={false}>
        {loading && !data ? <Loading /> : !rows.length && filtered ? (
          <Empty icon="search" title="Nothing matches" text={q ? `No extra or short line for "${q}" with these filters.` : 'No extra or short line with these filters.'} action={<button className="btn" onClick={clearAll}>Clear filters</button>} />
        ) : !rows.length ? (
          <Empty icon="layers" title="Nothing extra or short" text="When a shipment has extra pieces, or pieces are missing, enter them on Receive Goods. They will be listed here."
            action={<Link to="/grn/new" className="btn btn-primary">Receive goods</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>GRN</th><th>Supplier</th><th>Cargo</th><th>Product</th>
                <th className="right">Billed</th><th className="right">Extra</th><th className="right">Short</th><th className="right">Received</th><th className="right">Value</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="click" onClick={() => setOpen(r)} title="View details">
                    <td className="strong nowrap">{r.grn_no}<div className="sub">{niceDate(r.date)}</div></td>
                    <td>{r.supplier_name}</td>
                    <td>{r.cargo_name || '—'}</td>
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
      {open && <LineModal r={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
