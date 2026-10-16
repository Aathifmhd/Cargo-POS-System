import { Router } from 'express';
import { find, findOne, insert, setById, updateOne, deleteMany, count, fail, num } from '../db.js';
import {
  checkCredentials, checkSuperPassword, createSession, createApproval, requireAuth, adminOnly, audit, endSession,
  hashPassword, verifyPassword, publicUser, userByName, guard, RANK, rankOf, ROLE_NAME,
} from '../auth.js';

// Only a super admin may create, change or promote someone to super admin (`by` is who allowed the change).
const roleFor = (by, wanted, current = 'cashier') => {
  const role = ['cashier', 'admin', 'superadmin'].includes(wanted) ? wanted : current;
  if (role === 'superadmin' && rankOf(by) < RANK.superadmin) fail('Only the Super Admin can make a Super Admin');
  return role;
};
const USER_FIELDS = { id: 1, username: 1, name: 1, role: 1, active: 1, last_login: 1, created_at: 1 };
const shortUser = async (id) => findOne('users', { id }, { project: { id: 1, username: 1, name: 1, role: 1, active: 1 } });

const r = Router();

r.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) fail('Enter your username and password');
  const user = await checkCredentials(username, password);
  const token = await createSession(user);
  await audit(user, 'Logged in');
  res.json({ token, user: publicUser(user) });
});

/** Login page: the role badge for the username being typed (Super Admin / Admin / Cashier). */
r.get('/auth/role', async (req, res) => {
  const u = String(req.query.username || '').trim() ? await userByName(req.query.username) : null;
  res.json({ role: u?.role || null });
});

r.get('/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

r.post('/auth/logout', requireAuth, async (req, res) => {
  await endSession(req.token);
  await audit(req.user, 'Logged out');
  res.json({ ok: true });
});

/** An admin types their password on the cashier's screen to allow one protected change. */
r.post('/auth/approve', requireAuth, async (req, res) => {
  const { username, password, action } = req.body || {};
  const level = req.body?.level === 'superadmin' ? 'superadmin' : 'admin';
  // the Super Admin approves with the password only
  const approver = level === 'superadmin' && !String(username || '').trim() ? await checkSuperPassword(password) : await checkCredentials(username, password);
  if (rankOf(approver) < RANK[level]) {
    fail(level === 'superadmin' ? 'Only the Super Admin can approve this.' : 'This user is not an admin. Ask an admin to approve.', 403);
  }
  res.json({ approval: createApproval(approver, req.user, action), approver: approver.name });
});

r.post('/auth/password', requireAuth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(current, req.user.password_hash)) fail('Your current password is wrong');
  if (String(next || '').length < 6) fail('New password must be at least 6 characters');
  await updateOne('users', { id: req.user.id }, { $set: { password_hash: hashPassword(next) }, $inc: { token_version: 1 } });
  await audit(req.user, 'Changed own password');
  // the new password ends every older login; hand this device a fresh one so it stays signed in
  res.json({ ok: true, token: await createSession(await findOne('users', { id: req.user.id })) });
});

/* ---------------- users (admin only; every add, edit or delete needs the Super Admin's password) ---------------- */
const ROLE_ORDER = { admin: 0, cashier: 1, superadmin: 2 };   // same order as sorting the role names
r.get('/users', requireAuth, adminOnly, async (req, res) => {
  const users = await find('users', {}, { project: USER_FIELDS });
  res.json(users.sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
});

r.post('/users', requireAuth, adminOnly, async (req, res) => {
  const { username, name, password, role } = req.body || {};
  if (!String(username || '').trim() || !String(name || '').trim()) fail('Name and username are required');
  if (String(password || '').length < 6) fail('Password must be at least 6 characters');
  if (await userByName(username, false)) fail('That username is already taken');
  const by = await guard(req, `Add user ${String(username).trim()} (${ROLE_NAME[role] || 'Cashier'})`, 'superadmin', { always: true });
  const newRole = roleFor(by, role);
  const u = await insert('users', { username: username.trim(), name: name.trim(), password_hash: hashPassword(password), role: newRole });
  await audit(req.user, `Created user ${username.trim()} (${ROLE_NAME[newRole]})`);
  res.json(await shortUser(u.id));
});

r.put('/users/:id', requireAuth, adminOnly, async (req, res) => {
  const id = num(req.params.id);
  const u = await findOne('users', { id });
  if (!u) fail('User not found', 404);
  const newName = String(req.body.username ?? u.username).trim();
  if (!newName) fail('Username is required');
  if (newName.toLowerCase() !== u.username.toLowerCase()) {
    const taken = await userByName(newName, false);
    if (taken && taken.id !== id) fail('That username is already taken');
  }
  const by = await guard(req, `Edit user ${u.username}`, 'superadmin', { always: true });
  const role = roleFor(by, req.body.role, u.role);
  const active = req.body.active === undefined ? u.active : req.body.active ? 1 : 0;
  const supers = await count('users', { role: 'superadmin', active: 1 });
  if (u.role === 'superadmin' && u.active && (role !== 'superadmin' || !active) && supers <= 1) fail('You need at least one active Super Admin');
  if (id === req.user.id && !active) fail('You cannot switch off your own account');
  if (req.body.password && String(req.body.password).length < 6) fail('Password must be at least 6 characters');
  await setById('users', id, { name: String(req.body.name || u.name).trim(), username: newName, role, active });
  if (req.body.password) {
    // a new password ends their logins
    await updateOne('users', { id }, { $set: { password_hash: hashPassword(req.body.password) }, $inc: { token_version: 1 } });
  }
  await audit(req.user, `Updated user ${u.username}${newName !== u.username ? ` (now ${newName})` : ''}${req.body.password ? ' (password reset)' : ''}`);
  res.json(await shortUser(id));
});

// the Super Admin can never be deleted
r.delete('/users/:id', requireAuth, adminOnly, async (req, res) => {
  const id = num(req.params.id);
  const u = await findOne('users', { id });
  if (!u) fail('User not found', 404);
  if (u.role === 'superadmin') fail('The Super Admin cannot be deleted');
  if (id === req.user.id) fail('You cannot delete your own account');
  await guard(req, `Delete user ${u.username} (${ROLE_NAME[u.role]})`, 'superadmin', { always: true });
  await deleteMany('users', { id });
  await audit(req.user, `Deleted user ${u.username}`);
  res.json({ ok: true });
});

/**
 * Action Center (Super Admin only): the activity log, newest first; `after` returns only what is newer (for the live list).
 * `super` marks what the Super Admin approved, or a Super Admin-level change.
 */
r.get('/action-center', requireAuth, async (req, res) => {
  if (rankOf(req.user) < RANK.superadmin) fail('Only the Super Admin can open the Action Center', 403);
  const after = num(req.query.after);
  const [rows, users] = await Promise.all([
    find('audit_log', after ? { id: { $gt: after } } : {}, { sort: { id: -1 }, limit: after ? 200 : 1000 }),
    find('users', {}, { project: { username: 1, role: 1 } }),
  ]);
  const roleOf = Object.fromEntries(users.map((u) => [String(u.username).toLowerCase(), u.role]));
  res.json(rows.map((a) => ({
    ...a,
    role: a.role || roleOf[String(a.username || '').toLowerCase()] || null,
    super: a.level === 'superadmin' || Boolean(a.approved_by && roleOf[String(a.approved_by).toLowerCase()] === 'superadmin'),
  })));
});

r.get('/audit', requireAuth, adminOnly, async (req, res) => {
  res.json(await find('audit_log', {}, { sort: { id: -1 }, limit: 500 }));
});

export default r;
