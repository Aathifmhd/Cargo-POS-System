import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, n, r2, lkr, inr, money, today, addDays, computeLanding, margin, pct, int, PAY_METHODS_SUPPLIER, parseCatalog, findCategory, priceRules, autoPrices } from '../lib.js';
import { PageHeader, Card, Icon, Field, NumInput, Combobox, Segmented, useToast, Loading } from '../components/ui.jsx';
import { SupplierForm } from '../components/forms.jsx';
import SizePicker from '../components/SizePicker.jsx';
import { useSettings } from '../App.jsx';

const DRAFT = 'cargo-grn-draft-v2';   // v2: cargo is paid in LKR; each item has its own cargo charge
let keySeq = 1;
const blankItem = () => ({ key: keySeq++, product_id: null, name: '', category: '', subtype: '', pcs_per_set: '', colors_count: '', color_names: '', sizes: '', sets: '', extra_pcs: '', short_sets: '', short_pcs: '', cost_inr_per_pcs: '', cargo_per_pcs: '', other_per_pcs: '', mrp_per_pcs: '', expected_per_pcs: '' });
/**
 * Older GRNs and drafts kept the cargo as shared charges (per category, or for the whole shipment).
 * Move each item's share onto the item itself, so every cost stays exactly as it was.
 */
const cargoOntoItems = (items, expenses, rate) => {
  const charges = (expenses || []).filter((e) => n(e.amount_lkr) !== 0);
  if (!charges.length) return items;
  const c = computeLanding({ items: items.map((i) => ({ ...i, cargo_lkr: 0 })), expenses: charges, exchange_rate: rate });
  const shares = c.items.map((x) => r2(Math.max(0, x.landed_lkr - x.line_inr * rate)));
  // rounding cents go to the biggest share, so the cargo total stays exactly the same
  const big = shares.indexOf(Math.max(...shares));
  shares[big] = r2(shares[big] + charges.reduce((t, e) => t + n(e.amount_lkr), 0) - shares.reduce((t, v) => t + v, 0));
  return items.map((i, k) => ({ ...i, cargo_lkr: r2(n(i.cargo_lkr) + shares[k]) || '' }));
};
/** Lines kept as totals (older GRNs and drafts) → the same cargo and other expenses per piece. */
const chargesPerPiece = (items) => items.map((i) => {
  if (i.cargo_per_pcs !== undefined && i.other_per_pcs !== undefined && !n(i.cargo_lkr) && !n(i.other_lkr)) return i;
  const paid = computeLanding({ items: [{ ...i, cargo_per_pcs: undefined, other_per_pcs: undefined }], exchange_rate: 1 }).items[0].paid_pcs || 1;
  const per = (given, total) => (given !== undefined && given !== null && given !== '' ? given : n(total) ? r2(n(total) / paid) : '');
  const { cargo_lkr, other_lkr, ...rest } = i;
  return { ...rest, cargo_per_pcs: per(i.cargo_per_pcs, cargo_lkr), other_per_pcs: per(i.other_per_pcs, other_lkr) };
});
// prices are entered per piece; products keep them per set, so convert on the way in and out
const ppsOf = (it) => Math.max(1, Math.round(n(it.pcs_per_set) || 1));
const perPiece = (v, pps) => (n(v) > 0 ? r2(n(v) / Math.max(1, Math.round(n(pps) || 1))) : '');
const withPcsPrices = (it) => {
  let x = it.expected_per_pcs !== undefined ? it : { ...it, expected_per_pcs: perPiece(it.expected_per_set, it.pcs_per_set), mrp_per_pcs: perPiece(it.mrp_per_set, it.pcs_per_set) };
  if (x.cost_inr_per_pcs === undefined) { x = { ...x, cost_inr_per_pcs: perPiece(x.cost_inr_per_set, x.pcs_per_set) }; delete x.cost_inr_per_set; }
  return x;
};
const forSaving = (it) => ({ ...it, cost_inr_per_set: r2(n(it.cost_inr_per_pcs) * ppsOf(it)), expected_per_set: r2(n(it.expected_per_pcs) * ppsOf(it)), mrp_per_set: r2(n(it.mrp_per_pcs) * ppsOf(it)) });

