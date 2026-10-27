import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { GrnModal } from './GrnView.jsx';
import { ManualStickerModal } from '../components/Stickers.jsx';
import { useApi, lkr, inr, supMoney, niceDate, int, dueText } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, StatusBadge } from '../components/ui.jsx';

export default function GrnList() {
  const location = useLocation();
  const navigate = useNavigate();
  // coming back from editing a GRN: open it again in the pop-up
  const [openId, setOpenId] = useState(() => location.state?.openGrn || null);   // the GRN shown in the pop-up
  useEffect(() => { if (location.state?.openGrn) navigate('.', { replace: true, state: null }); }, []); // eslint-disable-line
  const [q, setQ] = useState('');
  const [stickers, setStickers] = useState(false);   // manual sticker printing
  const { data, error, loading, reload } = useApi(`/grns?q=${encodeURIComponent(q)}`);

  return (
    <div>
      <PageHeader title="Shipments (GRN)" subtitle="Every shipment received from India. Search by GRN no, cargo or supplier."
        actions={<>
          <button className="btn" onClick={() => setStickers(true)} title="Type product codes and print their stickers in bulk"><Icon name="tag" /> Print stickers</button>
          <Link to="/grn/new" className="btn btn-primary"><Icon name="plus" /> Receive goods</Link>
        </>} />
      {stickers && <ManualStickerModal onClose={() => setStickers(false)} />}
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="GRN no, cargo, supplier…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : !data?.length ? (
          <Empty icon="truck" title={q ? 'No shipment matches your search' : 'No shipments yet'} text="When a shipment arrives from India, record it here to add stock."
            action={<Link to="/grn/new" className="btn btn-primary">Receive goods</Link>} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>GRN</th><th>Date</th><th>Supplier</th><th>Cargo</th><th className="right">Rate</th><th className="right">Goods (INR)</th><th className="right">Cost (LKR)</th><th className="right">To pay (INR)</th><th>Payment</th></tr></thead>
              <tbody>
                {data.map((g) => (
                  <tr key={g.id} className="click" onClick={() => setOpenId(g.id)}>
                    <td className="strong">{g.grn_no}</td>
                    <td className="nowrap">{niceDate(g.date)}</td>
                    <td className="m-sub">{g.supplier_name}{g.supplier_code && <span className="muted small"> · {g.supplier_code}</span>}<div className="sub">{int(g.total_sets)} sets · {int(g.total_pcs)} pcs</div></td>
                    <td>{g.cargo_name || '—'}</td>
                    <td className="right">{g.exchange_rate.toFixed(2)}</td>
                    <td className="right">{supMoney(g)(g.goods_inr)}</td>
                    <td className="right strong">{lkr(g.total_lkr)}</td>
                    <td className="right">{g.balance_inr > 0 ? supMoney(g)(g.balance_inr) : '—'}</td>
                    <td><StatusBadge status={g.pay_status} />{g.balance_inr > 0 && <div className="sub">{dueText(g.due_date)}</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openId && <GrnModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}
