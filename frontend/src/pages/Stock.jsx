import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi, n, r2, lkr, money, niceDate, int, stockText, margin, pct, parseCatalog, findCategory, costTiers, costGroups, costCode, seesCost, codeOf, can } from '../lib.js';
import { useSettings, useAuth } from '../App.jsx';
import SizePicker from '../components/SizePicker.jsx';
import { ManualStickerModal } from '../components/Stickers.jsx';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, CostBadge, Modal, Field, NumInput, Segmented, Tabs, Stat, useToast } from '../components/ui.jsx';

/**
 * Stock Count → Remove stock: why the pieces are taken off, and what happens.
 * Damaged → into the damaged stock · Sold without a bill → a cash bill at the price · the rest → a loss under that reason.
 */
const REMOVE_REASONS = [
  { code: 'damaged', label: 'Damaged', hint: 'They go to the damaged stock (a loss) — they can still be sold under cost.' },
  { code: 'missing', label: "Missing — can't find", hint: 'Counted as a loss.' },
  { code: 'sample', label: 'Free sample given', hint: 'Counted as a loss (free sample).' },
  { code: 'gift', label: 'Gift / promotion', hint: 'Counted as a loss (gift / promotion).' },
  { code: 'shopuse', label: 'Used by the shop', hint: 'Counted as a loss (shop use).' },
  { code: 'counting', label: 'Counting mistake', hint: 'The stock was counted too high — counted as a loss.' },
  { code: 'nobill', label: 'Sold without a bill', hint: 'A cash bill is made at the price they were sold for, so the money and the profit count.' },
  { code: 'other', label: 'Other', hint: 'Counted as a loss — type the reason.' },
];
/** Stock Count → Add stock: the pieces go into their own "Stock Count" batch (the GRN stays as received). */
const ADD_REASONS = [
  { code: 'found', label: 'Found stock', hint: 'Pieces that were missing turned up — a gain, at the last GRN cost.' },
  { code: 'counting', label: 'Counting mistake', hint: 'The stock was counted too low — a gain, at the last GRN cost.' },
  { code: 'repaired', label: 'Damaged piece repaired', hint: 'From the damaged stock back into the good stock — the damaged loss comes back.' },
  { code: 'supplierfree', label: 'Free goods from supplier', hint: 'Given free outside a GRN — a gain, at the last GRN cost.' },
  { code: 'other', label: 'Other', hint: 'A gain, at the last GRN cost — type the reason.' },
];

