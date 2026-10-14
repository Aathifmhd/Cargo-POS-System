import { useEffect, useRef, useState } from 'react';
import { api, parseCatalog } from '../lib.js';
import { Icon, useToast } from './ui.jsx';
import { useSettings } from '../App.jsx';

let seq = 1;
const fromSettings = (settings) => parseCatalog(settings).map((c) => ({ ...c, orig: c.name, id: seq++ }));
const strip = (rows) => rows.map(({ name, sizes, types, reorder_sets }) => ({ name: name.trim(), sizes, types, reorder_sets: Math.max(0, Math.round(Number(reorder_sets) || 0)) })).filter((c) => c.name);

/** Chips with × to remove, and a box to add more (Enter or comma; pasting "S, M, L" adds all three). */
function TagEdit({ values, onChange, placeholder }) {
  const [text, setText] = useState('');
  const add = (raw) => {
    const extra = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const next = [...values];
    for (const v of extra) if (!next.some((x) => x.toLowerCase() === v.toLowerCase())) next.push(v);
    onChange(next);
    setText('');
  };
  return (
    <div className="tag-edit">
      {values.map((v) => (
        <span key={v} className="tag">
          {v}
          <button type="button" title={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}><Icon name="x" size={12} /></button>
        </span>
      ))}
      <input value={text} placeholder={placeholder} onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setText(e.target.value))}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (text.trim()) add(text); } }}
        onBlur={() => text.trim() && add(text)} />
    </div>
  );
}

