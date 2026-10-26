import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, lkr, niceDate, int } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Badge, Stat, Modal, Field, useToast } from '../components/ui.jsx';

/*
 * Cargo companies — added like suppliers and customers. A GRN picks its cargo from this list.
 * Each one: its shipments' cargo charges, the Extra & Short settled with it (lost by the cargo comes off,
 * extras paid go on), its payments and what is still to pay. Payments are made on Payment Portal → To pay cargo.
 */
export default function Cargo() {
  const { data, error, loading, reload } = useApi('/cargo/companies');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data || []).filter((c) => !s || `${c.name} ${c.contact || ''} ${c.phone || ''}`.toLowerCase().includes(s));
  }, [data, q]);
  const owe = (data || []).reduce((t, c) => t + Math.max(0, c.balance), 0);

  return (
    <div>
      <PageHeader title="Cargo" subtitle="The cargo companies that bring your shipments, and how much is to pay to each of them."
        actions={<>
          <Link to="/dues?tab=cargo" className="btn"><Icon name="wallet" /> Pay cargo</Link>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Add cargo</button>
        </>} />
      <div className="stats mb">
        <Stat icon="truck" label="Cargo companies" value={(data || []).filter((c) => c.active).length} />
        <Stat icon="wallet" tone="amber" label="Total to pay" value={lkr(owe)} />
        <Stat icon="layers" label="Shipments" value={int((data || []).reduce((t, c) => t + c.shipments, 0))} />
      </div>
      <div className="toolbar"><div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search cargo, contact, phone…" value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : rows.length === 0 ? <Empty icon="truck" title="No cargo companies yet" text="Add the cargo companies that bring your shipments." action={<button className="btn btn-primary" onClick={() => setAdding(true)}>Add cargo</button>} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Cargo company</th><th>Contact</th><th className="right">Shipments</th><th>Last shipment</th><th className="right">Cargo bills</th><th className="right">Paid</th><th className="right">To pay</th></tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpenId(c.id)}>
                  <td><b>{c.name}</b> {!c.active && <Badge>Inactive</Badge>}{c.address && <div className="sub">{c.address}</div>}</td>
                  <td>{c.contact || '—'}<div className="sub">{c.phone}</div></td>
                  <td className="right">{int(c.shipments)}</td>
                  <td>{c.last_date ? niceDate(c.last_date) : '—'}</td>
                  <td className="right">{lkr(c.total)}</td>
                  <td className="right">{lkr(c.paid)}</td>
                  <td className="right strong">{c.balance > 0.009 ? lkr(c.balance) : c.credit > 0.009 ? <Badge tone="green">{lkr(c.credit)} credit</Badge> : <Badge tone="green">Settled</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <CargoForm onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); reload(); setOpenId(c.id); }} />}
      {openId && <CargoModal id={openId} onClose={() => setOpenId(null)} onChanged={reload} />}
    </div>
  );
}

/** Add or edit a cargo company. */
export function CargoForm({ cargo, onClose, onSaved, url = '/cargo/companies' }) {
  const toast = useToast();
  const [f, setF] = useState(() => ({ name: '', contact: '', phone: '', address: '', notes: '', active: 1, ...cargo }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? (e.target.checked ? 1 : 0) : e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = cargo?.id ? await api.put(`/cargo/companies/${cargo.id}`, f) : await api.post(url, f);
      toast(cargo?.id ? `${saved.name} saved` : `${saved.name} added to the Cargo list`);
      onSaved(saved);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={cargo?.id ? `Edit ${cargo.name}` : 'Add cargo company'} onClose={onClose}
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="cargo-form" disabled={busy}><Icon name="check" /> Save</button></>}>
      <form id="cargo-form" className="stack" onSubmit={save}>
        <Field label="Cargo company name" required><input className="input" value={f.name} onChange={set('name')} autoFocus placeholder="e.g. Lanka Speed Cargo" /></Field>
        <div className="grid grid-2">
          <Field label="Contact person"><input className="input" value={f.contact || ''} onChange={set('contact')} /></Field>
          <Field label="Phone"><input className="input" value={f.phone || ''} onChange={set('phone')} /></Field>
        </div>
        <Field label="Address"><input className="input" value={f.address || ''} onChange={set('address')} /></Field>
        <Field label="Notes"><textarea className="input" value={f.notes || ''} onChange={set('notes')} /></Field>
        {cargo?.id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Active (shown on Receive Goods)</label>}
        {cargo?.id && f.name.trim() !== cargo.name && <p className="muted small">The new name is put on its GRNs, payments and cheques too.</p>}
      </form>
    </Modal>
  );
}

