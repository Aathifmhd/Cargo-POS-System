import { useState } from 'react';
import { api, downloadFile, today } from '../lib.js';
import { POS_KEYS } from './POS.jsx';
import { PageHeader, Card, Field, NumInput, Icon, useToast, ThemeSwitch } from '../components/ui.jsx';
import { useSettings } from '../App.jsx';

export default function Settings() {
  const { settings, reload } = useSettings();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? v.target.value : v }));

  const save = async () => {
    // only the fields on this page — the exchange rate is looked after by the live-rate service
    const keys = ['shop_name', 'shop_address', 'shop_phone', 'invoice_footer', 'default_markup_percent', 'grn_prefix', 'invoice_prefix'];
    try { await api.put('/settings', Object.fromEntries(keys.map((k) => [k, f[k]]))); await reload(); toast('Settings saved'); } catch (e) { toast(e.message, 'error'); }
  };

  return (
    <div>
      <PageHeader title="Settings" subtitle="Shop details printed on bills, and default values."
        actions={<button className="btn btn-primary" onClick={save}><Icon name="check" /> Save settings</button>} />
      <div className="grid grid-2">
        <Card title="Shop details">
          <div className="stack">
            <Field label="Shop name"><input className="input" value={f.shop_name} onChange={set('shop_name')} /></Field>
            <Field label="Address"><input className="input" value={f.shop_address} onChange={set('shop_address')} /></Field>
            <Field label="Phone"><input className="input" value={f.shop_phone} onChange={set('shop_phone')} /></Field>
            <Field label="Message at the bottom of bills"><textarea className="input" value={f.invoice_footer} onChange={set('invoice_footer')} /></Field>
          </div>
        </Card>
        <div className="stack">
          <Card title="Defaults">
            <div className="stack">
              <div className="alert alert-blue small"><Icon name="info" size={16} /> The INR exchange rate is live and updates by itself. To set it by hand, use <b>Edit</b> on the rate bar at the top of the Dashboard.</div>
              <Field label="Default markup on landed cost (%)" hint="Used by 'Quick pricing' on the GRN screen">
                <NumInput value={f.default_markup_percent} onChange={set('default_markup_percent')} />
              </Field>
              <div className="grid grid-2">
                <Field label="GRN number prefix"><input className="input" value={f.grn_prefix} onChange={set('grn_prefix')} /></Field>
                <Field label="Bill number prefix"><input className="input" value={f.invoice_prefix} onChange={set('invoice_prefix')} /></Field>
              </div>
            </div>
          </Card>
          <Card title="Appearance">
            <p className="muted mb">Choose how the system looks. <b>Light</b> is the default. The choice is saved on this computer.</p>
            <div style={{ maxWidth: 340 }}><ThemeSwitch /></div>
          </Card>
          <Card title="Backup">
            <p className="muted mb">Download a full copy of all your data. Keep it on a pen drive or Google Drive every week.</p>
            <button className="btn" onClick={() => downloadFile('/backup', `cargo-pos-backup-${today()}.json`).catch((e) => toast(e.message, 'error'))}>
              <Icon name="download" /> Download backup (.json)
            </button>
          </Card>
          <Card title="Keyboard shortcuts">
            <dl className="info-list">
              <dt><kbd>F2</kbd></dt><dd>Dashboard</dd>
              <dt><kbd>F3</kbd></dt><dd>New Sale (billing)</dd>
              <dt><kbd>F9</kbd></dt><dd>Sales & Bills</dd>
              <dt><kbd>F7</kbd></dt><dd>Take a payment (outside billing)</dd>
              <dt><kbd>Esc</kbd></dt><dd>Close a pop-up</dd>
            </dl>
            <p className="muted small mt-s mb">On the billing screen:</p>
            <div className="keys-grid">{POS_KEYS.map(([k, l]) => <div key={k} className="key-row"><kbd>{k}</kbd><span>{l}</span></div>)}</div>
          </Card>
        </div>
      </div>
    </div>
  );
}
