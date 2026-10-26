import { useEffect, useState } from 'react';
import { money, lkr, niceDate, niceTime, int, today } from '../lib.js';
import { Field, NumInput, Icon, Modal, useToast } from './ui.jsx';
import { useSettings } from '../App.jsx';
import { usePhone } from './mobile.js';
import { printFrame, withPrinting } from './printing.jsx';

/*
 * Printed bills, in two sizes: A5 landscape (the usual one) and an 80 mm receipt.
 * The look is set in Settings → Bill design (one setting, `bill_design`).
 * Printing never opens a new page: the bill is laid out in a hidden frame on this page and sent to the printer —
 * through the print agent when the printers are connected (Settings → Printers, on each computer), until then
 * through this computer's print window.
 */
export const BILL_DEFAULT = {
  default_size: 'a5',    // 'a5' (A5 landscape) or '80' (80 mm receipt)
  show_address: true, show_phone: true, show_time: true,
  show_code: true,       // product codes under the item names
  show_balance: true,    // a credit bill: paid, this bill's balance and the customer's total outstanding
  show_sign: true,       // A5: customer signature and "For {shop}"
  font_a5: 10,           // pt
  font_80: 9,            // pt
  title: '',             // a line under the shop name, e.g. "Wholesale clothing" (optional)
};
export const billDesign = (settings) => {
  let d = {};
  try { d = JSON.parse(settings?.bill_design || '{}') || {}; } catch { /* the defaults */ }
  return { ...BILL_DEFAULT, ...d };
};
export const SIZES = [
  { value: 'a5', label: 'A5', sub: 'Landscape · the usual bill', icon: 'receipt' },
  { value: '80', label: '80 mm', sub: 'Receipt printer', icon: 'print' },
];
export const billPageCss = (size) => (size === '80'
  ? '@page { size: 80mm auto; margin: 0; } html, body { margin: 0; background: #fff; }'
  : '@page { size: A5 landscape; margin: 7mm; } html, body { margin: 0; background: #fff; }');

const billTitle = (s) => (s.status === 'void' ? 'CANCELLED BILL'
  : s.total < 0 ? (s.payment_type === 'credit' ? 'RETURN · CREDIT NOTE' : 'RETURN · CASH REFUND')
    : s.payment_type === 'credit' ? 'CREDIT INVOICE' : 'CASH BILL');

/** A5 landscape. */
function BillA5({ s, d, settings }) {
  const hasDisc = s.items.some((i) => i.disc > 0);
  const credit = s.payment_type === 'credit' && s.total >= 0;
  return (
    <div className="bill bill-a5" style={{ fontSize: `${d.font_a5}pt` }}>
      <div className="b-head">
        <div>
          <div className="b-shop">{settings.shop_name}</div>
          {d.title && <div className="b-tag">{d.title}</div>}
          {d.show_address && settings.shop_address && <div>{settings.shop_address}</div>}
          {d.show_phone && settings.shop_phone && <div>Tel: {settings.shop_phone}</div>}
        </div>
        <div className="right">
          <div className="b-title">{billTitle(s)}</div>
          <div><b>{s.invoice_no}</b></div>
          <div>{niceDate(s.date)}{d.show_time && s.created_at ? ` · ${niceTime(s.created_at)}` : ''}</div>
        </div>
      </div>
      <div className="b-meta">
        <div><span className="b-muted">Bill to </span><b>{s.customer_name}</b>{s.customer_person ? ` · ${s.customer_person}` : ''}{s.customer_phone ? ` · ${s.customer_phone}` : ''}</div>
        {credit && s.due_date && <div><span className="b-muted">Payment due </span><b>{niceDate(s.due_date)}</b></div>}
      </div>
      <table className="b-items">
        <thead><tr><th>#</th><th>Item</th><th className="right">Qty</th><th className="right">Rate</th>{hasDisc && <th className="right">Dis</th>}<th className="right">Amount</th></tr></thead>
        <tbody>{s.items.map((i, idx) => (
          <tr key={i.id ?? idx}><td>{idx + 1}</td><td>{i.name}{d.show_code && i.code && <span className="b-muted"> · {i.code}</span>}</td>
            <td className="right">{int(i.pcs)} pcs</td><td className="right">{money(i.price)}</td>
            {hasDisc && <td className="right">{i.disc ? `${i.disc_pct}%` : '—'}</td>}<td className="right">{money(i.line_total)}</td></tr>
        ))}</tbody>
      </table>
      {/* the foot of the page: totals, then the signature lines, then the thank-you message */}
      <div className="b-fill" />
      <div className="b-bottom">
        <div className="b-totals">
          <div><span>Subtotal</span><span>{money(s.subtotal)}</span></div>
          {s.discount > 0 && <div><span>Discount</span><span>- {money(s.discount)}</span></div>}
          <div className="b-grand"><span>Total</span><span>{lkr(s.total)}</span></div>
          {credit && d.show_balance && <>
            <div><span>Paid</span><span>{money(s.paid_at_sale)}</span></div>
            <div><b>Balance on this bill</b><b>{money(s.total - s.paid_at_sale)}</b></div>
            {s.customer_balance != null && <div><span>Total outstanding</span><span>{lkr(s.customer_balance)}</span></div>}
          </>}
        </div>
        {d.show_sign && <div className="b-signs"><div>Customer signature</div><div>For {settings.shop_name}</div></div>}
        {settings.invoice_footer && <div className="b-thanks">{settings.invoice_footer}</div>}
      </div>
    </div>
  );
}

