import { useMemo, useRef, useState } from 'react';
import { api, useApi, lkr, inr, money, int, n, niceDate, niceDateTime, today, stockText, downloadFile, isSuper } from '../lib.js';
import { useAuth } from '../App.jsx';
import { Card, Icon, Loading, ErrorBox, Empty, Stat, Field, NumInput, DateInput, Segmented, Badge, Modal, useToast } from './ui.jsx';

/*
 * Settings → Stock Take: count every product (once a year), type in what is really there, and close it —
 * then the system's stock is put right: short pieces off the stock (a loss), extra pieces in at the last GRN cost (a gain).
 * The counts are saved as they are typed, so a count can go on over days; nothing changes in the stock until it is closed.
 */
export default function StockTake() {
  const { data, error, loading, reload } = useApi('/stocktakes');
  const [opened, setOpened] = useState(null);   // a closed stock take shown in full
  const [fresh, setFresh] = useState(null);     // the stock take whose "Start Fresh" pop-up is open
  const toast = useToast();
  const superAdmin = isSuper(useAuth().user);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !data) return <Loading />;
  const open = (data || []).find((s) => s.status === 'open');
  const closed = (data || []).filter((s) => s.status === 'closed');
  // Start Fresh: the newest finished stock take only, once, and not while another is being counted
  const newestId = closed.length ? Math.max(...closed.map((s) => s.id)) : null;
  const report = (s) => downloadFile(`/stocktakes/${s.id}/report`, `${s.no}-profit-loss-and-stock.xlsx`).catch((e) => toast(e.message, 'error'));
  return (
    <div className="stack">
      {open ? <Counting id={open.id} onDone={reload} /> : <StartForm onStarted={reload} />}
      <Card title={<span className="row gap-s"><Icon name="clock" size={16} /> Past stock takes</span>} pad={false}>
        {!closed.length ? <p className="muted small" style={{ padding: 16 }}>No stock take closed yet.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>No.</th><th>Stock take</th><th>Finished</th><th className="right">Counted</th><th className="right">Differ</th><th className="right">Short</th><th className="right">More</th><th className="right">Net</th><th /></tr></thead>
            <tbody>{closed.map((s) => (
              <tr key={s.id} className="click hover" onClick={() => setOpened(s.id)} title="See the counts">
                <td className="strong nowrap">{s.no}</td>
                <td>{s.title}{s.note && <div className="sub">{s.note}</div>}</td>
                <td className="nowrap">{niceDateTime(s.closed_at)}<div className="sub">by {s.closed_by}</div></td>
                <td className="right">{int(s.items_counted || 0)}</td>
                <td className="right">{int(s.items_differ || 0)}</td>
                <td className="right text-red">{money(s.short_value)}</td>
                <td className="right text-green">{money(s.over_value)}</td>
                <td className={`right strong ${s.over_value - s.short_value < 0 ? 'text-red' : 'text-green'}`}>{money(s.over_value - s.short_value)}</td>
                <td className="right" onClick={(e) => e.stopPropagation()}>
                  <div className="st-row-actions">
                    {s.fresh_at
                      ? <span className="badge badge-green" title={`by ${s.fresh_by}`}>Fresh start · {niceDate(s.period?.to)}</span>
                      : superAdmin && s.id === newestId && !open && <button className="btn btn-sm btn-fresh" onClick={() => setFresh(s)}><Icon name="back" size={13} /> Start fresh</button>}
                    {superAdmin && <button className="btn btn-sm btn-ghost" onClick={() => report(s)} title="Profit & loss of this period, and the stock after the count"><Icon name="download" size={13} /> P&amp;L + stock</button>}
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {opened && <ClosedView id={opened} onClose={() => setOpened(null)} />}
      {fresh && <StartFresh st={fresh} onReport={() => report(fresh)} onClose={() => setFresh(null)} onDone={() => { setFresh(null); reload(); }} />}
    </div>
  );
}

function StartForm({ onStarted }) {
  const toast = useToast();
  const [v, setV] = useState({ title: `Stock take ${today().slice(0, 4)}`, date: today() });
  const [busy, setBusy] = useState(false);
  const start = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { await api.post('/stocktakes', v); toast('Stock take started — count and type in what is there'); onStarted(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Card title={<span className="row gap-s"><Icon name="box" size={16} /> Start a stock take</span>}>
      <p className="muted small mb">Count every product in the shop and the store, and type in what is really there. The counts are saved as you type — the count can go on over several days. Nothing in the stock changes until you finish the stock count (Super Admin password).</p>
      <form className="grid grid-3" onSubmit={start}>
        <Field label="Name"><input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field>
        <Field label="Date"><DateInput value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} /></Field>
        <Field label="&nbsp;"><button className="btn btn-primary" disabled={busy}><Icon name="plus" size={16} /> {busy ? 'Starting…' : 'Start stock take'}</button></Field>
      </form>
    </Card>
  );
}

/** The open stock take: type the counts (Enter goes to the next), see the differences, close it. */
function Counting({ id, onDone }) {
  const toast = useToast();
  const { data: st, error, reload } = useApi(`/stocktakes/${id}`);
  const [counts, setCounts] = useState(null);   // product id → typed value (as typed)
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);   // the "add a new product" form
  const [uploading, setUploading] = useState(false);   // reading an uploaded count sheet
  const inputs = useRef({});
  if (st && counts === null) setCounts(Object.fromEntries(Object.entries(st.counts || {}).map(([k, x]) => [k, String(x.pcs)])));

  const products = st?.products || [];
  const typed = counts || {};
  const isCounted = (p) => typed[p.id] !== undefined && typed[p.id] !== '';
  const diff = (p) => (isCounted(p) ? Math.round(Number(typed[p.id])) - p.stock_pcs : null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter((p) => (!s || `${p.code} ${p.name} ${p.category || ''}`.toLowerCase().includes(s))
      && (show === 'all' || (show === 'todo' ? !isCounted(p) : show === 'differ' ? isCounted(p) && diff(p) !== 0 : isCounted(p))));
  }, [products, q, show, counts]); // eslint-disable-line
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!st || counts === null) return <Card><Loading /></Card>;

  const counted = products.filter(isCounted);
  const short = counted.filter((p) => diff(p) < 0);
  const more = counted.filter((p) => diff(p) > 0);
  const left = products.length - counted.length;   // every product needs a count (0 when there is none) before closing
  const shortValue = short.reduce((t, p) => t + -diff(p) * p.cost_per_pcs, 0);
  const moreValue = more.reduce((t, p) => t + diff(p) * p.cost_per_pcs, 0);

  const save = async (p, value) => {
    const was = st.counts?.[p.id]?.pcs;
    if (String(value) === String(was ?? '')) return;
    try {
      await api.put(`/stocktakes/${id}/count`, { product_id: p.id, counted: value === '' ? null : value });
      st.counts = { ...(st.counts || {}), [p.id]: value === '' ? undefined : { pcs: Number(value) } };
    } catch (err) { toast(err.message, 'error'); }
  };
  const next = (p) => {
    const i = list.findIndex((x) => x.id === p.id);
    const n = list[i + 1];
    if (n) { inputs.current[n.id]?.focus(); inputs.current[n.id]?.select(); }
  };
  const close = async () => {
    setBusy(true);
    try {
      const done = await api.post(`/stocktakes/${id}/close`, { note });
      toast(`${done.no} closed — ${lkr(done.short_value)} short, ${lkr(done.over_value)} more`);
      setClosing(false); onDone();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(new Error('Could not read the file')); r.readAsDataURL(file); });
      const out = await api.post(`/stocktakes/${id}/upload`, { file: data });
      const notes = [out.unknown.length && `${out.unknown.length} unknown code${out.unknown.length === 1 ? '' : 's'} (${out.unknown.slice(0, 5).join(', ')})`, out.bad.length && `${out.bad.length} not a number (${out.bad.slice(0, 5).join(', ')})`].filter(Boolean);
      toast(`${out.set} count${out.set === 1 ? '' : 's'} uploaded${out.empty ? ` · ${out.empty} left empty` : ''}${notes.length ? ` · skipped: ${notes.join('; ')}` : ''}`, notes.length ? 'error' : undefined);
      const fresh = await api.get(`/stocktakes/${id}`);   // the counts as saved now
      st.counts = fresh.counts;
      setCounts(Object.fromEntries(Object.entries(fresh.counts || {}).map(([k, x]) => [k, String(x.pcs)])));
      reload();
    } catch (err) { toast(err.message, 'error'); } finally { setUploading(false); }
  };
  const sheet = () => downloadFile(`/stocktakes/${id}/sheet`, `${st.no}-count-sheet.xlsx`).catch((err) => toast(err.message, 'error'));
  const discard = async () => {
    if (!confirm(`Discard ${st.no}? The ${counted.length} counts typed so far are thrown away. The stock doesn't change.`)) return;
    try { await api.del(`/stocktakes/${id}`); toast('Stock take discarded'); onDone(); } catch (err) { toast(err.message, 'error'); }
  };

  return (
    <div className="stack">
      <Card title={<span className="row gap-s"><Icon name="box" size={16} /> {st.title} <Badge tone="amber">{st.no} · counting</Badge></span>}
        actions={<><button className="btn btn-sm btn-ghost text-red" onClick={discard}><Icon name="trash" size={14} /> Discard</button>
          <button className="btn btn-sm btn-primary" onClick={() => (left ? (toast(`${left} product${left === 1 ? '' : 's'} not counted yet — type 0 when there is none`, 'error'), setShow('todo')) : setClosing(true))}
            title={left ? `${left} still to count` : 'Finish and put the stock right'}><Icon name="check" size={14} /> Finish the stock count{left ? ` (${left} to count)` : ''}</button></>}>
        <p className="muted small">Started {niceDate(st.date)} by {st.started_by}. Type what is really there in pieces — <b>Enter</b> goes to the next item. Counts are saved as you go; the stock only changes when you finish the stock count. <b>Every product needs a count before finishing — type 0 when there is none.</b></p>
      </Card>
      <div className="stats">
        <Stat icon="box" tone="blue" label="Items counted" value={`${int(counted.length)} of ${int(products.length)}`} sub={`${int(products.length - counted.length)} still to count`} onClick={() => setShow('todo')} />
        <Stat icon="alert" tone={short.length ? 'red' : 'green'} label="Short (less than the system)" value={lkr(shortValue)} sub={`${short.length} item${short.length === 1 ? '' : 's'}`} onClick={() => setShow('differ')} />
        <Stat icon="plus" tone="green" label="More than the system" value={lkr(moreValue)} sub={`${more.length} item${more.length === 1 ? '' : 's'}`} onClick={() => setShow('differ')} />
        <Stat icon="chart" tone={moreValue - shortValue < 0 ? 'red' : 'green'} label="Net" value={lkr(moreValue - shortValue)} sub="when you finish the stock count" />
      </div>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Find a product — code, name or category" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Segmented value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'todo', label: 'Not counted' }, { value: 'counted', label: 'Counted' }, { value: 'differ', label: 'Differs' }]} />
      </div>
      <div className="st-actions">
        <button className="btn" onClick={sheet} title="Print it and write the counts with a pen"><Icon name="download" size={15} /> Download count sheet (Excel)</button>
        <label className="st-upload-link" title="The same count sheet, with the Actual Count filled in">
          <Icon name="upload" size={13} /> {uploading ? 'Reading the sheet…' : 'Upload counts (Excel)'}
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden disabled={uploading} onChange={upload} />
        </label>
        <span className="spacer" />
        <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={15} /> Add new product</button>
      </div>
      <Card pad={false}>
        {!list.length ? <Empty icon="box" title="Nothing here" text={show === 'todo' ? 'Every product is counted.' : 'Change the search or the filter.'} /> : (
          <div className="table-wrap" style={{ maxHeight: 620 }}><table className="table st-table">
            <thead><tr><th>Code</th><th>Product</th><th className="right">System says</th><th className="right">Counted (pcs)</th><th className="right">Difference</th><th className="right">At cost</th></tr></thead>
            <tbody>{list.map((p) => {
              const d = diff(p);
              return (
                <tr key={p.id} className={d == null ? '' : d === 0 ? 'st-ok' : d < 0 ? 'st-short' : 'st-more'}>
                  <td className="muted strong">{p.code}</td>
                  <td><b>{p.name}</b><div className="sub">{p.category || '—'} · {p.pcs_per_set} pcs/set{p.damaged_pcs > 0 ? ` · ${p.damaged_pcs} damaged (not counted here)` : ''}</div></td>
                  <td className="right nowrap">{int(p.stock_pcs)} pcs<div className="sub">{stockText(p.stock_pcs, p.pcs_per_set)}</div></td>
                  <td className="right">
                    <input ref={(el) => { inputs.current[p.id] = el; }} className="input st-input" inputMode="numeric" value={typed[p.id] ?? ''} placeholder="—"
                      onChange={(e) => setCounts({ ...typed, [p.id]: e.target.value.replace(/[^\d]/g, '') })}
                      onBlur={(e) => save(p, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(p, e.target.value); next(p); } }} />
                  </td>
                  <td className="right nowrap">{d == null ? <span className="muted">—</span> : d === 0 ? <span className="badge badge-green">agrees</span> : <b className={d < 0 ? 'text-red' : 'text-green'}>{d > 0 ? '+' : ''}{int(d)} pcs</b>}</td>
                  <td className="right">{d ? money(Math.abs(d) * p.cost_per_pcs) : <span className="muted">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
      {adding && <NewProduct products={products} onClose={() => setAdding(false)} onAdded={async (p, count) => {
        setAdding(false);
        await api.put(`/stocktakes/${id}/count`, { product_id: p.id, counted: count });
        setCounts({ ...typed, [p.id]: String(count) });
        reload();
        toast(`${p.name} (${p.code}) added — counted ${count} pcs`);
      }} />}
      {closing && (
        <Modal size="sm" title={`Finish ${st.no}?`} subtitle={st.title} onClose={() => setClosing(false)}
          footer={<><button className="btn" onClick={() => setClosing(false)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={close} disabled={busy}><Icon name="check" size={15} /> {busy ? 'Finishing…' : 'Yes, finish and put the stock right'}</button></>}>
          <div className="stack">
            <div className="chq-ask">
              <div><span>Counted</span><b>{int(counted.length)} items</b></div>
              <div><span>Differ</span><b>{int(short.length + more.length)} items</b></div>
              <div><span>Short</span><b className="text-red">{lkr(shortValue)}</b></div>
              <div><span>More</span><b className="text-green">{lkr(moreValue)}</b></div>
            </div>
            <div className="st-close-rules">
              <div className="st-rule short"><Icon name="minus" size={16} /><span><b>Short pieces</b> come off the stock at their cost, as a <b>loss</b>.{short.length ? ` (${short.length} item${short.length === 1 ? '' : 's'} · ${lkr(shortValue)})` : ''}</span></div>
              <div className="st-rule more"><Icon name="plus" size={16} /><span><b>Extra pieces</b> go into their own <b>"{st.no}"</b> batch at the last GRN cost, as a <b>gain</b>. <b>No GRN is touched.</b>{more.length ? ` (${more.length} item${more.length === 1 ? '' : 's'} · ${lkr(moreValue)})` : ''}</span></div>
            </div>
            <p className="muted small">Both show in Sales &amp; Profit → Profit &amp; loss.</p>
            <Field label="A note about this count"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. who counted, anything unusual" /></Field>
            <p className="muted small">Needs the Super Admin password.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** A product found on the count that isn't in the system: added (stock 0), with its count — closing brings the pieces in. */
function NewProduct({ products, onClose, onAdded }) {
  const toast = useToast();
  const cats = [...new Set(products.map((p) => p.category).filter(Boolean))].sort();
  const [v, setV] = useState({ name: '', category: '', pcs_per_set: 1, cost: '', expected: '', counted: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x && x.target ? x.target.value : x }));
  const save = async (e) => {
    e.preventDefault();
    if (!v.name.trim()) return toast('Type the product name', 'error');
    if (!(n(v.cost) > 0)) return toast('Enter the cost of one piece', 'error');
    if (v.counted === '' || n(v.counted) < 0) return toast('Enter how many pieces were counted', 'error');
    setBusy(true);
    try {
      const pps = Math.max(1, Math.round(n(v.pcs_per_set)));
      const p = await api.post('/products', { name: v.name.trim(), category: v.category.trim(), pcs_per_set: pps, cost_per_set: n(v.cost) * pps, expected_per_set: n(v.expected) * pps });
      await onAdded(p, Math.round(n(v.counted)));
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Add a new product" subtitle="Found on the count, but not in the system" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="st-new" disabled={busy}><Icon name="plus" size={15} /> {busy ? 'Adding…' : 'Add to the count'}</button></>}>
      <form id="st-new" className="grid grid-2" onSubmit={save}>
        <Field label="Product name" required className="span-2"><input className="input" autoFocus value={v.name} onChange={set('name')} /></Field>
        <Field label="Category"><input className="input" list="st-cats" value={v.category} onChange={set('category')} /><datalist id="st-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Pieces per set"><NumInput value={v.pcs_per_set} onChange={set('pcs_per_set')} /></Field>
        <Field label="Cost of one piece (Rs)" required hint="The pieces come in at this cost"><NumInput money value={v.cost} onChange={set('cost')} placeholder="0.00" /></Field>
        <Field label="Selling price of one piece (Rs)"><NumInput money value={v.expected} onChange={set('expected')} placeholder="0.00" /></Field>
        <Field label="Counted (pcs)" required hint="They come into the stock when you finish the stock count"><NumInput value={v.counted} onChange={set('counted')} /></Field>
      </form>
    </Modal>
  );
}

/**
 * Start Fresh (Super Admin, once per year-end stock take): the sales and the profit & loss start again from now.
 * Shows the period being closed, what starts from zero and what carries over — nothing is deleted.
 */
function StartFresh({ st, onReport, onClose, onDone }) {
  const toast = useToast();
  const { data: d, error } = useApi(`/stocktakes/${st.id}/fresh`);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.post(`/stocktakes/${st.id}/fresh`, {}); toast('Started fresh — the sales and the profit & loss count from now'); onDone(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const s = d?.summary; const c = d?.carry;
  return (
    <Modal size="lg" title="Start fresh?" subtitle={`After ${st.no} — ${st.title}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-fresh-solid" onClick={go} disabled={busy || !d}><Icon name="back" size={15} /> {busy ? 'Starting fresh…' : 'Yes, start fresh'}</button></>}>
      {error ? <ErrorBox error={error} /> : !d ? <Loading /> : (
        <div className="stack fresh-box">
          <div className="fresh-period">
            <div><span>The period being closed</span><b>{d.period.from ? niceDate(d.period.from) : 'From the start'} → {niceDate(d.period.to)}</b></div>
            <button type="button" className="btn btn-sm" onClick={onReport}><Icon name="download" size={14} /> Download its Profit &amp; loss + stock (Excel)</button>
          </div>
          <div className="chq-ask fresh-figures">
            <div><span>Sales</span><b>{lkr(s.sales)}</b><small>{int(s.bills)} bills</small></div>
            <div><span>Gross profit</span><b className="text-green">{lkr(s.gross_profit)}</b></div>
            <div><span>Losses</span><b className="text-red">{lkr(s.losses)}</b></div>
            <div><span>Net profit</span><b className={s.net_profit < 0 ? 'text-red' : 'text-green'}>{lkr(s.net_profit)}</b></div>
          </div>
          <div className="grid grid-2">
            <div className="fresh-list zero">
              <h4><Icon name="back" size={15} /> Starts again from zero</h4>
              <ul>
                <li>Sales &amp; Profit — the sales, profit on bills, losses, gross and net profit</li>
                <li>Dashboard — today's and this month's sales and profit</li>
                <li>Losses and gains (damaged, under cost, shorts, stock counts…)</li>
                <li>The Uncollectable list in the Payment Portal — those dues stay written off</li>
              </ul>
            </div>
            <div className="fresh-list carry">
              <h4><Icon name="check" size={15} /> Carries over — nothing is deleted</h4>
              <ul>
                <li>Stock: <b>{int(c.stock_pcs)} pcs</b> worth <b>{lkr(c.stock_value)}</b>{c.damaged_pcs ? ` · ${int(c.damaged_pcs)} damaged pcs` : ''}</li>
                <li>To collect from customers: <b>{lkr(c.to_collect)}</b></li>
                <li>To pay suppliers: <b>{[c.to_pay_inr ? inr(c.to_pay_inr) : '', c.to_pay_lkr ? lkr(c.to_pay_lkr) : ''].filter(Boolean).join(' + ') || lkr(0)}</b> · cargo <b>{lkr(c.to_pay_cargo)}</b></li>
                <li>Cheques waiting: <b>{int(c.cheques_count)}</b> (received {lkr(c.cheques_in)} · given {lkr(c.cheques_out)})</li>
                <li>Every bill, payment, GRN, customer and supplier — they stay, and can still be opened</li>
              </ul>
            </div>
          </div>
          <div className="alert alert-amber small"><Icon name="alert" size={16} /><span><b>This can be done only once for {st.no}.</b> The closed period stays in Sales &amp; Profit (choose it under "Period") and its Excel can be downloaded any time. Needs the Super Admin password.</span></div>
        </div>
      )}
    </Modal>
  );
}

/** A closed stock take: every item counted, what the system said, and the difference. */
function ClosedView({ id, onClose }) {
  const { data: st, error } = useApi(`/stocktakes/${id}`);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const lines = (st?.lines || []).filter((l) => !onlyDiff || l.diff !== 0);
  return (
    <Modal size="xl" title={st ? `${st.no} — ${st.title}` : 'Stock take'} subtitle={st ? `Closed ${niceDateTime(st.closed_at)} by ${st.closed_by}${st.note ? ` · ${st.note}` : ''}` : ''} onClose={onClose}
      footer={<><button className="btn" onClick={() => window.print()}><Icon name="print" size={15} /> Print</button><button className="btn btn-primary" onClick={onClose}>Close</button></>}>
      {error ? <ErrorBox error={error} /> : !st ? <Loading /> : (
        <div className="stack">
          <div className="stats">
            <Stat icon="box" label="Counted" value={`${int(st.items_counted)} items`} sub={`${int(st.items_differ)} differed`} />
            <Stat icon="alert" tone="red" label="Short" value={lkr(st.short_value)} />
            <Stat icon="plus" tone="green" label="More" value={lkr(st.over_value)} />
            <Stat icon="chart" tone={st.over_value - st.short_value < 0 ? 'red' : 'green'} label="Net" value={lkr(st.over_value - st.short_value)} />
          </div>
          <label className="check"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only the items that differed</label>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Code</th><th>Product</th><th className="right">System said</th><th className="right">Counted</th><th className="right">Difference</th><th className="right">Cost / pc</th><th className="right">Value</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.product_id}>
                <td className="muted strong">{l.code}</td><td><b>{l.name}</b><div className="sub">{l.category || '—'}</div></td>
                <td className="right">{int(l.was)}</td><td className="right">{int(l.counted)}</td>
                <td className="right">{l.diff === 0 ? <span className="badge badge-green">agreed</span> : <b className={l.diff < 0 ? 'text-red' : 'text-green'}>{l.diff > 0 ? '+' : ''}{int(l.diff)}</b>}</td>
                <td className="right">{money(l.cost_per_pcs)}</td>
                <td className={`right ${l.diff < 0 ? 'text-red' : l.diff > 0 ? 'text-green' : ''}`}>{l.diff ? money(l.value) : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </div>
      )}
    </Modal>
  );
}
