import { useRef, useState } from 'react';
import { api, useApi, niceDateTime } from '../lib.js';
import { Field, Icon, Badge, Loading, useToast } from './ui.jsx';

/*
 * Settings → SMS messages (smslenz.lk): the account, the switches, the wording of each message, a test SMS and the log.
 * The account keys are not typed here — they live in the server's environment (SMSLENZ_USER_ID, SMSLENZ_API_KEY).
 */

// what each {word} becomes, with an example for the preview
const WORDS = {
  shop: ['Shop name', null],
  customer: ['Customer (shop name)', 'Nimal Stores'],
  invoice: ['Bill number', 'INV-00125'],
  invoices: ['Bill numbers', 'INV-00125, INV-00131'],
  amount: ['Amount', 'Rs 45,600.00'],
  paid: ['Paid on the bill', 'Rs 20,000.00'],
  credit: ['On credit', 'Rs 25,600.00'],
  balance: ['Total balance', 'Rs 68,250.00'],
  due_date: ['Due date', '30/10/2026'],
  days: ['When (tomorrow / in 3 days)', 'in 3 days'],
  cheque_no: ['Cheque number', '004512'],
  bank: ['Bank', 'BOC'],
  cheque_date: ['Cheque date', '25/10/2026'],
  supplier: ['Supplier', 'Lanka Textiles'],
  method: ['Paid by', 'bank transfer'],
  for_grn: ['" for your bill …"', ' for your bill B-2291'],
};

const MESSAGES = [
  {
    group: 'Customers', id: 'thanks', title: 'Thank-you after a bill', icon: 'receipt', toggle: 'sms_thanks_on',
    when: 'Sent by itself when a bill is saved for a registered customer with a phone number. Walk-in bills and returns get none.',
    texts: [
      { key: 'sms_thanks_cash', label: 'Cash bill', words: ['shop', 'customer', 'invoice', 'amount'] },
      { key: 'sms_thanks_cash_due', label: 'Cash bill — the customer still owes on older bills', words: ['shop', 'customer', 'invoice', 'amount', 'balance'] },
      { key: 'sms_thanks_credit', label: 'Credit bill', words: ['shop', 'customer', 'invoice', 'amount', 'paid', 'credit', 'due_date', 'balance'] },
    ],
  },
  {
    group: 'Customers', id: 'due', title: 'Payment due reminder', icon: 'clock', toggle: 'sms_due_on', due: true,
    when: 'Sent every morning on the days before a credit bill is due — one SMS a customer a day, listing every bill due in those days.',
    texts: [{ key: 'sms_due_text', label: 'Reminder', words: ['shop', 'customer', 'amount', 'invoices', 'days', 'due_date', 'balance'] }],
  },
  {
    group: 'Customers', id: 'cheque', title: 'Returned cheque', icon: 'cheque',
    when: 'Sent with the "Send message to inform" button on a returned cheque (Cheque Desk → Returned). Never sent by itself.',
    texts: [{ key: 'sms_cheque_text', label: 'Message', words: ['shop', 'customer', 'cheque_no', 'bank', 'amount', 'cheque_date', 'balance'] }],
  },
  {
    group: 'Local suppliers', id: 'sup_pay', title: 'Payment made', icon: 'cash', toggle: 'sms_sup_pay_on',
    when: 'Sent by itself when you pay a local supplier (cash, bank transfer, online) from the supplier\'s page or the Payment Portal.',
    texts: [{ key: 'sms_sup_pay_text', label: 'Message', words: ['shop', 'supplier', 'amount', 'method', 'for_grn'] }],
  },
  {
    group: 'Local suppliers', id: 'sup_cheque', title: 'Cheque issued', icon: 'cheque', toggle: 'sms_sup_cheque_on',
    when: 'Sent by itself for each cheque you give a local supplier.',
    texts: [{ key: 'sms_sup_cheque_text', label: 'Message', words: ['shop', 'supplier', 'cheque_no', 'bank', 'amount', 'cheque_date', 'for_grn'] }],
  },
];
export const SMS_SETTING_KEYS = ['sms_enabled', 'sms_sender_id', 'sms_due_days', 'sms_due_hour',
  ...MESSAGES.flatMap((m) => [m.toggle, ...m.texts.map((t) => t.key)]).filter(Boolean)];

const KIND = { thanks: 'Thank-you', due: 'Due reminder', cheque: 'Returned cheque', sup_pay: 'Supplier payment', sup_cheque: 'Supplier cheque', test: 'Test' };

