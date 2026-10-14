import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, money, lkr, inr, niceDate, int } from '../lib.js';
import { Loading, Icon } from '../components/ui.jsx';
import { useSettings } from '../App.jsx';

function PrintBar() {
  return (
    <div className="print-bar">
      <button className="btn" onClick={() => window.close()}>Close</button>
      <button className="btn btn-primary" onClick={() => window.print()}><Icon name="print" /> Print</button>
    </div>
  );
}
// Opens the print dialog automatically; add ?preview to the URL to just look at the page.
const useAutoPrint = (ready) => useEffect(() => {
  if (ready && !new URLSearchParams(window.location.search).has('preview')) setTimeout(() => window.print(), 300);
}, [ready]);

function ShopHead({ title, no, date }) {
  const { settings } = useSettings();
  return (
    <div className="print-head">
      <div>
        <h1>{settings.shop_name}</h1>
        <div>{settings.shop_address}</div>
        {settings.shop_phone && <div>Tel: {settings.shop_phone}</div>}
      </div>
      <div className="right">
        <h2>{title}</h2>
        <div><b>{no}</b></div>
        <div>{niceDate(date)}</div>
      </div>
    </div>
  );
}

export function PrintSale() {
  const { id } = useParams();
  const { settings } = useSettings();
  const { data: s } = useApi(`/sales/${id}`);
  useAutoPrint(!!s);
  if (!s) return <Loading />;
  const mrpTotal = s.items.reduce((a, i) => a + i.mrp_per_unit * i.qty, 0);
  const hasDisc = s.items.some((i) => i.disc > 0);
  return (
    <>
      <PrintBar />
      <div className="print-page">
        <ShopHead title={s.status === 'void' ? 'CANCELLED BILL' : s.payment_type === 'credit' ? 'CREDIT INVOICE' : 'CASH BILL'} no={s.invoice_no} date={s.date} />
        <div className="print-meta">
          <div><div className="muted">Bill to</div><b>{s.customer_name}</b>{s.customer_shop && <div>{s.customer_shop}</div>}{s.customer_address && <div>{s.customer_address}</div>}{s.customer_phone && <div>{s.customer_phone}</div>}</div>
          {s.payment_type === 'credit' && <div className="right"><div className="muted">Payment due</div><b>{niceDate(s.due_date)}</b></div>}
        </div>
        <table>
          <thead><tr><th>#</th><th>Item</th><th className="right">Qty</th><th className="right">MRP</th><th className="right">Rate</th>{hasDisc && <th className="right">Dis</th>}<th className="right">Amount</th></tr></thead>
          <tbody>{s.items.map((i, idx) => (
            <tr key={i.id}><td>{idx + 1}</td><td>{i.name}<div className="muted small">{i.code}</div></td><td className="right">{int(i.pcs)} pcs</td>
              <td className="right">{money(i.mrp_per_unit)}</td><td className="right">{money(i.price)}</td>
              {hasDisc && <td className="right">{i.disc ? `${i.disc_pct}%` : '—'}</td>}<td className="right">{money(i.line_total)}</td></tr>
          ))}</tbody>
        </table>
        <div className="print-totals">
          <div><span>Subtotal</span><span>{money(s.subtotal)}</span></div>
          {s.discount > 0 && <div><span>Discount</span><span>- {money(s.discount)}</span></div>}
          <div className="grand"><span>Total</span><span>{lkr(s.total)}</span></div>
          {s.payment_type === 'credit' && <>
            <div><span>Paid</span><span>{money(s.paid_at_sale)}</span></div>
            <div><b>Balance on this bill</b><b>{money(s.total - s.paid_at_sale)}</b></div>
            {s.customer_balance != null && <div><span>Total outstanding</span><span>{lkr(s.customer_balance)}</span></div>}
          </>}
          {mrpTotal > s.total && <div className="muted"><span>You saved vs MRP</span><span>{money(mrpTotal - s.total)}</span></div>}
        </div>
        <div className="print-foot">
          <div className="sign">Customer signature</div>
          <div className="sign">For {settings.shop_name}</div>
        </div>
        <p className="center muted mt">{settings.invoice_footer}</p>
      </div>
    </>
  );
}

export function PrintGrn() {
  const { id } = useParams();
  const { data: g } = useApi(`/grns/${id}`);
  useAutoPrint(!!g);
  if (!g) return <Loading />;
  return (
    <>
      <PrintBar />
      <div className="print-page">
        <ShopHead title="GOODS RECEIVED NOTE" no={g.grn_no} date={g.date} />
        <div className="print-meta">
          <div><div className="muted">Supplier</div><b>{g.supplier_name}</b><div>{g.supplier_city}</div><div>Invoice: {g.supplier_invoice_no || '—'}</div></div>
          <div className="right"><div>Cargo: <b>{g.cargo_name || '—'}</b></div><div>Rate: <b>1 INR = Rs {g.exchange_rate}</b></div></div>
        </div>
        <table>
          <thead><tr><th>Item</th><th className="right">Sets</th><th className="right">Pcs/set</th><th>Colours / Sizes</th><th className="right">Bill ₹/pc</th><th className="right">Cost Rs/pc</th><th className="right">Expected Rs/pc</th><th className="right">MRP Rs/pc</th></tr></thead>
          <tbody>{g.items.map((i) => (
            <tr key={i.id}><td>{i.name}<div className="muted small">{i.code}</div></td><td className="right">{i.sets}{i.extra_pcs > 0 && <div className="muted small">+{i.extra_pcs} extra pcs</div>}{i.extra_sets > 0 && <div className="muted small">+{i.extra_sets} free sets</div>}{(i.short_sets > 0 || i.short_pcs > 0) && <div className="muted small">−{i.short_sets * i.pcs_per_set + i.short_pcs} pcs short</div>}</td><td className="right">{i.pcs_per_set}</td><td>{i.colors_count || '—'} / {i.sizes || '—'}</td>
              <td className="right">{money(i.cost_inr_per_set / (i.pcs_per_set || 1))}</td><td className="right">{money(i.landed_per_pcs_lkr)}</td><td className="right">{money(i.expected_per_set / (i.pcs_per_set || 1))}</td><td className="right">{money(i.mrp_per_set / (i.pcs_per_set || 1))}</td></tr>
          ))}</tbody>
        </table>
        <div className="print-totals">
          <div><span>Goods</span><span>{inr(g.goods_inr)}</span></div>
          {g.cargo_charge_inr > 0 && <div><span>Cargo charge (₹)</span><span>{inr(g.cargo_charge_inr)}</span></div>}
          {g.expenses_lkr - (g.other_lkr || 0) > 0 && <div><span>Cargo charge</span><span>{lkr(g.expenses_lkr - (g.other_lkr || 0))}</span></div>}
          {g.other_lkr > 0 && <div><span>Other expenses</span><span>{lkr(g.other_lkr)}</span></div>}
          <div className="grand"><span>Total cost</span><span>{lkr(g.total_lkr)}</span></div>
          <div><span>Payable to supplier</span><span>{inr(g.payable_inr)}</span></div>
          <div><span>Due date</span><span>{niceDate(g.due_date)}</span></div>
        </div>
        <div className="print-foot"><div className="sign">Checked by</div><div className="sign">Approved by</div></div>
      </div>
    </>
  );
}
