import { useEffect, useRef, useState } from 'react';
import { api, setApprovalHandler, setToken } from '../lib.js';
import { Icon, Modal, Field, useToast } from './ui.jsx';

/* ================= LOGIN ================= */
export function Login({ onLoggedIn }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const userRef = useRef();

  useEffect(() => { userRef.current?.focus(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password'); setShake((s) => s + 1); return; }
    setBusy(true);
    setError('');
    try {
      const { token, user } = await api.post('/auth/login', { username: username.trim(), password });
      setToken(token);
      setLeaving(true);
      setTimeout(() => onLoggedIn(user), 550);
    } catch (err) {
      setError(err.message);
      setShake((s) => s + 1);
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <div className={`login ${leaving ? 'leaving' : ''}`}>
      <div className="login-blobs" aria-hidden="true">
        <span className="blob b1" /><span className="blob b2" /><span className="blob b3" /><span className="blob b4" />
      </div>

      <div className="login-center">
        <div className="login-brand">
          <div className="brand-logo lg"><Icon name="box" size={26} /></div>
          <h1>Cargo POS</h1>
          <p>Import, stock, billing and payments, all in one place.</p>
        </div>

        <form key={shake} className={`login-card ${shake ? 'shake' : ''}`} onSubmit={submit}>
          <h2>Welcome back</h2>
          <p className="muted">Sign in to continue</p>

          <label className="login-field">
            <Icon name="users" size={18} />
            <input ref={userRef} placeholder="Username" autoComplete="username" value={username}
              onChange={(e) => { setUsername(e.target.value); setError(''); }} />
          </label>
          <label className="login-field">
            <Icon name="lock" size={18} />
            <input type={show ? 'text' : 'password'} placeholder="Password" autoComplete="current-password" value={password}
              onChange={(e) => { setPassword(e.target.value); setError(''); }} />
            <button type="button" className="eye" onClick={() => setShow((s) => !s)} title={show ? 'Hide password' : 'Show password'}>
              <Icon name={show ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </label>

          <div className={`login-error ${error ? 'show' : ''}`}><Icon name="alert" size={15} /> {error || ' '}</div>

          <button className="btn btn-primary btn-lg btn-block login-btn" disabled={busy}>
            {busy ? <><span className="spinner light" /> Signing in…</> : <>Sign in <Icon name="arrowRight" size={18} /></>}
          </button>
        </form>
        <div className="login-foot">
          <span className="maker"><span className="maker-mark">Z</span> by <b>Zenatiq Solutions</b></span>
          <span className="maker-copy">© {new Date().getFullYear()} Cargo POS · All rights reserved</span>
        </div>
      </div>
    </div>
  );
}

/* ================= ADMIN APPROVAL ================= */
/** Registers the pop-up that lib.js uses whenever the API says "admin approval needed". */
export function ApprovalProvider({ children }) {
  const [req, setReq] = useState(null); // { action, level, resolve }

  useEffect(() => {
    setApprovalHandler((action, level) => new Promise((resolve) => setReq({ action, level, resolve })));
    return () => setApprovalHandler(null);
  }, []);

  const close = (value) => { req?.resolve(value); setReq(null); };
  return (
    <>
      {children}
      {req && <ApprovalModal action={req.action} level={req.level} onDone={close} />}
    </>
  );
}

function ApprovalModal({ action, level = 'admin', onDone }) {
  const toast = useToast();
  const sup = level === 'superadmin';
  const who = sup ? 'Super Admin' : 'Admin';
  const [username, setUsername] = useState(sup ? 'superadmin' : 'admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  const approve = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post('/auth/approve', { username, password, action, level });
      toast(`Approved by ${res.approver}`);
      onDone(res.approval);
    } catch (err) {
      setError(err.message);
      setPassword('');
      setShake((s) => s + 1);
      setBusy(false);
    }
  };

  return (
    <Modal size="sm" title={`${who} approval needed`} onClose={() => onDone(null)}
      footer={<><button className="btn" onClick={() => onDone(null)}>Cancel</button>
        <button className="btn btn-primary" form="approve-form" disabled={busy || !password}><Icon name="check" /> Approve</button></>}>
      <form id="approve-form" key={shake} className={`stack ${shake ? 'shake' : ''}`} onSubmit={approve}>
        <div className={`approve-head ${sup ? 'super' : ''}`}>
          <div className="lock-badge"><Icon name={sup ? 'shield' : 'lock'} size={22} /></div>
          <div>
            <div className="strong">{sup ? 'Only the Super Admin can approve this' : 'This change needs an admin'}</div>
            <div className="muted small">{action}</div>
          </div>
        </div>
        <Field label={`${who} username`}><input className="input" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
        <Field label={`${who} password`}>
          <input className="input" type="password" autoFocus value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} />
        </Field>
        {error && <div className="alert alert-red small"><Icon name="alert" size={16} /> {error}</div>}
        <p className="muted small">The {who.toLowerCase()}'s password is used once for this change only, and the change is written to the activity log.</p>
      </form>
    </Modal>
  );
}

/* ================= CHANGE OWN PASSWORD ================= */
export function ChangePasswordModal({ onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    if (f.next !== f.again) return toast('The new passwords do not match', 'error');
    try { await api.post('/auth/password', { current: f.current, next: f.next }); toast('Password changed'); onClose(); }
    catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal size="sm" title="Change my password" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="pw-form">Save</button></>}>
      <form id="pw-form" className="stack" onSubmit={save}>
        <Field label="Current password"><input type="password" className="input" autoFocus value={f.current} onChange={set('current')} /></Field>
        <Field label="New password" hint="At least 6 characters"><input type="password" className="input" value={f.next} onChange={set('next')} /></Field>
        <Field label="New password again"><input type="password" className="input" value={f.again} onChange={set('again')} /></Field>
      </form>
    </Modal>
  );
}
