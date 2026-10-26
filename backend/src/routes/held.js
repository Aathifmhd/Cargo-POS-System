import { Router } from 'express';
import { find, findOne, insert, deleteMany, fail, num, takeOne } from '../db.js';
import { can } from '../auth.js';

/*
 * Held bills (New Sale) and held GRNs (Receive Goods), kept on the server so every user, on every computer, sees the
 * same list. Carrying on with one takes it off the list (only one person can pick it up).
 * kind: 'bill' | 'grn' — a held GRN is for users who may receive goods.
 */
const r = Router();
const KINDS = ['bill', 'grn'];
const allowed = (req, kind) => {
  if (!KINDS.includes(kind)) fail('Unknown list', 404);
  if (kind === 'grn' && !can(req.user, 'receive_goods')) fail('You don\'t have permission for receiving goods (GRNs)', 403);
};
const shape = (h) => ({ id: h.id, kind: h.kind, label: h.label, summary: h.summary, by: h.by, at: h.created_at, data: h.data });

r.get('/held/:kind', async (req, res) => {
  allowed(req, req.params.kind);
  const list = await find('held', { kind: req.params.kind }, { sort: { id: 1 } });
  res.json(list.map(shape));
});

r.post('/held/:kind', async (req, res) => {
  allowed(req, req.params.kind);
  const { label, summary, data } = req.body || {};
  if (!data || typeof data !== 'object') fail('Nothing to hold');
  const size = JSON.stringify(data).length;
  if (size > 2_000_000) fail('This is too large to hold');
  const h = await insert('held', {
    kind: req.params.kind, label: String(label || '').slice(0, 120) || 'Held', summary: summary && typeof summary === 'object' ? summary : {},
    data, by: req.user.name || req.user.username,
  });
  res.json(shape(h));
});

/** Carry on with one: it comes off the list for everyone (if someone else took it first, it is gone). */
r.post('/held/:kind/:id/take', async (req, res) => {
  allowed(req, req.params.kind);
  const h = await takeOne('held', { id: num(req.params.id), kind: req.params.kind });
  if (!h) fail('Someone else has already taken this one — the list is refreshed', 404);
  res.json(shape(h));
});

r.delete('/held/:kind/:id', async (req, res) => {
  allowed(req, req.params.kind);
  const h = await findOne('held', { id: num(req.params.id), kind: req.params.kind });
  if (!h) fail('Already gone', 404);
  await deleteMany('held', { id: h.id });
  res.json({ ok: true });
});

export default r;
