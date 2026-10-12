import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi, n, lkr, money, niceDate, int, stockText, margin, pct } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, Modal, Field, NumInput, Segmented, Tabs, Stat, useToast } from '../components/ui.jsx';

export default function Stock() {
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [filter, setFilter] = useState(params.get('low') ? 'low' : 'all');
  const { data, error, loading, reload } = useApi('/products?active=all');
  const [open, setOpen] = useState(null); // product id | 'new'

  const categories = useMemo(() => [...new Set((data || []).map((p) => p.category).filter(Boolean))].sort(), [data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((p) =>
      (!s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s)) &&
      (!cat || p.category === cat) &&
      (filter === 'all' ? p.active : filter === 'low' ? p.active && p.stock_pcs < p.reorder_sets * p.pcs_per_set : filter === 'out' ? p.active && p.stock_pcs <= 0 : !p.active));
  }, [data, q, cat, filter]);

  const active = (data || []).filter((p) => p.active);
  const costValue = active.reduce((s, p) => s + p.stock_pcs * p.cost_per_pcs, 0);
  const sellValue = active.reduce((s, p) => s + (p.stock_pcs * p.expected_per_set) / p.pcs_per_set, 0);

  return (
    <div>
      <PageHeader title="Stock" subtitle="Stock goes up when you receive goods and down when you sell. Click a product to see its history or correct stock."
        actions={<>
          <button className="btn" onClick={() => setOpen('new')}><Icon name="plus" /> Add product manually</button>
          <Link to="/grn/new" className="btn btn-primary"><Icon name="truck" /> Receive goods</Link>
        </>} />

      <div className="stats mb">
        <Stat icon="box" label="Products in stock" value={int(active.filter((p) => p.stock_pcs > 0).length)} sub={`${int(active.reduce((s, p) => s + p.stock_pcs, 0))} pieces`} />
        <Stat icon="cash" tone="blue" label="Stock value at cost" value={lkr(costValue)} />
        <Stat icon="tag" tone="green" label="Value at expected price" value={lkr(sellValue)} sub={`Potential profit ${lkr(sellValue - costValue)}`} />
        <Stat icon="alert" tone="amber" label="Low / out of stock" value={`${active.filter((p) => p.stock_pcs < p.reorder_sets * p.pcs_per_set).length} / ${active.filter((p) => p.stock_pcs <= 0).length}`} />
      </div>

      <Tabs value={filter} onChange={setFilter} tabs={[
        { value: 'all', label: 'All products', count: active.length },
        { value: 'low', label: 'Low stock', count: active.filter((p) => p.stock_pcs < p.reorder_sets * p.pcs_per_set).length },
        { value: 'out', label: 'Out of stock', count: active.filter((p) => p.stock_pcs <= 0).length },
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
              <thead><tr><th>Code</th><th>Product</th><th>Pack</th><th>In stock</th><th className="right">Cost/set</th><th className="right">Expected/set</th><th className="right">MRP/set</th><th className="right">Margin</th><th className="right">Stock value</th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const low = p.stock_pcs < p.reorder_sets * p.pcs_per_set;
                  return (
                    <tr key={p.id} className="click" onClick={() => setOpen(p.id)}>
                      <td className="muted strong">{p.code}</td>
                      <td><b>{p.name}</b><div className="sub">{p.category || 'No category'}{p.supplier_name ? ` · ${p.supplier_name}` : ''}</div></td>
                      <td className="nowrap">{p.pcs_per_set} pcs/set<div className="sub">{p.colors_count ? `${p.colors_count} colours` : ''}{p.sizes ? ` · ${p.sizes}` : ''}</div></td>
                      <td><Badge tone={p.stock_pcs <= 0 ? 'red' : low ? 'amber' : 'green'}>{stockText(p.stock_pcs, p.pcs_per_set)}</Badge></td>
                      <td className="right">{money(p.cost_per_set)}</td>
                      <td className="right strong">{money(p.expected_per_set)}</td>
                      <td className="right">{money(p.mrp_per_set)}</td>
                      <td className={`right ${margin(p.expected_per_set, p.cost_per_set) < 0 ? 'text-red' : ''}`}>{pct(margin(p.expected_per_set, p.cost_per_set))}</td>
                      <td className="right">{money(p.stock_pcs * p.cost_per_pcs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && <ProductModal id={open === 'new' ? null : open} categories={categories} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function ProductModal({ id, categories, onClose, onChanged }) {
  const toast = useToast();
  const [tab, setTab] = useState(id ? 'details' : 'edit');
  const [p, setP] = useState(null);
  const [f, setF] = useState(null);
  const [adj, setAdj] = useState({ mode: 'out', sets: '', pcs: '', reason: 'Damaged' });
  const load = () => (id ? api.get(`/products/${id}`).then((x) => { setP(x); setF(x); }) : api.get('/products/next-code').then(({ code }) => setF({ code, name: '', category: '', pcs_per_set: 1, colors_count: '', sizes: '', color_names: '', mrp_per_set: '', expected_per_set: '', reorder_sets: '', cost_per_set: '', opening_sets: '', opening_pcs: '', active: 1 })));
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));

  const save = async () => {
    try {
      if (id) await api.put(`/products/${id}`, f); else await api.post('/products', f);
      toast('Product saved'); onChanged(); id ? (load(), setTab('details')) : onClose();
    } catch (e) { toast(e.message, 'error'); }
  };
  const adjust = async () => {
    try {
      await api.post(`/products/${id}/adjust`, { ...adj, direction: adj.mode });
      toast('Stock updated'); setAdj({ ...adj, sets: '', pcs: '' }); load(); onChanged(); setTab('history');
    } catch (e) { toast(e.message, 'error'); }
  };

  if (!f) return <Modal title="Loading…" onClose={onClose}><Loading /></Modal>;
  const moveLabel = { grn: 'Received', 'grn-delete': 'GRN deleted', sale: 'Sold', void: 'Bill cancelled', adjust: 'Adjustment' };

  return (
    <Modal size="lg" title={id ? p.name : 'Add product manually'} subtitle={id ? `${p.code} · ${stockText(p.stock_pcs, p.pcs_per_set)} in stock` : 'Use this for opening stock. Normally products are added through Receive Goods.'} onClose={onClose}
      footer={tab === 'edit' ? <><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={save}>Save product</button></> :
        tab === 'adjust' ? <><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={adjust}>Update stock</button></> : null}>
      {id && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'details', label: 'Overview' }, { value: 'history', label: 'Stock history' }, { value: 'adjust', label: 'Correct stock' }, { value: 'edit', label: 'Edit' }]} />}

      {tab === 'details' && p && (
        <div className="stack">
          <div className="grid grid-3">
            <Stat label="In stock" value={stockText(p.stock_pcs, p.pcs_per_set)} sub={`${int(p.stock_pcs)} pieces`} />
            <Stat label="Avg landed cost / set" value={lkr(p.cost_per_set)} sub={`Last GRN: ${lkr(p.last_cost_per_pcs * p.pcs_per_set)}`} />
            <Stat label="Sold so far" value={`${int(p.sold.pcs)} pcs`} sub={`${lkr(p.sold.amount)} · profit ${lkr(p.sold.profit)}`} />
          </div>
          <Card title="Purchase history (GRNs)" pad={false}>
            {p.purchases.length === 0 ? <p className="muted card-body">No GRNs yet.</p> : (
              <table className="table"><thead><tr><th>GRN</th><th>Date</th><th>Bale / Cargo</th><th className="right">Sets</th><th className="right">Cost ₹/set</th><th className="right">Rate</th><th className="right">Landed/set</th></tr></thead>
                <tbody>{p.purchases.map((x) => (
                  <tr key={x.id}><td><Link to={`/grn/${x.grn_id}`}>{x.grn_no}</Link></td><td>{niceDate(x.date)}</td><td>{x.bale_no || '—'}<div className="sub">{x.cargo_name}</div></td>
                    <td className="right">{x.sets}</td><td className="right">{money(x.cost_inr_per_set)}</td><td className="right">{x.exchange_rate}</td><td className="right strong">{money(x.landed_per_set_lkr)}</td></tr>
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
          <Segmented value={adj.mode} onChange={(mode) => setAdj({ ...adj, mode, reason: mode === 'out' ? 'Damaged' : mode === 'in' ? 'Customer return' : 'Stock count' })} options={[
            { value: 'out', label: 'Remove stock' }, { value: 'in', label: 'Add stock' }, { value: 'count', label: 'Set counted stock' }]} />
          <p className="muted small">{adj.mode === 'count' ? `Enter what you physically counted. Now the system says ${stockText(p.stock_pcs, p.pcs_per_set)}.` : adj.mode === 'out' ? 'For damaged, missing or free-sample goods.' : 'For customer returns or found stock.'}</p>
          <div className="grid grid-3">
            <Field label="Sets"><NumInput value={adj.sets} onChange={(v) => setAdj({ ...adj, sets: v })} /></Field>
            <Field label="Loose pieces"><NumInput value={adj.pcs} onChange={(v) => setAdj({ ...adj, pcs: v })} /></Field>
            <Field label="Reason">
              <input className="input" list="adj-reasons" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
              <datalist id="adj-reasons">{['Damaged', 'Missing', 'Customer return', 'Stock count', 'Free sample', 'Found stock'].map((r) => <option key={r} value={r} />)}</datalist>
            </Field>
          </div>
          <div className="alert alert-blue small"><Icon name="info" size={16} /> Change: {adj.mode === 'count' ? n(adj.sets) * p.pcs_per_set + n(adj.pcs) - p.stock_pcs : (adj.mode === 'out' ? -1 : 1) * (n(adj.sets) * p.pcs_per_set + n(adj.pcs))} pieces</div>
        </div>
      )}

      {tab === 'edit' && (
        <div className="grid grid-3">
          <Field label="Code"><input className="input" value={f.code} onChange={set('code')} /></Field>
          <Field label="Product name" required className="span-2"><input className="input" value={f.name} onChange={set('name')} autoFocus /></Field>
          <Field label="Category"><input className="input" list="cats" value={f.category || ''} onChange={set('category')} /><datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist></Field>
          <Field label="Pieces per set"><NumInput value={f.pcs_per_set} onChange={set('pcs_per_set')} /></Field>
          <Field label="No. of colours"><NumInput value={f.colors_count} onChange={set('colors_count')} /></Field>
          <Field label="Sizes"><input className="input" value={f.sizes || ''} onChange={set('sizes')} /></Field>
          <Field label="Colour names" className="span-2"><input className="input" value={f.color_names || ''} onChange={set('color_names')} /></Field>
          <Field label="Expected price / set (Rs)"><NumInput value={f.expected_per_set} onChange={set('expected_per_set')} /></Field>
          <Field label="MRP / set (Rs)"><NumInput value={f.mrp_per_set} onChange={set('mrp_per_set')} /></Field>
          <Field label="Re-order at (sets)"><NumInput value={f.reorder_sets} onChange={set('reorder_sets')} /></Field>
          {!id && <>
            <Field label="Cost / set (Rs)" hint="Landed cost of old stock"><NumInput value={f.cost_per_set} onChange={set('cost_per_set')} /></Field>
            <Field label="Opening stock — sets"><NumInput value={f.opening_sets} onChange={set('opening_sets')} /></Field>
            <Field label="Opening stock — loose pcs"><NumInput value={f.opening_pcs} onChange={set('opening_pcs')} /></Field>
          </>}
          {id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active (show in sales)</label>}
        </div>
      )}
    </Modal>
  );
}
