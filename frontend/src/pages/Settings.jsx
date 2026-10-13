import { useState } from 'react';
import { api, downloadFile, today, lkr, priceRules, autoPrices } from '../lib.js';
import { POS_KEYS } from './POS.jsx';
import { PageHeader, Field, NumInput, Icon, useToast, ThemeSwitch } from '../components/ui.jsx';
import { useSettings } from '../App.jsx';
import CatalogEditor from '../components/CatalogEditor.jsx';

// The settings menu, grouped under headings
const GROUPS = [
  {
    heading: 'Business',
    items: [
      { id: 'shop', icon: 'factory', label: 'Shop details', desc: 'Name, address and phone printed on bills.' },
      { id: 'bills', icon: 'receipt', label: 'Bills & numbering', desc: 'Bill and GRN number prefixes, and the message at the bottom of bills.' },
    ],
  },
  {
    heading: 'Stock & pricing',
    items: [
      { id: 'catalog', icon: 'layers', label: 'Categories & products', desc: 'Everything here feeds the Category, Products and Sizes choices on Receive Goods.' },
      { id: 'price', icon: 'tag', label: 'Price & billing', desc: 'How Receive Goods works out the selling price and MRP from the cost.' },
      { id: 'pricing', icon: 'chart', label: 'Exchange rate', desc: 'How the INR rate is kept up to date.' },
    ],
  },
  {
    heading: 'System',
    items: [
      { id: 'appearance', icon: 'sun', label: 'Appearance', desc: 'Light or dark look for this computer.' },
      { id: 'backup', icon: 'download', label: 'Backup', desc: 'Download a full copy of all your data.' },
      { id: 'shortcuts', icon: 'keyboard', label: 'Keyboard shortcuts', desc: 'Keys that speed up billing and moving around.' },
    ],
  },
];
const ALL = GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.heading })));
const SECTION_KEY = 'cargo-settings-section';

const readSection = () => {
  try { const s = localStorage.getItem(SECTION_KEY); if (ALL.some((i) => i.id === s)) return s; } catch { /* storage unavailable */ }
  return 'shop';
};

