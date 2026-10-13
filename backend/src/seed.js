// Demo data so the system can be explored. Stock is built only from the shop's own catalogue
// (Settings → Categories & products), with selling price & MRP from Settings → Price & billing.
//
//   npm run seed                      fills an EMPTY database (suppliers, customers, GRNs + stock)
//   node src/seed.js --reset-stock    removes every product, GRN, sale and payment, then adds the demo GRNs again
//                                     (suppliers, customers, users and settings are kept)
import {
  setup, close, find, findOne, insert, count, deleteMany, setById, updateMany, todayStr, addDays, getSettings, setSetting,
} from './db.js';
import { createGrn } from './services.js';
import { hashPassword, initAuth } from './auth.js';

await setup();
await initAuth();
const RESET = process.argv.includes('--reset-stock');
const today = todayStr();
const STOCK = ['sale_items', 'customer_payments', 'sales', 'supplier_payments', 'grn_expenses', 'grn_items', 'grns', 'stock_moves', 'products'];

if (RESET) {
  for (const t of STOCK) await deleteMany(t, {});
  // numbering starts again from 0001
  await deleteMany('counters', { _id: { $in: STOCK } });
  await insert('audit_log', { at: new Date().toISOString().slice(0, 19).replace('T', ' '), username: 'system', action: 'Demo stock reset: products, GRNs, sales and payments removed' });
  console.log('Old products, GRNs, sales and payments removed.');
} else if (await count('products')) {
  console.log('Database already has products - seed skipped. Use --reset-stock to replace the demo stock.');
  await close();
  process.exit(0);
}

/* ---------- suppliers & customers (only on an empty database) ---------- */
const sup = (name, city, state, phone, credit_days) =>
  insert('suppliers', { name, contact_person: name.split(' ')[0] + ' bhai', city, state, phone, whatsapp: phone, credit_days });
const cus = (name, shop_name, city, phone, credit_limit, credit_days) =>
  insert('customers', { name, shop_name, city, phone, credit_limit, credit_days });

if (!(await count('suppliers'))) {
  await sup('Shree Ganesh Textiles', 'Surat', 'Gujarat', '+91 98250 11111', 30);
  await sup('Tiruppur Knit Exports', 'Tiruppur', 'Tamil Nadu', '+91 94430 22222', 45);
  await sup('Mumbai Fancy Garments', 'Mumbai', 'Maharashtra', '+91 98200 33333', 15);
}
if (!(await count('customers'))) {
  await cus('Mohamed Rizwan', 'Rizwan Fashion', 'Kandy', '077 123 4567', 300000, 30);
  await cus('Saman Perera', 'Perera Textiles', 'Kurunegala', '071 765 4321', 200000, 21);
  await cus('Fathima Nusra', 'Nusra Collection', 'Batticaloa', '075 222 3344', 150000, 14);
  await cus('Kumar Rajan', 'KR Stores', 'Jaffna', '076 555 8899', 0, 0);
}
const [s1, s2, s3] = (await find('suppliers', { active: 1 }, { sort: { id: 1 } })).map((s) => s.id);

/* ---------- demo items: only products that exist in the catalogue ---------- */
const settings = await getSettings();
const catalog = JSON.parse(settings.catalog || '[]');
const inCatalog = (category, product) => catalog.some((c) => c.name === category && (c.types || []).includes(product));
const item = (category, product, pcs_per_set, sizes, sets, cost_inr_per_set, more = {}) =>
  ({ name: `${category} - ${product}`, category, subtype: product, pcs_per_set, colors_count: Math.min(pcs_per_set, 4), sizes, sets, cost_inr_per_set, ...more });
const only = (items) => items.filter((i) => inCatalog(i.category, i.subtype));

