import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, lkr, niceDate, today, addDays, niceTime, seesCost } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, StatusBadge, Segmented, Stat, useToast } from '../components/ui.jsx';
import { SaleModal } from './SaleView.jsx';
import { useAuth } from '../App.jsx';
import { useNarrow } from '../components/mobile.js';

const RANGES = {
  today: () => [today(), today()],
  week: () => [addDays(today(), -6), today()],
  month: () => [today().slice(0, 8) + '01', today()],
  all: () => ['', ''],
};

export default function Sales() {
  const narrow = useNarrow();   // a phone: a short list of bills instead of the table
  const seeCost = seesCost(useAuth().user);   // profit: Admins only
  const [openId, setOpenId] = useState(null);   // the bill shown in the pop-up
  const toast = useToast();
  // deleting a bill always asks for the Super Admin's password (the approval box appears by itself)
  const deleteBill = async (s) => {
    if (!confirm(`Delete bill ${s.invoice_no} (${lkr(s.total)}) for ${s.customer_name}?

The stock goes back. This cannot be undone. The Super Admin's password is needed.`)) return;
    try {
      const r = await api.del(`/sales/${s.id}`);
      toast(`${r.invoice_no} deleted${r.payments_kept ? ' — its payments stay on the customer account' : ''}`);
      reload();
    } catch (e) { if (e.message) toast(e.message, 'error'); }
  };
  const [range, setRange] = useState('week');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [from, to] = RANGES[range]();
  const { data, error, loading, reload } = useApi(`/sales?from=${from}&to=${to}&type=${type}`);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((x) => !s || x.invoice_no.toLowerCase().includes(s) || (x.customer_name || '').toLowerCase().includes(s));
  }, [data, q]);
  const done = rows.filter((r) => r.status === 'completed');
  const total = done.reduce((a, b) => a + b.total, 0);
  const profit = done.reduce((a, b) => a + b.profit, 0);
  const unpaid = done.reduce((a, b) => a + b.balance, 0);

  return (
    <div>
      <PageHeader title="Sales & Bills" subtitle="Every bill you have made. Click a bill to view, print or cancel it."
        actions={<Link to="/pos" className="btn btn-primary"><Icon name="plus" /> New sale</Link>} />

      <div className="toolbar">
        <Segmented value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All' }]} />
        <Segmented value={type} onChange={setType} options={[{ value: '', label: 'All bills' }, { value: 'cash', label: 'Cash' }, { value: 'credit', label: 'Credit' }]} />
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search bill no or customer…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>

      <div className="stats mb">
        <Stat icon="receipt" label="Bills" value={done.length} />
        <Stat icon="cash" tone="blue" label="Sales total" value={lkr(total)} />
        {seeCost && <Stat icon="chart" tone="green" label="Profit" value={lkr(profit)} />}
        <Stat icon="clock" tone={unpaid > 0 ? 'amber' : 'green'} label="Still unpaid" value={lkr(unpaid)} />
      </div>

      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length === 0 ? (
          <Empty icon="receipt" title="No bills in this period" text="Try a different date range or make a new sale." action={<Link to="/pos" className="btn btn-primary">New sale</Link>} />
        ) : narrow ? (
          /* phone: two short lines a bill — who and how much, then bill no · date · time and its state; tap for the details */
          <div className="bill-list">
            {rows.map((s) => (
              <div key={s.id} className={`bill-row ${s.status === 'void' ? 'void' : ''}`} role="button" onClick={() => setOpenId(s.id)}>
                <div className="br-top">
                  <b className="br-who">{s.customer_name}</b>
                  <b className="br-total">{lkr(s.total)}</b>
                </div>
                <div className="br-bottom">
                  <span className="br-meta">{s.invoice_no} · {niceDate(s.date).slice(0, 5)}{s.created_at ? ` · ${niceTime(s.created_at)}` : ''}</span>
                  <span className="br-tags">
                    {s.balance > 0 && s.status !== 'void'
                      ? <span className="br-due">Rs {Math.round(s.balance).toLocaleString('en-GB')} due</span>
                      : <Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type === 'cash' ? 'Cash' : 'Credit'}</Badge>}
                    <StatusBadge status={s.pay_status} />
                  </span>
                  <button type="button" className="btn btn-icon btn-sm btn-ghost br-del" title="Delete bill (Super Admin)"
                    onClick={(e) => { e.stopPropagation(); deleteBill(s); }}><Icon name="trash" size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Bill no</th><th>Date</th><th>Customer</th><th>Type</th><th className="right">Total</th>{seeCost && <th className="right">Profit</th>}<th className="right">Balance</th><th>Status</th><th className="x" /></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className={`click ${s.status === 'void' ? 'void' : ''}`} onClick={() => setOpenId(s.id)}>
                    <td className="strong">{s.invoice_no}</td>
                    <td className="nowrap">{niceDate(s.date)}{s.created_at && <div className="sub">{niceTime(s.created_at)}</div>}</td>
                    <td>{s.customer_name}<div className="sub">{s.item_count} item{s.item_count === 1 ? '' : 's'}</div></td>
                    <td><Badge tone={s.payment_type === 'cash' ? 'green' : 'amber'}>{s.payment_type === 'cash' ? 'Cash' : 'Credit'}</Badge></td>
                    <td className="right strong">{lkr(s.total)}</td>
                    {seeCost && <td className={`right ${s.profit < 0 ? 'text-red' : ''}`}>{lkr(s.profit)}</td>}
                    <td className="right">{s.balance > 0 ? lkr(s.balance) : '—'}</td>
                    <td><StatusBadge status={s.pay_status} /></td>
                    <td className="right">
                      <button type="button" className="btn btn-icon btn-sm btn-ghost row-del" title="Delete bill (Super Admin)"
                        onClick={(e) => { e.stopPropagation(); deleteBill(s); }}><Icon name="trash" size={15} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <SaleModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
