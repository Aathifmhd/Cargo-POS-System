import { useState } from 'react';
import { codeOf, int, n, useApi } from '../lib.js';
import { Field, NumInput, Icon, Modal } from './ui.jsx';
import { useSettings } from '../App.jsx';
import { useNarrow } from './mobile.js';
import { printFrame, withPrinting } from './printing.jsx';

/*
 * Set stickers: one sticker for each set received on a GRN — product code (big), product name, pieces in the set
 * and the cost code. The printer takes a roll with two stickers side by side, so the stickers print in rows.
 * The look is set in Settings → Sticker design (kept as one setting, `sticker_design`).
 */
export const STICKER_DEFAULT = {
  w: 50, h: 25,          // one sticker, in mm
  cols: 2,               // stickers side by side on the roll
  gap: 2,                // space between the stickers in a row, mm
  pad: 1.5,              // space inside each sticker, mm
  left: 0,               // move everything right (+) or left (−) to line up with the roll, mm
  code: 28,              // product code size, pt
  name: 8,               // product name size, pt
  info: 9,               // pieces and cost code size, pt
  show_name: true, show_pcs: true, show_cc: true, show_sizes: true,
  cc_of: 'pcs',          // the cost code of: 'pcs' (one piece) or 'set'
  border: false,         // a thin line round each sticker (for trying out on plain paper)
};
export const stickerDesign = (settings) => {
  let d = {};
  try { d = JSON.parse(settings?.sticker_design || '{}') || {}; } catch { /* use the defaults */ }
  return { ...STICKER_DEFAULT, ...d };
};

/** A GRN line's sizes as one short line: "XL, L, M". */
export const sizesText = (s) => (Array.isArray(s) ? s : String(s || '').split(/[,/]/)).map((x) => String(x).trim()).filter(Boolean).join(', ');

/**
 * One sticker:  product name ............ cost code
 *               P0016  (big)
 *               5 pieces/set ............ XL, L, M
 */
export function Sticker({ d, code, name, pcs, cc, sizes }) {
  return (
    <div className={`sticker ${d.border ? 'sticker-line' : ''}`} style={{ width: `${d.w}mm`, height: `${d.h}mm`, padding: `${d.pad}mm` }}>
      {(d.show_name || d.show_cc) && (
        <div className="st-top" style={{ fontSize: `${d.name}pt` }}>
          <span className="st-name">{d.show_name ? name : ''}</span>
          {d.show_cc && <b className="st-cc" style={{ fontSize: `${d.info}pt` }}>{cc}</b>}
        </div>
      )}
      <div className="st-code" style={{ fontSize: `${d.code}pt` }}>{code}</div>
      {(d.show_pcs || d.show_sizes) && (
        <div className="st-info" style={{ fontSize: `${d.info}pt` }}>
          <span>{d.show_pcs ? `${int(pcs)} ${Number(pcs) === 1 ? 'piece' : 'pieces'}/set` : ''}</span>
          {d.show_sizes && <span className="st-sizes">{sizes}</span>}
        </div>
      )}
    </div>
  );
}

/** Stickers laid out in rows of `cols` — each row is one printed page of the roll. */
export function StickerSheet({ d, stickers }) {
  const rows = [];
  for (let i = 0; i < stickers.length; i += d.cols) rows.push(stickers.slice(i, i + d.cols));
  return (
    <div className="sticker-sheet">
      {rows.map((row, r) => (
        <div key={r} className="sticker-row" style={{ gap: `${d.gap}mm`, height: `${d.h}mm`, paddingLeft: `${Math.max(0, d.left)}mm`, marginLeft: `${Math.min(0, d.left)}mm` }}>
          {row.map((s, i) => <Sticker key={i} d={d} {...s} />)}
        </div>
      ))}
    </div>
  );
}
/** The @page size for one row of stickers. */
export const stickerPageCss = (d) => `@page { size: ${d.cols * d.w + (d.cols - 1) * d.gap}mm ${d.h}mm; margin: 0; }`;

/**
 * Print stickers on this page (no print page), with the labels animation.
 * stickers: [{ code, name, pcs, sizes, cc }] — one entry a sticker.
 */
