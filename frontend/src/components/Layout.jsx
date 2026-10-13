import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, ThemeSwitch } from './ui.jsx';
import { ChangePasswordModal } from './auth.jsx';
import { isAdmin, ROLE_NAME } from '../lib.js';
import { useAuth, useFx, useSettings } from '../App.jsx';

const NAV = [
  { group: 'Daily work' },
  { to: '/', icon: 'dashboard', label: 'Dashboard', end: true, hint: 'F2' },
  { to: '/pos', icon: 'cart', label: 'New Sale', hint: 'F3', primary: true },
  { to: '/sales', icon: 'receipt', label: 'Sales & Bills', hint: 'F9' },
  { to: '/grn/new', icon: 'truck', label: 'Receive Goods', hint: 'GRN' },
  { group: 'Records' },
  { to: '/stock', icon: 'box', label: 'Stock' },
  { to: '/grn', icon: 'layers', label: 'Shipments (GRN)', end: true },
  { to: '/extra-short', icon: 'adjust', label: 'Extra & Short' },
  { to: '/customers', icon: 'users', label: 'Customers' },
  { to: '/suppliers', icon: 'factory', label: 'Suppliers' },
  { group: 'Money' },
  { to: '/dues', icon: 'wallet', label: 'Payments Due', hint: 'F7' },
  { to: '/reports', icon: 'chart', label: 'Reports' },
  { to: '/settings', icon: 'settings', label: 'Settings' },
  { to: '/users', icon: 'shield', label: 'Users & Security', admin: true },
];

export default function Layout() {
  const { settings } = useSettings();
  const { user, logout } = useAuth();
  const { fx } = useFx();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  const menuRef = useRef();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    const close = (e) => menuRef.current && !menuRef.current.contains(e.target) && setMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

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
          {NAV.filter((i) => !i.admin || isAdmin(user)).map((item, i) =>
            item.group ? (
              <div key={i} className="nav-group">{item.group}</div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''} ${item.primary ? 'primary' : ''}`}>
                <Icon name={item.icon} size={19} />
                <span>{item.label}</span>
                {item.hint && <kbd>{item.hint}</kbd>}
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
    </div>
  );
}
