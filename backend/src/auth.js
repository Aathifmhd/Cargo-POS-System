import crypto from 'node:crypto';
import { findOne, insert, updateOne, getSettings, setSetting, HttpError, stamp, inParallel, find } from './db.js';
import { connect } from './db.js';

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

const NOCASE = { locale: 'en', strength: 2 };   // usernames are not case-sensitive
export const userByName = (username, onlyActive = true) =>
  findOne('users', { username: String(username || '').trim(), ...(onlyActive ? { active: 1 } : {}) }, { collation: NOCASE });

/* ---------------- start-up: default logins + the token secret ---------------- */
let SECRET = null;
export async function initAuth() {
  await connect();
  // First run: create the default admin (admin / admin123) and super admin (superadmin / Superadmin123).
  if (!(await findOne('users', {}))) {
    await insert('users', { username: 'admin', name: 'Administrator', password_hash: hashPassword('admin123'), role: 'admin' });
  }
  if (!(await findOne('users', { role: 'superadmin' }))) {
    await insert('users', { username: 'superadmin', name: 'Super Admin', password_hash: hashPassword('Superadmin123'), role: 'superadmin' });
  }
  SECRET = await loadSecret();
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

/** The Super Admin approves with their password only: it is checked against every active Super Admin. */
export async function checkSuperPassword(password) {
  const key = '#superadmin-approval';
  checkThrottle(key);
  const supers = await find('users', { role: 'superadmin', active: 1 });
  const u = supers.find((x) => verifyPassword(password, x.password_hash));
  if (!u) {
    noteFailure(key);
    throw new HttpError(401, 'Wrong Super Admin password');
  }
  clearFailures(key);
  return u;
}

/** Check username + password; returns the user or throws. */
export async function checkCredentials(username, password) {
  checkThrottle(username);
  const u = await userByName(username);
  if (!u || !verifyPassword(password, u.password_hash)) {
    noteFailure(username);
    throw new HttpError(401, 'Wrong username or password');
  }
  clearFailures(username);
  return u;
}

/* ---------------- signed tokens ----------------
 * Login sessions and admin approvals are self-contained signed tokens (payload + HMAC), so any copy of
 * the backend can check them. Each user has a login version (users.token_version); changing a password
 * bumps it, which ends older logins. SESSION_SECRET (env) signs the tokens; without it a random secret
 * is kept in the database (shared by every copy, since they all use the same MongoDB).
 */
async function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = (await getSettings()).session_secret;
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', s);
  }
  return s;
}
const b64 = (buf) => Buffer.from(buf).toString('base64url');
const mac = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function sign(payload) {
  const body = b64(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}
function verify(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig || !SECRET) return null;
  const good = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
const tokenId = (token) => crypto.createHash('sha256').update(String(token)).digest('base64url');

/** Log out: the token is remembered as ended (in the database, so every copy knows) until it would expire. */
export async function endSession(token) {
  const p = verify(token);
  if (p) await updateOne('revoked_tokens', { _id: tokenId(token) }, { $set: { exp: new Date(p.exp) } }, { upsert: true }).catch(() => {});
}

export async function createSession(user) {
  await updateOne('users', { id: user.id }, { $set: { last_login: stamp() } });
  return sign({ t: 's', u: user.username, v: (user.token_version ?? 0), exp: Date.now() + SESSION_HOURS * 3600_000 });
}

export function createApproval(approver, user, action) {
  return sign({
    t: 'a', by: approver.username, v: (approver.token_version ?? 0), for: user.username, action: action || null,
    n: crypto.randomBytes(9).toString('base64url'), exp: Date.now() + APPROVAL_MINUTES * 60_000,
  });
}

/* ---------------- middleware ---------------- */
export async function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const p = token ? verify(token) : null;
  // is the login ended? + who is it? — read together (one round-trip)
  const [revoked, found] = p && p.t === 's'
    ? await inParallel(() => findOne('revoked_tokens', { _id: tokenId(token) }), () => userByName(p.u))
    : [null, null];
  const user = revoked ? null : found;
  if (!user || (user.token_version ?? 0) !== p.v) return res.status(401).json({ error: 'Please log in again' });
  req.user = user;
  req.token = token;
  next();
}

export function adminOnly(req, res, next) {
  if (rankOf(req.user) < RANK.admin) return res.status(403).json({ error: 'Only an admin can do this' });
  next();
}

export const audit = (user, action, approvedBy = null, level = null) =>
  insert('audit_log', { at: stamp(), user_id: user?.id ?? null, username: user?.username ?? null, role: user?.role ?? null, action, approved_by: approvedBy, level });

/**
 * Protected change. A user at or above `level` passes straight through. Anyone else needs a one-time
 * approval token (header X-Approval) created with the password of someone at that level.
 * Without one, the API answers 403 { needApproval, level } and the app asks for those credentials.
 * level: 'admin' (most changes) or 'superadmin'.
 * always: ask for the password even when the logged-in user already has the level (e.g. deleting a bill).
 */
export async function guard(req, action, level = 'admin', { always = false } = {}) {
  if (!always && rankOf(req.user) >= RANK[level]) {
    await audit(req.user, action, null, level);
    return req.user;
  }
  const p = verify(req.get('X-Approval'));
  const approver = p && p.t === 'a' && p.for === req.user.username ? await userByName(p.by) : null;
  const used = approver ? await findOne('used_approvals', { _id: p.n }) : null;
  const ok = approver && !used && (approver.token_version ?? 0) === p.v && rankOf(approver) >= RANK[level];
  if (!ok) throw new HttpError(403, `${ROLE_NAME[level]} approval needed: ${action}`, { needApproval: true, action, level });
  await updateOne('used_approvals', { _id: p.n }, { $set: { exp: new Date(p.exp) } }, { upsert: true });   // one use only
  await audit(req.user, action, approver.username, level);
  return approver;
}