/** 80 mm receipt. */
function Bill80({ s, d, settings }) {
  const credit = s.payment_type === 'credit' && s.total >= 0;
  return (
    <div className="bill bill-80" style={{ fontSize: `${d.font_80}pt` }}>
      <div className="center">
        <div className="b-shop">{settings.shop_name}</div>
        {d.title && <div>{d.title}</div>}
        {d.show_address && settings.shop_address && <div>{settings.shop_address}</div>}
        {d.show_phone && settings.shop_phone && <div>Tel: {settings.shop_phone}</div>}
        <div className="b-title">{billTitle(s)}</div>
      </div>
      <div className="b-row"><span>{s.invoice_no}</span><span>{niceDate(s.date)}{d.show_time && s.created_at ? ` ${niceTime(s.created_at)}` : ''}</span></div>
      <div>{s.customer_name}</div>
      <div className="b-rule" />
      {s.items.map((i, idx) => (
        <div key={i.id ?? idx} className="b-line">
          <div>{i.name}{d.show_code && i.code ? ` (${i.code})` : ''}</div>
          <div className="b-row"><span>{int(i.pcs)} × {money(i.price)}{i.disc ? ` −${i.disc_pct}%` : ''}</span><span>{money(i.line_total)}</span></div>
        </div>
      ))}
      <div className="b-rule" />
      <div className="b-row"><span>Subtotal</span><span>{money(s.subtotal)}</span></div>
      {s.discount > 0 && <div className="b-row"><span>Discount</span><span>- {money(s.discount)}</span></div>}
      <div className="b-row b-grand"><span>TOTAL</span><span>{lkr(s.total)}</span></div>
      {credit && d.show_balance && <>
        <div className="b-row"><span>Paid</span><span>{money(s.paid_at_sale)}</span></div>
        <div className="b-row"><b>Balance</b><b>{money(s.total - s.paid_at_sale)}</b></div>
        {s.customer_balance != null && <div className="b-row"><span>Total outstanding</span><span>{lkr(s.customer_balance)}</span></div>}
      </>}
      <div className="b-rule" />
      {settings.invoice_footer && <div className="center">{settings.invoice_footer}</div>}
    </div>
  );
}

export function BillDoc({ s, size, d, settings }) {
  return size === '80' ? <Bill80 s={s} d={d} settings={settings} /> : <BillA5 s={s} d={d} settings={settings} />;
}

