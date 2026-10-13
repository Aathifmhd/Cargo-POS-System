import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, lkr, inr, money, niceDate, int, pct, margin, today, addDays, stockText } from '../lib.js';
import { PageHeader, Card, Loading, ErrorBox, Stat, Tabs, Segmented, Icon } from '../components/ui.jsx';

const PRESETS = {
  today: () => [today(), today()],
  week: () => [addDays(today(), -6), today()],
  month: () => [today().slice(0, 8) + '01', today()],
  last30: () => [addDays(today(), -29), today()],
  year: () => [today().slice(0, 5) + '01-01', today()],
};

export default function Reports() {
  const [tab, setTab] = useState('sales');
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(PRESETS.month());
  const choose = (p) => { setPreset(p); setRange(PRESETS[p]()); };

  return (
    <div>
      <PageHeader title="Reports" subtitle="See how the business is doing."
        actions={<button className="btn" onClick={() => window.print()}><Icon name="print" /> Print</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'sales', label: 'Sales & profit' }, { value: 'shipments', label: 'Shipments & cargo' }, { value: 'stock', label: 'Stock value' }]} />
      {tab !== 'stock' && (
        <div className="toolbar">
          <Segmented value={preset} onChange={choose} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'last30', label: '30 days' }, { value: 'year', label: 'This year' }]} />
          <input type="date" className="input" style={{ width: 160 }} value={from} onChange={(e) => { setPreset(''); setRange([e.target.value, to]); }} />
          <span className="muted">to</span>
          <input type="date" className="input" style={{ width: 160 }} value={to} onChange={(e) => { setPreset(''); setRange([from, e.target.value]); }} />
        </div>
      )}
      {tab === 'sales' && <SalesReport from={from} to={to} />}
      {tab === 'shipments' && <ShipmentReport from={from} to={to} />}
      {tab === 'stock' && <StockReport />}
    </div>
  );
}

