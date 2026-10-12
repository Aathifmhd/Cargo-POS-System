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

const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
const nowIso = () => new Date().toISOString();
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

export function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, user.id, isoIn(SESSION_HOURS * 3600_000));
  run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', user.id);
  run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
  return token;
}

export function createApproval(approver, user, action) {
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO approvals (token, approver_id, user_id, action, expires_at) VALUES (?, ?, ?, ?, ?)',
    token, approver.id, user.id, action || null, isoIn(APPROVAL_MINUTES * 60_000));
  return token;
}

/* ---------------- middleware ---------------- */
export function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const row = token && get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`,
    token, nowIso());
  if (!row) return res.status(401).json({ error: 'Please log in again' });
  req.user = row;
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
export function guard(req, action, level = 'admin') {
  if (rankOf(req.user) >= RANK[level]) {
    audit(req.user, action);
    return;
  }
  const tok = req.get('X-Approval');
  const a = tok && get(
    `SELECT a.*, u.username AS approver, u.role AS approver_role FROM approvals a JOIN users u ON u.id = a.approver_id
      WHERE a.token = ? AND a.used = 0 AND a.user_id = ? AND a.expires_at > ?`, tok, req.user.id, nowIso());
  if (!a || (RANK[a.approver_role] ?? 0) < RANK[level]) {
    throw new HttpError(403, `${ROLE_NAME[level]} approval needed: ${action}`, { needApproval: true, action, level });
  }
  run('UPDATE approvals SET used = 1 WHERE token = ?', tok);
  audit(req.user, action, a.approver);
}
