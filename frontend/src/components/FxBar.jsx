import { useEffect, useState } from 'react';
import { api, n } from '../lib.js';
import { Icon, Modal, Field, NumInput, Segmented, useToast } from './ui.jsx';
import { useFx } from '../App.jsx';

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function Spark({ points }) {
  if (!points || points.length < 2) return null;
  const vals = points.map((p) => p.rate);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - min) / span) * 24}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg className={`fx-spark ${up ? 'up' : 'down'}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={d} fill="none" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The live INR rate strip at the top of the dashboard. */
export default function FxBar() {
  const { fx, setFx, reloadFx } = useFx();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);

  if (!fx) return <div className="fx-bar loading-bar"><span className="spinner" /> Getting today's INR rate…</div>;

  const refresh = async () => {
    setBusy(true);
    try { setFx(await api.post('/fx/refresh')); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const manual = fx.mode === 'manual';
  const dir = fx.change > 0 ? 'up' : fx.change < 0 ? 'down' : 'flat';

  return (
    <div className={`fx-bar ${manual ? 'manual' : ''}`}>
      <div className="fx-main">
        <span className={`fx-live ${manual ? 'off' : ''}`}><i />{manual ? 'SET BY HAND' : 'LIVE'}</span>
        <div className="fx-rate">
          <small>1 Indian Rupee</small>
          <b>Rs {fx.rate.toFixed(4)}</b>
        </div>
        {!manual && (
          <span className={`fx-change ${dir}`}>
            {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•'} {fx.change > 0 ? '+' : ''}{fx.change.toFixed(4)} ({fx.change_pct > 0 ? '+' : ''}{fx.change_pct}%)
            <small>vs 24 h ago</small>
          </span>
        )}
        <Spark points={fx.history} />
      </div>
      <div className="fx-meta">
        <span>{fx.source} · updated {ago(fx.updated_at)}</span>
        {fx.error && <span className="fx-err" title={fx.error}><Icon name="alert" size={13} /> offline — last known rate</span>}
        <span className="fx-note">Unpaid credit GRNs are re-costed with this rate</span>
      </div>
      <div className="fx-actions">
        {!manual && <button className="btn btn-sm" onClick={refresh} disabled={busy} title="Fetch the rate now"><Icon name="adjust" size={14} /> {busy ? 'Checking…' : 'Refresh'}</button>}
        <button className="btn btn-sm" onClick={() => setEditing(true)}><Icon name="edit" size={14} /> Edit</button>
      </div>
      {editing && <FxEdit fx={fx} onClose={() => setEditing(false)} onSaved={(d) => { setFx(d); setEditing(false); reloadFx(); }} />}
    </div>
  );
}

function FxEdit({ fx, onClose, onSaved }) {
  const toast = useToast();
  const [mode, setMode] = useState(fx.mode);
  const [rate, setRate] = useState(fx.rate);
  const save = async (e) => {
    e.preventDefault();
    try {
      const d = await api.put('/fx', mode === 'auto' ? { mode: 'auto' } : { mode: 'manual', rate: n(rate) });
      toast(mode === 'auto' ? `Back to the live rate: Rs ${d.rate}` : `Rate set to Rs ${d.rate}`);
      onSaved(d);
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal size="sm" title="INR exchange rate" subtitle="Used for new GRNs, supplier payments and re-costing unpaid credit goods" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="fx-form">Save</button></>}>
      <form id="fx-form" className="stack" onSubmit={save}>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'auto', label: 'Live rate (automatic)' }, { value: 'manual', label: 'Set by hand' }]} />
        {mode === 'manual' ? (
          <Field label="1 INR = ? LKR" hint="Stays until you switch back to the live rate">
            <NumInput autoFocus value={rate} onChange={setRate} />
          </Field>
        ) : (
          <p className="muted small">The rate is fetched from the internet every few minutes. Your bank's rate may differ — set it by hand if you want that instead.</p>
        )}
      </form>
    </Modal>
  );
}
