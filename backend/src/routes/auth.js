import { Router } from 'express';
import { all, get, run, fail, num } from '../db.js';
import {
  checkCredentials, createSession, createApproval, requireAuth, adminOnly, audit, endSession,
  hashPassword, verifyPassword, publicUser, RANK, rankOf, ROLE_NAME,
} from '../auth.js';

// Only a super admin may create, change or promote someone to super admin.
const roleFor = (req, wanted, current = 'cashier') => {
  const role = ['cashier', 'admin', 'superadmin'].includes(wanted) ? wanted : current;
  if (role === 'superadmin' && rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can make a Super Admin');
  return role;
};

const r = Router();

r.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) fail('Enter your username and password');
  const user = checkCredentials(username, password);
  const token = createSession(user);
  audit(user, 'Logged in');
  res.json({ token, user: publicUser(user) });
});

r.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

r.post('/auth/logout', requireAuth, (req, res) => {
  endSession(req.token);
  audit(req.user, 'Logged out');
  res.json({ ok: true });
});

/** An admin types their password on the cashier's screen to allow one protected change. */
r.post('/auth/approve', requireAuth, (req, res) => {
  const { username, password, action } = req.body || {};
  const level = req.body?.level === 'superadmin' ? 'superadmin' : 'admin';
  const approver = checkCredentials(username, password);
  if (rankOf(approver) < RANK[level]) {
    fail(level === 'superadmin' ? 'Only the Super Admin can approve this.' : 'This user is not an admin. Ask an admin to approve.', 403);
  }
  res.json({ approval: createApproval(approver, req.user, action), approver: approver.name });
});

r.post('/auth/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current, req.user.password_hash)) fail('Your current password is wrong');
  if (String(next || '').length < 6) fail('New password must be at least 6 characters');
  run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', hashPassword(next), req.user.id);
  audit(req.user, 'Changed own password');
  // the new password ends every older login; hand this device a fresh one so it stays signed in
  res.json({ ok: true, token: createSession(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

/* ---------------- users (admin only) ---------------- */
r.get('/users', requireAuth, adminOnly, (req, res) => {
  res.json(all('SELECT id, username, name, role, active, last_login, created_at FROM users ORDER BY role, name'));
});

r.post('/users', requireAuth, adminOnly, (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (!String(username || '').trim() || !String(name || '').trim()) fail('Name and username are required');
  if (String(password || '').length < 6) fail('Password must be at least 6 characters');
  if (get('SELECT id FROM users WHERE username = ?', username.trim())) fail('That username is already taken');
  const newRole = roleFor(req, role);
  const { lastInsertRowid } = run('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)',
    username.trim(), name.trim(), hashPassword(password), newRole);
  audit(req.user, `Created user ${username.trim()} (${ROLE_NAME[newRole]})`);
  res.json(get('SELECT id, username, name, role, active FROM users WHERE id = ?', lastInsertRowid));
});

r.put('/users/:id', requireAuth, adminOnly, (req, res) => {
  const id = num(req.params.id);
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u) fail('User not found', 404);
  if (u.role === 'superadmin' && rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can change the Super Admin account');
  const role = roleFor(req, req.body.role, u.role);
  const active = req.body.active === undefined ? u.active : req.body.active ? 1 : 0;
  const supers = get(`SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin' AND active = 1`).n;
  if (u.role === 'superadmin' && u.active && (role !== 'superadmin' || !active) && supers <= 1) fail('You need at least one active Super Admin');
  if (id === req.user.id && !active) fail('You cannot switch off your own account');
  run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?', String(req.body.name || u.name).trim(), role, active, id);
  if (req.body.password) {
    if (String(req.body.password).length < 6) fail('Password must be at least 6 characters');
    run('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', hashPassword(req.body.password), id);   // ends their logins
  }
  audit(req.user, `Updated user ${u.username}${req.body.password ? ' (password reset)' : ''}`);
  res.json(get('SELECT id, username, name, role, active FROM users WHERE id = ?', id));
});

r.get('/audit', requireAuth, adminOnly, (req, res) => {
  res.json(all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500'));
});

export default r;
