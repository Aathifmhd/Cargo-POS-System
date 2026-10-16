import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, lkr, supMoney, bothMoney, niceDate, int, today } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Stat, Segmented, Modal, Field, DateInput, useToast } from '../components/ui.jsx';

/*
 * How a line's extra or short pieces were resolved (empty = still to resolve).
 * short: received later → added to stock at the line's cost · lost at the cargo / clearance → a loss
 * extra: kept free → a profit (off the supplier bill) · paid with the bill · settled in the next shipment (off this bill)
 */
const SHORT = {
  received: { label: 'Received later', tone: 'green', text: 'The supplier sent them in a later shipment. They are added to stock at this line\'s cost per piece.' },
  lost: { label: 'Lost', tone: 'red', text: 'Lost at the cargo or customs clearance. Nothing is added to stock; the cost stays as a loss.' },
};
const EXTRA = {
  free: { label: 'Kept free', tone: 'green', text: 'The supplier says keep them. They come off the supplier bill and count as profit.' },
  billed: { label: 'Paid with bill', tone: 'blue', text: 'The supplier wants them paid. They stay on this GRN\'s bill.' },
  next: { label: 'Next shipment', tone: 'violet', text: 'The supplier will settle them in the next shipment. They come off this bill.' },
};

/** One GRN line's extra / short numbers, worked out from what was billed vs. what arrived. */
function lineFigures(r) {
  const pcPrice = r.cost_inr_per_set / (r.pcs_per_set || 1);          // ₹ per piece on the bill
  const pcCost = r.landed_per_pcs_lkr || 0;                          // Rs per piece, with the cargo charge
  const shortPcs = r.short_sets * r.pcs_per_set + r.short_pcs;
  const freePcs = r.extra_sets * r.pcs_per_set;                      // older GRNs: free extra sets
  const shortLkr = shortPcs * pcCost;
  const extraLkr = r.extra_pcs * pcCost;
  return {
    billedPcs: r.sets * r.pcs_per_set + r.extra_pcs,
    receivedPcs: Math.max(0, (r.sets + r.extra_sets - r.short_sets) * r.pcs_per_set + r.extra_pcs - r.short_pcs),
    extraPcs: r.extra_pcs + freePcs,
    shortPcs,
    extraInr: r.extra_pcs * pcPrice,
    shortInr: shortPcs * pcPrice,
    shortLkr,
    extraLkr,
    // what to resolve, and the profit or loss it makes now
    shortOpen: shortPcs > 0 && !r.short_status,
    extraOpen: r.extra_pcs > 0 && !r.extra_status,
    loss: shortPcs > 0 && r.short_status !== 'received' ? shortLkr : 0,          // paid for, not (yet) received
    profit: (r.extra_status === 'free' ? extraLkr : 0) + freePcs * pcCost,        // pieces we got for free
  };
}

function StatusBadges({ r }) {
  const f = r.f;
  return (
    <div className="es-status">
      {f.shortPcs > 0 && (r.short_status
        ? <span className={`badge badge-${SHORT[r.short_status].tone}`}>Short · {SHORT[r.short_status].label}</span>
        : <span className="badge badge-amber">Short · to resolve</span>)}
      {r.extra_pcs > 0 && (r.extra_status
        ? <span className={`badge badge-${EXTRA[r.extra_status].tone}`}>Extra · {EXTRA[r.extra_status].label}</span>
        : <span className="badge badge-amber">Extra · to resolve</span>)}
      {r.extra_sets > 0 && <span className="badge badge-green">Free sets</span>}
    </div>
  );
}

