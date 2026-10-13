// Demo data so the system can be explored. Stock is built only from the shop's own catalogue
// (Settings → Categories & products), with selling price & MRP from Settings → Price & billing.
//
//   npm run seed                      fills an EMPTY database (suppliers, customers, GRNs + stock)
//   node src/seed.js --reset-stock    removes every product, GRN, sale and payment, then adds the demo GRNs again
//                                     (suppliers, customers, users and settings are kept)
import { all, get, run, tx, todayStr, addDays, getSettings } from './db.js';
import { createGrn } from './services.js';
import { hashPassword } from './auth.js';

const RESET = process.argv.includes('--reset-stock');
const today = todayStr();

if (RESET) {
  tx(() => {
    for (const t of ['sale_items', 'customer_payments', 'sales', 'supplier_payments', 'grn_expenses', 'grn_items', 'grns', 'stock_moves', 'products']) {
      run(`DELETE FROM ${t}`);
    }
    // numbering starts again from 0001
    run(`DELETE FROM sqlite_sequence WHERE name IN ('sale_items', 'customer_payments', 'sales', 'supplier_payments', 'grn_expenses', 'grn_items', 'grns', 'stock_moves', 'products')`);
    run(`INSERT INTO audit_log (username, action) VALUES ('system', 'Demo stock reset: products, GRNs, sales and payments removed')`);
  });
  console.log('Old products, GRNs, sales and payments removed.');
} else if (get('SELECT COUNT(*) AS n FROM products').n > 0) {
  console.log('Database already has products - seed skipped. Use --reset-stock to replace the demo stock.');
  process.exit(0);
}

/* ---------- suppliers & customers (only on an empty database) ---------- */
const sup = (name, city, state, phone, credit_days) =>
  run(`INSERT INTO suppliers (name, contact_person, city, state, phone, whatsapp, credit_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, name.split(' ')[0] + ' bhai', city, state, phone, phone, credit_days).lastInsertRowid;
const cus = (name, shop, city, phone, limit, days) =>
  run(`INSERT INTO customers (name, shop_name, city, phone, credit_limit, credit_days) VALUES (?, ?, ?, ?, ?, ?)`,
    name, shop, city, phone, limit, days).lastInsertRowid;

if (!get('SELECT COUNT(*) AS n FROM suppliers').n) {
  sup('Shree Ganesh Textiles', 'Surat', 'Gujarat', '+91 98250 11111', 30);
  sup('Tiruppur Knit Exports', 'Tiruppur', 'Tamil Nadu', '+91 94430 22222', 45);
  sup('Mumbai Fancy Garments', 'Mumbai', 'Maharashtra', '+91 98200 33333', 15);
}
if (!get('SELECT COUNT(*) AS n FROM customers').n) {
  cus('Mohamed Rizwan', 'Rizwan Fashion', 'Kandy', '077 123 4567', 300000, 30);
  cus('Saman Perera', 'Perera Textiles', 'Kurunegala', '071 765 4321', 200000, 21);
  cus('Fathima Nusra', 'Nusra Collection', 'Batticaloa', '075 222 3344', 150000, 14);
  cus('Kumar Rajan', 'KR Stores', 'Jaffna', '076 555 8899', 0, 0);
}
const [s1, s2, s3] = all('SELECT id FROM suppliers WHERE active = 1 ORDER BY id').map((s) => s.id);

/* ---------- demo items: only products that exist in the catalogue ---------- */
const settings = getSettings();
const catalog = JSON.parse(settings.catalog || '[]');
const inCatalog = (category, product) => catalog.some((c) => c.name === category && (c.types || []).includes(product));
const item = (category, product, pcs_per_set, sizes, sets, cost_inr_per_set, more = {}) =>
  ({ name: `${category} - ${product}`, category, subtype: product, pcs_per_set, colors_count: Math.min(pcs_per_set, 4), sizes, sets, cost_inr_per_set, ...more });
const only = (items) => items.filter((i) => inCatalog(i.category, i.subtype));

const bales = [
  {
    date: addDays(today, -30), supplier_id: s1 || s2 || s3, supplier_invoice_no: 'SGT/2291', cargo_name: 'Lanka Speed Cargo',
    bale_no: 'B-101', lr_no: 'LR-558211', exchange_rate: 3.58, payment_type: 'credit',
    expenses: [{ label: 'Cargo charge', amount_lkr: 28500 }, { label: 'Clearing charges', amount_lkr: 12000 }, { label: 'Transport', amount_lkr: 4500 }],
    items: only([
      item('Shirts', 'Kerala', 4, 'M, L, XL, 2XL', 25, 1400),
      item('Shirts', 'L/S', 4, 'M, L, XL, 2XL', 15, 1520),
      item('Pant', 'Linen Pant', 5, '28/32', 12, 2200),
      item('Denim', 'Baggy', 5, '28/34', 12, 3250, { short_pcs: 2 }),
    ]),
  },
  {
    date: addDays(today, -14), supplier_id: s2 || s1, supplier_invoice_no: 'TKE-778', cargo_name: 'Ceylon Express Cargo',
    bale_no: 'B-117, B-118', lr_no: 'LR-90114', exchange_rate: 3.61, payment_type: 'credit',
    expenses: [{ label: 'Cargo charge', amount_lkr: 36800 }, { label: 'Clearing charges', amount_lkr: 15000 }, { label: 'Transport', amount_lkr: 6000 }, { label: 'Loading / Unloading', amount_lkr: 2000 }],
    items: only([
      item('T-shirts', 'Collar', 6, 'S, M, L, XL, 2XL, 3XL', 30, 720, { extra_pcs: 3 }),
      item('T-shirts', 'R/N Regular', 6, 'S, M, L, XL, 2XL, 3XL', 30, 690),
      item('T-shirts', 'Old Money', 4, 'M, L, XL, 2XL', 20, 950),
      item('Track Pant', 'Regular', 5, '28/36', 20, 1150),
      item('Shorts', 'Cargo', 6, '28/34', 15, 540),
    ]),
  },
  {
    date: addDays(today, -4), supplier_id: s3 || s1, supplier_invoice_no: 'MFG/45', cargo_name: 'Lanka Speed Cargo',
    bale_no: 'B-125', lr_no: 'LR-561002', exchange_rate: 3.63, payment_type: 'paid', payment_method: 'Bank transfer',
    expenses: [{ label: 'Cargo charge', amount_lkr: 17400 }, { label: 'Clearing charges', amount_lkr: 8000 }],
    items: only([
      item('Underwear', 'Boxer', 12, 'M, L, XL, 2XL', 15, 960),
      item('Underwear', 'V Cut', 12, 'M, L, XL, 2XL', 10, 900),
      item('Jacket', 'Hoodie', 4, 'M, L, XL, 2XL', 18, 1250, { short_pcs: 1 }),
      item('Jacket', 'Jacket', 4, 'M, L, XL, 2XL', 10, 1800),
    ]),
  },
].filter((b) => b.items.length && b.supplier_id);

const grns = bales.map((b) => createGrn(b));

// a part payment on the first bale, so the payables screens have something to show
if (grns[0]) {
  run(`INSERT INTO supplier_payments (supplier_id, grn_id, date, amount_inr, exchange_rate, amount_lkr, method, reference)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, grns[0].supplier_id, grns[0].id, addDays(today, -15), 40000, 3.60, 144000, 'Hawala', 'H-2231');
}