/* ---------------- printers on this computer ---------------- */
const PRINTERS_KEY = 'cargo-printers';
export const PRINTERS_DEFAULT = { mode: 'browser', url: 'http://localhost:9100/print', a5: '', p80: '' };
export const printerSetup = () => {
  try { return { ...PRINTERS_DEFAULT, ...(JSON.parse(localStorage.getItem(PRINTERS_KEY)) || {}) }; } catch { return { ...PRINTERS_DEFAULT }; }
};
const savePrinters = (p) => { try { localStorage.setItem(PRINTERS_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } };

/**
 * Print a bill on this page (no print page), with the printing animation. Returns 'sent' (to the print agent) or
 * 'window' (this computer's print window).
 * The print agent gets: POST { printer, paper: 'A5-landscape' | '80mm', document, html }.
 */
export function printBill(sale, size, settings) {
  return withPrinting({ kind: 'bill', title: sale.invoice_no || 'the bill', sub: size === '80' ? '80 mm receipt' : 'A5 bill' }, () => sendBill(sale, size, settings));
}
async function sendBill(sale, size, settings) {
  const d = billDesign(settings);
  const { doc, win, cleanup } = await printFrame({
    title: sale.invoice_no || 'Bill', width: size === '80' ? '80mm' : '210mm', height: '148mm', css: billPageCss(size),
    element: <BillDoc s={sale} size={size} d={d} settings={settings} />,
  });
  const setup = printerSetup();
  try {
    if (setup.mode === 'agent' && setup.url) {
      const res = await fetch(setup.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printer: size === '80' ? setup.p80 : setup.a5, paper: size === '80' ? '80mm' : 'A5-landscape', document: sale.invoice_no, html: `<!doctype html>${doc.documentElement.outerHTML}` }),
      });
      if (!res.ok) throw new Error(`The printer did not take the bill (${res.status})`);
      return 'sent';
    }
    win.focus();
    win.print();
    return 'window';
  } finally {
    cleanup();
  }
}

/** A5 or 80 mm: two cards, ← → to choose. */
export function SizeChoice({ value, onChange, onPick }) {
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onChange(e.key === 'ArrowLeft' ? 'a5' : '80'); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onPick(value); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  });
  return (
    <div className="size-choice">
      {SIZES.map((o) => (
        <button key={o.value} type="button" className={`size-card ${value === o.value ? 'on' : ''}`} onMouseEnter={() => onChange(o.value)} onClick={() => onPick(o.value)}>
          <span className={`size-shape size-${o.value}`} />
          <b>{o.label}</b><span className="muted small">{o.sub}</span>
        </button>
      ))}
    </div>
  );
}

/** Print a bill again (bill view, New Sale's reprint): choose the size, it prints on this page. */
export function PrintChoiceModal({ sale, onClose }) {
  const { settings } = useSettings();
  const phone = usePhone();   // a phone: tapping A5 or 80 mm prints
  const toast = useToast();
  const [size, setSize] = useState(billDesign(settings).default_size);
  const go = async (sz) => {
    try { const how = await printBill(sale, sz, settings); if (how === 'sent') toast(`${sale.invoice_no} sent to the ${sz === '80' ? '80 mm' : 'A5'} printer`); } catch (e) { toast(e.message, 'error'); }
    onClose();
  };
  return (
    <Modal size="sm" title={`Print ${sale.invoice_no}`} subtitle={phone ? 'Tap a size to print' : '← → to choose · Enter to print'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><span className="spacer" />{!phone && <button className="btn btn-primary" onClick={() => go(size)}><Icon name="print" /> Print {size === '80' ? '80 mm' : 'A5'}</button>}</>}>
      <SizeChoice value={size} onChange={setSize} onPick={go} />
    </Modal>
  );
}

/* ---------------- Settings ---------------- */
const SAMPLE = {
  invoice_no: 'INV-00042', date: today(), created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), status: 'completed',
  customer_name: 'Sameera Textiles', customer_person: 'Mr. Sameera', customer_phone: '077 123 4567', payment_type: 'credit', due_date: today(),
  items: [
    { id: 1, code: 'P0016', name: 'Tommy hilfiger - Collar - T-shirts', pcs: 12, price: 1450, disc: 0, line_total: 17400 },
    { id: 2, code: 'P0021', name: 'Moose - Linen Pant - Pant', pcs: 6, price: 2350, disc: 1, disc_pct: 5, line_total: 13395 },
    { id: 3, code: 'P0030', name: 'Royal Check - Collar L/S - T-shirts', pcs: 5, price: 1900, disc: 0, line_total: 9500 },
  ],
  subtotal: 40295, discount: 295, total: 40000, paid_at_sale: 15000, customer_balance: 62500,
};