/** Settings → Categories, products & sizes */
export default function CatalogEditor() {
  const { settings, reload } = useSettings();
  const toast = useToast();
  const [rows, setRows] = useState(() => fromSettings(settings));
  const [busy, setBusy] = useState(null); // 'all', or the id of the card being saved
  // after saving one card, the other cards keep their unsaved edits
  const keepEdits = useRef(false);
  useEffect(() => {
    if (keepEdits.current) { keepEdits.current = false; return; }
    setRows(fromSettings(settings));
  }, [settings.catalog]); // eslint-disable-line

  const saved = parseCatalog(settings);
  const savedOf = (r) => (r.orig ? saved.find((c) => c.name === r.orig) : null);
  const cardDirty = (r) => {
    const s = savedOf(r);
    return !s || JSON.stringify(strip([r])[0] || null) !== JSON.stringify(s);
  };
  const dirty = JSON.stringify(strip(rows)) !== JSON.stringify(saved);
  const unsavedCards = rows.filter((r) => cardDirty(r) && r.name.trim()).length;

  const upd = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (i, dir) => setRows((rs) => {
    const j = i + dir;
    if (j < 0 || j >= rs.length) return rs;
    const c = [...rs];
    [c[i], c[j]] = [c[j], c[i]];
    return c;
  });
  const remove = (r) => {
    if (confirm(`Remove the category "${r.name || 'new category'}"? Products already in it keep their category name.\n\nPress "Save all changes" to confirm the removal.`)) {
      setRows((rs) => rs.filter((x) => x.id !== r.id));
    }
  };

  const nameClash = (list) => {
    const names = list.map((r) => r.name.trim().toLowerCase()).filter(Boolean);
    return new Set(names).size !== names.length;
  };
  // a renamed category takes its products along, so nothing is left behind under the old name
  const renameProducts = async (r) => {
    if (r.orig && r.name.trim() && r.orig !== r.name.trim()) await api.post('/products/rename-category', { from: r.orig, to: r.name.trim() });
  };

  // Save just this card: the saved list with this one category replaced (or added at the end)
  const saveOne = async (r) => {
    const entry = strip([r])[0];
    if (!entry) return toast('Type the category name', 'error');
    const list = saved.map((c) => ({ ...c }));
    const at = r.orig ? list.findIndex((c) => c.name === r.orig) : -1;
    if (at >= 0) list[at] = entry; else list.push(entry);
    if (nameClash(list)) return toast(`There is already a category called "${entry.name}"`, 'error');
    setBusy(r.id);
    try {
      await renameProducts(r);
      await api.put('/settings', { catalog: JSON.stringify(list) });
      keepEdits.current = true;
      upd(r.id, { ...entry, orig: entry.name });
      await reload();
      toast(`${entry.name} saved`);
    } catch (e) { keepEdits.current = false; toast(e.message, 'error'); } finally { setBusy(null); }
  };

  const saveAll = async () => {
    if (nameClash(rows)) return toast('Two categories have the same name', 'error');
    setBusy('all');
    try {
      for (const r of rows) await renameProducts(r);
      await api.put('/settings', { catalog: JSON.stringify(strip(rows)) });
      await reload();
      toast('All categories, products and sizes saved');
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };

  return (
    <div className="stack">
      <div className="cat-flow">
        <span><b>Category</b> → Receive Goods' Category list</span>
        <span><b>Products</b> → that category's Products list</span>
        <span><b>Sizes</b> → the size buttons for that category</span>
        <span><b>Re-order at</b> → low stock alert for its products</span>
      </div>
      <p className="muted">Change a category and press <b>Save</b> on its card, or <b>Save all changes</b> at the bottom. Receive Goods shows the change straight away.
        Type a product or size and press Enter. You can paste several at once, e.g. <code>S, M, L</code>.
        Products added from Receive Goods with “+ Add product” appear here too.</p>
      <div className="cat-list">
        {rows.map((r, i) => {
          const edited = cardDirty(r);
          const before = savedOf(r);
          return (
            <div key={r.id} className={`cat-row ${edited ? 'edited' : ''}`}>
              <div className="cat-row-head">
                <input className="input" value={r.name} placeholder="Category name" onChange={(e) => upd(r.id, { name: e.target.value })} />
                {r.orig && r.name.trim() && r.orig !== r.name.trim() && <span className="badge badge-amber">renamed from {r.orig}</span>}
                {!r.orig && <span className="badge badge-violet">New</span>}
                <span className="muted">{r.types.length} products · {r.sizes.length} sizes</span>
                <button type="button" className="btn btn-icon btn-sm btn-ghost" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn btn-icon btn-sm btn-ghost" title="Move down" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="btn btn-icon btn-sm btn-ghost" title="Remove category" onClick={() => remove(r)}><Icon name="trash" size={15} /></button>
              </div>
              <div className="cat-label">Products</div>
              <TagEdit values={r.types} onChange={(types) => upd(r.id, { types })} placeholder="+ Add product" />
              <div className="cat-label">Sizes</div>
              <TagEdit values={r.sizes} onChange={(sizes) => upd(r.id, { sizes })} placeholder="+ Add size" />
              <div className="cat-reorder">
                <span className="cat-label">Re-order at</span>
                <input className="input" type="number" min="0" value={r.reorder_sets || ''} placeholder="0"
                  onChange={(e) => upd(r.id, { reorder_sets: e.target.value === '' ? 0 : Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                <span className="muted small">sets — low stock alert for every {r.name.trim() || 'product'} product (0 = no alert)</span>
              </div>
              {edited && (
                <div className="cat-row-save">
                  <span className="small">Unsaved changes</span>
                  {before && <button type="button" className="btn btn-sm btn-ghost" onClick={() => upd(r.id, { ...before })}>Undo</button>}
                  <button type="button" className="btn btn-sm btn-primary" disabled={!r.name.trim() || busy !== null} onClick={() => saveOne(r)}>
                    <Icon name="check" size={14} /> {busy === r.id ? 'Saving…' : `Save ${r.name.trim() || 'category'}`}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="cat-save-all">
        <button type="button" className="btn" onClick={() => setRows((rs) => [...rs, { name: '', sizes: [], types: [], reorder_sets: 0, orig: null, id: seq++ }])}>
          <Icon name="plus" size={16} /> Add category
        </button>
        <span className="spacer" />
        {dirty && <span className="muted small">{unsavedCards > 0 ? `${unsavedCards} ${unsavedCards === 1 ? 'category' : 'categories'} not saved` : 'Order or removals not saved'}</span>}
        {dirty && <button type="button" className="btn btn-ghost" onClick={() => setRows(fromSettings(settings))}>Undo all</button>}
        <button type="button" className="btn btn-primary" disabled={!dirty || busy !== null} onClick={saveAll}>
          <Icon name="check" size={16} /> {busy === 'all' ? 'Saving…' : 'Save all changes'}
        </button>
      </div>
    </div>
  );
}
