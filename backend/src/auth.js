import crypto from 'node:crypto';
import { get, run, HttpError } from './db.js';

const SESSION_HOURS = 12;
const APPROVAL_MINUTES = 3;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(password), salt, 64);
  const real = Buffer.from(hash, 'hex');
  return real.length === test.length && crypto.timingSafeEqual(real, test);
}

export const publicUser = (u) => u && { id: u.id, username: u.username, name: u.name, role: u.role };

/** cashier < admin < superadmin */
export const RANK = { cashier: 0, admin: 1, superadmin: 2 };
export const rankOf = (u) => RANK[u?.role] ?? 0;
export const ROLE_NAME = { cashier: 'Cashier', admin: 'Admin', superadmin: 'Super Admin' };

// First run: create the default admin (admin / admin123) and super admin (superadmin / Superadmin123).
if (!get('SELECT id FROM users LIMIT 1')) {
  run(`INSERT INTO users (username, name, password_hash, role) VALUES ('admin', 'Administrator', ?, 'admin')`, hashPassword('admin123'));
}
if (!get(`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`)) {
  run(`INSERT INTO users (username, name, password_hash, role) VALUES ('superadmin', 'Super Admin', ?, 'superadmin')`, hashPassword('Superadmin123'));
}

/* ---------------- login throttling (per username, in memory) ---------------- */
const failures = new Map();
export function checkThrottle(username) {
  const f = failures.get(String(username).toLowerCase());
  if (f && f.count >= 5 && Date.now() - f.at < 60_000) {
    throw new HttpError(429, 'Too many wrong attempts. Please wait one minute and try again.');
  }
}
export function noteFailure(username) {
  const k = String(username).toLowerCase();
  const f = failures.get(k);
  failures.set(k, { count: f && Date.now() - f.at < 60_000 ? f.count + 1 : 1, at: Date.now() });
}
export const clearFailures = (username) => failures.delete(String(username).toLowerCase());

/** Check username + password; returns the user or throws. */
export function checkCredentials(username, password) {
  checkThrottle(username);
  const u = get('SELECT * FROM users WHERE username = ? AND active = 1', String(username || '').trim());
  if (!u || !verifyPassword(password, u.password_hash)) {
    noteFailure(username);
    throw new HttpError(401, 'Wrong username or password');
  }
  clearFailures(username);
  return u;
}

/* ---------------- signed tokens ----------------
 * Login sessions and admin approvals are self-contained signed tokens (payload + HMAC), so ANY copy of
 * the backend can check them without looking anything up. This matters on Vercel, where several copies
 * run at once and each has its own database: a login made on one copy must work on the next one.
 * - The user is named by username (the same on every copy), not by database id.
 * - Each user has a login version (users.token_version, the same on every copy); changing a password
 *   bumps it, which ends older logins.
 * - SESSION_SECRET (env) signs the tokens. Locally a random secret is kept in the database.
 */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.VERCEL) {
    console.warn('SESSION_SECRET is not set — using the built-in demo secret. Set it in Vercel → Settings → Environment Variables.');
    return 'cargo-pos-demo-secret--set-SESSION_SECRET-on-vercel';
  }
  let s = get(`SELECT value FROM settings WHERE key = 'session_secret'`)?.value;
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    run(`INSERT INTO settings (key, value) VALUES ('session_secret', ?)`, s);
  }
  return s;
}
const SECRET = loadSecret();
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const activeUser = (username) => get('SELECT * FROM users WHERE username = ? AND active = 1', username);

// Logged-out tokens (kept on this copy until they would have expired anyway).
const loggedOut = new Map();
export function endSession(token) {
  const p = verify(token);
  if (p) loggedOut.set(token, p.exp);
  for (const [t, exp] of loggedOut) if (exp < Date.now()) loggedOut.delete(t);
}

export function createSession(user) {
  run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', user.id);
  return sign({ t: 's', u: user.username, v: (user.token_version ?? 0), exp: Date.now() + SESSION_HOURS * 3600_000 });
}

export function createApproval(approver, user, action) {
  return sign({
    t: 'a', by: approver.username, v: (approver.token_version ?? 0), for: user.username, action: action || null,
    n: crypto.randomBytes(9).toString('base64url'), exp: Date.now() + APPROVAL_MINUTES * 60_000,
  });
}

/* ---------------- middleware ---------------- */
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const p = token && !loggedOut.has(token) ? verify(token) : null;
  const user = p && p.t === 's' ? activeUser(p.u) : null;
  if (!user || (user.token_version ?? 0) !== p.v) return res.status(401).json({ error: 'Please log in again' });
  req.user = user;
  req.token = token;
  next();
}

export function adminOnly(req, res, next) {
  if (rankOf(req.user) < RANK.admin) return res.status(403).json({ error: 'Only an admin can do this' });
  next();
}

export function audit(user, action, approvedBy = null) {
  run('INSERT INTO audit_log (user_id, username, action, approved_by) VALUES (?, ?, ?, ?)',
    user?.id ?? null, user?.username ?? null, action, approvedBy);
}

/**
 * Protected change. A user at or above `level` passes straight through. Anyone else needs a one-time
 * approval token (header X-Approval) created with the password of someone at that level.
 * Without one, the API answers 403 { needApproval, level } and the app asks for those credentials.
 * level: 'admin' (most changes) or 'superadmin' (credit limits).
 */
/** always: ask for the password even when the logged-in user already has the level (e.g. deleting a bill). */
export function guard(req, action, level = 'admin', { always = false } = {}) {
  if (!always && rankOf(req.user) >= RANK[level]) {
    audit(req.user, action);
    return;
  }
  const p = verify(req.get('X-Approval'));
  const approver = p && p.t === 'a' && p.for === req.user.username ? activeUser(p.by) : null;
  const ok = approver && (approver.token_version ?? 0) === p.v && rankOf(approver) >= RANK[level] && !usedApprovals.has(p.n);
  if (!ok) throw new HttpError(403, `${ROLE_NAME[level]} approval needed: ${action}`, { needApproval: true, action, level });
  usedApprovals.set(p.n, p.exp);   // one use only
  for (const [n, exp] of usedApprovals) if (exp < Date.now()) usedApprovals.delete(n);
  audit(req.user, action, approver.username);
}
const usedApprovals = new Map();
