import { Link, useNavigate } from 'react-router-dom';
import { useApi, lkr, inr, supMoney, int, niceDate, dueText, stockText, pct } from '../lib.js';
import { Card, Icon, Loading, ErrorBox, Stat, StatusBadge, Badge } from '../components/ui.jsx';
import { useSettings } from '../App.jsx';
import FxBar from '../components/FxBar.jsx';
import { useState } from 'react';
import { SaleModal } from './SaleView.jsx';

export default function Dashboard() {
  const { data: d, error, reload } = useApi('/dashboard');
  const [openSale, setOpenSale] = useState(null);
  const { settings } = useSettings();
  const navigate = useNavigate();
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;

  const max = Math.max(...d.last7.map((x) => x.sales), 1);
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <FxBar />
      <div className="page-header">
        <div>
          <h1>{greet} 👋</h1>
          <p className="muted">Here is how {settings.shop_name} is doing today, {niceDate(new Date().toISOString())}.</p>
        </div>
      </div>

      <div className="quick-actions">
        <Link to="/pos" className="quick main-q"><div className="stat-icon"><Icon name="cart" /></div><div>New Sale<small>Make a bill (F3)</small></div></Link>
        <Link to="/grn/new" className="quick"><div className="stat-icon"><Icon name="truck" /></div><div>Receive Goods<small>New GRN from India</small></div></Link>
        <Link to="/dues?tab=receivables" className="quick"><div className="stat-icon stat-green" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}><Icon name="cash" /></div><div>Collect Payment<small>From customers</small></div></Link>
        <Link to="/dues?tab=payables" className="quick"><div className="stat-icon" style={{ background: 'var(--amber-soft)', color: 'var(--amber)' }}><Icon name="wallet" /></div><div>Pay Supplier<small>Settle India dues</small></div></Link>
      </div>

      <div className="stats">
        <Stat icon="receipt" label="Today's sales" value={lkr(d.today.sales)} sub={`${d.today.bills} bills · Cash ${lkr(d.today.cash)}`} />
        <Stat icon="chart" tone="green" label="Today's profit" value={lkr(d.today.profit)} sub={`Margin ${pct(d.today.sales ? (d.today.profit / d.today.sales) * 100 : 0)}`} />
        <Stat icon="cash" tone="blue" label="Cash received today" value={lkr(d.collectedToday)} sub="Cash bills + collections" />
        <Stat icon="layers" tone="violet" label="This month" value={lkr(d.month.sales)} sub={`Profit ${lkr(d.month.profit)}`} />
      </div>

      <div className="stats mt">
        <Stat icon="users" tone={d.receivables.overdue > 0 ? 'red' : 'default'} label="To collect" value={lkr(d.receivables.total)}
          sub={d.receivables.overdue > 0 ? `${lkr(d.receivables.overdue)} overdue` : 'Nothing overdue'} onClick={() => navigate('/dues?tab=receivables')} />
        <Stat icon="factory" tone={d.payables.overdue_inr > 0 ? 'red' : 'amber'} label="To pay suppliers" value={[d.payables.total_inr > 0 || !d.payables.total_lkr ? inr(d.payables.total_inr) : null, d.payables.total_lkr > 0 ? lkr(d.payables.total_lkr) : null].filter(Boolean).join(' + ')}
          sub={d.payables.overdue_inr > 0 || d.payables.overdue_lkr > 0 ? `${[d.payables.overdue_inr > 0 && inr(d.payables.overdue_inr), d.payables.overdue_lkr > 0 && lkr(d.payables.overdue_lkr)].filter(Boolean).join(' + ')} overdue` : 'Nothing overdue'} onClick={() => navigate('/dues?tab=payables')} />
        <Stat icon="box" label="Stock value (cost)" value={lkr(d.stock.cost_value)} sub={`Can sell for ${lkr(d.stock.expected_value)}`} onClick={() => navigate('/stock')} />
        <Stat icon="alert" tone={d.stock.low_count ? 'amber' : 'green'} label="Low stock items" value={int(d.stock.low_count)}
          sub={d.stock.low_count ? 'Need to re-order' : 'All good'} onClick={() => navigate('/stock?low=1')} />
      </div>

      <div className="dash-grid">
        <Card title="Sales — last 7 days">
          <div className="bars">
            {d.last7.map((x, i) => (
              <div key={x.date} className={`bar-col ${i === 6 ? 'today' : ''}`} title={`${niceDate(x.date)}: ${lkr(x.sales)} (profit ${lkr(x.profit)})`}>
                <div className="bar-val">{x.sales ? (x.sales >= 1000 ? `${Math.round(x.sales / 1000)}k` : int(x.sales)) : ''}</div>
                <div className="bar" style={{ height: `${(x.sales / max) * 100}%` }} />
                <div className="bar-day">{i === 6 ? 'Today' : new Date(x.date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short' })}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Payments to collect" actions={<Link to="/dues?tab=receivables" className="small">See all</Link>}>
          {d.receivables.upcoming.length === 0 ? <p className="muted">No customer payments due this week. 🎉</p> :
            d.receivables.upcoming.map((b) => (
              <Link key={`${b.customer_id}-${b.id}`} to={`/customers/${b.customer_id}`} className="list-row">
                <div><div className="t">{b.customer_name}</div><div className="s">{b.invoice_no} · {dueText(b.due_date)}</div></div>
                <div className="right"><div className="t">{lkr(b.balance)}</div><StatusBadge status={b.status} /></div>
              </Link>
            ))}
        </Card>

        <Card title="Recent bills" actions={<Link to="/sales" className="small">All sales</Link>}>
          {d.recentSales.length === 0 ? <p className="muted">No bills yet.</p> : d.recentSales.map((s) => (
            <button type="button" key={s.id} className="list-row list-row-btn" onClick={() => setOpenSale(s.id)}>
              <div><div className="t">{s.customer_name}</div><div className="s">{s.invoice_no} · {niceDate(s.date)}</div></div>
              <div className="row gap-s">
                {s.status === 'void' ? <Badge>Cancelled</Badge> : <Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type === 'cash' ? 'Cash' : 'Credit'}</Badge>}
                <b className="mono">{lkr(s.total)}</b>
              </div>
            </button>
          ))}
        </Card>

        <Card title="Supplier payments due" actions={<Link to="/dues?tab=payables" className="small">See all</Link>}>
          {d.payables.upcoming.length === 0 ? <p className="muted">No supplier payments due this week.</p> :
            d.payables.upcoming.map((b) => (
              <Link key={`${b.supplier_id}-${b.id}`} to={`/suppliers/${b.supplier_id}`} className="list-row">
                <div><div className="t">{b.supplier_name}</div><div className="s">{b.grn_no} · {dueText(b.due_date)}</div></div>
                <div className="right"><div className="t">{supMoney(b)(b.balance)}</div><StatusBadge status={b.status} /></div>
              </Link>
            ))}
        </Card>

        <Card title="Best sellers this month">
          {d.topProducts.length === 0 ? <p className="muted">No sales this month yet.</p> : d.topProducts.map((p, i) => (
            <div key={p.product_id} className="list-row">
              <div className="row gap"><Badge tone="teal">#{i + 1}</Badge><div><div className="t">{p.name}</div><div className="s">{int(p.pcs)} pcs sold</div></div></div>
              <b className="mono">{lkr(p.amount)}</b>
            </div>
          ))}
        </Card>

        <Card title={d.lowStock.length ? 'Running low — re-order soon' : 'Latest shipments'}>
          {d.lowStock.length ? d.lowStock.map((p) => (
            <div key={p.id} className="list-row">
              <div><div className="t">{p.name}</div><div className="s">{p.code} · re-order at {p.reorder_sets} sets</div></div>
              <Badge tone={p.stock_pcs <= 0 ? 'red' : 'amber'}>{stockText(p.stock_pcs, p.pcs_per_set)}</Badge>
            </div>
          )) : d.recentGrns.length === 0 ? <p className="muted">No shipments received yet.</p> : d.recentGrns.map((g) => (
            <Link key={g.id} to={`/grn/${g.id}`} className="list-row">
              <div><div className="t">{g.supplier_name}</div><div className="s">{g.grn_no} · {g.cargo_name || 'Cargo —'}</div></div>
              <b className="mono">{lkr(g.total_lkr)}</b>
            </Link>
          ))}
        </Card>
      </div>
      {openSale && <SaleModal id={openSale} onClose={() => setOpenSale(null)} onChanged={reload} />}
    </div>
  );
}
