import { Router } from 'express';
import { fail, num } from '../db.js';
import { guard } from '../auth.js';
import { ensureFreshRate, refreshRate, setManualRate, setAutoMode } from '../fx.js';

const r = Router();

r.get('/', async (req, res) => res.json(await ensureFreshRate()));
r.post('/refresh', async (req, res) => res.json(await refreshRate()));

/** Edit the rate: { mode: 'manual', rate } or { mode: 'auto' } */
r.put('/', async (req, res) => {
  if (req.body?.mode === 'auto') {
    await guard(req, 'Exchange rate: back to the live rate');
    return res.json(await setAutoMode());
  }
  const rate = num(req.body?.rate);
  if (!(rate > 0 && rate < 50)) fail('Enter a sensible rate, e.g. 3.45');
  await guard(req, `Exchange rate set by hand: 1 INR = Rs ${rate}`);
  res.json(await setManualRate(rate));
});

export default r;
