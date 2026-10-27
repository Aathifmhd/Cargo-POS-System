import { Router } from 'express';
import { find, findOne, fail, num, setById } from '../db.js';
import { guard, adminOnly } from '../auth.js';
import { sendSms, smsAccount, smsReady, chequeReturnedSms, dueReminders, smsNumber } from '../sms.js';

/* Settings → SMS messages: the account, a test SMS, the log. Cheque Desk → returned cheque → inform the customer. */
const r = Router();

r.use('/sms', adminOnly);   // the SMS settings and log: admins only

r.get('/sms/status', async (req, res) => res.json({ ...(await smsAccount()), sender_env: process.env.SMSLENZ_SENDER_ID || null }));

r.get('/sms/log', async (req, res) => {
  const filter = req.query.kind ? { kind: String(req.query.kind) } : {};
  res.json(await find('sms_log', filter, { sort: { id: -1 }, limit: Math.min(500, num(req.query.limit, 100)) }));
});

r.post('/sms/test', async (req, res) => {
  if (!smsReady()) fail('Add SMSLENZ_USER_ID and SMSLENZ_API_KEY first (backend/.env and Vercel → Environment Variables)');
  const phone = String(req.body?.phone || '');
  if (!smsNumber(phone)) fail('Enter a mobile number, e.g. 077 123 4567');
  const message = String(req.body?.message || '').trim() || 'Test SMS from Cargo POS — the SMS service is working.';
  res.json(await sendSms({ kind: 'test', phone, name: 'Test', message, user: req.user, strict: true }));
});

/** Send today's due reminders now (they also go by themselves from the set hour). */
r.post('/sms/due-now', async (req, res) => {
  await guard(req, 'Send today\'s due reminder SMS now');
  res.json(await dueReminders({ force: true }));
});

r.post('/cheques/:id/inform', async (req, res) => {
  const ch = await findOne('cheques', { id: num(req.params.id) });
  if (!ch) fail('Cheque not found', 404);
  if (ch.direction !== 'in' || ch.party !== 'customer' || ch.status !== 'returned') fail('Only a customer\'s returned cheque can be sent');
  const log = await chequeReturnedSms(ch, req.user);
  await setById('cheques', ch.id, { informed_at: log.at, history: [...(ch.history || []), { status: ch.status, at: log.at, by: req.user?.username || null, note: `SMS sent to ${log.to}` }] });
  res.json(log);
});

/**
 * The daily job (Vercel Cron, see vercel.json): due reminders. Public, so Vercel can call it; when CRON_SECRET is set,
 * only a call carrying it is accepted. Sending twice is harmless — each customer gets one reminder a day.
 */
export async function smsCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Not allowed' });
  res.json(await dueReminders());
}

export default r;