/** One cargo company: details, its cargo bills (with the Extra & Short settled with it) and payments. */
function CargoModal({ id, onClose, onChanged }) {
  const toast = useToast();
  const { data: c, error, reload } = useApi(`/cargo/companies/${id}`);
  const [editing, setEditing] = useState(false);
  if (error) return <Modal title="Cargo" onClose={onClose}><ErrorBox error={error} onRetry={reload} /></Modal>;
  if (!c) return <Modal title="Cargo" onClose={onClose}><Loading /></Modal>;
  const l = c.ledger;
  const del = async () => {
    if (!confirm(`Delete ${c.name} from the Cargo list?`)) return;
    try { await api.del(`/cargo/companies/${c.id}`); toast(`${c.name} deleted`); onChanged(); onClose(); } catch (e) { toast(e.message, 'error'); }
  };
  return (
    <Modal size="xl" title={c.name} subtitle={[c.contact, c.phone, c.address].filter(Boolean).join(' · ') || 'Cargo company'} onClose={onClose}
      footer={<>
        {!l?.shipments && <button className="btn btn-danger" onClick={del}><Icon name="trash" /> Delete</button>}
        <button className="btn" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>
        <span className="spacer" />
        <Link to="/dues?tab=cargo" className="btn btn-primary"><Icon name="wallet" /> Pay cargo</Link>
      </>}>
      <div className="stats mb">
        <Stat icon="layers" label="Shipments" value={int(l?.shipments || 0)} />
        <Stat icon="receipt" label="Cargo bills" value={lkr(l?.total || 0)} />
        <Stat icon="check" tone="green" label="Paid" value={lkr(l?.paid || 0)} />
        <Stat icon="wallet" tone={(l?.balance || 0) > 0.009 ? 'amber' : 'green'} label="To pay" value={lkr(l?.balance || 0)} sub={l?.credit > 0.009 ? `${lkr(l.credit)} paid in advance` : undefined} />
      </div>
      {c.notes && <p className="muted small mb">{c.notes}</p>}
      <h4 className="set-sub">Cargo bills</h4>
      {!l?.bills?.length ? <p className="muted">No shipments with this cargo yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Shipment</th><th>Date</th><th className="right">Pcs</th><th className="right">Cargo charge</th><th>Extra &amp; Short with the cargo</th><th className="right">Bill</th><th className="right">To pay</th></tr></thead>
            <tbody>{l.bills.slice().reverse().map((b) => (
              <tr key={b.id}>
                <td>{b.pending ? <>{b.grn_no} <Badge tone="violet">With next bill</Badge></> : <Link to={`/grn/${b.id}`}>{b.grn_no}</Link>}</td>
                <td>{niceDate(b.date)}</td>
                <td className="right">{b.pcs ? int(b.pcs) : '—'}</td>
                <td className="right">{b.pending ? '—' : lkr(b.cargo_lkr ?? b.amount)}</td>
                <td>{(b.adjustments || []).length ? b.adjustments.map((a, i) => (
                  <div key={i} className="small"><b className={a.amount < 0 ? 'text-green' : 'text-amber'}>{a.amount < 0 ? '−' : '+'} {lkr(Math.abs(a.amount))}</b> <span className="muted">{a.label}</span></div>
                )) : <span className="muted">—</span>}</td>
                <td className="right strong">{lkr(b.amount)}</td>
                <td className="right">{b.balance > 0.009 ? lkr(b.balance) : <span className="text-green">{b.paid_by_cheque ? 'Paid by cheque' : 'Paid'}</span>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <h4 className="set-sub mt">Payments</h4>
      {!l?.payments?.length ? <p className="muted">No payments yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Method</th><th>Reference</th><th className="right">Amount</th></tr></thead>
            <tbody>{l.payments.map((p) => (
              <tr key={p.id}><td>{niceDate(p.date)}</td><td>{p.method}{p.cheque_status && <span className="muted small"> · cheque {p.cheque_status}</span>}</td><td>{p.reference || '—'}</td>
                <td className={`right ${p.returned ? 'text-red' : 'strong'}`}>{p.returned ? 'Returned · ' : ''}{lkr(p.amount)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {editing && <CargoForm cargo={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); onChanged(); }} />}
    </Modal>
  );
}
