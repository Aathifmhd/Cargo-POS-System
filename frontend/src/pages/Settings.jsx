import { useState } from 'react';
import { api, downloadFile, today, lkr, priceRules, autoPrices, niceDateTime, costCode, costDecode, isSuper, isAdmin } from '../lib.js';
import { POS_KEYS } from './POS.jsx';
import { PageHeader, Field, NumInput, Icon, useToast, ThemeSwitch } from '../components/ui.jsx';
import { useSettings, useAuth } from '../App.jsx';
import CatalogEditor from '../components/CatalogEditor.jsx';
import DownloadReports from '../components/DownloadReports.jsx';
import StockTake from '../components/StockTake.jsx';
import { Rules as ApprovalRules } from './Users.jsx';
import { StickerDesign } from '../components/Stickers.jsx';

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
      { id: 'price', icon: 'tag', label: 'Price & billing', desc: 'How Receive Goods works out the expected selling price from the cost.' },
      { id: 'stickers', icon: 'tag', label: 'Sticker design', desc: 'The sticker for each set: product code, name, pieces and cost code — size and how they sit on the roll.' },
      { id: 'costcode', icon: 'lock', label: 'Cost code', desc: 'The letters that hide the cost on the Stock list and New Sale — the code is of the cost + Rs 300.' },
      { id: 'pricing', icon: 'chart', label: 'Exchange rate', desc: 'The fixed rate all costs use, and the live INR rate for reference.' },
      { id: 'stocktake', icon: 'box', super: true, label: 'Stock Take', desc: 'Count all the stock (once a year) and put the system right — short and extra pieces, with their value.' },
    ],
  },
  {
    heading: 'System',
    items: [
      { id: 'appearance', icon: 'sun', staff: true, label: 'Appearance', desc: 'Light or dark look for this computer.' },
      { id: 'reports', icon: 'chart', label: 'Download reports', desc: 'Excel sheets of GRNs, stock, invoices, customers, suppliers, payments and dues — for a time period.' },
      { id: 'backup', icon: 'download', label: 'Backup', desc: 'Download a full copy of all your data.' },
      { id: 'shortcuts', icon: 'keyboard', staff: true, label: 'Keyboard shortcuts', desc: 'Keys that speed up billing and moving around.' },
      { id: 'approvals', icon: 'crown', staff: true, label: 'Super admin approvals', desc: 'What only the Super Admin can open, and what needs the Super Admin\'s (or an Admin\'s) password.' },
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
  const me = useAuth().user;
  const superAdmin = isSuper(me);   // Stock Take (and Start Fresh): the Super Admin's only
  // Cashier, KP, Employee: Appearance, Keyboard shortcuts and Super admin approvals only
  const visible = (i) => (i.super ? superAdmin : isAdmin(me) || i.staff);
  const [sectionPicked, setSection] = useState(readSection);
  const section = ALL.some((i) => i.id === sectionPicked && visible(i)) ? sectionPicked : ALL.find(visible).id;
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
          {GROUPS.filter((g) => g.items.some(visible)).map((g) => (
            <div key={g.heading} className="set-group">
              <div className="set-group-title">{g.heading}</div>
              {g.items.filter(visible).map((i) => (
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

            {section === 'stickers' && <StickerDesign f={f} set={set} SaveBar={SaveBar} settings={settings} />}
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
                    </div>
                  )}
                  <div className="alert alert-blue small"><Icon name="info" size={16} /> On Receive Goods, the expected selling price fills in by itself from each item's cost. You can still type your own price for any item; it then stays as you typed it.</div>
                  <SaveBar keys={['selling_markup_percent', 'price_round_to']} />
                </div>
              );
            })()}

            {section === 'pricing' && (
              <div className="stack set-form">
                <Field label="Costing rate (Rs for ₹1)" hint="Every cost uses this rate: GRNs, cost per piece, supplier payments. Changing it re-costs all GRNs and stock.">
                  <div className="input-affix"><span>Rs</span><NumInput value={f.costing_rate} onChange={set('costing_rate')} /></div>
                </Field>
                <div className="alert alert-blue small"><Icon name="info" size={16} /> The <b>live INR rate</b> on the Dashboard keeps updating by itself, for reference only. It never changes your costs.</div>
                <SaveBar keys={['costing_rate']} />
              </div>
            )}

            {section === 'appearance' && (
              <div className="set-form">
                <p className="muted mb"><b>Light</b> is the default. The choice is saved on this computer.</p>
                <div style={{ maxWidth: 340 }}><ThemeSwitch /></div>
              </div>
            )}

            {section === 'reports' && <DownloadReports />}
            {section === 'stocktake' && superAdmin && <StockTake />}

            {section === 'approvals' && <ApprovalRules />}

            {section === 'costcode' && <CostCode f={f} set={set} SaveBar={SaveBar} />}

            {section === 'backup' && (
              <div className="set-form">
                <p className="muted mb">Keep a copy on a pen drive or Google Drive every week. A reminder pops up at the start of every month until that month's backup is downloaded.</p>
                <p className="small mb">{settings.last_backup_at ? <>Last backup: <b>{niceDateTime(settings.last_backup_at)}</b>{settings.last_backup_by ? ` by ${settings.last_backup_by}` : ''}</> : <span className="text-amber">No backup downloaded yet.</span>}</p>
                <button className="btn" onClick={() => downloadFile('/backup', `cargo-pos-backup-${today()}.json`).then(reload).catch((e) => toast(e.message, 'error'))}>
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

/** Settings → Cost code: the code word, the repeat letter, the amount added — with the letters, a try-out and a check. */
function CostCode({ f, set, SaveBar }) {
  const [tryCost, setTryCost] = useState('1053');
  const [check, setCheck] = useState('');
  const word = String(f.cost_code_word || '').toUpperCase();
  const rep = String(f.cost_code_repeat || '').toUpperCase();
  const add = Number(f.cost_code_add ?? 300) || 0;
  const problem = word.replace(/[^A-Z]/g, '').length !== 10 || new Set(word).size !== 10 ? 'The code word needs ten different letters.'
    : rep.length !== 1 ? 'The repeat letter is one letter.' : word.includes(rep) ? `The repeat letter "${rep}" can't be one of the code word's letters.` : '';
  const decoded = check ? costDecode(check, f) : null;
  return (
    <div className="stack set-form">
      <p className="muted small">The ten letters stand for <b>1 to 9 and then 0</b>. A digit that repeats the one before it is written as the <b>repeat letter</b>, and the run starts again. Every product is coded at its <b>cost per piece + Rs {add}</b> — the real cost shown on the Stock list and New Sale stays as it is.</p>
      <div className="grid grid-3">
        <Field label="Code word (ten different letters)"><input className="input cc-input" value={f.cost_code_word || ''} maxLength={10} onChange={(e) => set('cost_code_word')(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></Field>
        <Field label="Repeat letter"><input className="input cc-input" value={f.cost_code_repeat || ''} maxLength={1} onChange={(e) => set('cost_code_repeat')(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} /></Field>
        <Field label="Code the cost + (Rs)" hint="Added to the cost per piece before coding"><NumInput value={f.cost_code_add} onChange={set('cost_code_add')} /></Field>
      </div>
      {problem && <div className="alert alert-red small"><Icon name="alert" size={16} /> {problem}</div>}
      <div className="cc-map">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((d) => <div key={d}><span>{d}</span><b>{word[(d + 9) % 10] || '?'}</b></div>)}
        <div className="rep"><span>repeat</span><b>{rep || '?'}</b></div>
      </div>
      <div className="grid grid-3">
        <Field label="Try it — a cost per piece (Rs)"><NumInput value={tryCost} onChange={setTryCost} /></Field>
        <Field label={`Reads as (Rs ${Math.round(Number(tryCost) || 0) + add})`}><div className="cc-big">{problem ? '—' : costCode(tryCost, f)}</div></Field>
        <Field label="Check a code" hint={check ? (decoded == null ? 'Not a code' : `= Rs ${decoded.toLocaleString()} → cost Rs ${(decoded - add).toLocaleString()}`) : 'Type a code to read it back'}>
          <input className="input cc-input" value={check} onChange={(e) => setCheck(e.target.value.toUpperCase())} placeholder="e.g. KSBH" />
        </Field>
      </div>
      <SaveBar keys={['cost_code_word', 'cost_code_repeat', 'cost_code_add']} />
    </div>
  );
}