const bales = [
  {
    date: addDays(today, -30), supplier_id: s1 || s2 || s3, supplier_invoice_no: 'SGT/2291', cargo_name: 'Lanka Speed Cargo', payment_type: 'credit',
    expenses: [{ label: 'Cargo charge', amount_lkr: 45000 }],
    items: only([
      item('Shirts', 'Kerala', 4, 'M, L, XL, 2XL', 25, 1400),
      item('Shirts', 'L/S', 4, 'M, L, XL, 2XL', 15, 1520),
      item('Pant', 'Linen Pant', 5, '28/32', 12, 2200),
      item('Denim', 'Baggy', 5, '28/34', 12, 3250, { short_pcs: 2 }),
    ]),
  },
  {
    date: addDays(today, -14), supplier_id: s2 || s1, supplier_invoice_no: 'TKE-778', cargo_name: 'Ceylon Express Cargo', payment_type: 'credit',
    expenses: [{ label: 'Cargo charge', amount_lkr: 59800 }],
    items: only([
      item('T-shirts', 'Collar', 6, 'S, M, L, XL, 2XL, 3XL', 30, 720, { extra_pcs: 3 }),
      item('T-shirts', 'R/N Regular', 6, 'S, M, L, XL, 2XL, 3XL', 30, 690),
      item('T-shirts', 'Old Money', 4, 'M, L, XL, 2XL', 20, 950),
      item('Track Pant', 'Regular', 5, '28/36', 20, 1150),
      item('Shorts', 'Cargo', 6, '28/34', 15, 540),
    ]),
  },
  {
    date: addDays(today, -4), supplier_id: s3 || s1, supplier_invoice_no: 'MFG/45', cargo_name: 'Lanka Speed Cargo', payment_type: 'paid', payment_method: 'Bank transfer',
    expenses: [{ label: 'Cargo charge', amount_lkr: 25400 }],
    items: only([
      item('Underwear', 'Boxer', 12, 'M, L, XL, 2XL', 15, 960),
      item('Underwear', 'V Cut', 12, 'M, L, XL, 2XL', 10, 900),
      item('Jacket', 'Hoodie', 4, 'M, L, XL, 2XL', 18, 1250, { short_pcs: 1 }),
      item('Jacket', 'Jacket', 4, 'M, L, XL, 2XL', 10, 1800),
    ]),
  },
].filter((b) => b.items.length && b.supplier_id);

const grns = [];
for (const b of bales) grns.push(await createGrn(b));

// a part payment on the first bale, so the payables screens have something to show
if (grns[0]) {
  await insert('supplier_payments', {
    supplier_id: grns[0].supplier_id, grn_id: grns[0].id, date: addDays(today, -15), amount_inr: 40000, exchange_rate: 3.5,
    amount_lkr: 140000, method: 'Bank transfer', reference: 'TT-2231',
  });
}

/* ---------- selling price & MRP from the cost, as Receive Goods does ---------- */
const sellPct = Number(settings.selling_markup_percent ?? 30);
const mrpPct = Number(settings.mrp_markup_percent ?? 40);
const step = Math.max(1, Number(settings.price_round_to) || 1);
const up = (v) => Math.ceil(v / step - 1e-9) * step;
for (const p of await find('products')) {
  if (!(p.cost_per_pcs > 0)) continue;
  const prices = { expected_per_set: up(p.cost_per_pcs * (1 + sellPct / 100)) * p.pcs_per_set, mrp_per_set: up(p.cost_per_pcs * (1 + mrpPct / 100)) * p.pcs_per_set };
  await setById('products', p.id, prices);
  await updateMany('grn_items', { product_id: p.id }, { $set: prices });
}

/* ---------- first run only: a cashier login and shop details ---------- */
if (!RESET) {
  if (!(await findOne('users', { username: 'cashier' }))) {
    await insert('users', { username: 'cashier', name: 'Demo Cashier', password_hash: hashPassword('cashier123'), role: 'cashier' });
  }
  await setSetting('shop_name', 'Demo Wholesale Traders');
  await setSetting('shop_address', '45, Main Street, Pettah, Colombo 11');
  await setSetting('shop_phone', '011 234 5678');
}

console.log(`Demo stock added: ${grns.length} GRNs (${grns.map((g) => g.grn_no).join(', ')}), ${await count('products')} products from the catalogue.`);
await close();
