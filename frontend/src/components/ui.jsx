import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyTheme, getThemePref } from '../lib.js';

/* ================= ICONS ================= */
const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  cart: <><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /><path d="M2 3h3l2.6 12.2a2 2 0 0 0 2 1.6h8.6a2 2 0 0 0 2-1.5L22 7H6" /></>,
  receipt: <><path d="M5 2h14v20l-2.5-1.5L14 22l-2-1.5-2 1.5-2.5-1.5L5 22z" /><path d="M9 7h6M9 11h6M9 15h4" /></>,
  truck: <><path d="M1 4h14v12H1zM15 9h4l4 4v3h-8z" /><circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="18.5" r="2" /></>,
  box: <><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z" /><path d="M3.3 7 12 12l8.7-5M12 22V12" /></>,
  users: <><circle cx="9" cy="7" r="4" /><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.6" /></>,
  factory: <><path d="M2 20V9l6 4V9l6 4V4h4l2 16z" /><path d="M2 20h20M7 17h2M13 17h2" /></>,
  wallet: <><path d="M20 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /><path d="M3 7h17a1 1 0 0 1 1 1v4h-5a2 2 0 0 0 0 4h5" /></>,
  chart: <><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  trash: <><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>,
  print: <><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v8H6z" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  eye: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.2 3.2M1 1l22 22" /><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  alert: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />,
  cash: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>,
  calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></>,
  bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  cheque: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 14.5h6M15 14.5h3M6 10h3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  tag: <><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" /><circle cx="7" cy="7" r="1.5" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5M12 15V3" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5M12 3v12" /></>,
  layers: <><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
  arrowRight: <path d="M5 12h14M12 5l7 7-7 7" />,
  arrowDown: <path d="M12 5v14M5 12l7 7 7-7" />,
  camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></>,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
  keyboard: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8" /></>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  crown: <><path d="M2.5 7.5 7 11l5-7 5 7 4.5-3.5L19.5 18h-15z" /><path d="M5 21h14" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  monitor: <><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  adjust: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" /></>,
};

export function Icon({ name, size = 18, className = '', strokeWidth = 2 }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name] || ICONS.info}
    </svg>
  );
}