export function printStickers(stickers, d) {
  const list = stickers.slice(0, 5000);
  if (!list.length) return Promise.resolve();
  return withPrinting({ kind: 'label', title: `${list.length} sticker${list.length === 1 ? '' : 's'}`, sub: `${Math.ceil(list.length / d.cols)} row${Math.ceil(list.length / d.cols) === 1 ? '' : 's'} on the roll`, code: list[0].code },
    async () => {
      const { win, cleanup } = await printFrame({
        title: 'Stickers', width: `${d.cols * d.w + (d.cols - 1) * d.gap}mm`, height: `${d.h}mm`, css: stickerPageCss(d),
        element: <StickerSheet d={d} stickers={list} />,
      });
      try { win.focus(); win.print(); } finally { cleanup(); }
    });
}

/** A GRN line's cost code for its sticker (of one piece, or of the set). */
export const stickerCC = (it, d, settings) => codeOf(null, d.cc_of === 'set' ? it.landed_per_pcs_lkr * (it.pcs_per_set || 1) : it.landed_per_pcs_lkr, settings);

/**
 * What to print for a GRN: one sticker for every set, each with the pieces per set.
 * (A set with fewer pieces is printed by hand: Stock → Print stickers.)
 */
export const stickerLines = (items) => items.filter((i) => (i.sets || 0) > 0)
  .map((i) => ({ key: String(i.id), item: i, pcs: i.pcs_per_set || 1, count: i.sets }));

/** "Print stickers?" — the count for each product can be changed before printing. */
export function StickerModal({ grn, onClose, asked }) {
  const { settings } = useSettings();
  const [lines, setLines] = useState(() => stickerLines(grn.items));
  const upd = (key, patch) => setLines((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const total = lines.reduce((s, l) => s + Math.max(0, Math.round(n(l.count))), 0);
  const print = () => {
    const d = stickerDesign(settings);
    const stickers = [];
    for (const l of lines.filter((x) => n(x.count) > 0 && n(x.pcs) > 0)) {
      const one = { code: l.item.code, name: l.item.name, pcs: Math.round(n(l.pcs)), sizes: sizesText(l.item.sizes), cc: stickerCC(l.item, d, settings) };
      for (let k = 0; k < Math.min(Math.round(n(l.count)), 5000); k++) stickers.push(one);
    }
    if (!stickers.length) return;
    onClose();
    printStickers(stickers, d);
  };
  return (
    <Modal title={asked ? `${grn.grn_no} saved — print the stickers?` : `Stickers for ${grn.grn_no}`}
      subtitle="One sticker for each set. Change a count if you need more or fewer."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>{asked ? 'Not now' : 'Cancel'}</button><span className="spacer" />
        <button className="btn btn-primary" disabled={!total} onClick={print} autoFocus><Icon name="print" /> Print {int(total)} sticker{total === 1 ? '' : 's'}</button></>}>
      <table className="table">
        <thead><tr><th>Product</th><th className="right">Pcs on sticker</th><th className="right">Stickers</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key}>
              <td><b>{l.item.code}</b> · {l.item.name}{l.item.sizes ? <span className="muted"> · {sizesText(l.item.sizes)}</span> : null}</td>
              <td className="right" style={{ width: 120 }}><NumInput value={l.pcs} onChange={(v) => upd(l.key, { pcs: v })} /></td>
              <td className="right" style={{ width: 120 }}><NumInput value={l.count} onChange={(v) => upd(l.key, { count: v })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!lines.length && <p className="muted">No sets on this GRN.</p>}
    </Modal>
  );
}

