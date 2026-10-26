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
import money from './routes/money.js';
import exportsRoute from './routes/exports.js';
import stocktake from './routes/stocktake.js';
import held from './routes/held.js';
import authRoutes from './routes/auth.js';
import { requireAuth, initAuth } from './auth.js';
import fxRoutes from './routes/fx.js';
import { setOnRateChange, startFxTimer } from './fx.js';
import { revalueGrns, upgradeCosting, relabelCustomers, reorderProductNames, setupCargos } from './services.js';
import cargos from './routes/cargos.js';
import { setupBatches } from './db.js';
import { autoPassSoon } from './cheques.js';
import { attentionSoon } from './attention.js';
import { hideCosts, checkPaths } from './costcode.js';

// Connect to MongoDB, create indexes / default settings / default logins (safe on every start).
await setup();
await initAuth();

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', authRoutes);        // login is public; the rest of its routes check the session themselves
app.use('/api', requireAuth);       // everything below needs a logged-in user
app.use('/api', hideCosts);         // without "see costs": no costs or profit in any answer (the cost code instead)
app.use('/api', checkPaths);        // GRNs, suppliers, reports, Payment Portal, Cheque Desk: by the user's permissions
// cheques whose date has reached 3:00 PM pass by themselves (checked at most once a minute)
app.use('/api', (req, res, next) => { autoPassSoon().then(() => next(), next); });
// Action Center → Attention: overdue bills, cheques on hold, supplier bills due, GRN shorts (checked every half hour)
app.use('/api', (req, res, next) => { attentionSoon(); next(); });
app.use('/api/fx', fxRoutes);
app.use('/api/suppliers', suppliers);
app.use('/api/customers', customers);
app.use('/api/products', products);
app.use('/api/grns', grns);
app.use('/api/sales', sales);
app.use('/api', reports);
app.use('/api', cargos);          // the Cargo list
app.use('/api', money);           // cargo payable, cheques
app.use('/api', exportsRoute);     // Reports → Download reports (Excel)
app.use('/api', stocktake);        // Settings → Stock Take
app.use('/api', held);             // held bills and held GRNs, shared by every user

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
// stock batches first (once: existing stock is split by GRN), then the GRN costs
setupBatches().then(() => upgradeCosting()).then(() => revalueGrns()).catch((e) => console.error('Stock batches / re-costing GRNs failed:', e.message));
// customers go by their shop name: old bills and cheques written with the person's name are brought in line
relabelCustomers().catch((e) => console.error('Customer names on bills failed:', e.message));
reorderProductNames().catch((e) => console.error('Product names failed:', e.message));
setupCargos().catch((e) => console.error('Cargo list failed:', e.message));   // the cargo names in use → the Cargo list   // {product name} - {product} - {category}
if (!process.env.VERCEL) startFxTimer();   // on Vercel the rate is refreshed when the dashboard asks for it
if (!process.env.VERCEL) { setInterval(autoPassSoon, 60_000); setInterval(attentionSoon, 5 * 60_000); }   // on Vercel it runs with the requests
