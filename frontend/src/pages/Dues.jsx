import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, useApi, lkr, inr, supMoney, bothMoney, niceDate, dueText, niceTime, seesCost, can } from '../lib.js';
import { PageHeader, Card, Loading, ErrorBox, Empty, Stat, Tabs, Icon, Segmented, DateInput, Badge, Modal, Field, useToast } from '../components/ui.jsx';
import { SupplierPaymentModal, CustomerPaymentModal, CargoPaymentModal, ChequeReturned } from '../components/forms.jsx';
import { MoreMenu } from './Cheques.jsx';
import { whatsappReminder } from './CustomerView.jsx';
import { useSettings, useAuth } from '../App.jsx';

const GROUPS = [
  { key: 'overdue', title: 'Overdue — act now', tone: 'red' },
  { key: 'due-soon', title: 'Due within 7 days', tone: 'amber' },
  { key: 'open', title: 'Later', tone: 'blue' },
];

/** How a cheque stands, as a small badge (Cheque Desk words). */
const CHQ_BADGE = { pending: ['Waiting', 'blue'], holding: ['On hold', 'amber'], passed: ['Passed', 'green'], returned: ['Returned', 'red'] };
const ChqBadge = ({ status }) => (CHQ_BADGE[status] ? <Badge tone={CHQ_BADGE[status][1]}>{CHQ_BADGE[status][0]}</Badge> : null);