/** Pop-up with everything about one line: the shipment, the product, the quantities and the money. */
function LineModal({ r, onClose, onResolve, undoKind, onUndone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    const what = undoKind === 'short' ? `short pieces (${SHORT[r.short_status].label})` : `extra pieces (${EXTRA[r.extra_status].label})`;
    const stockNote = undoKind === 'short' && r.short_status === 'received' ? `\n\n${int(r.f.shortPcs)} pcs will be taken off stock.` : '';
    if (!confirm(`Undo the resolution of the ${what}? It goes back to the table as "to resolve".${stockNote}`)) return;
    setBusy(true);
    try {
      await api.post(`/grns/lines/${r.id}/resolve`, { kind: undoKind, action: 'reopen' });
      toast('Undone — back in the table to resolve');
      onUndone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const f = r.f;
  const pcPrice = r.cost_inr_per_set / (r.pcs_per_set || 1);
  const kind = f.extraPcs && f.shortPcs ? 'Extra and short' : f.extraPcs ? 'Extra pieces' : 'Short pieces';
  return (
    <Modal size="lg" title={r.name} subtitle={<>{r.grn_no} · {niceDate(r.date)} · <span className={f.shortPcs ? 'text-red' : 'text-green'}>{kind}</span></>} onClose={onClose}
      footer={undoKind !== undefined ? (
        <><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
          {undoKind && <button className="btn btn-danger" onClick={undo} disabled={busy}><Icon name="back" size={16} /> {busy ? 'Undoing…' : 'Undo'}</button>}</>
      ) : (
        <><span className="spacer" /><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={onResolve}><Icon name="check" size={16} /> Resolve</button></>
      )}>
      <div className="es-detail">
        <div className="es-qty">
          <div><span>Billed</span><b>{int(f.billedPcs)} pcs</b><small>{int(r.sets)} sets × {r.pcs_per_set}{r.extra_pcs ? ` + ${int(r.extra_pcs)}` : ''}</small></div>
          <div className="plus"><span>Extra</span><b>{f.extraPcs ? `+${int(f.extraPcs)}` : '0'} pcs</b><small>{r.extra_sets ? 'incl. free sets' : 'added to stock'}</small></div>
          <div className="minus"><span>Short</span><b>{f.shortPcs ? `−${int(f.shortPcs)}` : '0'} pcs</b><small>paid, not received</small></div>
          <div className="got"><span>Received</span><b>{int(f.receivedPcs)} pcs</b><small>added to stock</small></div>
        </div>
        <StatusBadges r={r} />
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
              <dt>Billed per piece</dt><dd>{supMoney(r)(pcPrice)}</dd>
              <dt>Cost per piece</dt><dd className="strong">{lkr(r.landed_per_pcs_lkr)}</dd>
              {f.extraInr > 0 && <><dt>Extra pieces' value</dt><dd className="text-green">{supMoney(r)(f.extraInr)} · {lkr(f.extraLkr)}</dd></>}
              {f.shortInr > 0 && <><dt>Short — paid, not received</dt><dd className="text-red">{supMoney(r)(f.shortInr)} · {lkr(f.shortLkr)}</dd></>}
              {f.profit > 0 && <><dt>Profit</dt><dd className="text-green strong">+{lkr(f.profit)}</dd></>}
              {f.loss > 0 && <><dt>Loss</dt><dd className="text-red strong">−{lkr(f.loss)}</dd></>}
            </dl>
          </div>
        </div>
        {[r.short_note && `Short: ${r.short_note}`, r.extra_note && `Extra: ${r.extra_note}`].filter(Boolean).map((t) => <p key={t} className="muted small">{t}</p>)}
      </div>
    </Modal>
  );
}

/** Resolve a line's short and / or extra pieces — or undo a resolution. */
function ResolveModal({ r, onClose, onDone }) {
  const toast = useToast();
  const f = r.f;
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    short: { action: r.short_status || '', date: r.short_date || today(), note: r.short_note || '' },
    extra: { action: r.extra_status || '', date: r.extra_date || today(), note: r.extra_note || '' },
  });
  const upd = (kind, patch) => setForm((x) => ({ ...x, [kind]: { ...x[kind], ...patch } }));

  const send = async (kind, action) => {
    const v = form[kind];
    if (!action) return toast('Choose how it was resolved', 'error');
    setBusy(true);
    try {
      await api.post(`/grns/lines/${r.id}/resolve`, { kind, action, date: v.date, note: v.note });
      toast(action === 'reopen' ? 'Moved back to "to resolve"' : `${kind === 'short' ? 'Short' : 'Extra'} pieces resolved`);
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };

  const section = (kind, title, pcs, options, saved) => {
    const v = form[kind];
    const opts = kind === 'short' ? SHORT : EXTRA;
    return (
      <div className="es-resolve">
        <div className="es-resolve-head">
          <b>{title}</b>
          <span className={kind === 'short' ? 'text-red strong' : 'text-green strong'}>{kind === 'short' ? '−' : '+'}{int(pcs)} pcs</span>
          {saved && <span className={`badge badge-${opts[saved].tone}`}>{opts[saved].label}{r[`${kind}_date`] ? ` · ${niceDate(r[`${kind}_date`])}` : ''}</span>}
        </div>
        {saved ? (
          <div className="row gap-s wrap">
            <span className="muted small spacer">{opts[saved].text}</span>
            <button className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => confirm(`Undo this? The ${kind} pieces go back to "to resolve"${saved === 'received' ? ` and ${int(pcs)} pcs are taken off stock` : ''}.`) && send(kind, 'reopen')}>
              <Icon name="back" size={14} /> Undo
            </button>
          </div>
        ) : (
          <>
            <div className="es-options">
              {options.map(([key, extra]) => (
                <label key={key} className={`es-option ${v.action === key ? 'on' : ''}`}>
                  <input type="radio" name={`${kind}-action`} checked={v.action === key} onChange={() => upd(kind, { action: key })} />
                  <span><b>{opts[key].label}</b><small>{opts[key].text}</small>{extra && <em className={`text-${opts[key].tone}`}>{extra}</em>}</span>
                </label>
              ))}
            </div>
            <div className="grid grid-3">
              <Field label="Date"><DateInput value={v.date} onChange={(e) => upd(kind, { date: e.target.value })} /></Field>
              <Field label="Note" hint="Optional" className="span-2"><input className="input" value={v.note} onChange={(e) => upd(kind, { note: e.target.value })} placeholder={kind === 'short' ? 'e.g. came with GRN-0007' : 'e.g. told by phone, 12 Oct'} /></Field>
            </div>
            <div className="row"><span className="spacer" /><button className="btn btn-primary" disabled={busy || !v.action} onClick={() => send(kind, v.action)}><Icon name="check" size={16} /> Save</button></div>
          </>
        )}
      </div>
    );
  };

  return (
    <Modal size="lg" title={`Resolve · ${r.name}`} subtitle={`${r.grn_no} · ${r.supplier_name}`} onClose={onClose}
      footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Close</button></>}>
      <div className="stack">
        {f.shortPcs > 0 && section('short', 'Short pieces', f.shortPcs, [
          ['received', `+${int(f.shortPcs)} pcs to stock at ${lkr(r.landed_per_pcs_lkr)} each`],
          ['lost', `Loss of ${lkr(f.shortLkr)}`],
        ], r.short_status)}
        {r.extra_pcs > 0 && section('extra', 'Extra pieces', r.extra_pcs, [
          ['free', `Profit of ${lkr(f.extraLkr)} · ${supMoney(r)(f.extraInr)} off the bill`],
          ['billed', `${supMoney(r)(f.extraInr)} stays on the bill`],
          ['next', `${supMoney(r)(f.extraInr)} off this bill`],
        ], r.extra_status)}
        {!(f.shortPcs > 0) && !(r.extra_pcs > 0) && <p className="muted">These are free sets from an older GRN — nothing to resolve.</p>}
      </div>
    </Modal>
  );
}