export default function Stock() {
  const { settings } = useSettings();   // the cost code
  const seeCost = seesCost(useAuth().user);
  const discreet = Boolean(useAuth().user.discreet);
  const manage = can(useAuth().user, 'receive_goods');   // add products, receive goods, Stock Count, edit (not cashiers)
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [filter, setFilter] = useState(params.get('low') ? 'low' : 'all');
  const { data, error, loading, reload } = useApi('/products?active=all');
  const [stickers, setStickers] = useState(false);
  // damaged returns kept apart from the stock (their cost is written off as a loss)
  const damagedPcs = (data || []).reduce((t, p) => t + (p.damaged?.pcs || 0), 0);
  const damagedValue = (data || []).reduce((t, p) => t + (p.damaged?.value || 0), 0);
  const [open, setOpen] = useState(null); // product id | 'new'

  const categories = useMemo(() => [...new Set((data || []).map((p) => p.category).filter(Boolean))].sort(), [data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!cat || p.category === cat) &&
      (filter === 'all' ? p.active : filter === 'low' ? p.active && p.stock_pcs < p.reorder_sets * p.pcs_per_set : filter === 'out' ? p.active && p.stock_pcs <= 0 : filter === 'damaged' ? p.damaged?.pcs > 0 : !p.active));
  }, [data, q, cat, filter]);

  const active = (data || []).filter((p) => p.active);
  // stock value batch by batch: each cost (and expected price) of the same product counted on its own pieces
  const valueOf = (p, key) => {
    const bs = (p.batches || []).filter((b) => b.left_pcs > 0);
    const expPc = p.expected_per_set / (p.pcs_per_set || 1);
    if (!bs.length) return Math.max(0, p.stock_pcs) * (key === 'cost' ? p.cost_per_pcs : expPc);
    return bs.reduce((s, b) => s + b.left_pcs * (key === 'cost' ? b.cost_per_pcs : b.expected_per_pcs || expPc), 0);
  };
  const costValue = active.reduce((s, p) => s + valueOf(p, 'cost'), 0);
  const sellValue = active.reduce((s, p) => s + valueOf(p, 'expected'), 0);

  return (
    <div>
      <PageHeader title="Stock" subtitle="Stock goes up when you receive goods and down when you sell. Click a product to see its history or do a stock count."
        actions={<>
          {manage && <button className="btn" onClick={() => setStickers(true)} title="Stickers for any product — e.g. a set with fewer pieces"><Icon name="tag" /> Print stickers</button>}
          {manage && <button className="btn" onClick={() => setOpen('new')}><Icon name="plus" /> Add product manually</button>}
          {manage && <Link to="/grn/new" className="btn btn-primary"><Icon name="truck" /> Receive goods</Link>}
        </>} />

      <div className="stats mb">
        <Stat icon="box" label="Products in stock" value={int(active.filter((p) => p.stock_pcs > 0).length)} sub={`${int(active.reduce((s, p) => s + Math.max(0, p.stock_pcs), 0))} pieces${active.some((p) => p.stock_pcs < 0) ? ` · ${active.filter((p) => p.stock_pcs < 0).length} sold without stock` : ''}`} />
        {seeCost && <Stat icon="cash" tone="blue" label="Stock value at cost" value={lkr(costValue)} />}
        {seeCost && <Stat icon="tag" tone="green" label="Value at expected price" value={lkr(sellValue)} sub={`Potential profit ${lkr(sellValue - costValue)}`} />}
        {damagedPcs > 0 && <Stat icon="alert" tone="red" label="Damaged stock" value={`${int(damagedPcs)} pcs`} sub={seeCost ? `Cost written off ${lkr(damagedValue)}` : 'Kept apart from the stock'} onClick={() => setFilter('damaged')} />}
        <Stat icon="alert" tone="amber" label="Low / out of stock" value={`${active.filter((p) => p.stock_pcs < p.reorder_sets * p.pcs_per_set).length} / ${active.filter((p) => p.stock_pcs <= 0).length}`} />
      </div>

      <Tabs value={filter} onChange={setFilter} tabs={[
        { value: 'all', label: 'All products', count: active.length },
        { value: 'low', label: 'Low stock', count: active.filter((p) => p.stock_pcs < p.reorder_sets * p.pcs_per_set).length },
        { value: 'out', label: 'Out of stock', count: active.filter((p) => p.stock_pcs <= 0).length },
        { value: 'damaged', label: 'Damaged', count: (data || []).filter((p) => p.damaged?.pcs > 0).length },
        { value: 'inactive', label: 'Inactive', count: (data || []).length - active.length },
      ]} />
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search name or code…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="input" style={{ width: 200 }} value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>{categories.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length === 0 ? <Empty title="No products here" text="Products are created automatically when you receive goods." /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Code</th><th>Product</th><th>Pack</th><th>In stock</th>{seeCost && <th className="right">Cost/pc</th>}<th>Cost code</th><th className="right">Expected/pc</th>{seeCost && <><th className="right">Margin</th><th className="right">Stock value</th></>}</tr></thead>
              <tbody>
                {rows.flatMap((p) => {
                  const low = p.stock_pcs < p.reorder_sets * p.pcs_per_set;
                  const batches = costGroups(p.batches);   // batches that cost the same are one line
                  // a product bought at different costs: one line per cost, each with its own badge
                  const lines = batches.length > 1 ? batches : [null];
                  const tiers = costTiers(batches);
                  return lines.map((b, k) => {
                    // a single-cost product shows its one batch's cost and expected price
                    const one = !b && batches.length === 1 ? batches[0] : null;
                    const src = b || one;
                    const pcs = b ? b.left_pcs : p.stock_pcs;
                    const cost = src ? src.cost_per_pcs : p.cost_per_pcs;
                    const exp = src?.expected_per_pcs || p.expected_per_set / p.pcs_per_set;
                    return (
                      <tr key={`${p.id}-${b?.id ?? 0}`} className={`click ${b ? 'multi-cost' : ''} ${b && k < lines.length - 1 ? 'multi-more' : ''}`} onClick={() => !discreet && setOpen(p.id)}>
                        <td className="muted strong m-sub">{p.code}</td>
                        <td className="m-title">
                          <b>{p.name}</b> {b && <CostBadge tier={tiers[b.id]} />}
                          <div className="sub">{b ? `${b.ref} · ${niceDate(b.date)}` : <>{p.category || 'No category'}{p.subtype ? ` · ${p.subtype}` : ''}{p.pname ? ` · ${p.pname}` : ''}{p.supplier_name ? ` · ${p.supplier_name}` : ''}</>}</div>
                        </td>
                        <td className="nowrap">{p.pcs_per_set} pcs/set<div className="sub">{p.colors_count ? `${p.colors_count} colours` : ''}{p.sizes ? ` · ${p.sizes}` : ''}</div></td>
                        <td className="m-badge">
                          <Badge tone={pcs <= 0 ? 'red' : !b && low ? 'amber' : 'green'}>{stockText(pcs, p.pcs_per_set)}</Badge>
                          {b && k === 0 && <div className="sub">{int(p.stock_pcs)} pcs in all</div>}
                          {!b && p.stock_pcs < 0 && <div className="sub text-amber">{int(-p.stock_pcs)} pcs sold without stock</div>}
                        </td>
                        {seeCost && <td className="right">{money(cost)}</td>}
                        <td><span className="cost-code">{codeOf(src || p, cost, settings)}</span></td>
                        <td className="right strong">{money(exp)}</td>
                        {seeCost && <td className={`right ${margin(exp, cost) < 0 ? 'text-red' : ''}`}>{pct(margin(exp, cost))}</td>}
                        {seeCost && <td className="right">{money(Math.max(0, pcs) * cost)}</td>}
                      </tr>
                    );
                  }).concat(p.damaged?.pcs > 0 ? [
                    <tr key={`${p.id}-dmg`} className="click damaged-row" onClick={() => !discreet && setOpen(p.id)} title="Damaged returns — kept apart from the stock">
                      <td className="muted strong">{p.code}</td>
                      <td><b>{p.name}</b> <span className="badge-damaged">Damaged</span>
                        <div className="sub">Damaged returns{p.damaged.refs?.length ? ` · ${p.damaged.refs.slice(0, 3).join(', ')}${p.damaged.refs.length > 3 ? '…' : ''}` : ''}</div></td>
                      <td className="nowrap">{p.pcs_per_set} pcs/set</td>
                      <td><Badge tone="red">{stockText(p.damaged.pcs, p.pcs_per_set)}</Badge></td>
                      {seeCost && <td className="right">{money(p.damaged.cost_per_pcs)}</td>}
                      <td><span className="cost-code">{codeOf(p.damaged, p.damaged.cost_per_pcs, settings)}</span></td>
                      <td className="right muted">sell under cost</td>
                      {seeCost && <td className="right muted">—</td>}
                      {seeCost && <td className="right"><span className="muted">written off</span><div className="sub">{money(p.damaged.value)} at cost</div></td>}
                    </tr>,
                  ] : []);
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <ProductModal id={open === 'new' ? null : open} categories={categories} onClose={() => setOpen(null)} onChanged={reload} />}
      {stickers && <ManualStickerModal onClose={() => setStickers(false)} />}
    </div>
  );
}

function ProductModal({ id, categories, onClose, onChanged }) {
  const toast = useToast();
  const manage = can(useAuth().user, 'receive_goods');   // Stock Count and Edit: not for cashiers (Overview and Stock history only)
  const [tabPicked, setTab] = useState(id ? 'details' : 'edit');
  const tab = !manage && (tabPicked === 'adjust' || tabPicked === 'edit') ? 'details' : tabPicked;
  const [p, setP] = useState(null);
  const [f, setF] = useState(null);
  const { settings } = useSettings();
  const catalog = useMemo(() => parseCatalog(settings), [settings]);
  const [adj, setAdj] = useState({ mode: 'out', sets: '', pcs: '', reason_code: 'damaged', note: '', price: '', batch_id: '' });
  const perPc = (v, pps) => (n(v) > 0 ? r2(n(v) / Math.max(1, n(pps) || 1)) : '');
  const load = () => (id
    ? api.get(`/products/${id}`).then((x) => { setP(x); setF({ ...x, expected_pc: perPc(x.expected_per_set, x.pcs_per_set), mrp_pc: perPc(x.mrp_per_set, x.pcs_per_set) }); })
    : api.get('/products/next-code').then(({ code }) => setF({ code, name: '', category: '', pcs_per_set: 1, colors_count: '', sizes: '', color_names: '', expected_pc: '', mrp_pc: '', reorder_sets: '', cost_pc: '', opening_sets: '', opening_pcs: '', active: 1 })));
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));

  const save = async () => {
    try {
      const pps = Math.max(1, n(f.pcs_per_set) || 1);
      const body = { ...f, expected_per_set: r2(n(f.expected_pc) * pps), mrp_per_set: r2(n(f.mrp_pc) * pps), cost_per_set: r2(n(f.cost_pc) * pps) };
      if (id) await api.put(`/products/${id}`, body); else await api.post('/products', body);
      toast('Product saved'); onChanged(); id ? (load(), setTab('details')) : onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  const adjust = async () => {
    try {
      const out = adj.mode === 'out';
      if (adj.reason_code === 'other' && !String(adj.note || '').trim()) { toast(`Type the reason for ${out ? 'removing' : 'adding'} the stock`, 'error'); return; }
      if (adj.mode === 'in' && adj.reason_code === 'repaired' && !(p.damaged?.pcs > 0)) { toast('This product has no damaged pieces', 'error'); return; }
      if (out && adj.reason_code === 'nobill' && !(n(adj.price) > 0)) { toast('Enter the price each piece was sold for', 'error'); return; }
      const res = await api.post(`/products/${id}/adjust`, { ...adj, direction: adj.mode });
      toast(res.sale ? `Cash bill ${res.sale.invoice_no} made for ${lkr(res.sale.total)}` : out && adj.reason_code === 'damaged' ? 'Moved to the damaged stock' : adj.mode === 'in' && adj.reason_code === 'repaired' ? 'Back from the damaged stock' : 'Stock updated');
      setAdj({ ...adj, sets: '', pcs: '', note: '', price: '' }); load(); onChanged(); setTab('history');
    } catch (e) { toast(e.message, 'error'); }
  };

  if (!f) return <Modal title="Loading…" onClose={onClose}><Loading /></Modal>;
  const cat = findCategory(catalog, f.category);
  const moveLabel = { grn: 'Received', 'grn-edit': 'GRN edited', 'grn-delete': 'GRN deleted', sale: 'Sold', return: 'Customer return', void: 'Bill cancelled', adjust: 'Adjustment', damaged: 'To damaged stock', repaired: 'Repaired (from damaged)', stocktake: 'Stock take', 'short-received': 'Short pieces received', 'short-undo': 'Short pieces taken back' };

  return (
    <Modal size="lg" title={id ? p.name : 'Add product manually'} subtitle={id ? `${p.code} · ${stockText(p.stock_pcs, p.pcs_per_set)} in stock` : 'Use this for opening stock. Normally products are added through Receive Goods.'} onClose={onClose}
      footer={tab === 'edit' ? <><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={save}>Save product</button></> :
        tab === 'adjust' ? <><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={adjust}>Update stock</button></> : null}>
      {id && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'details', label: 'Overview' }, { value: 'history', label: 'Stock history' }, ...(manage ? [{ value: 'adjust', label: 'Stock Count' }, { value: 'edit', label: 'Edit' }] : [])]} />}

      {tab === 'details' && p && (
        <div className="stack">
          <div className="grid grid-3">
            <Stat label="In stock" value={stockText(p.stock_pcs)} sub={`Comes in packs of ${p.pcs_per_set}`} />
            <Stat label={(p.batches || []).length > 1 ? 'Average cost / piece' : 'Cost / piece'} value={lkr(p.cost_per_pcs)} sub={(p.batches || []).length > 1 ? `${p.batches.length} costs: ${money(p.batches[0].cost_per_pcs)} – ${money(p.batches[p.batches.length - 1].cost_per_pcs)}` : `Last GRN: ${lkr(p.last_cost_per_pcs)} a piece`} />
            <Stat label="Sold so far" value={`${int(p.sold.pcs)} pcs`} sub={`${lkr(p.sold.amount)} · profit ${lkr(p.sold.profit)}`} />
          </div>
          {(p.batches || []).length > 0 && (
            <Card title="Stock by cost (batches)" pad={false}>
              <table className="table"><thead><tr><th>From</th><th>Date</th><th className="right">In stock</th><th className="right">Cost / pc</th><th className="right">Expected / pc</th></tr></thead>
                <tbody>{p.batches.map((b, k) => (
                  <tr key={b.id}>
                    <td className="strong">{b.ref || 'Stock'} <CostBadge tier={costTiers(p.batches)[b.id]} /></td>
                    <td>{niceDate(b.date)}</td>
                    <td className="right strong">{int(b.left_pcs)} pcs</td>
                    <td className="right">{money(b.cost_per_pcs)}</td>
                    <td className="right">{money(b.expected_per_pcs)}</td>
                  </tr>
                ))}</tbody></table>
            </Card>
          )}
          <Card title="Purchase history (GRNs)" pad={false}>
            {p.purchases.length === 0 ? <p className="muted card-body">No GRNs yet.</p> : (
              <table className="table"><thead><tr><th>GRN</th><th>Date</th><th>Cargo</th><th className="right">Sets</th><th className="right">Bill ₹/pc</th><th className="right">Rate</th><th className="right">Cost Rs/pc</th></tr></thead>
                <tbody>{p.purchases.map((x) => (
                  <tr key={x.id}><td><Link to={`/grn/${x.grn_id}`}>{x.grn_no}</Link></td><td>{niceDate(x.date)}</td><td>{x.cargo_name || '—'}</td>
                    <td className="right">{x.sets}</td><td className="right">{money(x.cost_inr_per_set / (x.pcs_per_set || 1))}</td><td className="right">{x.exchange_rate}</td><td className="right strong">{money(x.landed_per_pcs_lkr)}</td></tr>
                ))}</tbody></table>
            )}
          </Card>
        </div>
      )}

      {tab === 'history' && p && (
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="table">
            <thead><tr><th>Date</th><th>What happened</th><th>Ref</th><th className="right">Change</th><th className="right">Balance</th></tr></thead>
            <tbody>{p.moves.map((m) => (
              <tr key={m.id}><td>{niceDate(m.date)}</td><td>{moveLabel[m.type] || m.type}<div className="sub">{m.note}</div></td><td>{m.ref || '—'}</td>
                <td className={`right strong ${m.pcs < 0 ? 'text-red' : 'text-green'}`}>{m.pcs > 0 ? '+' : ''}{m.pcs} pcs</td><td className="right">{stockText(m.balance, p.pcs_per_set)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {tab === 'adjust' && p && (
        <div className="stack">
          <Segmented value={adj.mode} onChange={(mode) => setAdj({ ...adj, mode, note: '', price: '', reason_code: mode === 'in' ? 'found' : 'damaged' })} options={[
            { value: 'out', label: 'Remove stock' }, { value: 'in', label: 'Add stock' }]} />
          <p className="muted small">{adj.mode === 'out' ? 'For damaged, missing or free-sample goods.' : 'The pieces go into their own "Stock Count" batch at the last GRN cost — the GRN stays as it was received. Customer returns go on New Sale.'}</p>
          <div className="grid grid-2">
            <Field label="Pieces"><NumInput value={adj.pcs} onChange={(v) => setAdj({ ...adj, pcs: v })} /></Field>
            {(p.batches || []).length > 1 && adj.mode === 'out' && (
              <Field label="Which stock" className="span-2" hint={adj.mode === 'out' ? 'Leave as "oldest first" if you are not sure' : 'Leave as "newest" if you are not sure'}>
                <select className="input" value={adj.batch_id} onChange={(e) => setAdj({ ...adj, batch_id: e.target.value })}>
                  <option value="">{adj.mode === 'out' ? 'Oldest first' : 'Newest'}</option>
                  {p.batches.map((b) => <option key={b.id} value={b.id}>{b.ref} · {niceDate(b.date)} · {int(b.left_pcs)} pcs at {money(b.cost_per_pcs)}</option>)}
                </select>
              </Field>
            )}
            {adj.mode === 'out' ? <>
              <Field label="Reason" required hint={REMOVE_REASONS.find((r) => r.code === adj.reason_code)?.hint}>
                <select className="input" value={adj.reason_code} onChange={(e) => setAdj({ ...adj, reason_code: e.target.value })}>
                  {REMOVE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.code === 'other' ? 'Other (type the reason)' : r.label}</option>)}
                </select>
              </Field>
              {adj.reason_code === 'nobill' && (
                <Field label="Sold for, each piece (Rs)" required hint={`Expected price ${money(p.expected_per_set / (p.pcs_per_set || 1))} a piece`}>
                  <NumInput money value={adj.price} onChange={(v) => setAdj({ ...adj, price: v })} placeholder="0.00" />
                </Field>
              )}
              <Field label={adj.reason_code === 'other' ? 'The reason' : 'Details'} required={adj.reason_code === 'other'} className="span-2">
                <input className="input" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder={adj.reason_code === 'other' ? 'Why is this stock removed?' : 'e.g. who, where, or which customer'} />
              </Field>
            </> : adj.mode === 'in' ? <>
              <Field label="Reason" required hint={ADD_REASONS.find((r) => r.code === adj.reason_code)?.hint}>
                <select className="input" value={adj.reason_code} onChange={(e) => setAdj({ ...adj, reason_code: e.target.value })}>
                  {ADD_REASONS.map((r) => (
                    <option key={r.code} value={r.code} disabled={r.code === 'repaired' && !(p.damaged?.pcs > 0)}>
                      {r.code === 'other' ? 'Other (type the reason)' : r.code === 'repaired' ? (p.damaged?.pcs > 0 ? `${r.label} (${p.damaged.pcs} damaged)` : `${r.label} — no damaged pieces`) : r.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={adj.reason_code === 'other' ? 'The reason' : 'Details'} required={adj.reason_code === 'other'} className="span-2">
                <input className="input" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} placeholder={adj.reason_code === 'other' ? 'Why is this stock added?' : 'e.g. where it was found'} />
              </Field>
            </> : null}
          </div>
          <div className="alert alert-blue small"><Icon name="info" size={16} /> Change: {(adj.mode === 'out' ? -1 : 1) * (n(adj.sets) * p.pcs_per_set + n(adj.pcs))} pieces</div>
        </div>
      )}

      {tab === 'edit' && (
        <div className="grid grid-3">
          <Field label="Code"><input className="input" value={f.code} onChange={set('code')} /></Field>
          <Field label="Product name" required className="span-2"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Category">
            <select className="input" value={f.category || ''} onChange={(e) => setF((x) => ({ ...x, category: e.target.value, subtype: '', pname: '' }))}>
              <option value="">No category</option>
              {catalog.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              {[...new Set([f.category, ...categories])].filter((c) => c && !findCategory(catalog, c)).map((c) => <option key={c} value={c}>{c} (old)</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select className="input" value={f.subtype || ''} onChange={(e) => setF((x) => ({ ...x, subtype: e.target.value, pname: '' }))} disabled={!cat && !f.subtype}>
              <option value="">{cat ? 'Choose product…' : '—'}</option>
              {(cat?.types || []).map((t) => <option key={t} value={t}>{t}</option>)}
              {f.subtype && !(cat?.types || []).includes(f.subtype) && <option value={f.subtype}>{f.subtype}</option>}
            </select>
          </Field>
          <Field label="Product name">
            <input className="input" value={f.pname || ''} onChange={set('pname')} disabled={!f.subtype} placeholder={f.subtype ? 'e.g. Royal Check' : '—'} autoComplete="off" />
          </Field>
          <Field label="Pieces per set"><NumInput value={f.pcs_per_set} onChange={set('pcs_per_set')} /></Field>
          <Field label="No. of colours"><NumInput value={f.colors_count} onChange={set('colors_count')} /></Field>
          <Field label="Colour names" className="span-2"><input className="input" value={f.color_names || ''} onChange={set('color_names')} /></Field>
          <div className="field item-sizes">
            <span className="field-label">Sizes</span>
            <SizePicker value={f.sizes || ''} options={cat?.sizes} hint={`${f.name} ${f.category || ''}`} onChange={(sizes) => setF((x) => ({ ...x, sizes }))} />
          </div>
          <Field label="Expected price / piece (Rs)"><NumInput money value={f.expected_pc} onChange={set('expected_pc')} /></Field>
          <Field label="Re-order at (sets)"><NumInput value={f.reorder_sets} onChange={set('reorder_sets')} /></Field>
          {!id && <>
            <Field label="Cost / piece (Rs)" hint="Cost of old stock"><NumInput money value={f.cost_pc} onChange={set('cost_pc')} /></Field>
            <Field label="Opening stock (pieces)"><NumInput value={f.opening_pcs} onChange={set('opening_pcs')} /></Field>
          </>}
          {id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active (show in sales)</label>}
        </div>
      )}
    </Modal>
  );
}
