import { Router } from 'express';
import { find, findOne, insert, setById, updateMany, deleteMany, fail, num, tx } from '../db.js';
import { cargoLedgers } from '../cheques.js';
import { audit } from '../auth.js';

/*
 * Cargo companies (like suppliers and customers): name, contact person, phone, address, notes.
 * A GRN picks its cargo from this list. What is owed to each is worked out from its shipments, its payments
 * and the Extra & Short settled with it (cheques.js → cargoLedgers).
 * Mounted at /api: /cargo/... needs the "suppliers" permission (costcode.js), /grns/... the "receive goods" one.
 */
const r = Router();
const clean = (b) => {
  const name = String(b?.name || '').trim();
  if (!name) fail('Type the cargo company\'s name');
  const t = (v) => String(v ?? '').trim() || null;
  return { name, contact: t(b.contact), phone: t(b.phone), address: t(b.address), notes: t(b.notes), active: b.active === false || b.active === 0 ? 0 : 1 };
};
const sameName = (name, id = null) => findOne('cargos', { name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }, ...(id ? { id: { $ne: id } } : {}) });

/** The list, with what each is owed. */
r.get('/cargo/companies', async (req, res) => {
  const [list, ledgers] = await Promise.all([find('cargos', {}, { sort: { name: 1 } }), cargoLedgers()]);
  const byKey = new Map(ledgers.map((l) => [l.key, l]));
  res.json(list.map((c) => {
    const l = byKey.get(c.name.trim().toLowerCase());
    return { ...c, shipments: l?.shipments || 0, total: l?.total || 0, paid: l?.paid || 0, balance: l?.balance || 0, credit: l?.credit || 0, last_date: l?.last_date || null };
  }));
});
r.get('/cargo/companies/:id', async (req, res) => {
  const c = await findOne('cargos', { id: num(req.params.id) });
  if (!c) fail('Cargo company not found', 404);
  const l = (await cargoLedgers()).find((x) => x.key === c.name.trim().toLowerCase());
  res.json({ ...c, ledger: l || null });
});
const add = async (req, res) => {
  const body = clean(req.body);
  if (await sameName(body.name)) fail(`"${body.name}" is already in the Cargo list`);
  const c = await insert('cargos', body);
  await audit(req.user, `Added cargo company ${c.name}`);
  res.json(c);
};
r.post('/cargo/companies', add);
r.post('/grns/cargo-companies', add);   // from Receive Goods: "+ Add cargo"
/** Renaming carries the new name onto its GRNs, payments and cheques (what is owed is matched by name). */
r.put('/cargo/companies/:id', async (req, res) => {
  const c = await findOne('cargos', { id: num(req.params.id) });
  if (!c) fail('Cargo company not found', 404);
  const body = clean(req.body);
  if (await sameName(body.name, c.id)) fail(`"${body.name}" is already in the Cargo list`);
  await tx(async () => {
    await setById('cargos', c.id, body);
    if (body.name !== c.name) {
      const was = { $regex: `^\\s*${c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, $options: 'i' };
      await updateMany('grns', { $or: [{ cargo_id: c.id }, { cargo_name: was }] }, { $set: { cargo_name: body.name, cargo_id: c.id } });
      await updateMany('cargo_payments', { cargo_name: was }, { $set: { cargo_name: body.name } });
      await updateMany('cheques', { party: 'cargo', party_name: was }, { $set: { party_name: body.name } });
    }
  });
  if (body.name !== c.name) await audit(req.user, `Renamed cargo company ${c.name} → ${body.name}`);
  res.json(await findOne('cargos', { id: c.id }));
});
r.delete('/cargo/companies/:id', async (req, res) => {
  const c = await findOne('cargos', { id: num(req.params.id) });
  if (!c) fail('Cargo company not found', 404);
  const was = { $regex: `^\\s*${c.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, $options: 'i' };
  if (await findOne('grns', { $or: [{ cargo_id: c.id }, { cargo_name: was }] }) || await findOne('cargo_payments', { cargo_name: was })) {
    fail(`${c.name} has shipments or payments — it can't be deleted. Untick "Active" to hide it instead.`);
  }
  await deleteMany('cargos', { id: c.id });
  await audit(req.user, `Deleted cargo company ${c.name}`);
  res.json({ ok: true });
});
export default r;
