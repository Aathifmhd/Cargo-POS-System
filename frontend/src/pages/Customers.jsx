import { useMemo, useState } from 'react';
import { useApi, lkr, niceDate } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, Stat } from '../components/ui.jsx';
import { CustomerForm } from '../components/forms.jsx';
import { CustomerModal } from './CustomerView.jsx';

export default function Customers() {
  const [openId, setOpenId] = useState(null);   // the one shown in the pop-up
  const { data, error, loading, reload } = useApi('/customers');
  const [q, setQ] = useState('');
  const [onlyOwing, setOnlyOwing] = useState(false);
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((c) => (!onlyOwing || c.balance > 0) && (!s || `${c.name} ${c.shop_name || ''} ${c.city || ''} ${c.phone || ''}`.toLowerCase().includes(s)));
  }, [data, q, onlyOwing]);
  const owed = (data || []).reduce((a, b) => a + b.balance, 0);
  const overdue = (data || []).reduce((a, b) => a + b.overdue, 0);

  return (
    <div>
      <PageHeader title="Customers" subtitle="Shops that buy from you, their dues, and their credit limits."
        actions={<button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add customer</button>} />
      <div className="stats mb">
        <Stat icon="users" label="Customers" value={(data || []).filter((c) => c.active).length} />
        <Stat icon="cash" tone="blue" label="To collect" value={lkr(owed)} />
        <Stat icon="alert" tone={overdue > 0 ? 'red' : 'green'} label="Overdue" value={lkr(overdue)} />
      </div>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search name, shop, city, phone…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <label className="check"><input type="checkbox" checked={onlyOwing} onChange={(e) => setOnlyOwing(e.target.checked)} /> Only with dues</label>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length === 0 ? <Empty icon="users" title="No customers found" action={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add customer</button>} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Customer</th><th>Phone</th><th className="right">Bills</th><th className="right">Total bought</th><th>Last bill</th><th className="right">Credit limit</th><th className="right">Due</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpenId(c.id)}>
                  <td><b>{c.name}</b> {!c.active && <Badge>Inactive</Badge>}<div className="sub">{[c.shop_name, c.city].filter(Boolean).join(' · ') || '—'}</div></td>
                  <td>{c.phone || '—'}</td>
                  <td className="right">{c.bill_count}</td>
                  <td className="right">{lkr(c.total_bought)}</td>
                  <td>{niceDate(c.last_sale_date)}</td>
                  <td className="right">{c.credit_limit > 0 ? lkr(c.credit_limit) : <span className="muted">No limit</span>}</td>
                  <td className="right">{c.balance > 0 ? <><b className={c.overdue > 0 ? 'text-red' : ''}>{lkr(c.balance)}</b>{c.overdue > 0 && <div className="sub text-red">{lkr(c.overdue)} overdue</div>}{c.credit_limit > 0 && c.balance > c.credit_limit && <div><Badge tone="red">Over limit</Badge></div>}</> : <span className="muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <CustomerForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); reload(); setOpenId(c.id); }} />}
      {openId && <CustomerModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