/* ---------- selling price & MRP from the cost, as Receive Goods does ---------- */
const sellPct = Number(settings.selling_markup_percent ?? 30);
const mrpPct = Number(settings.mrp_markup_percent ?? 40);
const step = Math.max(1, Number(settings.price_round_to) || 1);
const up = (v) => Math.ceil(v / step - 1e-9) * step;
for (const p of all('SELECT id, cost_per_pcs, pcs_per_set FROM products')) {
  if (!(p.cost_per_pcs > 0)) continue;
  run('UPDATE products SET expected_per_set = ?, mrp_per_set = ? WHERE id = ?',
    up(p.cost_per_pcs * (1 + sellPct / 100)) * p.pcs_per_set, up(p.cost_per_pcs * (1 + mrpPct / 100)) * p.pcs_per_set, p.id);
  run('UPDATE grn_items SET expected_per_set = (SELECT expected_per_set FROM products WHERE id = ?), mrp_per_set = (SELECT mrp_per_set FROM products WHERE id = ?) WHERE product_id = ?', p.id, p.id, p.id);
}

/* ---------- first run only: a cashier login and shop details ---------- */
if (!RESET) {
  if (!get(`SELECT id FROM users WHERE username = 'cashier'`)) {
    run(`INSERT INTO users (username, name, password_hash, role) VALUES ('cashier', 'Demo Cashier', ?, 'cashier')`, hashPassword('cashier123'));
  }
  run(`UPDATE settings SET value = 'Demo Wholesale Traders' WHERE key = 'shop_name'`);
  run(`UPDATE settings SET value = '45, Main Street, Pettah, Colombo 11' WHERE key = 'shop_address'`);
  run(`UPDATE settings SET value = '011 234 5678' WHERE key = 'shop_phone'`);
}

const products = get('SELECT COUNT(*) AS n FROM products').n;
console.log(`Demo stock added: ${grns.length} GRNs (${grns.map((g) => g.grn_no).join(', ')}), ${products} products from the catalogue.`);