/** How many SMS a message takes: 160 letters (70 in Sinhala / Tamil), 153 / 67 a part when longer. */
export function smsParts(text) {
  const unicode = /[^\x00-\x7F£€¥èéùìòÇØøÅå]/.test(text);
  const len = text.length;
  const [one, part] = unicode ? [70, 67] : [160, 153];
  return { len, unicode, parts: len === 0 ? 0 : len <= one ? 1 : Math.ceil(len / part) };
}
const preview = (text, shop) => String(text || '').replace(/\{(\w+)\}/g, (_, k) => (k === 'shop' ? shop || 'Your shop' : WORDS[k]?.[1] ?? '')).replace(/\s{2,}/g, ' ').trim();

function Switch({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`sms-switch ${on ? 'on' : ''}`} onClick={() => onChange(on ? '0' : '1')}>
      <span className="sms-knob" /> <span>{label ?? (on ? 'On' : 'Off')}</span>
    </button>
  );
}

function Template({ t, value, onChange, shop }) {
  const ref = useRef(null);
  const insert = (w) => {
    const el = ref.current;
    const v = String(value || '');
    const at = el && document.activeElement === el ? el.selectionStart : v.length;
    const next = `${v.slice(0, at)}{${w}}${v.slice(el && document.activeElement === el ? el.selectionEnd : at)}`;
    onChange(next);
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + w.length + 2; } });
  };
  const shown = preview(value, shop);
  const p = smsParts(shown);
  return (
    <div className="sms-tpl">
      <div className="sms-tpl-head"><b>{t.label}</b><span className={`small ${p.parts > 2 ? 'text-amber' : 'muted'}`}>{p.len} letters · {p.parts} SMS{p.unicode ? ' (Sinhala / Tamil)' : ''}</span></div>
      <textarea ref={ref} className="input" rows={3} value={value || ''} onChange={(e) => onChange(e.target.value)} />
      <div className="sms-words">
        {t.words.map((w) => <button key={w} type="button" className="sms-word" title={WORDS[w][0]} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(w)}>{`{${w}}`}</button>)}
      </div>
      <div className="sms-preview"><Icon name="phone" size={14} /> <span>{shown || <i className="muted">Empty — nothing will be sent</i>}</span></div>
    </div>
  );
}

