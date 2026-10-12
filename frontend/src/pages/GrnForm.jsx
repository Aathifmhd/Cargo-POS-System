import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, n, r2, lkr, inr, money, today, addDays, computeLanding, margin, pct, int, PAY_METHODS_SUPPLIER } from '../lib.js';
import { PageHeader, Card, Icon, Field, NumInput, Combobox, Segmented, useToast, Loading } from '../components/ui.jsx';
import { SupplierForm } from '../components/forms.jsx';
import { useFx, useSettings } from '../App.jsx';

const DRAFT = 'cargo-grn-draft';
const EXPENSE_PRESETS = ['Clearing charges', 'Customs / Duty', 'Transport', 'Loading / Unloading', 'Bank charges'];
let keySeq = 1;
const blankItem = () => ({ key: keySeq++, product_id: null, name: '', category: '', pcs_per_set: '', colors_count: '', color_names: '', sizes: '', sets: '', cost_inr_per_set: '', mrp_per_set: '', expected_per_set: '', reorder_sets: '' });

export default function GrnForm() {
  const { settings } = useSettings();
  const { fx } = useFx();
  const toast = useToast();
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [cargoNames, setCargoNames] = useState([]);
  const [newSupplier, setNewSupplier] = useState(null);
  const [busy, setBusy] = useState(false);
  const [markup, setMarkup] = useState(settings.default_markup_percent || 40);
  const [mrpMarkup, setMrpMarkup] = useState(25);

  const initial = useMemo(() => {
    try { const d = JSON.parse(localStorage.getItem(DRAFT)); if (d?.items?.length) { d.items.forEach((i) => (i.key = keySeq++)); return d; } } catch { /* ignore */ }
    return {
      date: today(), supplier_id: null, supplier_invoice_no: '', cargo_name: '', bale_no: '', lr_no: '',
      exchange_rate: fx?.rate ?? settings.default_exchange_rate, cargo_charge_inr: '', cargo_in_supplier_bill: false,
      payment_type: 'credit', due_date: '', payment_method: 'Bank transfer', payment_reference: '', notes: '',
      expenses: [{ label: 'Clearing charges', amount_lkr: '' }, { label: 'Transport', amount_lkr: '' }],
      items: [blankItem()],
    };
  }, []); // eslint-disable-line
  const [g, setG] = useState(initial);
  const set = (k) => (v) => setG((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));

  useEffect(() => { localStorage.setItem(DRAFT, JSON.stringify(g)); }, [g]);
  useEffect(() => {
    api.get('/suppliers').then((s) => setSuppliers(s.filter((x) => x.active)));
    api.get('/products?active=all').then(setProducts);
    api.get('/products/categories').then(setCategories);
    api.get('/grns/cargo-names').then(setCargoNames);
  }, []);

  const supplier = (suppliers || []).find((s) => s.id === g.supplier_id);
  useEffect(() => {
    if (supplier && g.payment_type === 'credit') setG((x) => ({ ...x, due_date: addDays(x.date, supplier.credit_days) }));
  }, [g.supplier_id, g.date, g.payment_type]); // eslint-disable-line

  const calc = useMemo(() => computeLanding(g), [g]);
  const updItem = (key, patch) => setG((x) => ({ ...x, items: x.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) }));
  const delItem = (key) => setG((x) => ({ ...x, items: x.items.length > 1 ? x.items.filter((i) => i.key !== key) : [blankItem()] }));
  const addItem = () => setG((x) => ({ ...x, items: [...x.items, blankItem()] }));
  const updExp = (idx, patch) => setG((x) => ({ ...x, expenses: x.expenses.map((e, i) => (i === idx ? { ...e, ...patch } : e)) }));

  const pickProduct = (key, p) => updItem(key, {
    product_id: p.id, name: p.name, category: p.category || '', pcs_per_set: p.pcs_per_set, colors_count: p.colors_count || '',
    color_names: p.color_names || '', sizes: p.sizes || '', mrp_per_set: p.mrp_per_set || '', expected_per_set: p.expected_per_set || '', reorder_sets: p.reorder_sets || '',
  });

  const applyMarkup = () => setG((x) => ({
    ...x,
    items: x.items.map((it, i) => {
      const landed = calc.items[i]?.landed_per_set_lkr || 0;
      if (!landed) return it;
      const expected = Math.ceil((landed * (1 + n(markup) / 100)) / 10) * 10;
      return { ...it, expected_per_set: expected, mrp_per_set: Math.ceil((expected * (1 + n(mrpMarkup) / 100)) / 10) * 10 };
    }),
  }));

  const expectedValue = g.items.reduce((s, it, i) => s + n(it.expected_per_set) * (calc.items[i]?.sets || 0), 0);
  const filledItems = g.items.filter((i) => (i.product_id || i.name.trim()) && n(i.sets) > 0);

  const save = async () => {
    if (!g.supplier_id) return toast('Choose the supplier', 'error');
    if (n(g.exchange_rate) <= 0) return toast('Enter the exchange rate', 'error');
    if (!filledItems.length) return toast('Add at least one item with sets and cost', 'error');
    const missing = filledItems.find((i) => n(i.cost_inr_per_set) <= 0);
    if (missing && !confirm(`"${missing.name}" has no cost. Save anyway?`)) return;
    setBusy(true);
    try {
      const saved = await api.post('/grns', { ...g, items: filledItems });
      localStorage.removeItem(DRAFT);
      toast(`${saved.grn_no} saved — stock updated`);
      navigate(`/grn/${saved.id}`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const reset = () => { if (confirm('Clear this form and start again?')) { localStorage.removeItem(DRAFT); setG({ ...initial, items: [blankItem()], supplier_id: null }); window.location.reload(); } };

  if (!suppliers) return <Loading />;

  return (
    <div>
      <PageHeader title="Receive Goods (GRN)" subtitle="Enter a shipment from India. The system works out the real landed cost of every item in LKR."
        actions={<button className="btn btn-ghost" onClick={reset}><Icon name="trash" size={16} /> Clear form</button>} />

      <div className="grn-layout">
        <div className="stack">
          {/* STEP 1 */}
          <Card title={<span className="step-title"><span className="step-no">1</span> Shipment details</span>}>
            <div className="grid grid-3">
              <Field label="Supplier" required className="span-2">
                <Combobox items={suppliers} value={g.supplier_id} onSelect={(s) => set('supplier_id')(s.id)} placeholder="Search supplier…"
                  getSub={(s) => [s.city, s.balance_inr > 0 ? `owe ${inr(s.balance_inr)}` : ''].filter(Boolean).join(' · ')}
                  onCreate={(name) => setNewSupplier(name)} createLabel={(q) => `Add new supplier “${q}”`} />
              </Field>
              <Field label="Date received"><input type="date" className="input" value={g.date} onChange={set('date')} /></Field>
              <Field label="Cargo name" hint="Cargo / courier company">
                <input className="input" list="cargo-list" value={g.cargo_name} onChange={set('cargo_name')} placeholder="e.g. Lanka Speed Cargo" />
                <datalist id="cargo-list">{cargoNames.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Bale number"><input className="input" value={g.bale_no} onChange={set('bale_no')} placeholder="e.g. B-125" /></Field>
              <Field label="LR number" hint="Lorry receipt / tracking no"><input className="input" value={g.lr_no} onChange={set('lr_no')} /></Field>
              <Field label="Supplier invoice no"><input className="input" value={g.supplier_invoice_no} onChange={set('supplier_invoice_no')} /></Field>
              <Field label="Exchange rate for this package" required
                hint={fx && Math.abs(n(g.exchange_rate) - fx.rate) > 0.00005
                  ? <button type="button" className="link-btn" style={{ marginLeft: 0 }} onClick={() => set('exchange_rate')(fx.rate)}>Use today's {fx.mode === 'manual' ? '' : 'live '}rate Rs {fx.rate.toFixed(4)}</button>
                  : `Today's ${fx?.mode === 'manual' ? '' : 'live '}rate · edit if your rate differs`}>
                <div className="input-affix"><span>Rs</span><NumInput value={g.exchange_rate} onChange={set('exchange_rate')} /></div>
              </Field>
              <Field label="Notes"><input className="input" value={g.notes} onChange={set('notes')} /></Field>
            </div>
          </Card>

          {/* STEP 2 */}
          <Card title={<span className="step-title"><span className="step-no">2</span> Items in this bale</span>}
            actions={<span className="muted small">{filledItems.length} items · {int(calc.total_sets)} sets · {int(calc.total_pcs)} pcs</span>}>
            <datalist id="cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            {g.items.map((it, idx) => {
              const c = calc.items[idx] || {};
              const m = margin(it.expected_per_set, c.landed_per_set_lkr);
              return (
                <div key={it.key} className="item-card">
                  <div className="item-head">
                    <span className="item-no">{idx + 1}.</span>
                    <div className="spacer">
                      {it.product_id || it.name ? (
                        <div className="row gap-s" style={{ minHeight: 38 }}>
                          <b style={{ fontSize: 15 }}>{it.name}</b>
                          {it.product_id ? <span className="badge badge-teal">Existing product</span> : <span className="badge badge-violet">New product</span>}
                          <button className="btn btn-sm btn-ghost" onClick={() => updItem(it.key, { product_id: null, name: '' })}>Change</button>
                        </div>
                      ) : (
                        <Combobox items={products} value={null} onSelect={(p) => pickProduct(it.key, p)}
                          placeholder="Search existing product, or type a new product name…"
                          getLabel={(p) => p.name} getSub={(p) => `${p.code} · ${p.pcs_per_set} pcs/set`}
                          filterKeys={(p) => `${p.name} ${p.code} ${p.category || ''}`}
                          onCreate={(name) => updItem(it.key, { name, product_id: null })} createLabel={(q) => `New product “${q}”`} />
                      )}
                    </div>
                    <button className="btn btn-icon btn-ghost" title="Remove item" onClick={() => delItem(it.key)}><Icon name="trash" size={16} /></button>
                  </div>

                  <div className="item-fields">
                    <Field label="Category"><input className="input" list="cat-list" value={it.category} onChange={(e) => updItem(it.key, { category: e.target.value })} placeholder="Ladies Wear" /></Field>
                    <Field label="Pieces per set" hint="Pcs in one pack"><NumInput value={it.pcs_per_set} onChange={(v) => updItem(it.key, { pcs_per_set: v })} placeholder="1" /></Field>
                    <Field label="No. of colours"><NumInput value={it.colors_count} onChange={(v) => updItem(it.key, { colors_count: v })} placeholder="0" /></Field>
                    <Field label="Sizes"><input className="input" value={it.sizes} onChange={(e) => updItem(it.key, { sizes: e.target.value })} placeholder="M, L, XL" /></Field>
                    <Field label="No. of sets" required><NumInput value={it.sets} onChange={(v) => updItem(it.key, { sets: v })} placeholder="0" /></Field>
                    <Field label="Cost per set (₹ INR)" required><NumInput value={it.cost_inr_per_set} onChange={(v) => updItem(it.key, { cost_inr_per_set: v })} placeholder="0.00" /></Field>
                  </div>

                  <div className="item-calc">
                    <div className="calc-pill">Line total<b>{inr(c.line_inr)}</b></div>
                    <div className="calc-pill hl">Landed cost / set<b>{lkr(c.landed_per_set_lkr)}</b></div>
                    <div className="calc-pill hl">Landed cost / piece<b>{lkr(c.landed_per_pcs_lkr)}</b></div>
                    <div className="calc-pill">Total pieces<b>{int(c.pcs)}</b></div>
                  </div>

                  <div className="item-fields">
                    <Field label="Expected selling price / set (Rs)" className="span-2"
                      hint={c.landed_per_set_lkr > 0 && n(it.expected_per_set) > 0 ? <span className={m < 0 ? 'text-red' : m < 15 ? 'text-amber' : 'text-green'}>Margin {pct(m)} · profit {lkr(n(it.expected_per_set) - c.landed_per_set_lkr)} per set</span> : 'What you plan to sell one set for'}>
                      <NumInput value={it.expected_per_set} onChange={(v) => updItem(it.key, { expected_per_set: v })} placeholder="0.00" />
                    </Field>
                    <Field label="MRP / set (Rs)" className="span-2" hint="Printed / maximum retail price">
                      <NumInput value={it.mrp_per_set} onChange={(v) => updItem(it.key, { mrp_per_set: v })} placeholder="0.00" />
                    </Field>
                    <Field label="Colour names" hint="Optional"><input className="input" value={it.color_names} onChange={(e) => updItem(it.key, { color_names: e.target.value })} /></Field>
                    <Field label="Re-order at (sets)" hint="Low stock alert"><NumInput value={it.reorder_sets} onChange={(v) => updItem(it.key, { reorder_sets: v })} placeholder="0" /></Field>
                  </div>
                </div>
              );
            })}
            <div className="row gap mt wrap">
              <button className="btn" onClick={addItem}><Icon name="plus" /> Add another item</button>
              <span className="spacer" />
              <span className="muted small">Quick pricing:</span>
              <div className="row gap-s">
                <span className="small">Expected =</span>
                <div className="input-affix" style={{ width: 90 }}><span>+%</span><NumInput className="input-sm" value={markup} onChange={setMarkup} /></div>
                <span className="small">on cost, MRP =</span>
                <div className="input-affix" style={{ width: 90 }}><span>+%</span><NumInput className="input-sm" value={mrpMarkup} onChange={setMrpMarkup} /></div>
                <button className="btn btn-sm" onClick={applyMarkup}>Apply to all</button>
              </div>
            </div>
          </Card>

          {/* STEP 3 */}
          <Card title={<span className="step-title"><span className="step-no">3</span> Cargo charge & other expenses</span>}>
            <div className="grid grid-2">
              <Field label="Cargo charge (₹ INR)" hint={`= ${lkr(n(g.cargo_charge_inr) * n(g.exchange_rate))}`}>
                <div className="input-affix"><span>₹</span><NumInput value={g.cargo_charge_inr} onChange={set('cargo_charge_inr')} /></div>
              </Field>
              <Field label=" ">
                <label className="check" style={{ height: 38 }}>
                  <input type="checkbox" checked={g.cargo_in_supplier_bill} onChange={set('cargo_in_supplier_bill')} />
                  Cargo charge is included in the supplier's bill (we pay it to the supplier)
                </label>
              </Field>
            </div>
            <div className="mt">
              <div className="field-label mb" style={{ marginBottom: 8 }}>Other expenses in Sri Lanka (Rs LKR)</div>
              {g.expenses.map((e, i) => (
                <div key={i} className="expense-row">
                  <input className="input" value={e.label} placeholder="Expense name" onChange={(ev) => updExp(i, { label: ev.target.value })} />
                  <div className="input-affix"><span>Rs</span><NumInput value={e.amount_lkr} onChange={(v) => updExp(i, { amount_lkr: v })} /></div>
                  <button className="btn btn-icon btn-ghost" onClick={() => setG((x) => ({ ...x, expenses: x.expenses.filter((_, j) => j !== i) }))}><Icon name="x" size={16} /></button>
                </div>
              ))}
              <div className="chips" style={{ marginBottom: 0 }}>
                {EXPENSE_PRESETS.filter((p) => !g.expenses.some((e) => e.label === p)).map((p) => (
                  <button key={p} className="chip" onClick={() => setG((x) => ({ ...x, expenses: [...x.expenses, { label: p, amount_lkr: '' }] }))}>+ {p}</button>
                ))}
                <button className="chip" onClick={() => setG((x) => ({ ...x, expenses: [...x.expenses, { label: '', amount_lkr: '' }] }))}>+ Other</button>
              </div>
            </div>
          </Card>

          {/* STEP 4 */}
          <Card title={<span className="step-title"><span className="step-no">4</span> Supplier payment</span>}>
            <div className="grid grid-3">
              <Field label="How will you pay the supplier?" className="span-2">
                <Segmented size="lg" value={g.payment_type} onChange={set('payment_type')} options={[
                  { value: 'credit', label: 'Credit (pay later)', icon: 'clock', tone: 'amber' },
                  { value: 'paid', label: 'Paid in full now', icon: 'check', tone: 'green' },
                ]} />
              </Field>
              {g.payment_type === 'credit' ? (
                <Field label="Payment due date" hint={supplier ? `${supplier.name}: ${supplier.credit_days} days credit` : ''}>
                  <input type="date" className="input" value={g.due_date} onChange={set('due_date')} />
                </Field>
              ) : (
                <Field label="Paid by"><select className="input" value={g.payment_method} onChange={set('payment_method')}>{PAY_METHODS_SUPPLIER.map((m) => <option key={m}>{m}</option>)}</select></Field>
              )}
            </div>
            {g.payment_type === 'paid' && <Field label="Payment reference" className="mt"><input className="input" value={g.payment_reference} onChange={set('payment_reference')} /></Field>}
            <div className="alert alert-blue small mt">
              <Icon name="info" size={16} />
              {g.payment_type === 'paid'
                ? <span>Paid now — the cost of these goods is <b>fixed at Rs {n(g.exchange_rate).toFixed(4)}</b> per rupee.</span>
                : <span>On credit — the cost of these goods <b>follows the live INR rate every day</b> until the supplier bill is paid. Each payment fixes its part at the rate you paid.</span>}
            </div>
          </Card>
        </div>

        {/* SUMMARY */}
        <div className="grn-summary stack">
          <Card title="Landed cost summary">
            <dl className="kv">
              <dt>Goods value</dt><dd>{inr(calc.goods_inr)}</dd>
              <dt>Cargo charge</dt><dd>{inr(calc.cargo_inr)}</dd>
              <dt className="strong">Total in INR</dt><dd>{inr(calc.goods_inr + calc.cargo_inr)}</dd>
              <dt>× Exchange rate</dt><dd>{n(g.exchange_rate).toFixed(2)}</dd>
              <dt>= In LKR</dt><dd>{lkr((calc.goods_inr + calc.cargo_inr) * n(g.exchange_rate))}</dd>
              <dt>+ Expenses (LKR)</dt><dd>{lkr(calc.expenses_lkr)}</dd>
              <dt className="total">Total landed cost</dt><dd className="total">{lkr(calc.total_lkr)}</dd>
            </dl>
            <div className="formula mt">
              <b>Landing factor: {calc.landing_factor ? calc.landing_factor.toFixed(3) : '—'}</b><br />
              Every ₹1 of goods really costs <b>Rs {calc.landing_factor ? calc.landing_factor.toFixed(2) : '—'}</b> after cargo & expenses.
            </div>
            <dl className="kv mt">
              <dt>Sets / pieces</dt><dd>{int(calc.total_sets)} / {int(calc.total_pcs)}</dd>
              <dt>Expected sales value</dt><dd>{lkr(expectedValue)}</dd>
              <dt>Expected profit</dt><dd className={expectedValue - calc.total_lkr < 0 ? 'text-red' : 'text-green'}>{lkr(expectedValue - calc.total_lkr)} ({pct(margin(expectedValue, calc.total_lkr))})</dd>
              <dt>Payable to supplier</dt><dd>{inr(calc.goods_inr + (g.cargo_in_supplier_bill ? calc.cargo_inr : 0))}</dd>
            </dl>
          </Card>
          <button className="btn btn-primary btn-lg btn-block" onClick={save} disabled={busy}><Icon name="check" /> {busy ? 'Saving…' : 'Save GRN & add to stock'}</button>
          <p className="muted small center">Draft is saved automatically on this computer until you save.</p>
        </div>
      </div>

      {newSupplier != null && (
        <SupplierForm initialName={newSupplier} onClose={() => setNewSupplier(null)}
          onSaved={(s) => { setSuppliers((x) => [...x, { ...s, balance_inr: s.opening_balance_inr }]); set('supplier_id')(s.id); setNewSupplier(null); }} />
      )}
    </div>
  );
}
