import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, ThemeSwitch, Modal, useToast } from './ui.jsx';
import { ChangePasswordModal } from './auth.jsx';
import { api, isAdmin, isSuper, can, ROLE_NAME, downloadFile, today, fromStamp, niceDateTime } from '../lib.js';
import { useAuth, useFx, useSettings } from '../App.jsx';

const BACKUP_SNOOZE = 'cargo-backup-snooze';   // the day "Remind me tomorrow" was pressed

const NAV = [
  { to: '/action-center', icon: 'bell', label: 'Action Center', perm: 'action_center' },
  { group: 'Daily work' },
  { to: '/', icon: 'dashboard', label: 'Dashboard', end: true, hint: 'F2' },
  { to: '/pos', icon: 'cart', label: 'New Sale', hint: 'F3', primary: true },
  { to: '/sales', icon: 'receipt', label: 'Sales & Bills', hint: 'F9' },
  { to: '/grn/new', icon: 'truck', label: 'Receive Goods', hint: 'GRN', perm: 'receive_goods' },
  { group: 'Records' },
  { to: '/stock', icon: 'box', label: 'Stock' },
  { to: '/grn', icon: 'layers', label: 'Shipments (GRN)', end: true, perm: 'receive_goods' },
  { to: '/extra-short', icon: 'adjust', label: 'Extra & Short', perm: 'receive_goods' },
  { to: '/customers', icon: 'users', label: 'Customers' },
  { to: '/suppliers', icon: 'factory', label: 'Suppliers', perm: 'suppliers' },
  { group: 'Money' },
  { to: '/dues', icon: 'wallet', label: 'Payment Portal', hint: 'F7', perm: 'dues' },
  { to: '/cheques', icon: 'cheque', label: 'Cheque Desk', cheques: true, perm: 'cheques' },
  { to: '/reports', icon: 'chart', label: 'Reports', perm: 'reports' },
  { to: '/sales-profit', icon: 'cash', label: 'Sales & Profit', super: true },
  { to: '/settings', icon: 'settings', label: 'Settings', perm: 'settings' },
  { to: '/users', icon: 'shield', label: 'Users & Security', admin: true },
];

