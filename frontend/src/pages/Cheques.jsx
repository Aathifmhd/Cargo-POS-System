import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi, lkr, inr, niceDate, today, addDays, niceDateTime } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Stat, Tabs, Badge, Modal, Field, NumInput, DateInput, useToast } from '../components/ui.jsx';
import { BankList } from '../components/forms.jsx';

/*
 * Cheque Desk: every cheque, received (from customers) and given (to cargo companies and suppliers).
 * Passed — the cheque cleared. A customer's due comes down only now.
 * Returned — the cheque came back. A cheque we gave: that amount is owed again. A customer's: their due goes back up.
 * Holding — held back for now (not deposited yet). No money changes.
 */
const STATUS = {
  pending: { label: 'Waiting', tone: 'blue' },
  holding: { label: 'Holding', tone: 'amber' },
  passed: { label: 'Passed', tone: 'green' },
  returned: { label: 'Returned', tone: 'red' },
};
const PARTY = { customer: 'Customer', supplier: 'Supplier', cargo: 'Cargo' };
const open = (c) => c.status === 'pending' || c.status === 'holding';

/** "⋯" next to Passed: the other things you can do with a cheque. */
function MoreMenu({ items, disabled }) {
  const [show, setShow] = useState(null);   // where the list opens (it floats above the table, so it is never cut off)
  const ref = useRef();
  useEffect(() => {
    if (!show) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setShow(null); };
    const esc = (e) => { if (e.key === 'Escape') setShow(null); };
    const away = () => setShow(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', away, true); window.removeEventListener('resize', away); };
  }, [show]);
  return (
    <span className="more-menu" ref={ref}>
      <button type="button" className="btn btn-sm btn-ghost btn-icon" title="More" aria-haspopup="menu" aria-expanded={Boolean(show)} disabled={disabled}
        onClick={(e) => {
          if (show) return setShow(null);
          const r = e.currentTarget.getBoundingClientRect();
          const below = window.innerHeight - r.bottom > 120;   // open upwards near the bottom of the screen
          setShow({ right: Math.max(8, window.innerWidth - r.right), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) });
        }}>⋯</button>
      {show && (
        <div className="more-menu-list" role="menu" style={show}>
          {items.map((it) => (
            <button key={it.label} type="button" role="menuitem" className={it.danger ? 'danger' : ''} onClick={() => { setShow(null); it.onClick(); }}>
              <Icon name={it.icon} size={14} /> {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Correct a cheque entered wrongly: owner, bank, number, amount, date, notes. */
function EditCheque({ c, onClose, onSaved }) {
  const toast = useToast();
  const [v, setV] = useState({ owner: c.owner || '', bank: c.bank || '', cheque_no: c.cheque_no, amount: c.amount, cheque_date: c.cheque_date, notes: c.notes || '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (x) => setV((o) => ({ ...o, [k]: x && x.target ? x.target.value : x }));
  const save = async (e) => {
    e.preventDefault();
    if (!String(v.cheque_no).trim()) return toast('Enter the cheque number', 'error');
    if (!(Number(v.amount) > 0)) return toast('Enter the amount', 'error');
    if (!v.cheque_date) return toast('Enter the cheque date', 'error');
    setBusy(true);
    try {
      await api.put(`/cheques/${c.id}`, v);
      toast(`Cheque ${v.cheque_no} saved`);
      onSaved();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Edit cheque #${c.cheque_no}`} subtitle={`${c.direction === 'in' ? 'Received from' : 'Given to'} ${c.party_name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="chq-edit" disabled={busy}><Icon name="check" size={16} /> {busy ? 'Saving…' : 'Save cheque'}</button></>}>
      <form id="chq-edit" className="grid grid-2" onSubmit={save}>
        <Field label="Cheque owner"><input className="input" value={v.owner} onChange={set('owner')} /></Field>
        <Field label="Bank"><input className="input" list="bank-list" value={v.bank} onChange={set('bank')} placeholder="Which bank's cheque" /><BankList /></Field>
        <Field label="Cheque number" required><input className="input" value={v.cheque_no} onChange={set('cheque_no')} /></Field>
        <Field label="Amount (Rs)" required hint={c.payment_id ? 'The payment it made is corrected too' : ''}><NumInput money value={v.amount} onChange={set('amount')} /></Field>
        <Field label="Cheque date" required><DateInput value={v.cheque_date} onChange={set('cheque_date')} /></Field>
        <Field label="Notes" className="span-2"><input className="input" value={v.notes} onChange={set('notes')} /></Field>
        <p className="muted small span-2">Saving asks for the Super Admin password.</p>
      </form>
    </Modal>
  );
}

/** What each change does, shown before it is made. */
const ASK = {
  passed: { title: 'Mark as passed', icon: 'check', btn: 'Yes, mark passed', cls: 'btn-receive',
    text: (c) => (c.direction === 'in' ? `The cheque has cleared. ${c.party_name}'s due comes down by ${lkr(c.amount)}.` : `The cheque has cleared. It stays paid to ${c.party_name}.`) },
  returned: { title: 'Mark as returned', icon: 'back', btn: 'Yes, mark returned', cls: 'btn-danger-solid',
    text: (c) => (c.direction === 'in' ? `The cheque came back. ${c.party_name} still owes this ${lkr(c.amount)}.` : `The cheque came back. ${lkr(c.amount)} is owed to ${c.party_name} again.`) },
  holding: { title: 'Put on hold', icon: 'pause', btn: 'Yes, put on hold', cls: 'btn-primary',
    text: () => 'The cheque is held back for now (not deposited yet). It does not pass by itself on the cheque date. No money changes.' },
  delete: { title: 'Delete cheque', icon: 'trash', btn: 'Yes, delete cheque', cls: 'btn-danger-solid',
    text: (c) => `Only for a cheque entered by mistake. It is removed from the Cheque Desk${c.payment_id ? (c.direction === 'in' ? `, and the ${lkr(c.amount)} it paid comes off — ${c.party_name}'s due goes back up` : `, and the ${lkr(c.amount)} it paid is owed to ${c.party_name} again`) : ''}. Needs the Super Admin password.` },
  pending: { title: 'Back to waiting', icon: 'arrowRight', btn: 'Yes, back to waiting', cls: 'btn-primary',
    text: (c) => (c.status === 'holding' ? 'The hold is lifted — the cheque is waiting again, and passes by itself at 3:00 PM on the cheque date.' : 'Undo: the cheque goes back to waiting, as if it was not passed or returned. It will not pass by itself again — mark it Passed when it clears.') },
};

/** The two sides of the desk, and the tabs on each. */
const SIDES = [
  { value: 'in', label: 'Received cheques', hint: 'From customers', icon: 'plus', who: 'From', empty: 'Cheques are added here when a customer pays by cheque (Payment Portal).' },
  { value: 'out', label: 'Given cheques', hint: 'To cargo & suppliers', icon: 'minus', who: 'To', empty: 'Cheques are added here when you pay a cargo company or a local supplier by cheque (Payment Portal).' },
];
const TABS = [
  { value: 'today', label: "Today's", empty: 'No cheques for today' },
  { value: 'upcoming', label: 'Upcoming', empty: 'No upcoming cheques' },
  { value: 'passed', label: 'Passed', empty: 'No passed cheques yet' },
  { value: 'holding', label: 'Hold', empty: 'No cheques on hold' },
  { value: 'returned', label: 'Returned', empty: 'No returned cheques' },
];

export default function Cheques() {
  const toast = useToast();
  const [version, setVersion] = useState(0);
  const { data, error, loading, reload } = useApi(`/cheques?v=${version}`);
  const [side, setSide] = useState('in');
  const [tab, setTab] = useState('today');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [shown, setShown] = useState(null);   // the cheque whose history is open

  const t0 = today();
  const week = addDays(t0, 7);
  const mine = (data || []).filter((c) => c.direction === side);
  const inTab = (c, t = tab) => ({
    // waiting cheques for today (and any from past dates that were put back to waiting by hand)
    today: c.status === 'pending' && c.cheque_date <= t0,
    upcoming: c.status === 'pending' && c.cheque_date > t0,
    passed: c.status === 'passed',
    holding: c.status === 'holding',
    returned: c.status === 'returned',
  })[t];
  const list = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = mine.filter((c) => inTab(c) && (!words.length || words.every((w) => [c.cheque_no, c.owner, c.bank, c.party_name, c.bill_no, c.notes].join(' ').toLowerCase().includes(w))));
    // waiting cheques: soonest first; done ones: newest first
    return ['passed', 'returned'].includes(tab) ? rows.slice().reverse() : rows;
  }, [data, side, tab, q]); // eslint-disable-line

  const of = (t) => mine.filter((c) => inTab(c, t));
  const total = (rows) => rows.reduce((t, c) => t + (c.currency === 'INR' ? 0 : c.amount), 0);
  const todays = of('today');
  const nextWeek = mine.filter((c) => c.status === 'pending' && c.cheque_date > t0 && c.cheque_date <= week);
  const held = of('holding');
  const waiting = mine.filter(open);   // every cheque not passed or returned yet (waiting or on hold)
  const back = of('returned');
  const money = (c) => (c.currency === 'INR' ? inr : lkr);
  const sideCount = (d) => (data || []).filter((c) => c.direction === d && c.status === 'pending' && c.cheque_date <= t0).length;

  const [asking, setAsking] = useState(null);   // { c, status } waiting for the OK
  const mark = (c, status) => setAsking({ c, status });
  const [editing, setEditing] = useState(null);   // the cheque being corrected
  const confirmMark = async () => {
    const { c, status } = asking;
    setBusy(c.id);
    try {
      if (status === 'delete') await api.del(`/cheques/${c.id}`);
      else await api.post(`/cheques/${c.id}/status`, { status });
      toast(status === 'delete' ? `Cheque ${c.cheque_no} deleted` : `Cheque ${c.cheque_no}: ${STATUS[status].label}`);
      setAsking(null);
      setVersion((v) => v + 1);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const S = SIDES.find((s) => s.value === side);
  // the ⋯ menu: what else can be done with the cheque where it is now
  const menu = (c) => {
    const returned = { label: 'Mark as returned', icon: 'back', danger: true, onClick: () => mark(c, 'returned') };
    const undo = { label: 'Undo — back to waiting', icon: 'back', onClick: () => mark(c, 'pending') };
    const items = {
      pending: [returned, { label: 'Put on hold', icon: 'pause', onClick: () => mark(c, 'holding') }],
      holding: [returned, { label: 'Release hold', icon: 'arrowRight', onClick: () => mark(c, 'pending') }],
      passed: [undo],
      returned: [undo],
    }[c.status];
    return [...items, { label: 'Edit cheque', icon: 'edit', onClick: () => setEditing(c) }, { label: 'Delete cheque', icon: 'trash', danger: true, onClick: () => mark(c, 'delete') }];
  };

  return (
    <div>
      <PageHeader title="Cheque Desk" subtitle="Cheques received from customers, and cheques given to cargo companies and suppliers." />

      <div className="stats mb">
        <Stat icon="calendar" tone={todays.length ? 'amber' : 'default'} label="Today" value={`${todays.length} cheque${todays.length === 1 ? '' : 's'}`} sub={lkr(total(todays))} onClick={() => setTab('today')} />
        <Stat icon="cheque" tone="green" label="Total amount of cheques" value={lkr(total(waiting))} sub={`${waiting.length} cheque${waiting.length === 1 ? '' : 's'} waiting${held.length ? ` · ${held.length} on hold` : ''}`} onClick={() => setTab('upcoming')} />
        <Stat icon="clock" tone="blue" label="Next 7 days" value={lkr(total(nextWeek))} sub={`${nextWeek.length} cheque${nextWeek.length === 1 ? '' : 's'}`} onClick={() => setTab('upcoming')} />
        <Stat icon="alert" tone={back.length ? 'red' : 'green'} label="Returned" value={lkr(total(back))} sub={`${back.length} cheque${back.length === 1 ? '' : 's'}`} onClick={() => setTab('returned')} />
      </div>

      <div className="chq-sides" role="tablist" aria-label="Received or given cheques">
        {SIDES.map((x) => {
          const waiting = (data || []).filter((c) => c.direction === x.value && open(c));
          const due = sideCount(x.value);
          return (
            <button key={x.value} type="button" role="tab" aria-selected={side === x.value} className={`chq-side ${x.value} ${side === x.value ? 'on' : ''}`}
              onClick={() => { setSide(x.value); setShown(null); }}>
              <span className="chq-side-icon"><Icon name={x.value === 'in' ? 'arrowDown' : 'arrowUp'} size={20} /></span>
              <span className="chq-side-text">
                <b>{x.label}</b>
                <small>{x.hint} · {waiting.length} waiting{waiting.length ? ` · ${lkr(total(waiting))}` : ''}</small>
              </span>
              {due > 0 && <span className="nav-count" title="Due today or before">{due}</span>}
            </button>
          );
        })}
      </div>

      <Tabs value={tab} onChange={setTab} tabs={TABS.map((t) => ({ value: t.value, label: t.label, count: t.value === 'passed' ? undefined : of(t.value).length }))} />
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={`Search cheque no, owner, bank, ${side === 'in' ? 'customer' : 'cargo or supplier'}…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="spacer" />
        <span className="muted small"><Icon name="clock" size={13} /> Waiting cheques pass automatically at <b>3:00 PM</b> on the cheque date.</span>
      </div>
      <ErrorBox error={error} onRetry={reload} />

      <Card pad={false}>
        {loading && !data ? <Loading /> : !list.length ? (
          <Empty icon="calendar" title={q ? 'Nothing matches' : TABS.find((t) => t.value === tab).empty} text={q ? `No cheque for "${q}".` : S.empty} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Cheque date</th><th>Cheque</th><th>{S.who}</th><th className="right">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.flatMap((c) => [
                  <tr key={c.id} className={`hover click ${c.direction === 'in' ? 'chq-in' : 'chq-out'}`} onClick={() => setShown(shown === c.id ? null : c.id)} title="Show its history">
                    <td className="nowrap"><b>{niceDate(c.cheque_date)}</b>
                      <div className="sub">{c.status !== 'pending' ? '' : c.cheque_date === t0 ? 'Today · passes at 3:00 PM' : c.cheque_date < t0 ? 'Date passed' : `in ${Math.round((new Date(c.cheque_date) - new Date(t0)) / 86400000)} days`}</div></td>
                    <td className="nowrap"><b className="mono">#{c.cheque_no}</b><div className="sub">{[c.owner, c.bank].filter(Boolean).join(' · ') || '—'}</div></td>
                    <td><b>{c.party_name}</b>
                      <div className="sub">{PARTY[c.party]}{c.bill_no ? ` · ${c.bill_no}` : ''}{c.notes ? ` · ${c.notes}` : ''}</div></td>
                    <td className="right nowrap"><b className={c.direction === 'in' ? 'text-green' : 'text-amber'}>{money(c)(c.amount)}</b></td>
                    <td><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                      {c.status === 'passed' && <div className="sub">{niceDate(c.passed_on)}{(c.history || []).at(-1)?.by === 'Auto' ? ' · automatically' : ''}</div>}</td>
                    <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                      {open(c) && <button className="btn btn-sm btn-receive" disabled={busy === c.id} onClick={() => mark(c, 'passed')}><Icon name="check" size={13} /> Passed</button>}
                      {c.status === 'passed' && <button className="btn btn-sm btn-danger" disabled={busy === c.id} onClick={() => mark(c, 'returned')}><Icon name="back" size={13} /> Returned</button>}
                      <MoreMenu disabled={busy === c.id} items={menu(c)} />
                    </td>
                  </tr>,
                  shown === c.id && (
                    <tr key={`${c.id}-h`} className="cargo-detail"><td colSpan={6}>
                      <div className="pay-step-title">History of cheque #{c.cheque_no}</div>
                      <div className="chq-history">
                        {(c.history || []).map((h, i) => (
                          <span key={i}><Badge tone={STATUS[h.status]?.tone || 'grey'}>{STATUS[h.status]?.label || h.status}</Badge> {h.at ? niceDateTime(h.at) : ''}{h.by ? ` · ${h.by}` : ''}{h.note ? ` · ${h.note}` : ''}</span>
                        ))}
                        <span className="muted">{c.direction === 'in' ? 'Received' : 'Given'} on {niceDate(c.given_on)}</span>
                        {c.party === 'customer' && <Link to={`/customers/${c.party_id}`}>Open customer</Link>}
                        {c.party === 'supplier' && <Link to={`/suppliers/${c.party_id}`}>Open supplier</Link>}
                        {c.party === 'cargo' && <Link to="/dues?tab=cargo">Open cargo payments</Link>}
                      </div>
                    </td></tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <EditCheque c={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setVersion((x) => x + 1); }} />}
      {asking && (() => {
        const { c, status } = asking;
        const a = ASK[status];
        return (
          <Modal size="sm" title={a.title} subtitle={`Cheque #${c.cheque_no} · ${c.direction === 'in' ? 'from' : 'to'} ${c.party_name}`} onClose={() => setAsking(null)}
            footer={<><button className="btn" onClick={() => setAsking(null)}>Cancel</button>
              <button className={`btn ${a.cls}`} disabled={busy === c.id} onClick={confirmMark}><Icon name={a.icon} size={15} /> {busy === c.id ? 'Saving…' : a.btn}</button></>}>
            <div className="stack">
              <div className="chq-ask">
                <div><span>Amount</span><b className={c.direction === 'in' ? 'text-green' : 'text-amber'}>{money(c)(c.amount)}</b></div>
                <div><span>Cheque date</span><b>{niceDate(c.cheque_date)}</b></div>
                <div><span>Owner</span><b>{c.owner || '—'}</b></div>
                <div><span>Bank</span><b>{c.bank || '—'}</b></div>
              </div>
              <p>{a.text(c)}</p>
            </div>
          </Modal>
        );
      })()}
      <p className="muted small mt-s">
        <b>Passed</b>: the cheque cleared — waiting cheques pass by themselves at 3:00 PM on the cheque date; a customer's due comes down only then.
        <b> Returned</b>: it came back — mark it on the Passed tab. A cheque you gave is owed again; a customer's due goes back up.
        <b> Hold</b>: held back for now (it does not pass by itself), no money changes.
      </p>
    </div>
  );
}