function SalesReport({ from, to }) {
  const { data: d, error, reload } = useApi(`/reports/sales?from=${from}&to=${to}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;
  const s = d.summary;
  return (
    <div className="stack">
      <div className="stats">
        <Stat icon="receipt" label="Sales" value={lkr(s.sales)} sub={`${s.bills} bills${s.voided ? ` · ${s.voided} cancelled` : ''}`} />
        <Stat icon="chart" tone="green" label="Gross profit" value={lkr(s.profit)} sub={`Margin ${pct(margin(s.sales, s.cost))}`} />
        <Stat icon="cash" tone="blue" label="Cash sales" value={lkr(s.cash)} sub={`Credit ${lkr(s.credit)}`} />
        <Stat icon="wallet" tone="violet" label="Collections from credit" value={lkr(s.collections)} sub={`Discounts given ${lkr(s.discount)}`} />
      </div>
      <Card title="Day by day" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Date</th><th className="right">Bills</th><th className="right">Cash</th><th className="right">Credit</th><th className="right">Total</th><th className="right">Profit</th></tr></thead>
          <tbody>{d.daily.length === 0 ? <tr><td colSpan={6} className="center muted">No sales in this period.</td></tr> : d.daily.map((r) => (
            <tr key={r.date}><td>{niceDate(r.date)}</td><td className="right">{r.bills}</td><td className="right">{money(r.cash)}</td><td className="right">{money(r.credit)}</td><td className="right strong">{money(r.sales)}</td><td className="right text-green">{money(r.profit)}</td></tr>
          ))}</tbody>
          {d.daily.length > 0 && <tfoot><tr><td>Total</td><td className="right">{s.bills}</td><td className="right">{money(s.cash)}</td><td className="right">{money(s.credit)}</td><td className="right">{money(s.sales)}</td><td className="right">{money(s.profit)}</td></tr></tfoot>}
        </table></div>
      </Card>
      <div className="grid grid-2">
        <Card title="Products sold" pad={false}>
          <div className="table-wrap" style={{ maxHeight: 420 }}><table className="table">
            <thead><tr><th>Product</th><th className="right">Pcs</th><th className="right">Sales</th><th className="right">Profit</th></tr></thead>
            <tbody>{d.products.map((p) => (
              <tr key={p.product_id}><td><b>{p.name}</b><div className="sub">{p.code}</div></td><td className="right">{int(p.pcs)}</td><td className="right">{money(p.amount)}</td><td className={`right ${p.profit < 0 ? 'text-red' : 'text-green'}`}>{money(p.profit)}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
        <Card title="Customers" pad={false}>
          <div className="table-wrap" style={{ maxHeight: 420 }}><table className="table">
            <thead><tr><th>Customer</th><th className="right">Bills</th><th className="right">Sales</th><th className="right">Profit</th></tr></thead>
            <tbody>{d.customers.map((c, i) => (
              <tr key={i}><td>{c.customer_id ? <Link to={`/customers/${c.customer_id}`}>{c.customer_name}</Link> : c.customer_name}</td><td className="right">{c.bills}</td><td className="right">{money(c.amount)}</td><td className="right text-green">{money(c.profit)}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
      </div>
    </div>
  );
}

function ShipmentReport({ from, to }) {
  const { data: d, error, reload } = useApi(`/reports/shipments?from=${from}&to=${to}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;
  const t = d.grns.reduce((a, g) => ({ goods: a.goods + g.goods_inr, cargo: a.cargo + g.cargo_charge_inr * g.exchange_rate, exp: a.exp + g.expenses_lkr, total: a.total + g.total_lkr }), { goods: 0, cargo: 0, exp: 0, total: 0 });
  return (
    <div className="stack">
      <div className="stats">
        <Stat icon="truck" label="Shipments" value={d.grns.length} />
        <Stat icon="layers" tone="blue" label="Goods bought" value={inr(t.goods)} />
        <Stat icon="cash" tone="amber" label="Cargo & local charges" value={lkr(t.cargo + t.exp)} sub={t.total ? `${pct(((t.cargo + t.exp) / t.total) * 100)} of total cost` : ''} />
        <Stat icon="box" tone="green" label="Total cost" value={lkr(t.total)} />
      </div>
      <Card title="By cargo company" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Cargo</th><th className="right">Shipments</th><th className="right">Pieces</th><th className="right">Goods ₹</th><th className="right">Cargo (Rs)</th><th className="right">Cargo per piece</th><th className="right">Cost LKR</th></tr></thead>
          <tbody>{d.byCargo.map((c) => (
            <tr key={c.cargo_name}><td className="strong">{c.cargo_name}</td><td className="right">{c.shipments}</td><td className="right">{int(c.pcs)}</td><td className="right">{money(c.goods_inr)}</td><td className="right">{money(c.cargo_lkr)}</td><td className="right">{lkr(c.pcs ? c.cargo_lkr / c.pcs : 0)}</td><td className="right strong">{money(c.total_lkr)}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
      <Card title="By supplier" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Supplier</th><th className="right">Shipments</th><th className="right">Goods ₹</th><th className="right">Avg rate</th><th className="right">Cost LKR</th></tr></thead>
          <tbody>{d.bySupplier.map((s) => (
            <tr key={s.supplier_name}><td className="strong">{s.supplier_name}</td><td className="right">{s.shipments}</td><td className="right">{money(s.goods_inr)}</td><td className="right">{s.avg_rate.toFixed(2)}</td><td className="right strong">{money(s.total_lkr)}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
      <Card title="All shipments" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>GRN</th><th>Date</th><th>Supplier</th><th>Cargo</th><th>Bale</th><th>LR</th><th className="right">Rate</th><th className="right">Cost LKR</th></tr></thead>
          <tbody>{d.grns.map((g) => (
            <tr key={g.id}><td><Link to={`/grn/${g.id}`}>{g.grn_no}</Link></td><td>{niceDate(g.date)}</td><td>{g.supplier_name}</td><td>{g.cargo_name || '—'}</td><td>{g.bale_no || '—'}</td><td>{g.lr_no || '—'}</td><td className="right">{g.exchange_rate}</td><td className="right strong">{money(g.total_lkr)}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </div>
  );
}

function StockReport() {
  const { data: d, error, reload } = useApi('/reports/stock');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;
  const t = d.categories.reduce((a, c) => ({ cost: a.cost + c.cost_value, exp: a.exp + c.expected_value, mrp: a.mrp + c.mrp_value }), { cost: 0, exp: 0, mrp: 0 });
  return (
    <div className="stack">
      <div className="stats">
        <Stat icon="box" label="Stock at cost" value={lkr(t.cost)} />
        <Stat icon="tag" tone="green" label="At expected price" value={lkr(t.exp)} sub={`Profit ${lkr(t.exp - t.cost)}`} />
        <Stat icon="layers" tone="blue" label="At MRP" value={lkr(t.mrp)} />
      </div>
      <Card title="By category" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Category</th><th className="right">Products</th><th className="right">Pieces</th><th className="right">Cost value</th><th className="right">Expected value</th><th className="right">MRP value</th></tr></thead>
          <tbody>{d.categories.map((c) => (
            <tr key={c.category}><td className="strong">{c.category}</td><td className="right">{c.products}</td><td className="right">{int(c.pcs)}</td><td className="right">{money(c.cost_value)}</td><td className="right">{money(c.expected_value)}</td><td className="right">{money(c.mrp_value)}</td></tr>
          ))}</tbody>
          <tfoot><tr><td>Total</td><td /><td /><td className="right">{money(t.cost)}</td><td className="right">{money(t.exp)}</td><td className="right">{money(t.mrp)}</td></tr></tfoot>
        </table></div>
      </Card>
      <Card title="Slow moving — no sales in 60 days" pad={false}>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Product</th><th>In stock</th><th>Last sold</th><th className="right">Money stuck (cost)</th></tr></thead>
          <tbody>{d.slow.length === 0 ? <tr><td colSpan={4} className="center muted">Everything is moving. 👍</td></tr> : d.slow.map((p) => (
            <tr key={p.id}><td><b>{p.name}</b><div className="sub">{p.code}</div></td><td>{stockText(p.stock_pcs, p.pcs_per_set)}</td><td>{p.last_sold ? niceDate(p.last_sold) : 'Never'}</td><td className="right strong">{money(p.cost_value)}</td></tr>
          ))}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
