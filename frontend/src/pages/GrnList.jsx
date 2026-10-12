import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApi, lkr, inr, niceDate, int, dueText } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, StatusBadge } from '../components/ui.jsx';

export default function GrnList() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const { data, error, loading, reload } = useApi(`/grns?q=${encodeURIComponent(q)}`);

  return (
    <div>
      <PageHeader title="Shipments (GRN)" subtitle="Every bale received from India. Search by bale no, LR no, cargo or supplier."
        actions={<Link to="/grn/new" className="btn btn-primary"><Icon name="plus" /> Receive goods</Link>} />
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Bale no, LR no, GRN no, cargo, supplier…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : !data?.length ? (
          <Empty icon="truck" title={q ? 'No shipment matches your search' : 'No shipments yet'} text="When a bale arrives from India, record it here to add stock."
            action={<Link to="/grn/new" className="btn btn-primary">Receive goods</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>GRN</th><th>Date</th><th>Supplier</th><th>Cargo · Bale · LR</th><th className="right">Rate</th><th className="right">Goods (INR)</th><th className="right">Landed (LKR)</th><th className="right">To pay (INR)</th><th>Payment</th></tr></thead>
              <tbody>
                {data.map((g) => (
                  <tr key={g.id} className="click" onClick={() => navigate(`/grn/${g.id}`)}>
                    <td className="strong">{g.grn_no}</td>
                    <td className="nowrap">{niceDate(g.date)}</td>
                    <td>{g.supplier_name}<div className="sub">{int(g.total_sets)} sets · {int(g.total_pcs)} pcs</div></td>
                    <td>{g.cargo_name || '—'}<div className="sub">Bale {g.bale_no || '—'} · LR {g.lr_no || '—'}</div></td>
                    <td className="right">{g.exchange_rate.toFixed(2)}</td>
                    <td className="right">{inr(g.goods_inr)}</td>
                    <td className="right strong">{lkr(g.total_lkr)}</td>
                    <td className="right">{g.balance_inr > 0 ? inr(g.balance_inr) : '—'}</td>
                    <td><StatusBadge status={g.pay_status} />{g.balance_inr > 0 && <div className="sub">{dueText(g.due_date)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
