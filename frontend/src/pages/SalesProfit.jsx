import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, lkr, money, niceDate, niceTime, int, pct, margin } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Stat, Tabs, Segmented, DateInput, Badge } from '../components/ui.jsx';
import { SalesReport, PRESETS } from './Reports.jsx';

/*
 * Sales & Profit (Super Admin only): every sale of a period, and the profit & loss —
 * the profit of each bill (and extra pieces kept free), and every loss with its reason.
 */
const REASON = {
  damaged: { label: 'Damaged return', tone: 'red', text: 'cost written off' },
  undercost: { label: 'Sold under cost', tone: 'amber', text: 'cost − price' },
  short: { label: 'GRN short (lost)', tone: 'violet', text: 'paid for, not received' },
  stock: { label: 'Stock correction', tone: 'grey', text: 'taken off on a count' },
  missing: { label: "Missing — can't find", tone: 'grey', text: 'Stock Count' },
  sample: { label: 'Free sample given', tone: 'blue', text: 'Stock Count' },
  gift: { label: 'Gift / promotion', tone: 'blue', text: 'Stock Count' },
  shopuse: { label: 'Used by the shop', tone: 'violet', text: 'Stock Count' },
  counting: { label: 'Counting mistake', tone: 'grey', text: 'Stock Count' },
  other: { label: 'Other', tone: 'grey', text: 'Stock Count' },
};
const GAIN = {
  extra: { label: 'Extra kept free', tone: 'green' },
  stockfound: { label: 'Stock found', tone: 'blue' },
  add_found: { label: 'Found stock', tone: 'blue' },
  add_counting: { label: 'Counting mistake', tone: 'blue' },
  add_supplierfree: { label: 'Free goods from supplier', tone: 'green' },
  add_other: { label: 'Other', tone: 'blue' },
  repaired: { label: 'Damaged piece repaired', tone: 'violet' },
};

export default function SalesProfit() {
  const [tab, setTab] = useState('sales');
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(PRESETS.month());
  const choose = (p) => { setPreset(p); setRange(PRESETS[p]()); };
  return (
    <div>
      <PageHeader title="Sales & Profit" subtitle="Every sale, the profit on each bill, and every loss with its reason — for the period you choose."
        actions={<button className="btn" onClick={() => window.print()}><Icon name="print" /> Print</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'sales', label: 'Sales' }, { value: 'pl', label: 'Profit & loss' }]} />
      <div className="toolbar">
        <Segmented value={preset} onChange={choose} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'last30', label: '30 days' }, { value: 'year', label: 'This year' }]} />
        <DateInput style={{ width: 160 }} value={from} onChange={(e) => { setPreset(''); setRange([e.target.value, to]); }} />
        <span className="muted">to</span>
        <DateInput style={{ width: 160 }} value={to} onChange={(e) => { setPreset(''); setRange([from, e.target.value]); }} />
      </div>
      {tab === 'sales' ? <SalesReport from={from} to={to} withBills /> : <ProfitLoss from={from} to={to} />}
    </div>
  );
}

