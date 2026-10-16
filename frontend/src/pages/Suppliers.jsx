import { useMemo, useState } from 'react';
import { useApi, inr, supMoney, bothMoney, isLocalSup, niceDate, dueText } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, Stat } from '../components/ui.jsx';
import { SupplierForm } from '../components/forms.jsx';
import { SupplierModal } from './SupplierView.jsx';

export default function Suppliers() {
  const [openId, setOpenId] = useState(null);   // the one shown in the pop-up
  const { data, error, loading, reload } = useApi('/suppliers');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((x) => !s || `${x.name} ${x.city || ''} ${x.phone || ''} ${x.contact_person || ''}`.toLowerCase().includes(s));
  }, [data, q]);
  // Indian suppliers in ₹, local ones in Rs — kept apart
  const owe = bothMoney(data, (b) => b.balance_inr);
  const overdueAmt = (data || []).reduce((a, b) => a + b.overdue_inr, 0);
  const overdue = bothMoney(data, (b) => b.overdue_inr);

  return (
    <div>
      <PageHeader title="Suppliers" subtitle="Your suppliers in India and Sri Lanka, and how much is to pay to each of them."
        actions={<button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add supplier</button>} />
      <div className="stats mb">
        <Stat icon="factory" label="Suppliers" value={(data || []).filter((s) => s.active).length} />
        <Stat icon="wallet" tone="amber" label="Total to pay" value={owe} />
        <Stat icon="alert" tone={overdueAmt > 0 ? 'red' : 'green'} label="Overdue" value={overdue} />
      </div>
      <div className="toolbar"><div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search supplier, city, phone…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length === 0 ? <Empty icon="factory" title="No suppliers yet" text="Add the companies in India you buy from." action={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add supplier</button>} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Supplier</th><th>Contact</th><th className="right">GRNs</th><th>Last shipment</th><th className="right">To pay (INR)</th><th>Next due</th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.id} className="click" onClick={() => setOpenId(s.id)}>
                  <td><b>{s.name}</b> {!s.active && <Badge>Inactive</Badge>}<div className="sub">{[s.city, s.state].filter(Boolean).join(', ') || '—'} · {s.credit_days} days credit</div></td>
                  <td>{s.contact_person || '—'}<div className="sub">{s.phone}</div></td>
                  <td className="right">{s.grn_count}</td>
                  <td>{niceDate(s.last_grn_date)}</td>
                  <td className={`right strong ${s.overdue_inr > 0 ? 'text-red' : ''}`}>{s.balance_inr > 0 ? supMoney(s)(s.balance_inr) : '—'}</td>
                  <td>{s.balance_inr > 0 ? (s.overdue_inr > 0 ? <Badge tone="red">{supMoney(s)(s.overdue_inr)} overdue</Badge> : <span className="small">{dueText(s.next_due)}</span>) : <Badge tone="green">Settled</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <SupplierForm onClose={() => setAdding(false)} onSaved={(s) => { setAdding(false); reload(); setOpenId(s.id); }} />}
      {openId && <SupplierModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
