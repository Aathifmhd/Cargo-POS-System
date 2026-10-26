import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApi, money, lkr, inr, supMoney, niceDate, niceTime, int } from '../lib.js';
import { Loading, Icon } from '../components/ui.jsx';
import { useSettings } from '../App.jsx';
import { BillDoc, billDesign, billPageCss } from '../components/Bill.jsx';
import { printFrame, withPrinting } from '../components/printing.jsx';
import { StickerSheet, stickerDesign, stickerPageCss, stickerCC, sizesText, STICKER_PRINT_KEY } from '../components/Stickers.jsx';

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

function ShopHead({ title, no, date, time, settings }) {
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
        <div>{niceDate(date)}{time ? ` · ${niceTime(time)}` : ''}</div>
      </div>
    </div>
  );
}

export function PrintSale() {
  const { id } = useParams();
  const { settings } = useSettings();
  const d = billDesign(settings);
  const want = new URLSearchParams(window.location.search).get('size');
  const size = want === '80' || want === 'a5' ? want : d.default_size;
  const { data: s } = useApi(`/sales/${id}`);
  useAutoPrint(!!s);
  if (!s) return <Loading />;
  return (
    <>
      <style>{billPageCss(size)}</style>
      <PrintBar />
      <div className={`bill-paper paper-${size} bill-open`}><BillDoc s={s} size={size} d={d} settings={settings} /></div>
    </>
  );
}

export function PrintGrn() {
  const { id } = useParams();
  const { settings } = useSettings();
  const { data: g } = useApi(`/grns/${id}`);
  useAutoPrint(!!g);
  if (!g) return <Loading />;
  return (
    <>
      <PrintBar />
      <GrnDoc g={g} settings={settings} />
    </>
  );
}

/** Print a GRN on this page (no print page), with the printing animation. */
export function printGrn(g, settings) {
  return withPrinting({ kind: 'bill', title: g.grn_no, sub: 'Goods received note · A4' }, async () => {
    const { win, cleanup } = await printFrame({
      title: g.grn_no, width: '210mm', height: '297mm', css: '@page { size: A4; margin: 12mm; }',
      element: <GrnDoc g={g} settings={settings} />,
    });
    try { win.focus(); win.print(); } finally { cleanup(); }
  });
}

/** The GRN as printed. */
function GrnDoc({ g, settings }) {
  const cur = supMoney(g);
  return (
      <div className="print-page">
        <ShopHead title="GOODS RECEIVED NOTE" no={g.grn_no} date={g.date} settings={settings} />
        <div className="print-meta">
          <div><div className="muted">Supplier</div><b>{g.supplier_name}</b><div>{g.supplier_city}</div><div>Invoice: {g.supplier_invoice_no || '—'}</div>{g.supplier_bill_date && <div>Billed: {niceDate(g.supplier_bill_date)}</div>}</div>
          <div className="right"><div>Cargo: <b>{g.cargo_name || '—'}</b></div><div>{g.currency === 'LKR' ? <b>Local purchase · Rs</b> : <>Rate: <b>1 INR = Rs {g.exchange_rate}</b></>}</div></div>
        </div>
        <table>
          <thead><tr><th>Item</th><th className="right">Sets</th><th className="right">Pcs/set</th><th>Colours / Sizes</th><th className="right">Bill {g.currency === 'LKR' ? 'Rs' : '₹'}/pc</th><th className="right">Cost Rs/pc</th><th className="right">Expected Rs/pc</th></tr></thead>
          <tbody>{g.items.map((i) => (
            <tr key={i.id}><td>{i.name}<div className="muted small">{i.code}</div></td><td className="right">{i.sets}{i.odd_pcs ? <div className="muted small">{i.sets * i.pcs_per_set + i.odd_pcs} pcs, not {i.sets * i.pcs_per_set}</div> : null}{i.extra_pcs > 0 && <div className="muted small">+{i.extra_pcs} extra pcs</div>}{i.extra_sets > 0 && <div className="muted small">+{i.extra_sets} free sets</div>}{(i.short_sets > 0 || i.short_pcs > 0) && <div className="muted small">−{i.short_sets * i.pcs_per_set + i.short_pcs} pcs short</div>}</td><td className="right">{i.pcs_per_set}</td><td>{i.colors_count || '—'} / {i.sizes || '—'}</td>
              <td className="right">{money(i.cost_inr_per_set / (i.pcs_per_set || 1))}</td><td className="right">{money(i.landed_per_pcs_lkr)}</td><td className="right">{money(i.expected_per_set / (i.pcs_per_set || 1))}</td></tr>
          ))}</tbody>
        </table>
        <div className="print-totals">
          <div><span>Goods</span><span>{cur(g.goods_inr)}</span></div>
          {g.cargo_charge_inr > 0 && <div><span>Cargo charge (₹)</span><span>{cur(g.cargo_charge_inr)}</span></div>}
          {g.expenses_lkr - (g.other_lkr || 0) > 0 && <div><span>Cargo charge</span><span>{lkr(g.expenses_lkr - (g.other_lkr || 0))}</span></div>}
          {g.other_lkr > 0 && <div><span>Other expenses</span><span>{lkr(g.other_lkr)}</span></div>}
          <div className="grand"><span>Total cost</span><span>{lkr(g.total_lkr)}</span></div>
          <div><span>Payable to supplier</span><span>{cur(g.payable_inr)}</span></div>
          <div><span>Due date</span><span>{niceDate(g.due_date)}</span></div>
        </div>
        <div className="print-foot"><div className="sign">Checked by</div><div className="sign">Approved by</div></div>
      </div>
  );
}