/** History, shown under the tables: payments made to suppliers / received from customers, newest first. */
function PaymentHistory({ isPay, cargo = false, version, onHide, onUndone }) {
  const kind = cargo ? 'cargo' : isPay ? 'payables' : 'receivables';
  const { data, error, loading, reload } = useApi(`/dues/history?kind=${kind}&v=${version}`);
  const toast = useToast();
  const [undoing, setUndoing] = useState(null);   // the payment waiting for "Yes, undo"
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      await api.del(`/payments/${kind}/${undoing.id}`);
      toast(`Payment of ${supMoney(undoing)(undoing.amount)} undone${undoing.cheque_id ? ' (its cheque is removed too)' : ''}`);
      setUndoing(null);
      reload();
      onUndone?.();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const [q, setQ] = useState('');
  const fmt = isPay ? inr : lkr;
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data || []).filter((p) => !words.length || words.every((w) => [p.who, p.who_sub, p.bill_no, p.method, p.reference, p.notes].join(' ').toLowerCase().includes(w)));
  }, [data, q]);
  const total = bothMoney(rows, (p) => p.amount);
  return (
    <Card className="dues-history" title={<span className="row gap-s"><Icon name="clock" size={16} /> {cargo ? 'Cargo payments — history' : isPay ? 'Payments made — history' : 'Payments received — history'} <span className="badge badge-grey">{rows.length}</span></span>}
      actions={<><b className="mono">{isPay ? total : fmt(rows.reduce((a, p) => a + p.amount, 0))}</b><button className="btn btn-sm btn-ghost" onClick={onHide}><Icon name="x" size={14} /> Hide</button></>}>
      <ErrorBox error={error} onRetry={reload} />
      <div className="toolbar"><div className="search"><Icon name="search" size={16} /><input className="input" placeholder={`Search ${isPay ? 'supplier' : 'customer'}, bill, method or reference…`} value={q} onChange={(e) => setQ(e.target.value)} /></div></div>
      {loading && !data ? <Loading /> : !rows.length ? (
        <Empty icon="clock" title={q ? 'Nothing matches' : 'No payments yet'} text={q ? `No payment for "${q}".` : isPay ? 'Payments to suppliers are listed here.' : 'Payments from customers are listed here.'} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>{cargo ? 'Cargo company' : isPay ? 'Supplier' : 'Customer'}</th>{!cargo && <th>{isPay ? 'GRN' : 'Bill'}</th>}<th>Method</th><th>Reference / notes</th><th className="right">Amount</th><th /></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="hover">
                  <td className="nowrap">{niceDate(p.date)}{p.at && <div className="sub">{niceTime(p.at)}</div>}</td>
                  <td>{cargo ? <b>{p.who}</b> : <Link to={isPay ? `/suppliers/${p.who_id}` : `/customers/${p.who_id}`} className="strong">{p.who}</Link>}{p.who_sub && <div className="sub">{p.who_sub}</div>}</td>
                  {!cargo && <td>{p.bill_no ? <Link to={isPay ? `/grn/${p.bill_id}` : `/sales/${p.bill_id}`}>{p.bill_no}</Link> : <span className="muted">Oldest first</span>}</td>}
                  <td>{p.method || '—'}</td>
                  <td>{p.reference || <span className="muted">—</span>}{p.notes && <div className="sub">{p.notes}</div>}</td>
                  <td className="right nowrap"><b className={isPay ? 'text-amber' : 'text-green'}>{supMoney(p)(p.amount)}</b>{isPay && p.currency !== 'LKR' && p.amount_lkr ? <div className="sub">{lkr(p.amount_lkr)}</div> : null}</td>
                  <td className="right"><button className="btn btn-sm btn-ghost" title="Undo this payment (Super Admin)" onClick={() => setUndoing(p)}><Icon name="back" size={13} /> Undo</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {undoing && (
        <Modal size="sm" title="Undo this payment?" subtitle={`${undoing.who} · ${niceDate(undoing.date)}`} onClose={() => setUndoing(null)}
          footer={<><button className="btn" onClick={() => setUndoing(null)} disabled={busy}>Cancel</button>
            <button className="btn btn-danger-solid" onClick={undo} disabled={busy}><Icon name="back" size={15} /> {busy ? 'Undoing…' : 'Yes, undo payment'}</button></>}>
          <div className="stack">
            <div className="pay-total"><span>{undoing.method || 'Payment'}{undoing.reference ? ` · ${undoing.reference}` : ''}</span><b>{supMoney(undoing)(undoing.amount)}</b></div>
            <p>The payment is taken back, so this amount is {kind === 'receivables' ? `owed by ${undoing.who}` : `to pay to ${undoing.who}`} again.
              {undoing.cheque_id ? ' It was paid by cheque — the cheque is removed from the Cheque Desk too.' : ''}</p>
            <p className="muted small">Needs the Super Admin password.</p>
          </div>
        </Modal>
      )}
    </Card>
  );
}

/** Payment Portal → To pay cargo: what each cargo company is owed (their GRNs' cargo charges), paid in bulk. */
function CargoTab({ version, onPaid }) {
  const { data, error, loading, reload } = useApi(`/cargo?v=${version}`);
  const [paying, setPaying] = useState(null);   // the company key being paid ('' = choose)
  const [open, setOpen] = useState(null);       // the company whose shipments are shown
  const [q, setQ] = useState('');
  const list = data || [];
  const shown = list.filter((c) => !q.trim() || c.cargo_name.toLowerCase().includes(q.trim().toLowerCase()));
  const owe = list.reduce((a, c) => a + c.balance, 0);
  const notNamed = list.find((c) => !c.named);
  return (
    <>
      <div className="stats mb">
        <Stat icon="truck" tone="amber" label="Total to pay cargo" value={lkr(owe)} sub={`${list.filter((c) => c.balance > 0.009).length} cargo companies`} />
        <Stat icon="layers" label="Cargo charges" value={lkr(list.reduce((a, c) => a + c.total, 0))} sub={`${list.reduce((a, c) => a + c.shipments, 0)} shipments`} />
        <Stat icon="check" tone="green" label="Paid so far" value={lkr(list.reduce((a, c) => a + c.paid, 0))} />
      </div>
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search cargo company…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <span className="spacer" />
        <button className="btn btn-pay" onClick={() => setPaying('')} disabled={!list.some((c) => c.named)}><Icon name="wallet" size={15} /> Pay cargo</button>
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {loading && !data ? <Loading /> : !shown.length ? (
          <Empty icon="truck" title={q ? 'Nothing matches' : 'No cargo charges yet'} text={q ? `No cargo company "${q}".` : 'Cargo charges come from the GRNs (cargo charge per piece × pieces). Enter the cargo company on each GRN.'} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Cargo company</th><th className="right">Shipments</th><th>Last shipment</th><th className="right">Cargo charges</th><th className="right">Paid</th><th className="right">To pay</th><th /></tr></thead>
              <tbody>
                {shown.flatMap((c) => [
                  <tr key={c.key} className="click" onClick={() => setOpen(open === c.key ? null : c.key)} title="Show the shipments">
                    <td><b>{c.cargo_name}</b>{!c.named && <div className="sub text-amber">Set the cargo name on these GRNs to pay them</div>}</td>
                    <td className="right">{c.shipments}</td>
                    <td>{niceDate(c.last_date)}</td>
                    <td className="right">{lkr(c.total)}</td>
                    <td className="right text-green">{lkr(c.paid)}</td>
                    <td className="right strong">{c.balance > 0.009 ? lkr(c.balance) : <Badge tone="green">Settled</Badge>}
                      {c.balance > 0.009 && (c.cheques_returned || []).map((x) => <div key={x.id} className="sub"><ChequeReturned c={x} /></div>)}</td>
                    <td className="right nowrap" onClick={(e) => e.stopPropagation()}>
                      {c.named && c.balance > 0.009 && <button className="btn btn-sm btn-pay" onClick={() => setPaying(c.key)}><Icon name="wallet" size={14} /> Pay</button>}
                    </td>
                  </tr>,
                  open === c.key && (
                    <tr key={`${c.key}-x`} className="cargo-detail"><td colSpan={7}>
                      <div className="grid grid-2">
                        <div>
                          <div className="pay-step-title">Shipments</div>
                          <table className="table mini">
                            <thead><tr><th>GRN</th><th>Date</th><th className="right">Cargo</th><th className="right">Still to pay</th></tr></thead>
                            <tbody>{c.bills.slice().reverse().map((b) => (
                              <tr key={b.id}><td>{b.pending ? <>{b.grn_no} <span className="badge badge-violet">With next bill</span></> : <Link to={`/grn/${b.id}`}>{b.grn_no}</Link>}</td><td>{niceDate(b.date)}</td><td className="right">{lkr(b.amount)}{(b.adjustments || []).map((a, i) => <div key={i} className="sub">{a.amount < 0 ? '−' : '+'} {lkr(Math.abs(a.amount))} {a.amount < 0 ? 'short, lost by cargo' : 'extra pieces'}</div>)}</td><td className="right">{b.balance > 0.009 ? lkr(b.balance) : <span className="text-green">{b.paid_by_cheque ? 'Paid by cheque' : 'Paid'}</span>}{(b.cheques_returned || []).map((x) => <div key={x.id} className="sub"><ChequeReturned c={x} /></div>)}</td></tr>
                            ))}</tbody>
                          </table>
                        </div>
                        <div>
                          <div className="pay-step-title">Payments</div>
                          {!c.payments.length ? <p className="muted small">Nothing paid yet.</p> : (
                            <table className="table mini">
                              <thead><tr><th>Date</th><th>How</th><th className="right">Amount</th></tr></thead>
                              <tbody>{c.payments.map((p) => (
                                <tr key={p.id} className={p.returned ? 'muted' : ''}><td className="nowrap">{niceDate(p.date)}{p.created_at && <div className="sub">{niceTime(p.created_at)}</div>}</td><td><span className="row gap-s">{p.method}<ChqBadge status={p.cheque_status} /></span>{p.reference || p.cheque_bank ? <div className="sub">{[p.reference, p.cheque_bank].filter(Boolean).join(' · ')}</div> : null}</td><td className="right">{p.returned ? <s>{lkr(p.amount)}</s> : lkr(p.amount)}</td></tr>
                              ))}</tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    </td></tr>
                  ),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {notNamed && <p className="muted small mt-s">"Cargo not named" is the cargo charge of GRNs without a cargo company. Open those GRNs and enter the cargo name to pay them here.</p>}


      {paying != null && <CargoPaymentModal companies={list} initial={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reload(); onPaid(); }} />}
    </>
  );
}

/* ---------- bad debts: dues a customer will never pay — written off as a loss ---------- */
const BAD_REASONS = ['Not paying', "Can't be found", 'Cheated us', 'Business closed', 'Other'];

/** Mark what is left on a bill as a bad debt (Super Admin password). */
function BadDebtModal({ b, onClose, onDone }) {
  const toast = useToast();
  const [reason, setReason] = useState(BAD_REASONS[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const left = b.balance;
  const go = async () => {
    if (reason === 'Other' && !note.trim()) return toast('Type the reason', 'error');
    setBusy(true);
    try {
      await api.post(`/customers/${b.customer_id}/bad-debts`, { sale_id: b.id ?? null, reason, note });
      toast(`${b.invoice_no} — ${lkr(left)} marked as uncollectable`);
      onDone();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal size="sm" title="Mark as uncollectable?" subtitle={`${b.customer_name} · ${b.invoice_no}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn btn-danger-solid" onClick={go} disabled={busy}><Icon name="alert" size={15} /> {busy ? 'Saving…' : 'Yes, mark as uncollectable'}</button></>}>
      <div className="stack">
        <div className="pay-total"><span>Can't be collected</span><b>{lkr(left)}</b></div>
        {b.cheque_pending > 0 && <div className="alert alert-amber small"><Icon name="clock" size={16} /><span>A cheque of {lkr(b.cheque_pending)} is still waiting on this bill — pass it or mark it returned first.</span></div>}
        <Field label="Why can't it be collected?">
          <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{BAD_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
        </Field>
        <Field label={reason === 'Other' ? 'The reason' : 'Details'} required={reason === 'Other'}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. shop closed, phone off since March" />
        </Field>
        <p className="small">The bill leaves <b>To collect</b> and goes to the <b>Uncollectable</b> list. {lkr(left)} is counted as a <b>loss</b> in Sales &amp; Profit → Profit &amp; loss. If they pay later, undo it from the Uncollectable list.</p>
        <p className="muted small">Needs the Super Admin password.</p>
      </div>
    </Modal>
  );
}

/** Payment Portal → Uncollectable: every due written off, with Undo (Super Admin password). */
function BadDebts({ data, error, reload, onUndone }) {
  const toast = useToast();
  const [undoing, setUndoing] = useState(null);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try { await api.del(`/bad-debts/${undoing.id}`); toast(`${undoing.invoice_no} — ${lkr(undoing.amount)} is to collect again`); setUndoing(null); onUndone(); } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const list = data || [];
  const total = list.reduce((t, d) => t + d.amount, 0);
  return (
    <>
      <div className="stats mb">
        <Stat icon="alert" tone="red" label="Uncollectable" value={lkr(total)} sub={`${list.length} bill${list.length === 1 ? '' : 's'} written off — counted as a loss`} />
      </div>
      <ErrorBox error={error} onRetry={reload} />
      <Card pad={false}>
        {!data ? <Loading /> : !list.length ? <Empty icon="check" title="Nothing uncollectable" text="When a customer will never pay a bill, mark it with ⋯ → Mark as uncollectable on To collect." /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Customer</th><th>Bill</th><th>Why</th><th className="right">Written off</th><th /></tr></thead>
            <tbody>{list.map((d) => (
              <tr key={d.id} className="hover">
                <td className="nowrap">{niceDate(d.date)}<div className="sub">by {d.by}</div></td>
                <td><Link to={`/customers/${d.customer_id}`} className="strong">{d.customer_name}</Link>{(d.customer_person || d.customer_phone) && <div className="sub">{[d.customer_person, d.customer_phone].filter(Boolean).join(' · ')}</div>}</td>
                <td>{d.sale_id ? <Link to={`/sales/${d.sale_id}`}>{d.invoice_no}</Link> : d.invoice_no}</td>
                <td><span className="badge-damaged">{d.reason}</span>{d.note && <div className="sub">{d.note}</div>}</td>
                <td className="right strong text-red">{lkr(d.amount)}</td>
                <td className="right"><button className="btn btn-sm btn-ghost" onClick={() => setUndoing(d)} title="They paid after all — the due is back (Super Admin)"><Icon name="back" size={13} /> Undo</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {undoing && (
        <Modal size="sm" title="Undo uncollectable?" subtitle={`${undoing.customer_name} · ${undoing.invoice_no}`} onClose={() => setUndoing(null)}
          footer={<><button className="btn" onClick={() => setUndoing(null)} disabled={busy}>Cancel</button><button className="btn btn-primary" onClick={undo} disabled={busy}><Icon name="back" size={15} /> {busy ? 'Undoing…' : 'Yes, to collect again'}</button></>}>
          <p>{lkr(undoing.amount)} goes back to <b>To collect</b> (for example, the customer has come to pay), and comes off the losses. Needs the Super Admin password.</p>
        </Modal>
      )}
    </>
  );
}

export default function Dues() {
  const [params, setParams] = useSearchParams();
  const seeCost = can(useAuth().user, 'suppliers');   // the supplier and cargo tabs: the "suppliers" permission
  const asked = params.get('tab') || 'receivables';
  const tab = asked === 'baddebts' || seeCost ? asked : 'receivables';
  const { settings } = useSettings();
  const pay = useApi(seeCost ? '/dues/payables' : null);
  const rec = useApi('/dues/receivables');
  const [modal, setModal] = useState(null);
  const [badFor, setBadFor] = useState(null);   // the bill being marked as uncollectable
  const bad = useApi('/bad-debts');
  const [history, setHistory] = useState(false);
  const [version, setVersion] = useState(0);   // bumped after a payment, so the history reloads too
  const showHistory = () => {
    setHistory((h) => !h);
    setTimeout(() => document.querySelector('.dues-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const isPay = tab === 'payables';
  const src = isPay ? pay : rec;
  const fmt = isPay ? inr : lkr;
  const rows = src.data || [];
  // search: supplier / customer, phone, bill or GRN number
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = rows.filter((r) => !words.length || words.every((w) => [r.supplier_name, r.customer_name, r.customer_person, r.customer_phone, r.grn_no, r.invoice_no].join(' ').toLowerCase().includes(w)));
  // customers: what is left after cheques still waiting to be passed (the credit limit still counts them as owed)
  const left = (b) => (isPay ? b.balance : b.balance_after_cheques ?? b.balance);
  const sum = (k) => rows.filter((r) => !k || r.status === k).reduce((a, b) => a + left(b), 0);
  const chequesWaiting = isPay ? 0 : rows.reduce((a, b) => a + (b.cheque_pending || 0), 0);
  // supplier bills: ₹ (India) and Rs (local) kept apart; customer bills are all Rs
  const sumText = (k) => (isPay ? bothMoney(rows.filter((r) => !k || r.status === k), (b) => b.balance) : fmt(sum(k)));

  const openPay = async (b) => {
    if (isPay) setModal({ type: 'sup', who: await api.get(`/suppliers/${b.supplier_id}`), id: b.id });
    else setModal({ type: 'cus', who: await api.get(`/customers/${b.customer_id}`), id: b.id });
  };
  const done = () => { setModal(null); pay.reload(); rec.reload(); setVersion((v) => v + 1); };

  return (
    <div>
      <PageHeader title="Payment Portal" subtitle="Money to collect from customers, money to pay suppliers, and cargo charges to pay." />
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[
        { value: 'receivables', label: 'To collect from customers', count: rec.data?.length },
        ...(seeCost ? [{ value: 'payables', label: 'To pay suppliers', count: pay.data?.length }, { value: 'cargo', label: 'To pay cargo' }] : []),
        { value: 'baddebts', label: 'Uncollectable', count: bad.data?.length || undefined },
      ]} />
      {tab === 'baddebts' ? <BadDebts data={bad.data} error={bad.error} reload={bad.reload} onUndone={() => { rec.reload(); bad.reload(); }} /> : tab === 'cargo' ? <CargoTab version={version} onPaid={() => setVersion((v) => v + 1)} /> : <>

      <div className="stats mb">
        <Stat icon="wallet" tone="blue" label={isPay ? 'Total to pay' : 'Total to collect'} value={sumText()} sub={chequesWaiting > 0 ? `after ${lkr(chequesWaiting)} in cheques waiting` : ''} />
        <Stat icon="alert" tone="red" label="Overdue" value={sumText('overdue')} />
        <Stat icon="clock" tone="amber" label="Due in 7 days" value={sumText('due-soon')} />
        <Stat icon="check" tone="green" label="Not due yet" value={sumText('open')} />
      </div>

      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder={isPay ? 'Search supplier or GRN…' : 'Search customer, phone or bill…'} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {q && <button className="btn btn-ghost" onClick={() => setQ('')}>Clear</button>}
      </div>

      <ErrorBox error={src.error} onRetry={src.reload} />
      {src.loading && !src.data ? <Loading /> : rows.length > 0 && shown.length === 0 ? (
        <Card><Empty icon="search" title="Nothing matches" text={`No ${isPay ? 'supplier bill' : 'customer bill'} for "${q}".`} action={<button className="btn" onClick={() => setQ('')}>Clear search</button>} /></Card>
      ) : rows.length === 0 ? (
        <Card><Empty icon="check" title={isPay ? 'Nothing to pay suppliers' : 'No customer has dues'} text="Everything is settled. 🎉" /></Card>
      ) : (
        <div className="stack">
          {GROUPS.map((g) => {
            const list = shown.filter((r) => r.status === g.key);
            if (!list.length) return null;
            return (
              <Card key={g.key} title={<span className="row gap-s"><span className={`badge badge-${g.tone}`}>{list.length}</span> {g.title}</span>} actions={<b className="mono">{isPay ? bothMoney(list, (b) => b.balance) : fmt(list.reduce((a, b) => a + left(b), 0))}</b>} pad={false}>
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>{isPay ? 'Supplier' : 'Customer'}</th><th>{isPay ? 'GRN · Bale' : 'Bill'}</th><th>Date</th><th>Due date</th><th className="right">Amount</th><th className="right">Balance</th><th></th></tr></thead>
                    <tbody>
                      {list.map((b) => (
                        <tr key={`${b.supplier_id || b.customer_id}-${b.id}`} className="hover">
                          <td><Link to={isPay ? `/suppliers/${b.supplier_id}` : `/customers/${b.customer_id}`} className="strong">{b.supplier_name || b.customer_name}</Link>{!isPay && (b.customer_person || b.customer_phone) && <div className="sub">{[b.customer_person, b.customer_phone].filter(Boolean).join(' · ')}</div>}</td>
                          <td>{isPay ? (b.id ? <Link to={`/grn/${b.id}`}>{b.grn_no}</Link> : b.grn_no) : (b.id ? <Link to={`/sales/${b.id}`}>{b.invoice_no}</Link> : b.invoice_no)}</td>
                          <td>{niceDate(b.date)}</td>
                          <td>{niceDate(b.due_date)}<div className={`sub ${b.status === 'overdue' ? 'text-red' : ''}`}>{dueText(b.due_date)}</div></td>
                          <td className="right">{(isPay ? supMoney(b) : fmt)(b.amount)}</td>
                          <td className="right strong">{(isPay ? supMoney(b) : fmt)(left(b))}
                            {!isPay && b.cheque_pending > 0 && <div className="sub"><span className="chq-wait">{lkr(b.cheque_pending)} by cheque · waiting</span></div>}
                            {(b.cheques_returned || []).map((c) => <div key={c.id} className="sub"><ChequeReturned c={c} money={isPay ? supMoney(b) : lkr} /></div>)}</td>
                          <td className="nowrap right">
                            {!isPay && b.customer_phone && b.status === 'overdue' && (
                              <a className="btn btn-sm btn-ghost" title="Send WhatsApp reminder" target="_blank" rel="noreferrer"
                                href={whatsappReminder({ name: b.customer_person || b.customer_name, phone: b.customer_phone }, b.balance, settings.shop_name)}><Icon name="phone" size={15} /></a>
                            )}
                            <button className={`btn btn-sm ${isPay ? 'btn-pay' : 'btn-receive'}`} onClick={() => openPay(b)}><Icon name={isPay ? 'wallet' : 'cash'} size={14} /> {isPay ? 'Pay' : 'Receive'}</button>
                            {!isPay && <MoreMenu items={[{ label: 'Mark as uncollectable', icon: 'alert', danger: true, onClick: () => setBadFor(b) }]} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })}
          <span className="muted small">Amounts for Indian suppliers are in Indian Rupees (₹), for local suppliers in Sri Lankan Rupees (Rs). Customer amounts are in Sri Lankan Rupees (Rs).</span>
        </div>
      )}

      </>}

      <div className="es-history-bar">
        <button className={`btn btn-sm ${history ? '' : 'btn-ghost'}`} onClick={showHistory}><Icon name="clock" size={14} /> {history ? 'Hide history' : 'History'}</button>
      </div>
      {history && <PaymentHistory isPay={isPay} cargo={tab === 'cargo'} version={version} onHide={() => setHistory(false)} onUndone={() => { pay.reload(); rec.reload(); setVersion((v) => v + 1); }} />}

      {modal?.type === 'sup' && <SupplierPaymentModal supplier={modal.who} bills={modal.who.bills} defaultGrnId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
      {badFor && <BadDebtModal b={badFor} onClose={() => setBadFor(null)} onDone={() => { setBadFor(null); rec.reload(); bad.reload(); setVersion((v) => v + 1); }} />}
      {modal?.type === 'cus' && <CustomerPaymentModal customer={modal.who} bills={modal.who.bills} defaultSaleId={modal.id} onClose={() => setModal(null)} onSaved={done} />}
    </div>
  );
}