/* ================= TOASTS ================= */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 5000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'error' ? 'alert' : 'check'} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ================= LAYOUT BITS ================= */
export function PageHeader({ title, subtitle, actions, back }) {
  const navigate = useNavigate();
  return (
    <div className="page-header">
      <div className="page-title">
        {back && (
          <button className="btn btn-icon btn-ghost" onClick={() => (typeof back === 'function' ? back() : typeof back === 'string' ? navigate(back) : navigate(-1))} title="Back">
            <Icon name="back" />
          </button>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '', pad = true }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="row gap-s">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-body' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone = 'default', icon, onClick }) {
  return (
    <div className={`stat stat-${tone} ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      {icon && <div className="stat-icon"><Icon name={icon} size={20} /></div>}
      <div className="stat-text">
        <div className="stat-label">{label}</div>
        <div className="stat-value">{value}</div>
        {sub && <div className="stat-sub">{sub}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone = 'grey', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Low / medium / high cost badge for a stock batch (see costTiers in lib.js). */
export function CostBadge({ tier }) {
  if (!tier) return null;
  return <span className={`cost-badge cost-${tier}`}>{tier === 'low' ? 'Low cost' : tier === 'medium' ? 'Medium cost' : 'High cost'}</span>;
}

const STATUS = {
  paid: ['green', 'Paid'],
  overdue: ['red', 'Overdue'],
  'due-soon': ['amber', 'Due soon'],
  open: ['blue', 'Not due yet'],
  void: ['grey', 'Cancelled'],
};
/** A user's role as a badge: Super Admin (with a crown), Admin or Cashier. */
export function RoleBadge({ role }) {
  if (!role) return null;
  const label = { superadmin: 'Super Admin', admin: 'Admin', cashier: 'Cashier', kp: 'KP', employee: 'Employee' }[role] || role;
  return (
    <span className={`role-badge role-${role}`}>
      <Icon name={role === 'superadmin' ? 'crown' : role === 'admin' ? 'shield' : 'users'} size={13} /> {label}
    </span>
  );
}

export function StatusBadge({ status }) {
  const [tone, label] = STATUS[status] || ['grey', status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function Empty({ icon = 'box', title, text, action }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={28} /></div>
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {action}
    </div>
  );
}

export function Loading({ text = 'Loading…' }) {
  return <div className="loading"><span className="spinner" /> {text}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="alert alert-red">
      <Icon name="alert" />
      <span>{error}</span>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/* ================= FORM BITS ================= */
export function Field({ label, hint, children, className = '', required }) {
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}{required && <b className="req">*</b>}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Segmented({ options, value, onChange, size = '' }) {
  return (
    <div className={`segmented ${size}`}>
      {options.map((o) => (
        <button type="button" key={o.value} className={value === o.value ? `active ${o.tone || ''}` : ''} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />} {o.label}
        </button>
      ))}
    </div>
  );
}

/** Number input that selects its content on focus (fast data entry). */
/**
 * A number box. One click selects the whole number, ready to type over.
 * `money`: a price — shown with two decimals (350 → 350.00) except while you type in it.
 */
export function NumInput({ value, onChange, className = '', money = false, ...rest }) {
  const [typing, setTyping] = useState(false);
  const fresh = useRef(false);   // focused by this click: keep the whole number selected when the mouse comes up
  const shown = money && !typing && value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : value ?? '';
  return (
    <input type="number" inputMode="decimal" step="any" className={`input num ${className}`} value={shown}
      onFocus={(e) => { fresh.current = true; const el = e.target; el.select(); setTimeout(() => document.activeElement === el && el.select(), 0); }}
      onMouseUp={(e) => { if (fresh.current) { e.preventDefault(); fresh.current = false; } }}
      onBlur={() => { setTyping(false); fresh.current = false; }} onWheel={(e) => e.target.blur()}
      onChange={(e) => { setTyping(true); onChange(e.target.value); }} {...rest} />
  );
}

/* ================= DATE (always DD/MM/YYYY) ================= */
const isoToText = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v.slice(8, 10)}/${v.slice(5, 7)}/${v.slice(0, 4)}` : '');
/** "31/12/2026" → "2026-12-31", or null when it is not a real date. */
function textToIso(t) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return d.getFullYear() === Number(yyyy) && d.getMonth() === Number(mm) - 1 && d.getDate() === Number(dd) ? `${yyyy}-${mm}-${dd}` : null;
}
/**
 * A date box that always reads DD/MM/YYYY (the browser's own date box follows the computer's region, e.g. MM/DD/YYYY).
 * Type the digits (the slashes go in by themselves) or use the calendar button. The value stays 'YYYY-MM-DD', and
 * onChange gets an event-like { target: { value } }, like a normal date input.
 */
export function DateInput({ value, onChange, className = '', style, min, max, disabled, ...rest }) {
  const [text, setText] = useState(isoToText(value));
  const [typing, setTyping] = useState(false);
  const picker = useRef();
  useEffect(() => { if (!typing) setText(isoToText(value)); }, [value, typing]);
  const send = (v) => onChange?.({ target: { value: v, type: 'date' } });
  const type = (raw) => {
    // only the digits count: the slashes go back in by themselves (backspace over a slash removes the digit before it)
    let d = raw.replace(/\D/g, '');
    if (raw.length < text.length && d === text.replace(/\D/g, '')) d = d.slice(0, -1);
    d = d.slice(0, 8);
    const t = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
    setText(t);
    if (!t) return send('');
    const iso = textToIso(t);
    if (iso) send(iso);
  };
  const bad = text && text.length === 10 && !textToIso(text);
  return (
    <span className={`date-input ${className}`} style={style}>
      <input className={`input ${bad ? 'bad' : ''}`} inputMode="numeric" placeholder="DD/MM/YYYY" value={text} disabled={disabled} maxLength={10}
        onFocus={(e) => { setTyping(true); e.target.select(); }} onBlur={() => { setTyping(false); setText(isoToText(value)); }}
        onChange={(e) => type(e.target.value)} {...rest} />
      <button type="button" className="date-input-btn" tabIndex={-1} disabled={disabled} title="Pick from the calendar"
        onClick={() => { try { picker.current.showPicker(); } catch { picker.current.focus(); } }}>
        <Icon name="calendar" size={15} />
      </button>
      <input ref={picker} type="date" className="date-input-native" tabIndex={-1} aria-hidden="true" value={value || ''} min={min} max={max}
        onChange={(e) => send(e.target.value)} />
    </span>
  );
}

/* ================= MODAL ================= */
export function Modal({ title, subtitle, onClose, children, footer, size = 'md' }) {
  const ref = useRef();
  useEffect(() => {
    // Esc closes only the top-most pop-up (e.g. the approval box over a form)
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const all = document.querySelectorAll('.modal');
      if (all[all.length - 1] === ref.current) onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} className={`modal modal-${size}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </div>
          <button className="btn btn-icon btn-ghost" onClick={onClose} title="Close (Esc)"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ================= COMBOBOX (search + pick) ================= */
export function Combobox({
  items, value, onSelect, getLabel = (i) => i.name, getSub, placeholder = 'Search…',
  onCreate, createLabel = (q) => `Add “${q}”`, filterKeys, autoFocus, inputRef, onQueryChange, query: controlledQuery,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const boxRef = useRef();
  const q = controlledQuery ?? query;

  const selected = items.find((i) => i.id === value);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items.slice(0, 50);
    return items.filter((i) => (filterKeys ? filterKeys(i) : getLabel(i)).toLowerCase().includes(s)).slice(0, 50);
  }, [items, q, filterKeys, getLabel]);

  useEffect(() => {
    const close = (e) => boxRef.current && !boxRef.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const setQ = (v) => { onQueryChange ? onQueryChange(v) : setQuery(v); };
  const pick = (item) => { onSelect(item); setQ(''); setOpen(false); };
  const canCreate = onCreate && q.trim() && !results.some((r) => getLabel(r).toLowerCase() === q.trim().toLowerCase());
  const total = results.length + (canCreate ? 1 : 0);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, total - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter' && open) {
      e.preventDefault();
      if (hi < results.length) results[hi] && pick(results[hi]);
      else if (canCreate) { onCreate(q.trim()); setQ(''); setOpen(false); }
    } else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="combo" ref={boxRef}>
      <div className="combo-input">
        <Icon name="search" size={16} />
        <input
          ref={inputRef}
          className="input"
          autoFocus={autoFocus}
          placeholder={selected && !open ? getLabel(selected) : placeholder}
          value={open ? q : selected ? getLabel(selected) : q}
          onFocus={() => { setOpen(true); setHi(0); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
          onKeyDown={onKey}
        />
      </div>
      {open && total > 0 && (
        <div className="combo-list">
          {results.map((r, i) => (
            <button type="button" key={r.id} className={`combo-item ${i === hi ? 'hi' : ''} ${r.id === value ? 'sel' : ''}`}
              onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
              <span className="combo-main">{getLabel(r)}</span>
              {getSub && <span className="combo-sub">{getSub(r)}</span>}
            </button>
          ))}
          {canCreate && (
            <button type="button" className={`combo-item combo-create ${hi === results.length ? 'hi' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onCreate(q.trim()); setQ(''); setOpen(false); }}>
              <Icon name="plus" size={16} /> {createLabel(q.trim())}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= THEME SWITCH ================= */
export function ThemeSwitch() {
  const [pref, setPref] = useState(getThemePref);
  useEffect(() => {
    const on = (e) => setPref(e.detail);
    window.addEventListener('cargo-pos-theme', on);
    return () => window.removeEventListener('cargo-pos-theme', on);
  }, []);
  const opts = [['light', 'sun', 'Light'], ['dark', 'moon', 'Dark']];
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {opts.map(([v, icon, label]) => (
        <button key={v} type="button" role="radio" aria-checked={pref === v} className={pref === v ? 'on' : ''}
          title={`${label} theme`} onClick={() => applyTheme(v)}>
          <Icon name={icon} size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

/* ================= TABS ================= */
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} className={value === t.value ? 'active' : ''} onClick={() => onChange(t.value)}>
          {t.label}{t.count != null && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Keys for a list in a pop-up: ↑ ↓ move the highlight, Enter picks it, Delete removes it (when onDelete is given).
 * Returns [highlighted index, set it] — set it on mouse-over too, so the mouse and the keys agree.
 */
export function useListKeys(count, { onEnter, onDelete } = {}) {
  const [hi, setHi] = useState(0);
  const ref = useRef({ hi: 0, count, onEnter, onDelete });
  ref.current = { hi: Math.min(hi, Math.max(0, count - 1)), count, onEnter, onDelete };
  useEffect(() => {
    const key = (e) => {
      const { hi: h, count: n, onEnter: enter, onDelete: del } = ref.current;
      if (!n) return;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'ArrowDown') { stop(); setHi(Math.min(h + 1, n - 1)); }
      else if (e.key === 'ArrowUp') { stop(); setHi(Math.max(h - 1, 0)); }
      else if (e.key === 'Enter') { stop(); enter?.(h); }
      else if (e.key === 'Delete' && del) { stop(); del(h); }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  // keep the highlighted row in view
  useEffect(() => { document.querySelector('.key-list .on')?.scrollIntoView({ block: 'nearest' }); }, [hi]);
  return [ref.current.hi, setHi];
}