export default function Settings() {
  const { settings, reload } = useSettings();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const [section, setSection] = useState(readSection);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));

  const open = (id) => {
    setSection(id);
    try { localStorage.setItem(SECTION_KEY, id); } catch { /* storage unavailable */ }
  };

  // only these keys are saved from here — the exchange rate is looked after by the live-rate service
  const save = async (keys) => {
    try { await api.put('/settings', Object.fromEntries(keys.map((k) => [k, f[k]]))); await reload(); toast('Settings saved'); } catch (e) { toast(e.message, 'error'); }
  };
  const dirty = (keys) => keys.some((k) => String(f[k] ?? '') !== String(settings[k] ?? ''));
  const SaveBar = ({ keys }) => (
    <div className="set-save">
      {dirty(keys) && <span className="muted small">You have unsaved changes</span>}
      <button className="btn btn-primary" disabled={!dirty(keys)} onClick={() => save(keys)}><Icon name="check" /> Save changes</button>
    </div>
  );

  const cur = ALL.find((i) => i.id === section);

  return (
    <div>
      <PageHeader title="Settings" subtitle="Shop details, products, appearance and backups — arranged by section." />
      <div className="set-layout">
        <nav className="set-nav">
          {GROUPS.map((g) => (
            <div key={g.heading} className="set-group">
              <div className="set-group-title">{g.heading}</div>
              {g.items.map((i) => (
                <button key={i.id} type="button" className={`set-link ${section === i.id ? 'on' : ''}`} onClick={() => open(i.id)}>
                  <Icon name={i.icon} size={16} /> <span>{i.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <section className="card set-panel">
          <div className="set-head">
            <div className="set-crumb">{cur.group}</div>
            <h2>{cur.label}</h2>
            <p className="muted">{cur.desc}</p>
          </div>
          <div className="set-body">
            {section === 'shop' && (
              <div className="stack set-form">
                <Field label="Shop name"><input className="input" value={f.shop_name} onChange={set('shop_name')} /></Field>
                <Field label="Address"><input className="input" value={f.shop_address} onChange={set('shop_address')} /></Field>
                <Field label="Phone"><input className="input" value={f.shop_phone} onChange={set('shop_phone')} /></Field>
                <SaveBar keys={['shop_name', 'shop_address', 'shop_phone']} />
              </div>
            )}

            {section === 'bills' && (
              <div className="stack set-form">
                <div className="grid grid-2">
                  <Field label="Bill number prefix" hint="e.g. INV → INV-0001"><input className="input" value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
                  <Field label="GRN number prefix" hint="e.g. GRN → GRN-0001"><input className="input" value={f.grn_prefix} onChange={set('grn_prefix')} /></Field>
                </div>
                <Field label="Message at the bottom of bills"><textarea className="input" value={f.invoice_footer} onChange={set('invoice_footer')} /></Field>
                <SaveBar keys={['invoice_prefix', 'grn_prefix', 'invoice_footer']} />
              </div>
            )}

            {section === 'catalog' && <CatalogEditor />}

            {section === 'price' && (() => {
              const rules = priceRules(f);
              const sample = autoPrices(250, 1, rules);
              return (
                <div className="stack set-form">
                  <div className="grid grid-2">
                    <Field label="Expected selling price = cost +" hint="Added to the cost per piece">
                      <div className="input-affix"><span>+%</span><NumInput value={f.selling_markup_percent} onChange={set('selling_markup_percent')} /></div>
                    </Field>
                    <Field label="MRP = cost +" hint="Added to the cost per piece">
                      <div className="input-affix"><span>+%</span><NumInput value={f.mrp_markup_percent} onChange={set('mrp_markup_percent')} /></div>
                    </Field>
                  </div>
                  <Field label="Round prices up to the nearest" hint="Per piece, e.g. Rs 343 → Rs 350">
                    <select className="input" value={f.price_round_to || '1'} onChange={set('price_round_to')} style={{ maxWidth: 220 }}>
                      {['1', '5', '10', '50', '100'].map((v) => <option key={v} value={v}>Rs {v}</option>)}
                    </select>
                  </Field>
                  {sample && (
                    <div className="price-example">
                      <span>Example: cost <b>{lkr(250)}</b> a piece</span>
                      <span>→ selling price <b>{lkr(sample.expected_per_pcs)}</b></span>
                      <span>→ MRP <b>{lkr(sample.mrp_per_pcs)}</b></span>
                    </div>
                  )}
                  <div className="alert alert-blue small"><Icon name="info" size={16} /> On Receive Goods, the selling price and MRP fill in by themselves from each item's cost. You can still type your own price for any item; it then stays as you typed it.</div>
                  <SaveBar keys={['selling_markup_percent', 'mrp_markup_percent', 'price_round_to']} />
                </div>
              );
            })()}

            {section === 'pricing' && (
              <div className="stack set-form">
                <div className="alert alert-blue small"><Icon name="info" size={16} /> The INR exchange rate is live and updates by itself. To set it by hand, use <b>Edit</b> on the rate bar at the top of the Dashboard.</div>
              </div>
            )}

            {section === 'appearance' && (
              <div className="set-form">
                <p className="muted mb"><b>Light</b> is the default. The choice is saved on this computer.</p>
                <div style={{ maxWidth: 340 }}><ThemeSwitch /></div>
              </div>
            )}

            {section === 'backup' && (
              <div className="set-form">
                <p className="muted mb">Keep a copy on a pen drive or Google Drive every week.</p>
                <button className="btn" onClick={() => downloadFile('/backup', `cargo-pos-backup-${today()}.json`).catch((e) => toast(e.message, 'error'))}>
                  <Icon name="download" /> Download backup (.json)
                </button>
              </div>
            )}

            {section === 'shortcuts' && (
              <div className="stack set-keys">
                <div>
                  <h4 className="set-sub">Anywhere</h4>
                  <dl className="info-list">
                    <dt><kbd>F2</kbd></dt><dd>Dashboard</dd>
                    <dt><kbd>F3</kbd></dt><dd>New Sale (billing)</dd>
                    <dt><kbd>F9</kbd></dt><dd>Sales & Bills</dd>
                    <dt><kbd>F7</kbd></dt><dd>Take a payment (outside billing)</dd>
                    <dt><kbd>Esc</kbd></dt><dd>Close a pop-up</dd>
                  </dl>
                </div>
                <div>
                  <h4 className="set-sub">On the billing screen</h4>
                  <div className="keys-grid">{POS_KEYS.map(([k, l]) => <div key={k} className="key-row"><kbd>{k}</kbd><span>{l}</span></div>)}</div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