/** History, shown under the table: every extra / short that has been resolved, newest first (one entry per resolution). */
function HistorySection({ version, onHide, onOpen }) {
  const { data, error, loading, reload } = useApi(`/grns/extra-short?v=${version}`);   // reloads after each resolve
  const [q, setQ] = useState('');
  const entries = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (const raw of data || []) {
      const r = { ...raw, f: lineFigures(raw) };
      if (r.short_status && r.f.shortPcs > 0) {
        out.push({ key: `s${r.id}`, r, undo: 'short', kind: 'Short', pcs: -r.f.shortPcs, how: SHORT[r.short_status], date: r.short_date, note: r.short_note,
          money: r.short_status === 'lost' ? -r.f.shortLkr : 0 });
      }
      if (r.extra_sets > 0) {
        out.push({ key: `f${r.id}`, r, undo: null, kind: 'Extra', pcs: r.extra_sets * r.pcs_per_set, how: { label: 'Free sets', tone: 'green' }, date: r.date, note: 'Older GRN: free sets',
          money: r.extra_sets * r.pcs_per_set * (r.landed_per_pcs_lkr || 0) });
      }
      if (r.extra_status && r.extra_pcs > 0) {
        out.push({ key: `e${r.id}`, r, undo: 'extra', kind: 'Extra', pcs: r.extra_pcs, how: EXTRA[r.extra_status], date: r.extra_date, note: r.extra_note,
          money: r.extra_status === 'free' ? r.f.extraLkr : 0 });
      }
    }
    return out
      .filter((e) => !words.length || words.every((w) => [e.r.grn_no, e.r.supplier_name, e.r.name, e.r.code, e.how.label, e.note].join(' ').toLowerCase().includes(w)))
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.r.id - a.r.id);
  }, [data, q]);

  return (
    <Card className="es-history" title={<span className="row gap-s"><Icon name="clock" size={16} /> Resolved — history <span className="badge badge-grey">{entries.length}</span></span>}
      actions={<button className="btn btn-sm btn-ghost" onClick={onHide}><Icon name="x" size={14} /> Hide</button>}>
      <ErrorBox error={error} onRetry={reload} />
      <div className="toolbar"><div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search GRN, product, supplier or note…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      {loading && !data ? <Loading /> : !entries.length ? (
        <Empty icon="clock" title={q ? 'Nothing matches' : 'Nothing resolved yet'} text={q ? `No resolved line for "${q}".` : 'When you resolve an extra or short line, it is listed here.'} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Resolved</th><th>GRN</th><th>Product</th><th className="right">Pieces</th><th>How</th><th className="right">Profit / loss</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.key} className="click" onClick={() => onOpen(e.r, e.undo)} title="View details">
                  <td className="nowrap">{e.date ? niceDate(e.date) : '—'}</td>
                  <td className="nowrap strong">{e.r.grn_no}<div className="sub">{e.r.supplier_name}</div></td>
                  <td><b>{e.r.name}</b>{e.note && <div className="sub">{e.note}</div>}</td>
                  <td className={`right strong nowrap ${e.pcs < 0 ? 'text-red' : 'text-green'}`}>{e.pcs > 0 ? '+' : '−'}{int(Math.abs(e.pcs))} pcs</td>
                  <td><span className={`badge badge-${e.how.tone}`}>{e.kind} · {e.how.label}</span></td>
                  <td className="right nowrap">{e.money > 0 ? <span className="text-green strong">+{lkr(e.money)}</span> : e.money < 0 ? <span className="text-red strong">−{lkr(-e.money)}</span> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
  const [open, setOpen] = useState(null);         // id of the line shown in the pop-up
  const [resolving, setResolving] = useState(null); // id of the line being resolved
  const [history, setHistory] = useState(false);
  const [version, setVersion] = useState(0);    // bumped after a resolve, so the history reloads too
  const showHistory = () => {
    setHistory((h) => !h);
    setTimeout(() => document.querySelector('.es-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };
  const [undoKind, setUndoKind] = useState(undefined);   // set when a line is opened from the history: 'short' / 'extra' / null
  const [picked, setPicked] = useState(null);   // a line opened from History (it may be outside the filters)
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data || []).map((r) => ({ ...r, f: lineFigures(r) })).filter((r) => {
      if (supplierId && String(r.supplier_id) !== supplierId) return false;
      if (!words.length) return true;
      const text = [r.grn_no, r.supplier_name, r.name, r.code, r.cargo_name, r.sizes].join(' ').toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [data, q, supplierId]);
  // the table holds only what is still to resolve; once resolved, a line moves to the history below
  const openRows = rows.filter((r) => r.f.shortOpen || r.f.extraOpen);
  const filtered = Boolean(q || supplierId || from || to || kind !== 'all');
  const clearAll = () => { setQ(''); setSupplierId(''); setFrom(''); setTo(''); setKind('all'); };
  const totals = rows.reduce((t, r) => ({
    extraPcs: t.extraPcs + r.f.extraPcs, shortPcs: t.shortPcs + r.f.shortPcs,
    extraInr: t.extraInr + r.f.extraInr, shortInr: t.shortInr + r.f.shortInr,
    profit: t.profit + r.f.profit, loss: t.loss + r.f.loss,
    pendingLoss: t.pendingLoss + (r.f.shortOpen ? r.f.loss : 0),
    toResolve: t.toResolve + (r.f.shortOpen || r.f.extraOpen ? 1 : 0),
  }), { extraPcs: 0, shortPcs: 0, extraInr: 0, shortInr: 0, profit: 0, loss: 0, pendingLoss: 0, toResolve: 0 });
  const grnCount = new Set(rows.map((r) => r.grn_id)).size;
  const net = totals.profit - totals.loss;
  const openRow = rows.find((r) => r.id === open) || (data || []).map((r) => ({ ...r, f: lineFigures(r) })).find((r) => r.id === open) || (picked?.id === open ? picked : null);
  const resolveRow = (data || []).map((r) => ({ ...r, f: lineFigures(r) })).find((r) => r.id === resolving) || (picked?.id === resolving ? picked : null);

  return (
    <div>
      <PageHeader title="Extra & Short" subtitle="Bales that didn't match the supplier's bill: extra pieces received, or pieces missing. Resolve each one once the supplier has answered." />
      <ErrorBox error={error} onRetry={reload} />

      {data && rows.length > 0 && (
        <div className="stats es-stats">
          <Stat icon="layers" label="GRNs affected" value={int(grnCount)} sub={totals.toResolve ? `${totals.toResolve} of ${rows.length} lines to resolve` : `${rows.length} lines · all resolved`} />
          <Stat icon="plus" tone="green" label="Extra pieces" value={`${int(totals.extraPcs)} pcs`} sub={`${bothMoney(rows, (r) => r.f.extraInr)} on the bills`} />
          <Stat icon="minus" tone="red" label="Short pieces" value={`${int(totals.shortPcs)} pcs`} sub={`${bothMoney(rows, (r) => r.f.shortInr)} paid, not received`} />
          <Stat icon="wallet" tone={net < 0 ? 'red' : net > 0 ? 'green' : 'default'} label="Profit or loss" value={`${net < 0 ? '−' : net > 0 ? '+' : ''}${lkr(Math.abs(net))}`}
            sub={<>
              <span className="text-green">+{lkr(totals.profit)} free extras</span> · <span className="text-red">−{lkr(totals.loss)} shorts</span>
              {totals.pendingLoss > 0 && <> ({lkr(totals.pendingLoss)} still to resolve)</>}
            </>} />
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
        <label className="row gap-s small muted">From <DateInput value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row gap-s small muted">To <DateInput value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {filtered && <button className="btn btn-ghost" onClick={clearAll}>Clear filters</button>}
      </div>

      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length && !openRows.length ? (
          <Empty icon="check" title="Everything is resolved" text={filtered ? 'Nothing left to resolve with these filters.' : 'Every extra and short has been resolved.'}
            action={<button className="btn" onClick={() => { if (!history) showHistory(); }}><Icon name="clock" size={14} /> See history</button>} />
        ) : !rows.length && filtered ? (
          <Empty icon="search" title="Nothing matches" text={q ? `No extra or short line for "${q}" with these filters.` : 'No extra or short line with these filters.'} action={<button className="btn" onClick={clearAll}>Clear filters</button>} />
        ) : !rows.length ? (
          <Empty icon="layers" title="Nothing extra or short" text="When a shipment has extra pieces, or pieces are missing, enter them on Receive Goods. They will be listed here."
            action={<Link to="/grn/new" className="btn btn-primary">Receive goods</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>GRN</th><th>Supplier</th><th>Product</th>
                <th className="right">Billed</th><th className="right">Extra</th><th className="right">Short</th><th className="right">Received</th><th className="right">Profit / loss</th><th>Status</th><th />
              </tr></thead>
              <tbody>
                {openRows.map((r) => (
                  <tr key={r.id} className="click" onClick={() => { setUndoKind(undefined); setOpen(r.id); }} title="View details">
                    <td className="strong nowrap">{r.grn_no}<div className="sub">{niceDate(r.date)}</div></td>
                    <td>{r.supplier_name}<div className="sub">{r.cargo_name || ''}</div></td>
                    <td><b>{r.name}</b><div className="sub">{r.code}{r.sizes ? ` · ${r.sizes}` : ''}</div></td>
                    <td className="right">{int(r.f.billedPcs)} pcs</td>
                    <td className="right">{r.f.extraPcs ? <span className="text-green strong">+{int(r.f.extraPcs)} pcs</span> : '—'}</td>
                    <td className="right">{r.f.shortPcs ? <span className="text-red strong">−{int(r.f.shortPcs)} pcs</span> : '—'}</td>
                    <td className="right strong">{int(r.f.receivedPcs)} pcs</td>
                    <td className="right nowrap">
                      {r.f.profit > 0 && <div className="text-green strong">+{lkr(r.f.profit)}</div>}
                      {r.f.loss > 0 && <div className="text-red strong">−{lkr(r.f.loss)}</div>}
                      {!r.f.profit && !r.f.loss && <span className="muted">—</span>}
                    </td>
                    <td><StatusBadges r={r} /></td>
                    <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-sm btn-primary" onClick={() => setResolving(r.id)}>
                        <Icon name="check" size={14} /> Resolve
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="es-history-bar">
        <button className={`btn btn-sm ${history ? '' : 'btn-ghost'}`} onClick={showHistory}><Icon name="clock" size={14} /> {history ? 'Hide history' : 'History'}</button>
      </div>
      {history && <HistorySection version={version} onHide={() => setHistory(false)} onOpen={(r, undo) => { setPicked(r); setUndoKind(undo); setOpen(r.id); }} />}
      {openRow && <LineModal r={openRow} undoKind={undoKind} onClose={() => { setOpen(null); setUndoKind(undefined); }}
        onResolve={() => { setOpen(null); setResolving(openRow.id); }}
        onUndone={() => { setOpen(null); setUndoKind(undefined); reload(); setVersion((v) => v + 1); }} />}
      {resolveRow && <ResolveModal key={`${resolveRow.id}-${resolveRow.short_status}-${resolveRow.extra_status}`} r={resolveRow} onClose={() => setResolving(null)} onDone={() => { reload(); setVersion((v) => v + 1); }} />}
    </div>
  );
}
