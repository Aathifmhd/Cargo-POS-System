import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './db.js';
import suppliers from './routes/suppliers.js';
import customers from './routes/customers.js';
import products from './routes/products.js';
import grns from './routes/grns.js';
import sales from './routes/sales.js';
import reports from './routes/reports.js';
import authRoutes from './routes/auth.js';
import { requireAuth, initAuth } from './auth.js';
import fxRoutes from './routes/fx.js';
import { setOnRateChange, startFxTimer } from './fx.js';
import { revalueGrns } from './services.js';

// Connect to MongoDB, create indexes / default settings / default logins (safe on every start).
await setup();
await initAuth();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', authRoutes);        // login is public; the rest of its routes check the session themselves
app.use('/api', requireAuth);       // everything below needs a logged-in user
app.use('/api/fx', fxRoutes);
app.use('/api/suppliers', suppliers);
app.use('/api/customers', customers);
app.use('/api/products', products);
app.use('/api/grns', grns);
app.use('/api/sales', sales);
app.use('/api', reports);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Serve the built React app (npm run build in /frontend) so the shop only needs one program running.
const dist = path.resolve(import.meta.dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => (req.method === 'GET' ? res.sendFile(path.join(dist, 'index.html')) : next()));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `Server error: ${err.message}`, ...(err.extra || {}) });
});

// --port=NNNN wins over $PORT so the dev script never collides with the Vite port.
const argPort = process.argv.find((a) => a.startsWith('--port='))?.split('=')[1];
const PORT = argPort || process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Cargo POS API running on http://localhost:${PORT}`));

// The live INR rate is shown on the dashboard only — costs always use the fixed costing rate (Settings).
setOnRateChange((rate) => console.log(`Live INR rate now ${rate}`));
revalueGrns().catch((e) => console.error('Re-costing GRNs failed:', e.message));
if (!process.env.VERCEL) startFxTimer();   // on Vercel the rate is refreshed when the dashboard asks for it