export default function Layout() {
  const { settings, reload: reloadSettings } = useSettings();
  const { user, logout } = useAuth();
  const { fx } = useFx();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const menuRef = useRef();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setOpen(false), [location.pathname]);

  /*
   * Monthly backup reminder (admins): from the 1st of each month until a full backup is downloaded that month.
   * "Remind me tomorrow" hides it for the rest of the day on this computer.
   */
  const toast = useToast();
  const [snoozed, setSnoozed] = useState(() => { try { return localStorage.getItem(BACKUP_SNOOZE) === today(); } catch { return false; } });
  const [backingUp, setBackingUp] = useState(false);
  const last = fromStamp(settings.last_backup_at);
  const lastMonth = last && !Number.isNaN(last.getTime()) ? `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}` : '';
  const needBackup = isAdmin(user) && settings.shop_name !== undefined && lastMonth !== today().slice(0, 7) && !snoozed;
  const snooze = () => {
    try { localStorage.setItem(BACKUP_SNOOZE, today()); } catch { /* storage unavailable */ }
    setSnoozed(true);
    api.post('/backup/remind-later', {}).catch(() => {});   // the Super Admin sees it under Action Center → Attention
  };
  const backupNow = async () => {
    setBackingUp(true);
    try {
      await downloadFile('/backup', `cargo-pos-backup-${today()}.json`);
      toast('Backup downloaded — keep it on a pen drive or Google Drive');
      reloadSettings();
    } catch (e) { toast(e.message, 'error'); } finally { setBackingUp(false); }
  };
  useEffect(() => {
    const close = (e) => menuRef.current && !menuRef.current.contains(e.target) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Action Center (Super Admin): how many activities came in since it was last opened, and the Attention
  // messages not read yet (red — they go once the Attention tab is opened)
  const [unseen, setUnseen] = useState(0);
  const [attn, setAttn] = useState(0);
  useEffect(() => {
    if (!can(user, 'action_center')) return undefined;
    const read = () => { try { return Number(localStorage.getItem('cargo-attention-seen')) || 0; } catch { return 0; } };
    const check = () => api.get(`/action-center?after=${read()}&level=attention`).then((l) => setAttn(l.length)).catch(() => {});
    check();
    const t = setInterval(check, 15000);
    const reset = () => setAttn(0);
    window.addEventListener('cargo-attention-seen', reset);
    return () => { clearInterval(t); window.removeEventListener('cargo-attention-seen', reset); };
  }, [user]);
  useEffect(() => {
    if (!can(user, 'action_center')) return undefined;
    const seen = () => { try { return Number(localStorage.getItem('cargo-action-center-seen')) || 0; } catch { return 0; } };
    const check = () => {
      if (location.pathname === '/action-center') return setUnseen(0);
      api.get(`/action-center?after=${seen()}`).then((l) => setUnseen(seen() ? l.length : 0)).catch(() => {});
    };
    check();
    const t = setInterval(check, 15000);
    const reset = () => setUnseen(0);
    window.addEventListener('cargo-action-center-seen', reset);
    return () => { clearInterval(t); window.removeEventListener('cargo-action-center-seen', reset); };
  }, [user, location.pathname]);

  // Cheque Desk: how many cheques are due today (or from past dates and still waiting)
  const [chequesToday, setChequesToday] = useState(0);
  useEffect(() => {
    const t = new Date();
    const day = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    api.get('/cheques').then((l) => setChequesToday(l.filter((c) => (c.status === 'pending' && c.cheque_date <= day) || (c.status === 'holding' && c.cheque_date === day)).length)).catch(() => {});
  }, [location.pathname]);

  // Function keys anywhere: F2 dashboard · F3 billing · F9 bills · F7 take a payment
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('.modal')) return;
      const onPos = location.pathname === '/pos';
      const go = (to) => { e.preventDefault(); if (location.pathname !== to) navigate(to); };
      if (e.key === 'F2') go('/');
      else if (e.key === 'F3' && !onPos) go('/pos');
      else if (e.key === 'F9') go('/sales');
      else if (e.key === 'F7' && !onPos) go('/dues?tab=receivables');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, navigate]);

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo"><Icon name="box" size={20} /></div>
          <div>
            <div className="brand-name">{settings.shop_name || 'Cargo POS'}</div>
            <div className="brand-sub">Cargo POS · Wholesale</div>
          </div>
        </div>
        <nav>
          {NAV.filter((i) => (!i.admin || isAdmin(user)) && (!i.super || isSuper(user)) && (!i.perm || can(user, i.perm))).map((item, i) =>
            item.group ? (
              <div key={i} className="nav-group">{item.group}</div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''} ${item.primary ? 'primary' : ''}`}>
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
                {item.to === '/action-center' && attn > 0 && <span className="nav-count" title="New Attention messages">{attn > 99 ? '99+' : attn}</span>}
                {item.to === '/action-center' && !attn && unseen > 0 && <span className="nav-count grey" title="New activities">{unseen > 99 ? '99+' : unseen}</span>}
                {item.cheques && chequesToday > 0 && <span className="nav-count" title="Cheques due today or waiting from past dates">{chequesToday}</span>}
              </NavLink>
            )
          )}
        </nav>
        <div className="sidebar-foot">
          <span className={`fx-dot ${fx?.mode === 'manual' ? 'off' : ''}`} />
          1 INR = <b>Rs {(fx?.rate ?? Number(settings.default_exchange_rate)).toFixed(4)}</b>
          <NavLink to="/" className="link-sm">{fx?.mode === 'manual' ? 'by hand' : 'live'}</NavLink>
        </div>
        <div className="side-maker" title="Cargo POS by Zenatiq Solutions">by <b>Zenatiq Solutions</b></div>
        <div className="user-chip" ref={menuRef}>
          <button className="user-btn" onClick={() => setMenu((m) => !m)}>
            <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
            <span className="user-text">
              <b>{user.name}</b>
              <small>{ROLE_NAME[user.role] || 'Cashier'} · {user.username}</small>
            </span>
            <Icon name="settings" size={16} />
          </button>
          {menu && (
            <div className="user-menu">
              <ThemeSwitch />
              <button onClick={() => { setMenu(false); setPw(true); }}><Icon name="lock" size={16} /> Change my password</button>
              <button className="danger" onClick={logout}><Icon name="logout" size={16} /> Log out</button>
            </div>
          )}
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <main className="main">
        <div className="mobile-bar">
          <button className="btn btn-icon btn-ghost" onClick={() => setOpen(true)}><Icon name="menu" /></button>
          <b>{settings.shop_name}</b>
        </div>
        <Outlet />
      </main>
      {pw && <ChangePasswordModal onClose={() => setPw(false)} />}
      {needBackup && (
        <Modal size="sm" title="Time for the monthly backup" subtitle={new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} onClose={snooze}
          footer={<><button className="btn" onClick={snooze} disabled={backingUp}>Remind me tomorrow</button>
            <button className="btn btn-primary" autoFocus onClick={backupNow} disabled={backingUp}><Icon name="download" size={16} /> {backingUp ? 'Downloading…' : 'Download backup now'}</button></>}>
          <div className="stack">
            <div className="alert alert-amber small"><Icon name="download" size={16} /><span><b>Download a full copy of all your data.</b> Keep it on a pen drive or Google Drive, so nothing is lost if this computer or the internet fails.</span></div>
            <p className="muted small">{settings.last_backup_at ? `Last backup: ${niceDateTime(settings.last_backup_at)}${settings.last_backup_by ? ` by ${settings.last_backup_by}` : ''}.` : 'No backup has been downloaded yet.'} This reminder comes back at the start of every month until the backup is downloaded.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
