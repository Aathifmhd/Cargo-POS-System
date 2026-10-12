// Fills an EMPTY database with realistic demo data so the system can be explored.
// Usage: npm run seed
import { get, run, todayStr, addDays } from './db.js';
import { createGrn, createSale } from './services.js';
import { hashPassword } from './auth.js';

if (get('SELECT COUNT(*) AS n FROM products').n > 0) {
  console.log('Database already has products - seed skipped. Delete backend/data/cargo-pos.db to start fresh.');
  process.exit(0);
}

const today = todayStr();
const sup = (name, city, state, phone, credit_days) =>
  run(`INSERT INTO suppliers (name, contact_person, city, state, phone, whatsapp, credit_days) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    name, name.split(' ')[0] + ' bhai', city, state, phone, phone, credit_days).lastInsertRowid;
const cus = (name, shop, city, phone, limit, days) =>
  run(`INSERT INTO customers (name, shop_name, city, phone, credit_limit, credit_days) VALUES (?, ?, ?, ?, ?, ?)`,
    name, shop, city, phone, limit, days).lastInsertRowid;

const s1 = sup('Shree Ganesh Textiles', 'Surat', 'Gujarat', '+91 98250 11111', 30);
const s2 = sup('Tiruppur Knit Exports', 'Tiruppur', 'Tamil Nadu', '+91 94430 22222', 45);
const s3 = sup('Mumbai Fancy Garments', 'Mumbai', 'Maharashtra', '+91 98200 33333', 15);

const c1 = cus('Mohamed Rizwan', 'Rizwan Fashion', 'Kandy', '077 123 4567', 300000, 30);
const c2 = cus('Saman Perera', 'Perera Textiles', 'Kurunegala', '071 765 4321', 200000, 21);
const c3 = cus('Fathima Nusra', 'Nusra Collection', 'Batticaloa', '075 222 3344', 150000, 14);
const c4 = cus('Kumar Rajan', 'KR Stores', 'Jaffna', '076 555 8899', 0, 0);

const g1 = createGrn({
  date: addDays(today, -40), supplier_id: s1, supplier_invoice_no: 'SGT/2291', cargo_name: 'Lanka Speed Cargo',
  bale_no: 'B-101', lr_no: 'LR-558211', exchange_rate: 3.58, cargo_charge_inr: 6500, payment_type: 'credit',
  expenses: [{ label: 'Clearing', amount_lkr: 12000 }, { label: 'Transport', amount_lkr: 4500 }],
  items: [
    { name: 'Ladies Cotton Kurti', category: 'Ladies Wear', pcs_per_set: 4, colors_count: 4, sizes: 'M, L, XL, XXL', sets: 25, cost_inr_per_set: 1400, mrp_per_set: 9800, expected_per_set: 7600, reorder_sets: 5 },
    { name: 'Printed Saree (Georgette)', category: 'Sarees', pcs_per_set: 5, colors_count: 5, sizes: 'Free', sets: 12, cost_inr_per_set: 3250, mrp_per_set: 21500, expected_per_set: 17000, reorder_sets: 3 },
  ],
});
const g2 = createGrn({
  date: addDays(today, -21), supplier_id: s2, supplier_invoice_no: 'TKE-778', cargo_name: 'Ceylon Express Cargo',
  bale_no: 'B-117, B-118', lr_no: 'LR-90114', exchange_rate: 3.61, cargo_charge_inr: 9800, payment_type: 'credit',
  expenses: [{ label: 'Clearing', amount_lkr: 15000 }, { label: 'Transport', amount_lkr: 6000 }, { label: 'Unloading', amount_lkr: 2000 }],
  items: [
    { name: 'Gents Round Neck T-Shirt', category: 'Gents Wear', pcs_per_set: 6, colors_count: 3, sizes: 'S, M, L, XL, XXL, 3XL', sets: 40, cost_inr_per_set: 690, mrp_per_set: 5400, expected_per_set: 4100, reorder_sets: 8 },
    { name: 'Kids Shorts Set', category: 'Kids Wear', pcs_per_set: 6, colors_count: 6, sizes: '2-12 yrs', sets: 30, cost_inr_per_set: 540, mrp_per_set: 4200, expected_per_set: 3200, reorder_sets: 6 },
    { name: 'Gents Track Pant', category: 'Gents Wear', pcs_per_set: 5, colors_count: 2, sizes: 'M, L, XL, XXL, 3XL', sets: 20, cost_inr_per_set: 1150, mrp_per_set: 8200, expected_per_set: 6300, reorder_sets: 4 },
  ],
});
const g3 = createGrn({
  date: addDays(today, -6), supplier_id: s3, supplier_invoice_no: 'MFG/45', cargo_name: 'Lanka Speed Cargo',
  bale_no: 'B-125', lr_no: 'LR-561002', exchange_rate: 3.63, cargo_charge_inr: 4200, cargo_in_supplier_bill: true, payment_type: 'paid',
  payment_method: 'Bank transfer', expenses: [{ label: 'Clearing', amount_lkr: 8000 }],
  items: [
    { name: 'Ladies Leggings', category: 'Ladies Wear', pcs_per_set: 12, colors_count: 12, sizes: 'Free', sets: 15, cost_inr_per_set: 960, mrp_per_set: 7800, expected_per_set: 5900, reorder_sets: 4 },
    { name: 'Baby Frock', category: 'Kids Wear', pcs_per_set: 4, colors_count: 4, sizes: '0-3 yrs', sets: 18, cost_inr_per_set: 620, mrp_per_set: 4600, expected_per_set: 3500, reorder_sets: 4 },
  ],
});

// partial payment to the first supplier
run(`INSERT INTO supplier_payments (supplier_id, grn_id, date, amount_inr, exchange_rate, amount_lkr, method, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, s1, g1.id, addDays(today, -15), 40000, 3.60, 144000, 'Hawala', 'H-2231');

const ids = Object.fromEntries([...g1.items, ...g2.items, ...g3.items].map((i) => [i.name, i.product_id]));
const price = (name, unit = 'set') => {
  const p = get('SELECT expected_per_set, pcs_per_set FROM products WHERE id = ?', ids[name]);
  return unit === 'set' ? p.expected_per_set : Math.round(p.expected_per_set / p.pcs_per_set * 1.1);
};
const line = (name, qty, unit = 'set', adj = 0) => ({ product_id: ids[name], qty, unit, price: price(name, unit) + adj });

const sales = [
  [-18, c1, 'credit', [line('Ladies Cotton Kurti', 5), line('Printed Saree (Georgette)', 2, 'set', -300)]],
  [-15, null, 'cash', [line('Ladies Cotton Kurti', 2)]],
  [-12, c2, 'credit', [line('Gents Round Neck T-Shirt', 6), line('Kids Shorts Set', 5)]],
  [-9, c3, 'credit', [line('Gents Track Pant', 3), line('Kids Shorts Set', 4, 'set', -100)]],
  [-7, null, 'cash', [line('Gents Round Neck T-Shirt', 3), line('Ladies Cotton Kurti', 3, 'pcs')]],
  [-5, c4, 'cash', [line('Ladies Leggings', 2), line('Baby Frock', 3)]],
  [-3, c1, 'credit', [line('Ladies Leggings', 4), line('Gents Round Neck T-Shirt', 8)]],
  [-2, null, 'cash', [line('Baby Frock', 2), line('Kids Shorts Set', 2)]],
  [-1, c2, 'cash', [line('Printed Saree (Georgette)', 3)]],
  [0, null, 'cash', [line('Gents Track Pant', 2), line('Ladies Leggings', 1)]],
  [0, c3, 'credit', [line('Ladies Cotton Kurti', 4), line('Baby Frock', 2)]],
];
for (const [d, customer_id, payment_type, items] of sales) {
  createSale({ date: addDays(today, d), customer_id, payment_type, items, paid_amount: payment_type === 'credit' ? 10000 : 0 });
}
run(`INSERT INTO customer_payments (customer_id, date, amount, method, reference) VALUES (?, ?, ?, ?, ?)`, c1, addDays(today, -4), 30000, 'Bank transfer', 'BOC 88123');
if (!get(`SELECT id FROM users WHERE username = 'cashier'`)) {
  run(`INSERT INTO users (username, name, password_hash, role) VALUES ('cashier', 'Demo Cashier', ?, 'cashier')`, hashPassword('cashier123'));
}
run(`UPDATE settings SET value = 'Demo Wholesale Traders' WHERE key = 'shop_name'`);
run(`UPDATE settings SET value = '45, Main Street, Pettah, Colombo 11' WHERE key = 'shop_address'`);
run(`UPDATE settings SET value = '011 234 5678' WHERE key = 'shop_phone'`);

console.log(`Demo data added: 3 suppliers, 4 customers, 3 GRNs (${g1.grn_no}, ${g2.grn_no}, ${g3.grn_no}), ${sales.length} sales.`);