/** Settings → Sticker design: size, layout on the roll, what is printed — with a preview of one row. */
export function StickerDesign({ f, set, SaveBar, settings }) {
  const d = stickerDesign(f);
  const put = (patch) => set('sticker_design')(JSON.stringify({ ...d, ...patch }));
  const num = (k, label, hint, step) => (
    <Field label={label} hint={hint}><NumInput value={d[k]} step={step} onChange={(v) => put({ [k]: v === '' ? '' : Number(v) })} /></Field>
  );
  const tick = (k, label) => (
    <label className="check"><input type="checkbox" checked={!!d[k]} onChange={(e) => put({ [k]: e.target.checked })} /> {label}</label>
  );
  const sample = { code: 'P0016', name: 'Denim Baggy Jeans', pcs: 5, sizes: 'XL, L, M', cc: codeOf(null, 1053, { ...settings, ...f }) };
  const safe = { ...d, w: n(d.w) || 50, h: n(d.h) || 25, cols: Math.max(1, Math.round(n(d.cols)) || 1) };
  const testPrint = () => printStickers(Array.from({ length: safe.cols * 2 }, () => sample), { ...safe, gap: n(d.gap) || 0 });
  return (
    <div className="stack set-form">
      <p className="muted small">One sticker is printed for each set received on a GRN. The printer takes a roll with <b>{safe.cols}</b> sticker{safe.cols === 1 ? '' : 's'} side by side, so each printed row is one page of {safe.cols * safe.w + (safe.cols - 1) * (n(d.gap) || 0)} × {safe.h} mm — set the same paper size on the printer.</p>
      <div className="grid grid-3">
        {num('w', 'Sticker width (mm)')}
        {num('h', 'Sticker height (mm)')}
        <Field label="Stickers in a row"><select className="input" value={d.cols} onChange={(e) => put({ cols: Number(e.target.value) })}>{[1, 2, 3].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
        {num('gap', 'Gap between stickers (mm)')}
        {num('pad', 'Space inside a sticker (mm)')}
        {num('left', 'Move left / right (mm)', 'To line up with the roll: + right, − left')}
        {num('code', 'Product code size (pt)', 'Printed the biggest')}
        {num('name', 'Product name size (pt)')}
        {num('info', 'Cost code, pieces & sizes size (pt)')}
      </div>
      <div className="row gap wrap">
        {tick('show_name', 'Product name')}
        {tick('show_pcs', 'Number of pieces')}
        {tick('show_cc', 'Cost code')}
        {tick('show_sizes', 'Sizes')}
        {tick('border', 'Line round each sticker (for a test on plain paper)')}
      </div>
      <Field label="Cost code on the sticker is of">
        <select className="input" value={d.cc_of} onChange={(e) => put({ cc_of: e.target.value })} style={{ maxWidth: 260 }}>
          <option value="pcs">One piece (as on Stock and New Sale)</option>
          <option value="set">The whole set</option>
        </select>
      </Field>
      <div className="sticker-preview">
        <div className="muted small">Preview — one row of the roll</div>
        <StickerSheet d={{ ...safe, border: true }} stickers={Array.from({ length: safe.cols }, () => sample)} />
      </div>
      <div className="row gap">
        <button type="button" className="btn" onClick={testPrint}><Icon name="print" /> Print a test row</button>
        <button type="button" className="btn btn-ghost" onClick={() => set('sticker_design')(JSON.stringify(STICKER_DEFAULT))}>Back to the standard design</button>
      </div>
      <SaveBar keys={['sticker_design']} />
    </div>
  );
}

/** Manual stickers are handed to the print page through this (it opens in a new tab). */
export const STICKER_PRINT_KEY = 'cargo-sticker-print';

/**
 * Manual sticker printing (Shipments and Stock): type a product code — its name, cost code, pieces and sizes
 * fill in (only what is ticked in Settings → Sticker design) and can be changed — and how many stickers.
 * Add as many rows as needed and print them all at once.
 */
export function ManualStickerModal({ onClose }) {
  const { settings } = useSettings();
  const d = stickerDesign(settings);
  const { data: products } = useApi('/products?active=all');
  const narrow = useNarrow();   // a phone: one card a sticker instead of the table
  const blank = () => ({ key: Date.now() + Math.random(), code: '', name: '', cc: '', pcs: '', sizes: '', count: 1, found: null });
  const [rows, setRows] = useState(() => [blank()]);
  const [openKey, setOpenKey] = useState(null);   // phone: the sticker card that is open (the others are folded); null = the last one
  const upd = (key, patch) => setRows((l) => l.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  // a product code typed in: fill in the rest from the product
  const lookUp = (r, code) => {
    const p = (products || []).find((x) => String(x.code).toLowerCase() === String(code).trim().toLowerCase());
    if (!p) {
      const t = String(code).trim().toLowerCase();   // still typing a code: no warning yet
      return upd(r.key, { code, found: t && !(products || []).some((x) => String(x.code).toLowerCase().startsWith(t)) ? false : null });
    }
    const cc = p.cost_code && d.cc_of !== 'set' ? p.cost_code : stickerCC({ landed_per_pcs_lkr: p.cost_per_pcs || 0, pcs_per_set: p.pcs_per_set }, d, settings);
    upd(r.key, { code: p.code, name: p.name, cc, pcs: p.pcs_per_set || 1, sizes: sizesText(p.sizes), found: true });
  };
  const addRow = () => {
    const row = blank();
    setRows((l) => [...l, row]);
    setOpenKey(row.key);   // phone: the stickers before it fold up
    if (narrow) setTimeout(() => document.querySelector('.msk-card.open')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  };
  const filled = rows.filter((r) => String(r.code).trim() && n(r.count) > 0);
  const total = filled.reduce((t, r) => t + Math.round(n(r.count)), 0);
  const print = () => {
    if (!total) return;
    const stickers = [];
    for (const r of filled) {
      const one = { code: String(r.code).trim(), name: r.name, cc: r.cc, pcs: Math.round(n(r.pcs)), sizes: r.sizes };
      for (let k = 0; k < Math.min(5000, Math.round(n(r.count))); k++) stickers.push(one);
    }
    printStickers(stickers, d);
  };
  const cols = [d.show_name && 'name', d.show_cc && 'cc', d.show_pcs && 'pcs', d.show_sizes && 'sizes'].filter(Boolean);
  const head = { name: 'Product name', cc: 'Cost code', pcs: 'Pieces / set', sizes: 'Sizes' };
  // phone: products matching what is typed in a code box, to tap instead of typing the whole code
  const matches = (r) => {
    const t = String(r.code).trim().toLowerCase();
    if (!t || r.found) return [];
    return (products || []).filter((p) => p.active && (String(p.code).toLowerCase().includes(t) || String(p.name).toLowerCase().includes(t))).slice(0, 5);
  };
  const step = (r, by) => setRows((l) => l.map((x) => (x.key === r.key ? { ...x, count: Math.max(1, Math.round(n(x.count)) + by) } : x)));

  if (narrow) {
    return (
      <Modal size="xl" title="Print stickers" subtitle="Type or tap a product — the rest fills in" onClose={onClose}
        footer={<><button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={!total} onClick={print}><Icon name="print" /> Print {int(total)} sticker{total === 1 ? '' : 's'}</button></>}>
        <div className="msk-list">
          {rows.map((r, idx) => (openKey ?? rows[rows.length - 1].key) !== r.key ? (
            /* folded: one line — tap it to open (and fold the open one) */
            <div key={r.key} className="msk-card folded" role="button" onClick={() => setOpenKey(r.key)}>
              <span className="msk-no">{idx + 1}</span>
              <span className="msk-sum">
                <b>{String(r.code).trim() || 'No product yet'}</b>
                {r.name && <small>{r.name}</small>}
              </span>
              <span className="msk-x">× {int(Math.round(n(r.count)))}</span>
              {rows.length > 1 && <button type="button" className="btn btn-sm btn-icon btn-ghost" title="Remove"
                onClick={(e) => { e.stopPropagation(); setRows((x) => x.filter((y) => y.key !== r.key)); }}><Icon name="trash" size={16} /></button>}
            </div>
          ) : (
            <div key={r.key} className="msk-card open">
              <div className="msk-head">
                <b>Sticker {idx + 1}</b>
                {rows.length > 1 && <button type="button" className="btn btn-sm btn-icon btn-ghost" title="Remove" onClick={() => { setRows((x) => x.filter((y) => y.key !== r.key)); setOpenKey(null); }}><Icon name="trash" size={16} /></button>}
              </div>
              <Field label="Product code">
                <input className="input msk-code" value={r.code} placeholder="e.g. P0016" autoCapitalize="characters" autoComplete="off" enterKeyHint="done"
                  onChange={(e) => lookUp(r, e.target.value)} />
              </Field>
              {matches(r).length > 0 && (
                <div className="msk-hits">
                  {matches(r).map((p) => (
                    <button type="button" key={p.id} onClick={() => lookUp(r, p.code)}><b>{p.code}</b><span>{p.name}</span></button>
                  ))}
                </div>
              )}
              {r.found === false && <div className="sub text-amber">Not a product code — type the rest</div>}
              <div className="msk-grid">
                {cols.includes('name') && <Field label="Product name" className="msk-wide"><input className="input" value={r.name} onChange={(e) => upd(r.key, { name: e.target.value })} /></Field>}
                {cols.includes('cc') && <Field label="Cost code"><input className="input cc-input" value={r.cc} autoCapitalize="characters" onChange={(e) => upd(r.key, { cc: e.target.value.toUpperCase() })} /></Field>}
                {cols.includes('pcs') && <Field label="Pieces / set"><NumInput value={r.pcs} inputMode="numeric" enterKeyHint="done" onChange={(v) => upd(r.key, { pcs: v })} /></Field>}
                {cols.includes('sizes') && <Field label="Sizes" className="msk-wide"><input className="input" value={r.sizes} placeholder="e.g. XL, L, M" onChange={(e) => upd(r.key, { sizes: e.target.value })} /></Field>}
              </div>
              <div className="msk-count">
                <span>Stickers to print</span>
                <div className="msk-step">
                  <button type="button" onClick={() => step(r, -1)} disabled={Math.round(n(r.count)) <= 1} aria-label="One less">−</button>
                  <NumInput value={r.count} inputMode="numeric" enterKeyHint="done" onChange={(v) => upd(r.key, { count: v })} />
                  <button type="button" onClick={() => step(r, 1)} aria-label="One more">+</button>
                </div>
              </div>
              {String(r.code).trim() && (
                <div className="msk-preview">
                  <Sticker d={{ ...d, border: true }} code={String(r.code).trim()} name={r.name} pcs={r.pcs} cc={r.cc} sizes={r.sizes} />
                </div>
              )}
            </div>
          ))}
          <button type="button" className="msk-add" onClick={addRow}><Icon name="plus" size={16} /> Add another sticker</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal size="xl" title="Print stickers" subtitle="Type a product code — the rest fills in and can be changed. Add as many as you need and print them together."
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Close</button><span className="spacer" />
        <button className="btn btn-primary" disabled={!total} onClick={print}><Icon name="print" /> Print {int(total)} sticker{total === 1 ? '' : 's'}</button></>}>
      <datalist id="sticker-codes">{(products || []).filter((p) => p.active).map((p) => <option key={p.id} value={p.code}>{p.name}</option>)}</datalist>
      <table className="table sticker-rows">
        <thead><tr><th>Product code</th>{cols.map((c) => <th key={c} className={c === 'pcs' ? 'right' : ''}>{head[c]}</th>)}<th className="right">Stickers</th><th /></tr></thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={r.key}>
              <td style={{ width: 120 }}>
                <input className="input" list="sticker-codes" value={r.code} placeholder="e.g. P0016" autoFocus={idx === rows.length - 1}
                  onChange={(e) => lookUp(r, e.target.value)} />
                {r.found === false && <div className="sub text-amber">Not a product code — type the rest</div>}
              </td>
              {cols.includes('name') && <td><input className="input" value={r.name} onChange={(e) => upd(r.key, { name: e.target.value })} /></td>}
              {cols.includes('cc') && <td style={{ width: 95 }}><input className="input cc-input" value={r.cc} onChange={(e) => upd(r.key, { cc: e.target.value.toUpperCase() })} /></td>}
              {cols.includes('pcs') && <td style={{ width: 80 }}><NumInput value={r.pcs} onChange={(v) => upd(r.key, { pcs: v })} /></td>}
              {cols.includes('sizes') && <td style={{ width: 140 }}><input className="input" value={r.sizes} onChange={(e) => upd(r.key, { sizes: e.target.value })} /></td>}
              <td style={{ width: 80 }}>
                <NumInput value={r.count} onChange={(v) => upd(r.key, { count: v })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && idx === rows.length - 1) { e.preventDefault(); addRow(); } }} />
              </td>
              <td style={{ width: 40 }}>{rows.length > 1 && <button className="btn btn-sm btn-icon btn-ghost" title="Remove" onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}><Icon name="trash" size={15} /></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row gap mt-s">
        <button type="button" className="btn btn-sm" onClick={addRow}><Icon name="plus" size={14} /> Add another sticker</button>
        <span className="muted small">Enter in the last Stickers box adds a row too.</span>
      </div>
    </Modal>
  );
}