/** Settings → Bill design: the usual size, what is printed, letter sizes — with a preview of both. */
export function BillDesign({ f, set, SaveBar }) {
  const d = billDesign(f);
  const [view, setView] = useState(d.default_size);
  const put = (patch) => set('bill_design')(JSON.stringify({ ...d, ...patch }));
  const tick = (k, label) => <label className="check"><input type="checkbox" checked={!!d[k]} onChange={(e) => put({ [k]: e.target.checked })} /> {label}</label>;
  return (
    <div className="stack set-form">
      <Field label="Usual bill size" hint="Picked first when a sale is finished — the other is one arrow key away">
        <select className="input" value={d.default_size} onChange={(e) => put({ default_size: e.target.value })} style={{ maxWidth: 260 }}>
          <option value="a5">A5 landscape</option><option value="80">80 mm receipt</option>
        </select>
      </Field>
      <div className="grid grid-3">
        <Field label="Line under the shop name" hint="Optional, e.g. Wholesale clothing"><input className="input" value={d.title} onChange={(e) => put({ title: e.target.value })} /></Field>
        <Field label="A5 letter size (pt)"><NumInput value={d.font_a5} onChange={(v) => put({ font_a5: v === '' ? '' : Number(v) })} /></Field>
        <Field label="80 mm letter size (pt)"><NumInput value={d.font_80} onChange={(v) => put({ font_80: v === '' ? '' : Number(v) })} /></Field>
      </div>
      <Field label="Message at the bottom of bills"><textarea className="input" value={f.invoice_footer || ''} onChange={set('invoice_footer')} /></Field>
      <div className="row gap wrap">
        {tick('show_address', 'Shop address')}
        {tick('show_phone', 'Shop phone')}
        {tick('show_time', 'Time of the bill')}
        {tick('show_code', 'Product codes')}
        {tick('show_balance', 'Paid, balance and outstanding (credit bills)')}
        {tick('show_sign', 'Signature lines (A5)')}
      </div>
      <div className="bill-preview">
        <div className="row gap">
          <span className="muted small">Preview</span>
          {SIZES.map((o) => <button key={o.value} type="button" className={`btn btn-sm ${view === o.value ? 'btn-primary' : ''}`} onClick={() => setView(o.value)}>{o.label}</button>)}
        </div>
        <div className={`bill-paper paper-${view}`}><BillDoc s={SAMPLE} size={view} d={{ ...d, font_a5: Number(d.font_a5) || 10, font_80: Number(d.font_80) || 9 }} settings={f} /></div>
      </div>
      <SaveBar keys={['bill_design', 'invoice_footer']} />
    </div>
  );
}

/** Settings → Printers: kept on this computer (each computer has its own printers). */
export function PrinterSettings() {
  const { settings } = useSettings();
  const toast = useToast();
  const [p, setP] = useState(printerSetup);
  const put = (patch) => { const next = { ...p, ...patch }; setP(next); savePrinters(next); };
  const test = async (size) => {
    try { const how = await printBill(SAMPLE, size, settings); toast(how === 'sent' ? 'Test bill sent to the printer' : 'Test bill sent to the print window'); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <div className="stack set-form">
      <div className="alert alert-blue small"><Icon name="info" size={16} /> These are kept on <b>this computer</b> — set them on each computer that prints bills.</div>
      <Field label="How bills are printed">
        <select className="input" value={p.mode} onChange={(e) => put({ mode: e.target.value })} style={{ maxWidth: 420 }}>
          <option value="browser">This computer's print window (until the printers are connected)</option>
          <option value="agent">Straight to the printers (print agent)</option>
        </select>
      </Field>
      {p.mode === 'agent' ? (
        <div className="grid grid-3">
          <Field label="Print agent address"><input className="input" value={p.url} onChange={(e) => put({ url: e.target.value })} /></Field>
          <Field label="A5 printer name"><input className="input" value={p.a5} onChange={(e) => put({ a5: e.target.value })} placeholder="e.g. EPSON L3250" /></Field>
          <Field label="80 mm printer name"><input className="input" value={p.p80} onChange={(e) => put({ p80: e.target.value })} placeholder="e.g. XP-80C" /></Field>
        </div>
      ) : (
        <p className="muted small">The bill prints from the same page — no new tab. The computer's print window still shows until the printers are connected straight.</p>
      )}
      <div className="row gap">
        <button type="button" className="btn" onClick={() => test('a5')}><Icon name="print" /> Test A5</button>
        <button type="button" className="btn" onClick={() => test('80')}><Icon name="print" /> Test 80 mm</button>
      </div>
    </div>
  );
}