function ProfitLoss({ from, to }) {
  const { data: d, error, reload } = useApi(`/reports/profit?from=${from}&to=${to}`);
  const [show, setShow] = useState('');   // a loss reason to show alone
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!d) return <Loading />;
  const s = d.summary;
  const losses = show ? d.losses.filter((l) => l.reason === show) : d.losses;
  return (
    <div className="stack">
      <div className="stats">
        <Stat icon="chart" tone="green" label="Gross profit" value={lkr(s.gross_profit)}
          sub={[`Bills ${lkr(s.invoice_profit)}`, s.extra_profit ? `Free extras ${lkr(s.extra_profit)}` : '', s.stock_gain ? `Stock found ${lkr(s.stock_gain)}` : ''].filter(Boolean).join(' · ')} />
        <Stat icon="alert" tone={s.losses > 0 ? 'red' : 'green'} label="Losses" value={lkr(s.losses)} sub={`${d.losses.length} item${d.losses.length === 1 ? '' : 's'}`} />
        <Stat icon="wallet" tone={s.net_profit < 0 ? 'red' : 'blue'} label="Net profit" value={lkr(s.net_profit)} sub={s.sales ? `Margin ${pct((s.net_profit / s.sales) * 100)}` : ''} />
        <Stat icon="receipt" label="Sales" value={lkr(s.sales)} sub={`${s.bills} bills · cost ${lkr(s.cost)}`} />
      </div>
      <p className="muted small pl-note">Net profit = gross profit − losses. A loss inside a bill (a damaged return, selling under cost) is taken out of that bill's profit and listed under Losses with its reason.</p>

      <Card title={<span className="row gap-s"><Icon name="alert" size={16} /> Losses <Badge tone="red">{lkr(s.losses)}</Badge></span>} pad={false}>
        {d.by_reason.length > 0 && (
          <div className="pl-reasons">
            <button type="button" className={`pl-reason ${!show ? 'on' : ''}`} onClick={() => setShow('')}>All <b>{lkr(s.losses)}</b></button>
            {d.by_reason.map((r) => (
              <button type="button" key={r.reason} className={`pl-reason ${show === r.reason ? 'on' : ''}`} onClick={() => setShow(show === r.reason ? '' : r.reason)}>
                <Badge tone={REASON[r.reason]?.tone || 'grey'}>{REASON[r.reason]?.label || r.reason}</Badge> <b>{lkr(r.amount)}</b> <span className="muted small">· {r.count}</span>
              </button>
            ))}
          </div>
        )}
        {!losses.length ? <Empty icon="check" title="No losses in this period" text="Damaged returns, selling under cost, GRN shorts lost and stock taken off show up here." /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Reason</th><th>Bill / GRN</th><th>Product</th><th className="right">Pcs</th><th className="right">Loss</th><th>Details</th></tr></thead>
            <tbody>{losses.map((l, i) => (
              <tr key={i} className="hover">
                <td className="nowrap">{niceDate(l.date)}</td>
                <td><Badge tone={REASON[l.reason]?.tone || 'grey'}>{REASON[l.reason]?.label || l.reason}</Badge></td>
                <td className="nowrap">{l.sale_id ? <Link to={`/sales/${l.sale_id}`}>{l.ref}</Link> : l.grn_id ? <Link to={`/grn/${l.grn_id}`}>{l.ref}</Link> : l.ref}</td>
                <td><b>{l.name}</b>{l.code && <div className="sub">{l.code}</div>}</td>
                <td className="right">{int(l.pcs)}</td>
                <td className="right strong text-red">{money(l.amount)}</td>
                <td className="small">{l.note}<div className="sub">{REASON[l.reason]?.text}</div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      <Card title={<span className="row gap-s"><Icon name="receipt" size={16} /> Profit on each bill <Badge tone="green">{lkr(s.invoice_profit)}</Badge></span>} pad={false}>
        {!d.invoices.length ? <Empty icon="receipt" title="No bills in this period" text="Choose another period." /> : (
          <div className="table-wrap" style={{ maxHeight: 560 }}><table className="table">
            <thead><tr><th>Bill</th><th>Date</th><th>Customer</th><th className="right">Total</th><th className="right">Cost</th><th className="right">Profit</th><th className="right">Losses in it</th><th className="right">After losses</th></tr></thead>
            <tbody>{d.invoices.map((b) => (
              <tr key={b.id} className="hover">
                <td className="nowrap"><Link to={`/sales/${b.id}`} className="strong">{b.invoice_no}</Link><div className="sub">{b.payment_type === 'credit' ? 'Credit' : 'Cash'}{b.total < 0 ? ' · return' : ''}</div></td>
                <td className="nowrap">{niceDate(b.date)}{b.created_at && <div className="sub">{niceTime(b.created_at)}</div>}</td>
                <td>{b.customer_name}{b.damaged_sold > 0 && <div className="sub"><span className="badge-damaged">Damaged sold {money(b.damaged_sold)}</span></div>}</td>
                <td className="right">{money(b.total)}</td>
                <td className="right muted">{money(b.cost)}</td>
                <td className={`right strong ${b.profit < 0 ? 'text-red' : 'text-green'}`}>{money(b.profit)}</td>
                <td className="right">{b.losses ? <span className="text-red">− {money(b.losses)}</span> : <span className="muted">—</span>}</td>
                <td className={`right ${b.net < 0 ? 'text-red' : ''}`}>{money(b.net)}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr><td colSpan={3}>Total · {d.invoices.length} bills</td><td className="right">{money(s.sales)}</td><td className="right">{money(s.cost)}</td><td className="right">{money(s.invoice_profit)}</td>
              <td className="right">{money(d.invoices.reduce((t, b) => t + b.losses, 0))}</td><td className="right">{money(d.invoices.reduce((t, b) => t + b.net, 0))}</td></tr></tfoot>
          </table></div>
        )}
      </Card>

      <Card title={<span className="row gap-s"><Icon name="tag" size={16} /> Extra pieces kept free & stock found <Badge tone="green">{lkr(s.extra_profit + s.stock_gain)}</Badge></span>} pad={false}>
        {!d.gains.length ? <p className="muted small" style={{ padding: 16 }}>No extra pieces kept free or stock found in this period. Extra pieces a supplier lets you keep (Extra &amp; Short → Kept free) count as profit here.</p> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>What</th><th>GRN</th><th>Product</th><th className="right">Pcs</th><th className="right">Profit</th><th>Details</th></tr></thead>
            <tbody>{d.gains.map((g, i) => (
              <tr key={i} className="hover">
                <td className="nowrap">{niceDate(g.date)}</td>
                <td><Badge tone={GAIN[g.reason]?.tone || 'green'}>{GAIN[g.reason]?.label || g.reason}</Badge></td>
                <td>{g.grn_id ? <Link to={`/grn/${g.grn_id}`}>{g.ref}</Link> : g.ref}</td>
                <td><b>{g.name}</b>{g.code && <div className="sub">{g.code}</div>}</td>
                <td className="right">{int(g.pcs)}</td>
                <td className="right strong text-green">{money(g.amount)}</td>
                <td className="small">{g.note}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