export default function GrnForm() {
  const { settings, reload: reloadSettings } = useSettings();
  const toast = useToast();
  const navigate = useNavigate();
  // /grn/:id/edit — fixing a GRN that was entered wrongly (saving needs the Super Admin's password)
  const { id: editId } = useParams();
  const [editing, setEditing] = useState(editId ? null : false); // null while the GRN loads, then its GRN number
  const loadedRef = useRef('');   // the GRN as loaded (to spot unsaved changes)
  // back to the Shipments list with this GRN open in its pop-up
  const backToGrn = (grnId = editId) => navigate('/grn', { state: { openGrn: Number(grnId) } });
  const [suppliers, setSuppliers] = useState(null);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [cargoNames, setCargoNames] = useState([]);
  const [newSupplier, setNewSupplier] = useState(null);
  const [busy, setBusy] = useState(false);

  const initial = useMemo(() => {
    if (editId) return { items: [], entry: blankItem(), editingKey: null, expenses: [] };
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT));
      if (d && Array.isArray(d.items)) {
        // the list holds only added items; the entry card is the item being typed in (or edited)
        d.items = d.items.filter((i) => i.name || i.product_id).map((i) => withPcsPrices({ ...i, key: keySeq++ }));
        d.entry = withPcsPrices({ ...(d.entry || blankItem()), key: keySeq++ });
        d.editingKey = null;
        // an older draft's shared cargo charges move onto its items
        d.items = chargesPerPiece(cargoOntoItems(d.items, d.expenses, n(settings.costing_rate) || 3.5));
        d.entry = chargesPerPiece([d.entry])[0];
        d.expenses = [];
        return d;
      }
    } catch { /* ignore */ }
    return {
      date: today(), supplier_id: null, supplier_invoice_no: '', supplier_bill_date: '', cargo_name: '',
      payment_type: 'credit', due_date: '', payment_method: 'Bank transfer', payment_reference: '', notes: '',
      expenses: [],   // older GRNs only: the cargo is now entered on each item
      items: [], entry: blankItem(), editingKey: null,
    };
  }, []); // eslint-disable-line
  const [g, setG] = useState(initial);
  const set = (k) => (v) => setG((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));

  useEffect(() => { if (!editId) localStorage.setItem(DRAFT, JSON.stringify(g)); }, [g, editId]);   // edits are not kept as a draft
  useEffect(() => { if (loadedRef.current === 'pending') loadedRef.current = JSON.stringify({ ...g, entry: null }); }, [g]);

  // editing: load the GRN into the form, keeping its prices as they were
  useEffect(() => {
    if (!editId) return;
    api.get(`/grns/${editId}`).then((d) => {
      const pp = (v, pps) => (n(v) > 0 ? r2(n(v) / Math.max(1, n(pps) || 1)) : '');
      setG({
        date: d.date, supplier_id: d.supplier_id, supplier_invoice_no: d.supplier_invoice_no || '', supplier_bill_date: d.supplier_bill_date || '', cargo_name: d.cargo_name || '',
        payment_type: d.payment_type, due_date: d.due_date || '', payment_method: d.payments?.[0]?.method || 'Bank transfer', payment_reference: '', notes: d.notes || '',
        expenses: [],
        // an older GRN's shared cargo charges move onto its items (same costs)
        items: cargoOntoItems(d.items.map((i) => ({
          key: keySeq++, product_id: i.product_id, name: i.name, category: i.category || '', subtype: i.subtype || '', pname: i.pname || '',
          catOther: false, isNew: false, pcs_per_set: i.pcs_per_set, colors_count: i.colors_count || '', color_names: i.color_names || '', sizes: i.sizes || '',
          sets: i.sets, extra_pcs: i.extra_pcs || '', short_sets: i.short_sets || '', short_pcs: i.short_pcs || '', showQty: Boolean(i.extra_pcs || i.short_pcs || i.short_sets),
          cost_inr_per_pcs: pp(i.cost_inr_per_set, i.pcs_per_set), cargo_lkr: i.cargo_per_pcs != null ? '' : i.cargo_lkr || '', other_lkr: i.other_per_pcs != null ? '' : i.other_lkr || '',
          cargo_per_pcs: i.cargo_per_pcs ?? undefined, other_per_pcs: i.other_per_pcs ?? undefined, expected_per_pcs: pp(i.expected_per_set, i.pcs_per_set), mrp_per_pcs: pp(i.mrp_per_set, i.pcs_per_set),
          expectedManual: true, mrpManual: true,
        })), d.expenses, d.exchange_rate).map((i) => chargesPerPiece([i])[0]),
        entry: blankItem(), editingKey: null,
      });
      setFormOpen(false);
      keepDue.current = true;
      setEditing(d.grn_no);
      loadedRef.current = 'pending';   // taken on the next render, once the form holds the loaded GRN
    }).catch((e) => { toast(e.message, 'error'); navigate('/grn'); });
  }, [editId]); // eslint-disable-line
  useEffect(() => {
    api.get('/suppliers').then((s) => setSuppliers(s.filter((x) => x.active)));
    api.get('/products?active=all').then(setProducts);
    api.get('/products/categories').then(setCategories);
    api.get('/grns/cargo-names').then(setCargoNames);
    reloadSettings(); // the latest categories, products and sizes from Settings
  }, []);

  const supplier = (suppliers || []).find((s) => s.id === g.supplier_id);
  // the due date follows the supplier's credit days — but a GRN loaded for editing keeps its own due date
  const keepDue = useRef(false);
  useEffect(() => {
    if (keepDue.current) { keepDue.current = false; return; }
    if (supplier && g.payment_type === 'credit') setG((x) => ({ ...x, due_date: addDays(x.date, supplier.credit_days) }));
  }, [g.supplier_id, g.date, g.payment_type]); // eslint-disable-line

  // the bale's figures come from the added items only
  // every cost is worked out at the fixed costing rate (Settings → Exchange rate), never the live rate
  const rate = n(settings.costing_rate) || 3.5;
  const calc = useMemo(() => computeLanding({ ...g, exchange_rate: rate }), [g, rate]);
  // the entry card's own figures: worked out as if it were already in the list (charges are shared by value)
  const entryIdx = g.editingKey ? g.items.findIndex((i) => i.key === g.editingKey) : g.items.length;
  const preview = useMemo(() => {
    const items = g.editingKey ? g.items.map((i) => (i.key === g.editingKey ? g.entry : i)) : [...g.items, g.entry];
    return computeLanding({ ...g, exchange_rate: rate, items });
  }, [g, rate]);

  // an item is either the entry card or a line in the list
  const mapItem = (x, key, fn) => (x.entry?.key === key ? { ...x, entry: fn(x.entry) } : { ...x, items: x.items.map((i) => (i.key === key ? fn(i) : i)) });
  const updItem = (key, patch) => setG((x) => mapItem(x, key, (i) => ({ ...i, ...patch })));

  const catalog = useMemo(() => parseCatalog(settings), [settings]);
  const rules = useMemo(() => priceRules(settings), [settings]);

  // Category first: it decides the product types and sizes offered
  const chooseCategory = (key, value) => {
    if (value === '__other') return updItem(key, { catOther: true, category: '', subtype: '', pname: '', product_id: null, name: '', isNew: false, sizes: '', pcsAuto: false });
    updItem(key, { catOther: false, category: value, subtype: '', pname: '', product_id: null, name: '', isNew: false, sizes: '', pcsAuto: false });
  };
  // Category → product ("Kerala") → product name ("Royal Check"): the stock item is "Shirts - Kerala - Royal Check"
  const chooseProduct = (key, type) => setG((x) => mapItem(x, key, (i) => ({ ...i, subtype: type || '', pname: '', product_id: null, name: '', isNew: false })));
  // the product name is typed (it changes from shipment to shipment) and completes the item —
  // stock goes onto the existing item of that name, if there is one
  const typePName = (key, pname) => setG((x) => mapItem(x, key, (i) => {
    const text = pname.trim();
    if (!text) return { ...i, pname, product_id: null, name: '', isNew: false };
    const name = `${i.category} - ${i.subtype} - ${text}`;
    const existing = products.find((p) => p.name.toLowerCase() === name.toLowerCase());
    return existing ? { ...i, pname, product_id: existing.id, name: existing.name, isNew: false } : { ...i, pname, product_id: null, name, isNew: true };
  }));
  // leaving the name box: an existing item fills in what is still empty (pieces per set, sizes, prices…)
  const fillFromExisting = (key) => setG((x) => mapItem(x, key, (i) => {
    const existing = i.product_id && products.find((p) => p.id === i.product_id);
    if (!existing) return i;
    const fill = Object.fromEntries(Object.entries(productFields(existing)).filter(([k]) => i[k] === '' || i[k] == null));
    return { ...i, ...fill };
  }));

  // "+ Add product" in the Products dropdown: saves it under the category for next time, then selects it
  const [adding, setAdding] = useState(null); // { key, text } — a new product being added to the category
  const addProduct = async (it) => {
    const product = (adding?.text || '').trim();
    if (!product) return;
    try {
      const res = await api.post('/catalog/products', { category: it.category, product });
      await reloadSettings();
      setAdding(null);
      chooseProduct(it.key, res.product);
      toast(`"${res.product}" added to ${it.category}`);
    } catch (e) { toast(e.message, 'error'); }
  };

  const productFields = (p) => ({
    product_id: p.id, name: p.name, category: p.category || '', subtype: p.subtype || '', pname: p.pname || '', pcs_per_set: p.pcs_per_set, colors_count: p.colors_count || '',
    color_names: p.color_names || '', sizes: p.sizes || '', mrp_per_pcs: perPiece(p.mrp_per_set, p.pcs_per_set), expected_per_pcs: perPiece(p.expected_per_set, p.pcs_per_set),
  });

  // every piece received (free ones too) can be sold, so expected value is per piece × all pieces
  const expectedValue = g.items.reduce((s, it, i) => {
    const c = calc.items[i];
    return s + (c ? (n(it.expected_per_pcs)) * c.pcs : 0);
  }, 0);
  const hasQty = (i) => n(i.sets) > 0 || n(i.extra_pcs) > 0;
  const filledItems = g.items;
  const extraPcs = calc.items.reduce((s, c) => s + c.extra_pcs, 0);
  const shortPcs = calc.items.reduce((s, c) => s + c.short_sets * c.pcs_per_set + c.short_pcs, 0);
  const entryStarted = Boolean(g.entry.name || g.entry.product_id || n(g.entry.sets) || n(g.entry.cost_inr_per_pcs));
  // the add-item form folds into one "+ Add item" bar under the list; it opens on click or Edit, and folds after adding
  const [formOpen, setFormOpen] = useState(() => !initial.items.length || entryStarted);
  const showForm = formOpen || Boolean(g.editingKey);   // starts open when the list is empty, and can always be folded
  const openForm = () => {
    setFormOpen(true);
    setTimeout(() => document.querySelector('.item-entry')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };

  // Selling price & MRP follow the cost automatically (Settings → Price & billing) until you type your own
  useEffect(() => {
    const withAuto = (it, c) => {
      const auto = c && autoPrices(c.landed_per_pcs_lkr, c.pcs_per_set, rules);
      if (!auto) return it;
      const patch = {};
      if (!it.expectedManual && n(it.expected_per_pcs) !== auto.expected_per_pcs) patch.expected_per_pcs = auto.expected_per_pcs;
      if (!it.mrpManual && n(it.mrp_per_pcs) !== auto.mrp_per_pcs) patch.mrp_per_pcs = auto.mrp_per_pcs;
      return Object.keys(patch).length ? { ...it, ...patch } : it;
    };
    setG((x) => {
      const items = x.items.map((it, i) => (it.key === x.editingKey ? it : withAuto(it, calc.items[i])));
      const entry = withAuto(x.entry, preview.items[entryIdx]);
      return items.some((it, i) => it !== x.items[i]) || entry !== x.entry ? { ...x, items, entry } : x;
    });
  }, [calc, preview, rules]); // eslint-disable-line

  // "Add item" puts the entry card into the list (or saves the changes to the line being edited)
  const addItem = () => {
    const e = g.entry;
    if (!e.category.trim()) return toast('Choose the category', 'error');
    const fromCatalog = !e.catOther && findCategory(catalog, e.category);
    if (fromCatalog && !e.subtype) return toast('Choose the product', 'error');
    // new items need a product name; existing stock items from before product names keep theirs as they are
    if (fromCatalog && !String(e.pname || '').trim() && !e.product_id) return toast('Type the product name', 'error');
    if (!e.name.trim()) return toast('Choose the product', 'error');
    if (!hasQty(e)) return toast('Enter the number of sets', 'error');
    if (n(e.sets) > 0 && n(e.cost_inr_per_pcs) <= 0 && !confirm(`"${e.name}" has no billed price per piece. Add it anyway?`)) return;
    const editing = g.editingKey;
    setG((x) => ({
      ...x,
      items: editing ? x.items.map((i) => (i.key === editing ? { ...e } : i)) : [...x.items, { ...e }],
      // the next item starts in the same category — bales usually hold several products of one kind
      entry: { ...blankItem(), category: e.category, catOther: e.catOther },
      editingKey: null,
    }));
    setAdding(null);
    setFormOpen(false);
    toast(editing ? `${e.name} updated` : `${e.name} added`);
  };
  const editItem = (it) => {
    if (g.editingKey === it.key) return;
    if (!g.editingKey && entryStarted && !confirm('The item you are entering has not been added yet. Discard it and edit this one?')) return;
    setAdding(null);
    setG((x) => ({ ...x, entry: { ...it }, editingKey: it.key }));
    openForm();
  };
  const cancelEdit = () => { setG((x) => ({ ...x, entry: blankItem(), editingKey: null })); setFormOpen(false); };
  const delItem = (it) => {
    if (!confirm(`Remove ${it.name} from this GRN?`)) return;
    setG((x) => ({
      ...x,
      items: x.items.filter((i) => i.key !== it.key),
      ...(x.editingKey === it.key ? { entry: blankItem(), editingKey: null } : {}),
    }));
  };

  // the list, category by category (in the Settings order, then any others)
  const groups = useMemo(() => {
    const order = catalog.map((c) => c.name.toLowerCase());
    const map = new Map();
    g.items.forEach((it, i) => {
      const k = it.category.trim() || 'Other';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ it, c: calc.items[i] || {} });
    });
    const rank = (k) => { const r = order.indexOf(k.toLowerCase()); return r < 0 ? 999 : r; };
    return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [g.items, calc, catalog]);

  const save = async () => {
    if (!g.supplier_id) return toast('Choose the supplier', 'error');
    if (g.editingKey) return toast('Finish editing the item first: press "Update item" or Cancel', 'error');
    if (entryStarted && !confirm(`"${g.entry.name || 'The item you are entering'}" has not been added to the list. Save the GRN without it?`)) return;
    if (!filledItems.length) return toast('Add at least one item to the list', 'error');
    const missing = filledItems.find((i) => n(i.sets) > 0 && n(i.cost_inr_per_pcs) <= 0);
    if (missing && !confirm(`"${missing.name}" has no cost. Save anyway?`)) return;
    setBusy(true);
    try {
      const body = { ...g, items: filledItems.map(forSaving), expenses: [] };
      const saved = editId ? await api.put(`/grns/${editId}`, body) : await api.post('/grns', body);
      if (!editId) localStorage.removeItem(DRAFT);
      toast(editId ? `${saved.grn_no} updated — stock adjusted` : `${saved.grn_no} saved — stock updated`);
      if (editId) backToGrn(saved.id); else navigate(`/grn/${saved.id}`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const reset = () => { if (confirm('Clear this form and start again?')) { localStorage.removeItem(DRAFT); setG({ ...initial, items: [], entry: blankItem(), editingKey: null, supplier_id: null }); window.location.reload(); } };

  // Cancel / Back while editing: ask before throwing away changes
  const editChanged = Boolean(editId && loadedRef.current && loadedRef.current !== 'pending' && (loadedRef.current !== JSON.stringify({ ...g, entry: null }) || entryStarted));
  const leaveEdit = () => {
    if (editChanged && !confirm(`You have unsaved changes to ${editing}.\n\nOK = discard the changes\nCancel = keep editing`)) return;
    backToGrn();
  };

  if (!suppliers || editing === null) return <Loading />;

  return (
    <div>
      {editId ? (
        <PageHeader back={leaveEdit} title={`Edit ${editing}`} subtitle="Fix what was entered wrongly. Stock moves by the difference only. Saving needs the Super Admin's password."
          actions={<>
            {editChanged && <span className="badge badge-amber">Unsaved changes</span>}
            <button className="btn btn-ghost" onClick={leaveEdit}>Cancel</button>
          </>} />
      ) : (
        <PageHeader title="Receive Goods (GRN)" subtitle="Enter a shipment from India. The system works out the real cost of every item in LKR."
          actions={<button className="btn btn-ghost" onClick={reset}><Icon name="trash" size={16} /> Clear form</button>} />
      )}

      <div className="grn-layout">
        <div className="stack">
          {/* STEP 1 */}
          <Card title={<span className="step-title"><span className="step-no">1</span> Shipment details</span>}>
            <div className="grid grid-3">
              <Field label="Supplier" required>
                <Combobox items={suppliers} value={g.supplier_id} onSelect={(s) => set('supplier_id')(s.id)} placeholder="Search supplier…"
                  getSub={(s) => [s.city, s.balance_inr > 0 ? `to pay ${inr(s.balance_inr)}` : ''].filter(Boolean).join(' · ')}
                  onCreate={(name) => setNewSupplier(name)} createLabel={(q) => `Add new supplier “${q}”`} />
              </Field>
              <Field label="Supplier billed date" hint="The date on the supplier's bill">
                <input type="date" className="input" value={g.supplier_bill_date || ''} max={g.date || undefined} onChange={set('supplier_bill_date')} />
              </Field>
              <Field label="Date received"><input type="date" className="input" value={g.date} onChange={set('date')} /></Field>
              <Field label="Cargo name" hint="Cargo / courier company">
                <input className="input" list="cargo-list" value={g.cargo_name} onChange={set('cargo_name')} placeholder="e.g. Lanka Speed Cargo" />
                <datalist id="cargo-list">{cargoNames.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Supplier invoice no"><input className="input" value={g.supplier_invoice_no} onChange={set('supplier_invoice_no')} /></Field>
              <Field label="Notes"><input className="input" value={g.notes} onChange={set('notes')} /></Field>
            </div>
          </Card>

          {/* STEP 2 */}
          <Card title={<span className="step-title"><span className="step-no">2</span> Goods Table</span>}
            actions={<span className="muted small">{filledItems.length} items · {int(calc.total_sets)} sets · {int(calc.total_pcs)} pcs</span>}>
            <datalist id="cat-list">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            {/* the items added so far, category by category */}
            <div className="item-list">
              {!g.items.length ? (
                <div className="item-list-empty">No items yet. Use <b>Add item</b> below to add the first one.</div>
              ) : groups.map(([cat, rows]) => (
                <div key={cat} className="item-group">
                  <div className="item-group-head">
                    <b>{cat}</b>
                    <span className="muted small">{rows.length} {rows.length === 1 ? 'product' : 'products'} · {int(rows.reduce((t, r) => t + (r.c.pcs || 0), 0))} pcs</span>
                  </div>
                  <table className="table item-table">
                    <thead><tr><th>Product</th><th className="right">Pieces</th><th className="right">Cargo & other / pc</th><th className="right">Cost / pc</th><th className="right">Selling / pc</th><th /></tr></thead>
                    <tbody>
                      {rows.map(({ it: row, c: rc }) => (
                        <tr key={row.key} className={g.editingKey === row.key ? 'row-editing' : ''}>
                          <td>
                            <b>{row.subtype ? (row.pname ? `${row.subtype} · ${row.pname}` : row.subtype) : row.name}</b>
                            {row.sizes && <div className="sub">{row.sizes}</div>}
                          </td>
                          <td className="right nowrap">
                            <b>{int(rc.pcs)}</b>
                            {(rc.extra_pcs > 0 || rc.short_pcs > 0) && (
                              <div className="sub">
                                {rc.extra_pcs > 0 && <span className="text-green">+{int(rc.extra_pcs)} </span>}
                                {rc.short_pcs > 0 && <span className="text-red">−{int(rc.short_pcs)}</span>}
                              </div>
                            )}
                          </td>
                          <td className="right nowrap">
                            {rc.cargo_lkr > 0 || rc.other_lkr > 0 ? <>
                              {rc.cargo_lkr > 0 && <div>{lkr(n(row.cargo_per_pcs))}/pc</div>}
                              {rc.other_lkr > 0 && <div className="sub">+ {lkr(n(row.other_per_pcs))}/pc other</div>}
                              <div className="sub">{lkr(rc.cargo_lkr + rc.other_lkr)} in all</div>
                            </> : <span className="muted">—</span>}
                          </td>
                          <td className="right nowrap">{lkr(rc.landed_per_pcs_lkr)}</td>
                          <td className="right nowrap">{lkr(row.expected_per_pcs)}</td>
                          <td className="right nowrap">
                            {g.editingKey === row.key
                              ? <span className="badge badge-amber">Editing</span>
                              : <>
                                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => editItem(row)}><Icon name="edit" size={14} /> Edit</button>
                                  <button type="button" className="btn btn-icon btn-sm btn-ghost" title="Remove" onClick={() => delItem(row)}><Icon name="trash" size={14} /></button>
                                </>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {!showForm ? (
              <button type="button" className="item-add-bar" onClick={openForm}>
                <span className="item-add-plus"><Icon name="plus" size={18} /></span>
                <span>{entryStarted ? <>Continue adding <b>{g.entry.name || 'the item'}</b></> : 'Add item'}</span>
                <span className="item-add-arrow">▸</span>
              </button>
            ) : (() => {
              const it = g.entry;
              const c = preview.items[entryIdx] || {};
              const m = margin(it.expected_per_pcs, c.landed_per_pcs_lkr);
              return (
                <div className={`item-card item-entry ${g.editingKey ? 'editing' : ''}`}>
                  <div className="item-entry-title">
                    <Icon name={g.editingKey ? 'edit' : 'plus'} size={15} />
                    {g.editingKey ? <span>Editing <b>{it.name}</b></span> : <span>Add an item</span>}
                    {!g.editingKey && (
                      <button type="button" className="item-fold" onClick={() => { setAdding(null); setFormOpen(false); }} title="Fold the form away (what you typed is kept)">Fold ▴</button>
                    )}
                  </div>
                  <div className="item-head">
                    <div className="spacer stack-s">
                      {(() => {
                        const cat = findCategory(catalog, it.category);
                        const otherCat = it.catOther || (it.category && !cat);
                        // exactly the products listed for this category in Settings → Categories & products
                        const options = cat ? [...cat.types] : [];
                        // a product picked earlier that has since been removed from Settings stays visible on this line only
                        const removed = cat && it.subtype && !options.some((t) => t.toLowerCase() === it.subtype.toLowerCase()) ? it.subtype : null;
                        const isAdding = adding?.key === it.key;
                        return (<>
                          <div className="item-pick">
                            <Field label="Category" required>
                              <select className="input" value={otherCat ? '__other' : it.category} onChange={(e) => { setAdding(null); chooseCategory(it.key, e.target.value); }}>
                                <option value="">Choose category…</option>
                                {catalog.map((cg) => <option key={cg.name} value={cg.name}>{cg.name}</option>)}
                                <option value="__other">Other…</option>
                              </select>
                              {otherCat && <input className="input mt-s" list="cat-list" value={it.category} placeholder="Type the category" onChange={(e) => updItem(it.key, { category: e.target.value })} />}
                            </Field>
                            {cat && (
                              <Field label={`${cat.name} — product`} required>
                                <select className="input" value={isAdding ? '__add' : it.subtype}
                                  onChange={(e) => {
                                    if (e.target.value === '__add') return setAdding({ key: it.key, text: '' });
                                    setAdding(null);
                                    chooseProduct(it.key, e.target.value);
                                  }}>
                                  <option value="">Choose product…</option>
                                  {options.map((t) => <option key={t} value={t}>{t}</option>)}
                                  {removed && <option value={removed}>{removed} (removed in Settings)</option>}
                                  <option value="__add">+ Add product to {cat.name}…</option>
                                </select>
                                {isAdding && (
                                  <div className="row mt-s" style={{ gap: 8 }}>
                                    <input className="input" autoFocus value={adding.text} placeholder={`New ${cat.name} product, e.g. Collar Boxy`}
                                      onChange={(e) => setAdding({ ...adding, text: e.target.value })}
                                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addProduct(it); } if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); } }} />
                                    <button type="button" className="btn btn-primary" disabled={!adding.text.trim()} onClick={() => addProduct(it)}>Add</button>
                                    <button type="button" className="btn btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
                                  </div>
                                )}
                              </Field>
                            )}
                            {cat && it.subtype && !isAdding && (
                              <Field label={`${it.subtype} — product name`} required hint="Type the name on this shipment">
                                <input className="input" value={it.pname || ''} placeholder="e.g. Royal Check" autoComplete="off"
                                  onChange={(e) => typePName(it.key, e.target.value)} onBlur={() => fillFromExisting(it.key)} />
                              </Field>
                            )}
                            {otherCat && (
                              <Field label="Product name" required>
                                <input className="input" value={it.name} placeholder="e.g. Sarong - Batik"
                                  onChange={(e) => {
                                    const name = e.target.value;
                                    const existing = products.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
                                    updItem(it.key, existing ? { ...productFields(existing), category: it.category, isNew: false } : { name, product_id: null, isNew: Boolean(name) });
                                  }} />
                              </Field>
                            )}
                          </div>
                          {it.name && !isAdding && (
                            <div className="item-product-row">
                              <span className="item-product-name">{it.name}</span>
                              {it.product_id
                                ? <span className="badge badge-teal">In stock · this GRN adds to it</span>
                                : <span className="badge badge-violet">New — created when the GRN is saved</span>}
                            </div>
                          )}
                        </>);
                      })()}
                    </div>
                  </div>

                  {/* 1 · quantity */}
                  <div className="item-fields">
                    <Field label="Colour names" hint="Optional"><input className="input" value={it.color_names} onChange={(e) => updItem(it.key, { color_names: e.target.value })} placeholder="Red, Navy" /></Field>
                    <Field label="No. of colours"><NumInput value={it.colors_count} onChange={(v) => updItem(it.key, { colors_count: v })} placeholder="0" /></Field>
                    <Field label="Pieces per set" hint={it.pcsAuto ? '1 of each size — change if needed' : 'Pcs in one pack'}>
                      <NumInput value={it.pcs_per_set} onChange={(v) => updItem(it.key, { pcs_per_set: v, pcsAuto: false })} placeholder="1" />
                    </Field>
                    <Field label="No. of sets" required hint="As on the supplier's bill"><NumInput value={it.sets} onChange={(v) => updItem(it.key, { sets: v })} placeholder="0" /></Field>
                    <div className="field">
                      <span className="field-label">Total pieces</span>
                      <div className="input input-static">{int(c.set_pcs)}</div>
                      <span className="field-hint">Sets × pieces per set</span>
                    </div>
                    <Field label="Billed per piece (INR)" required hint="From the supplier's bill">
                      <NumInput value={it.cost_inr_per_pcs} onChange={(v) => updItem(it.key, { cost_inr_per_pcs: v })} placeholder="0.00" />
                    </Field>
                  </div>

                  {/* 2 · what really came in the bale — folded away unless needed */}
                  {!(it.showQty || n(it.extra_pcs) > 0 || n(it.short_pcs) > 0) ? (
                    <button type="button" className="item-qty-toggle" onClick={() => updItem(it.key, { showQty: true })}>
                      <Icon name="plus" size={14} /> Extra or short pieces in this bale?
                    </button>
                  ) : (
                  <div className={`item-qty-check ${c.extra_pcs || c.short_pcs ? 'on' : ''}`}>
                    <Field label="+ Extra pieces" hint="Received & billed"><NumInput value={it.extra_pcs} onChange={(v) => updItem(it.key, { extra_pcs: v })} placeholder="0" /></Field>
                    <Field label="− Short pieces" hint="Billed, not received"><NumInput value={it.short_pcs} onChange={(v) => updItem(it.key, { short_pcs: v })} placeholder="0" /></Field>
                    <div className="field">
                      <span className="field-label">Pieces received</span>
                      <div className={`input input-static strong ${c.pcs !== c.set_pcs ? (c.pcs > c.set_pcs ? 'text-green' : 'text-red') : ''}`}>{int(c.pcs)}</div>
                      <span className="field-hint">Added to stock</span>
                    </div>
                    <p className="item-qty-note muted small">
                      {c.short_pcs
                        ? 'Shorts are still paid in full. They show as a loss under Extra & Short until you resolve them (received later, or lost).'
                        : c.extra_pcs
                          ? 'Extra pieces go into stock and onto the supplier bill. Resolve them under Extra & Short once the supplier answers (keep free, pay, or next shipment).'
                          : 'Got extra pieces, or pieces missing? Enter them here.'}
                      {' '}<button type="button" className="link-btn" style={{ display: 'inline', marginLeft: 0 }}
                        onClick={() => updItem(it.key, { showQty: false, extra_pcs: '', short_pcs: '' })}>Remove</button>
                    </p>
                  </div>
                  )}

                  {/* 3 · sizes, then this item's cargo charge and other expenses below them (both go into its cost) */}
                  {(() => {
                    const paidPcs = c.paid_pcs || 0;
                    const total = (v) => (n(v) > 0 && paidPcs ? `× ${int(paidPcs)} pcs = ${lkr(n(v) * paidPcs)} · added to each piece's cost` : 'For each piece · added to its cost');
                    return (
                      <div className="item-size-row">
                        <div className="field">
                          <span className="field-label">Sizes in the pack</span>
                          <SizePicker value={it.sizes} options={findCategory(catalog, it.category)?.sizes} hint={`${it.name} ${it.category}`}
                            onChange={(sizes, count) => updItem(it.key, {
                              sizes,
                              ...(count > 0 && (it.pcsAuto || !n(it.pcs_per_set)) ? { pcs_per_set: count, pcsAuto: true } : {}),
                            })} />
                        </div>
                        <div className="item-charges">
                          <Field label="Cargo charge / piece (Rs)" hint={total(it.cargo_per_pcs)}>
                            <NumInput value={it.cargo_per_pcs ?? ''} onChange={(v) => updItem(it.key, { cargo_per_pcs: v, cargo_lkr: '' })} placeholder="0.00" />
                          </Field>
                          <Field label="Other expenses / piece (Rs)" hint={total(it.other_per_pcs)}>
                            <NumInput value={it.other_per_pcs ?? ''} onChange={(v) => updItem(it.key, { other_per_pcs: v, other_lkr: '' })} placeholder="0.00" />
                          </Field>
                        </div>
                      </div>
                    );
                  })()}

                  {/* 4 · cost */}
                  <div className="item-cost-row">
                    <div className="item-calc">
                      <div className="calc-pill">Bill amount<b>{inr(c.line_inr)}</b><small>{int(c.billed_pcs)} pcs × {inr(c.billed_pcs ? c.line_inr / c.billed_pcs : 0)}</small></div>
                      <div className="calc-pill hl">Cost / piece<b>{lkr(c.landed_per_pcs_lkr)}</b></div>
                    </div>
                  </div>

                  {/* 5 · selling price & MRP — automatic from Settings → Price & billing, or typed in */}
                  {(() => {
                    const auto = autoPrices(c.landed_per_pcs_lkr, c.pcs_per_set, rules);
                    const priceHint = (manual, key, pctRule) => {
                      if (manual) {
                        return (
                          <span>Changed by you{auto && <> · <button type="button" className="link-btn" onClick={() => updItem(it.key, { [`${key}Manual`]: false, [`${key}_per_pcs`]: auto[`${key}_per_pcs`] })}>use auto ({lkr(auto[`${key}_per_pcs`])})</button></>}</span>
                        );
                      }
                      return auto ? <span className="text-green">Auto · cost + {pctRule}%</span> : `Auto · cost + ${pctRule}% (enter the cost first)`;
                    };
                    const perSet = (v) => (n(v) > 0 && c.pcs_per_set > 1 ? <> · {lkr(n(v) * c.pcs_per_set)} a set</> : null);
                    return (
                      <div className="item-fields">
                        <Field label="Expected selling price / piece (Rs)" className="span-3"
                          hint={<>{priceHint(it.expectedManual, 'expected', rules.selling)}{perSet(it.expected_per_pcs)}
                            {c.landed_per_pcs_lkr > 0 && n(it.expected_per_pcs) > 0 && <span className={m < 0 ? 'text-red' : m < 15 ? 'text-amber' : 'text-green'}> · margin {pct(m)}</span>}</>}>
                          <NumInput value={it.expected_per_pcs} onChange={(v) => updItem(it.key, { expected_per_pcs: v, expectedManual: true })} placeholder="0.00" />
                        </Field>
                        <Field label="MRP / piece (Rs)" className="span-3" hint={<>{priceHint(it.mrpManual, 'mrp', rules.mrp)}{perSet(it.mrp_per_pcs)}</>}>
                          <NumInput value={it.mrp_per_pcs} onChange={(v) => updItem(it.key, { mrp_per_pcs: v, mrpManual: true })} placeholder="0.00" />
                        </Field>
                      </div>
                    );
                  })()}
                  <div className="item-entry-actions">
                    {g.editingKey && <button type="button" className="btn btn-ghost" onClick={cancelEdit}>Cancel</button>}
                    <button type="button" className="btn btn-primary" onClick={addItem}>
                      <Icon name={g.editingKey ? 'check' : 'plus'} size={16} /> {g.editingKey ? 'Update item' : 'Add item'}
                    </button>
                  </div>
                </div>
              );
            })()}

          </Card>

          {/* STEP 3 */}
          <Card title={<span className="step-title"><span className="step-no">3</span> Supplier payment</span>}>
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
              <span>All costs use the fixed rate <b>Rs {rate.toFixed(2)} per ₹1</b> (Settings → Exchange rate), paid now or on credit. The live rate does not change them.</span>
            </div>
          </Card>
        </div>

        {/* SUMMARY */}
        <div className="grn-summary stack">
          <Card title="Cost summary">
            <dl className="kv">
              <dt>Goods value</dt><dd>{inr(calc.goods_inr)}</dd>
              <dt>× Costing rate</dt><dd>{rate.toFixed(2)}</dd>
              <dt>= Goods in LKR</dt><dd>{lkr(calc.goods_inr * rate)}</dd>
              <dt>+ Cargo charge</dt><dd>{lkr(calc.expenses_lkr - calc.other_lkr)}</dd>
              <dt>+ Other expenses</dt><dd>{lkr(calc.other_lkr)}</dd>
              <dt className="total">Total cost</dt><dd className="total">{lkr(calc.total_lkr)}</dd>
            </dl>
            <div className="formula mt">
              <b>Cost factor: {calc.landing_factor ? calc.landing_factor.toFixed(3) : '—'}</b><br />
              Every ₹1 of goods really costs <b>Rs {calc.landing_factor ? calc.landing_factor.toFixed(2) : '—'}</b> after the cargo charge.
            </div>
            {filledItems.length > 0 && (
              <div className="pcs-costs mt">
                <div className="pcs-costs-title">Cost per piece (Rs)</div>
                {g.items.map((it, i) => (hasQty(it) && (it.product_id || it.name.trim()) ? (
                  <div key={it.key} className="pcs-cost-row">
                    <span>{it.name}</span><b className="mono">{lkr(calc.items[i]?.landed_per_pcs_lkr)}</b>
                  </div>
                ) : null))}
              </div>
            )}
            <dl className="kv mt">
              <dt>Sets / pieces received</dt><dd>{int(calc.total_sets)} / {int(calc.total_pcs)}</dd>
              {extraPcs > 0 && <><dt>+ Extra pieces (billed)</dt><dd className="text-green">{int(extraPcs)} pcs</dd></>}
              {shortPcs > 0 && <><dt>− Short (paid, not received)</dt><dd className="text-red">{int(shortPcs)} pcs</dd></>}
              <dt>Expected sales value</dt><dd>{lkr(expectedValue)}</dd>
              <dt>Expected profit</dt><dd className={expectedValue - calc.total_lkr < 0 ? 'text-red' : 'text-green'}>{lkr(expectedValue - calc.total_lkr)} ({pct(margin(expectedValue, calc.total_lkr))})</dd>
              <dt>Payable to supplier</dt><dd>{inr(calc.goods_inr)}</dd>
            </dl>
          </Card>
          <button className="btn btn-primary btn-lg btn-block" onClick={save} disabled={busy}><Icon name="check" /> {busy ? 'Saving…' : editId ? `Save changes to ${editing}` : 'Save GRN & add to stock'}</button>
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