/** Set stickers, a row of the roll per printed page. */
function StickerPrint({ stickers }) {
  const { settings } = useSettings();
  const d = stickerDesign(settings);
  useAutoPrint(!!stickers);
  if (!stickers) return <Loading />;
  return (
    <>
      <style>{stickerPageCss(d)}</style>
      <div className="print-bar"><span className="muted">{int(stickers.length)} stickers · {Math.ceil(stickers.length / d.cols)} rows</span><span className="spacer" />
        <button className="btn" onClick={() => window.close()}>Close</button>
        <button className="btn btn-primary" onClick={() => window.print()}><Icon name="print" /> Print</button>
      </div>
      <StickerSheet d={d} stickers={stickers} />
    </>
  );
}
export function PrintStickers() {
  const { id } = useParams();
  if (id === 'test') return <TestStickers />;
  if (id === 'manual') return <ManualStickers />;
  return <GrnStickers id={id} />;
}
function GrnStickers({ id }) {
  const { settings } = useSettings();
  const d = stickerDesign(settings);
  const { data: g } = useApi(`/grns/${id}`);
  let stickers = null;
  if (g) {
    const byId = new Map(g.items.map((i) => [String(i.id), i]));
    stickers = [];
    for (const part of (new URLSearchParams(window.location.search).get('c') || '').split(',')) {
      const [lineId, pcs, count] = part.split(':');
      const it = byId.get(lineId);
      if (!it) continue;
      const one = { code: it.code, name: it.name, pcs: Number(pcs) || it.pcs_per_set, sizes: sizesText(it.sizes), cc: stickerCC(it, d, settings) };
      for (let k = 0; k < Math.min(Number(count) || 0, 5000); k++) stickers.push(one);
    }
  }
  return <StickerPrint stickers={stickers} />;
}
/** Manual stickers (Shipments / Stock → Print stickers), handed over through localStorage. */
function ManualStickers() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(STICKER_PRINT_KEY)) || []; } catch { /* nothing to print */ }
  const stickers = [];
  for (const r of Array.isArray(list) ? list : []) for (let k = 0; k < Math.min(Number(r.count) || 0, 5000); k++) stickers.push({ code: r.code, name: r.name, cc: r.cc, pcs: r.pcs, sizes: r.sizes });
  return <StickerPrint stickers={stickers} />;
}
function TestStickers() {
  const { settings } = useSettings();
  const count = Math.min(Number(new URLSearchParams(window.location.search).get('n')) || 2, 12);
  const one = { code: 'P0016', name: 'Denim Baggy Jeans', pcs: 5, sizes: 'XL, L, M', cc: stickerCC({ landed_per_pcs_lkr: 1053, pcs_per_set: 5 }, stickerDesign(settings), settings) };
  return <StickerPrint stickers={Array.from({ length: count }, () => one)} />;
}