export default function SmsSettings({ f, set, SaveBar, settings }) {
  const toast = useToast();
  const status = useApi('/sms/status');
  const [logV, setLogV] = useState(0);
  const log = useApi(`/sms/log?limit=50&v=${logV}`);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState('');
  const st = status.data;
  const on = (k) => String(f[k] ?? '') === '1';

  const test = async () => {
    setBusy('test');
    try { const r = await api.post('/sms/test', { phone }); toast(`Test SMS sent to ${r.to}`); status.reload(); } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(''); setLogV((v) => v + 1); }
  };
  const dueNow = async () => {
    setBusy('due');
    try { const r = await api.post('/sms/due-now'); toast(r.skipped === 'off' ? 'Due reminders are off (or the SMS keys are not set)' : `${r.sent} reminder${r.sent === 1 ? '' : 's'} sent${r.failed ? `, ${r.failed} failed` : ''}`); } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(''); setLogV((v) => v + 1); }
  };

  return (
    <div className="stack set-form sms-set">
      <div className="sms-account">
        {status.loading && !st ? <Loading text="Checking the SMS account…" /> : !st?.ready ? (
          <div className="alert alert-amber small"><Icon name="alert" size={16} />
            <span>The SMS account is not connected yet. Add <b>SMSLENZ_USER_ID</b> and <b>SMSLENZ_API_KEY</b> (from smslenz.lk → API) in Vercel → Settings → Environment Variables, then redeploy. Messages can be arranged here meanwhile.</span></div>
        ) : st.error ? (
          <div className="alert alert-red small"><Icon name="alert" size={16} /> <span>SMS account: {st.error}</span></div>
        ) : (
          <div className="sms-acc-grid">
            <div><span>Account</span><b className={st.status === 'active' ? 'text-green' : 'text-amber'}>{st.status || '—'}</b></div>
            <div><span>Credit left</span><b>Rs {st.balance ?? '—'}</b></div>
            <div><span>Plan</span><b>{st.plan || '—'}</b></div>
            <div><span>Sender IDs</span><b>{st.senders?.length ? st.senders.join(', ') : '—'}</b></div>
          </div>
        )}
      </div>

      <div className="grid grid-2">
        <Field label="Send SMS" hint="The main switch — when off, nothing is sent by itself.">
          <Switch on={on('sms_enabled')} onChange={set('sms_enabled')} label={on('sms_enabled') ? 'On — messages are sent' : 'Off — nothing is sent'} />
        </Field>
        <Field label="Sender ID" hint={`The name customers see (approved on smslenz.lk, up to 11 letters). Empty: ${st?.sender_env || 'SMSlenzDEMO'}.`}>
          <input className="input" maxLength={11} value={f.sms_sender_id || ''} placeholder={st?.sender_env || 'SMSlenzDEMO'} onChange={set('sms_sender_id')} />
        </Field>
      </div>

      {['Customers', 'Local suppliers'].map((g) => (
        <div key={g} className="stack">
          <h4 className="set-sub">{g}</h4>
          {MESSAGES.filter((m) => m.group === g).map((m) => (
            <div key={m.id} className={`sms-card ${m.toggle && !on(m.toggle) ? 'off' : ''}`}>
              <div className="sms-card-head">
                <span className="sms-card-icon"><Icon name={m.icon} size={16} /></span>
                <div className="grow"><b>{m.title}</b><p className="muted small">{m.when}</p></div>
                {m.toggle ? <Switch on={on(m.toggle)} onChange={set(m.toggle)} /> : <Badge tone="blue">Button</Badge>}
              </div>
              {m.due && (
                <div className="grid grid-3 sms-due">
                  <Field label="Start reminding" hint="Days before the due date, one SMS each day">
                    <select className="input" value={f.sms_due_days || '3'} onChange={set('sms_due_days')}>
                      {[1, 2, 3, 4, 5, 7].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'} before</option>)}
                    </select>
                  </Field>
                  <Field label="Every morning at" hint="Sri Lanka time">
                    <select className="input" value={f.sms_due_hour || '10'} onChange={set('sms_due_hour')}>
                      {[8, 9, 10, 11, 12].map((h) => <option key={h} value={h}>{h === 12 ? '12:00 PM' : `${h}:00 AM`}</option>)}
                    </select>
                  </Field>
                  <Field label="Today's reminders">
                    <button type="button" className="btn" disabled={busy === 'due' || !st?.ready} onClick={dueNow}><Icon name="bell" size={15} /> {busy === 'due' ? 'Sending…' : 'Send now'}</button>
                  </Field>
                </div>
              )}
              {m.texts.map((t) => <Template key={t.key} t={t} value={f[t.key]} onChange={set(t.key)} shop={f.shop_name || settings.shop_name} />)}
            </div>
          ))}
        </div>
      ))}

      <SaveBar keys={SMS_SETTING_KEYS} />

      <div className="stack">
        <h4 className="set-sub">Send a test SMS</h4>
        <div className="sms-test">
          <input className="input" inputMode="tel" placeholder="Mobile number, e.g. 077 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={busy === 'test' || !phone.trim() || !st?.ready} onClick={test}><Icon name="phone" size={15} /> {busy === 'test' ? 'Sending…' : 'Send test'}</button>
        </div>
      </div>

      <div className="stack">
        <div className="sms-log-head"><h4 className="set-sub">Sent messages</h4><button type="button" className="btn btn-sm btn-ghost" onClick={() => setLogV((v) => v + 1)}><Icon name="refresh" size={14} /> Refresh</button></div>
        {log.loading && !log.data ? <Loading /> : !log.data?.length ? <p className="muted small">No SMS sent yet.</p> : (
          <div className="sms-log">
            {log.data.map((x) => (
              <div key={x.id} className={`sms-log-row ${x.ok ? '' : 'bad'}`}>
                <div className="sms-log-top">
                  <Badge tone={x.ok ? 'green' : 'red'}>{x.ok ? 'Sent' : 'Failed'}</Badge>
                  <b>{KIND[x.kind] || x.kind}</b>
                  <span className="muted small">{x.name ? `${x.name} · ` : ''}{x.to}{x.ref ? ` · ${x.ref}` : ''}</span>
                  <span className="spacer" />
                  <span className="muted small nowrap">{niceDateTime(x.at)}{x.by && x.by !== 'System' ? ` · ${x.by}` : ''}</span>
                </div>
                <div className="sms-log-msg">{x.message}</div>
                {x.error && <div className="small text-red">{x.error}</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
