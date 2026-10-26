import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Empty, Tabs, Badge, RoleBadge } from '../components/ui.jsx';
import { useNarrow } from '../components/mobile.js';

const LIVE_MS = 5000;          // how often the list checks for new activity
const SEEN_KEY = 'cargo-action-center-seen';
const pad = (x) => String(x).padStart(2, '0');

/** A stored time ("2026-10-16 09:30:12", UTC) as a Date on this computer's clock. */
const toDate = (s) => new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') ? '' : 'Z'));
/** hh:mm (the phone list) */
function shortTime(s) {
  const d = toDate(s);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** hh:mm:ss */
function timeOf(s) {
  const d = toDate(s);
  return Number.isNaN(d.getTime()) ? '—' : `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** The local day, 'YYYY-MM-DD' (for grouping). */
function dayKey(d) {
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 'Today · 16/10/2026', 'Yesterday · 15/10/2026', or 'Wednesday · 14/10/2026' */
function dayLabel(key) {
  const nice = `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}`;
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (key === dayKey(today)) return `Today · ${nice}`;
  if (key === dayKey(yesterday)) return `Yesterday · ${nice}`;
  return `${new Date(`${key}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long' })} · ${nice}`;
}
const isLogin = (a) => /^Logged (in|out)$/.test(a.action);

/**
 * Action Center (Super Admin only): everything that happens in the system, live, day by day.
 * "All activities" = the whole activity log · "Super admin approvals" = what needed (and got) the Super Admin.
 */
export default function ActionCenter() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [logins, setLogins] = useState(true);
  const [fresh, setFresh] = useState(() => new Set());   // ids that just arrived (highlighted for a moment)
  const newest = useRef(0);
  const narrow = useNarrow();   // a phone: each activity as a short card instead of the table

  const load = async (initial = false) => {
    try {
      const got = await api.get(`/action-center${initial ? '' : `?after=${newest.current}`}`);
      setError(null);
      if (initial) { setRows(got); newest.current = got[0]?.id || 0; }
      else if (got.length) {
        newest.current = Math.max(newest.current, ...got.map((a) => a.id));
        setRows((r) => [...got, ...(r || [])].slice(0, 1000));
        setFresh(new Set(got.map((a) => a.id)));
        setTimeout(() => setFresh(new Set()), 4000);
      }
      try { localStorage.setItem(SEEN_KEY, String(newest.current)); } catch { /* private mode */ }
      window.dispatchEvent(new Event('cargo-action-center-seen'));
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(true); }, []);   // eslint-disable-line
  // always live: new activity is fetched every few seconds
  useEffect(() => {
    const t = setInterval(() => load(false), LIVE_MS);
    return () => clearInterval(t);
  }, []); // eslint-disable-line

  // the activities shown, grouped by day (newest day first)
  const days = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const shown = (rows || []).filter((a) =>
      (tab === 'all' || (tab === 'super' ? a.super : a.level === 'attention')) &&
      (logins || !isLogin(a)) &&
      (!words.length || words.every((w) => `${a.username || ''} ${a.action} ${a.approved_by || ''}`.toLowerCase().includes(w))));
    const out = [];
    for (const a of shown) {
      const key = dayKey(toDate(a.at));
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, items: [] });
      out[out.length - 1].items.push(a);
    }
    return out;
  }, [rows, tab, q, logins]);
  const superCount = (rows || []).filter((a) => a.super).length;
  const attentionCount = (rows || []).filter((a) => a.level === 'attention').length;
  // the Attention tab open = its messages are read (the red count on the menu goes)
  useEffect(() => {
    if (tab !== 'attention' || !rows) return;
    const top = Math.max(0, ...rows.filter((a) => a.level === 'attention').map((a) => a.id));
    try { localStorage.setItem('cargo-attention-seen', String(top)); } catch { /* private mode */ }
    window.dispatchEvent(new Event('cargo-attention-seen'));
  }, [tab, rows]);
  const unreadAttention = (() => { let seen = 0; try { seen = Number(localStorage.getItem('cargo-attention-seen')) || 0; } catch { /* private mode */ } return (rows || []).filter((a) => a.level === 'attention' && a.id > seen).length; })();

  return (
    <div>
      <PageHeader title="Action Center" subtitle="Everything that happens in the system, as it happens — and every change the Super Admin approved." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'all', label: 'All activities', count: rows?.length },
        { value: 'super', label: 'Super admin approvals', count: superCount },
        { value: 'attention', label: <span className="row gap-s"><Icon name="alert" size={14} /> Attention{tab !== 'attention' && unreadAttention > 0 && <span className="nav-count">{unreadAttention}</span>}</span>, count: attentionCount },
      ]} />
      {tab === 'attention' && <p className="muted small mb">Things to act on: returned cheques, cheques on hold too long, big bills overdue, supplier payments due soon, GRN shorts not settled, bills below cost, big discounts, large cash refunds, wrong passwords, products 10 pcs below zero, and a put-off backup.</p>}
      <div className="toolbar">
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search user, action or approver…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {tab === 'all' && <label className="check"><input type="checkbox" checked={logins} onChange={(e) => setLogins(e.target.checked)} /> Show logins</label>}
      </div>
      {error && <ErrorBox error={error} onRetry={() => load(true)} />}
      {!rows ? <Card><Loading /></Card> : !days.length ? (
        <Card><Empty icon={tab === 'super' ? 'crown' : tab === 'attention' ? 'alert' : 'clock'} title={q ? 'Nothing matches' : tab === 'super' ? 'No Super Admin approvals yet' : tab === 'attention' ? 'Nothing needs attention' : 'No activity yet'}
          text={q ? `Nothing for "${q}".` : 'New activity shows up here by itself.'} /></Card>
      ) : (
        <div className="stack">
          {days.map((d) => (
            <Card key={d.key} pad={false}
              title={<span className="row gap-s"><Icon name="calendar" size={16} /> {dayLabel(d.key)}</span>}
              actions={<span className="badge badge-grey">{d.items.length} {d.items.length === 1 ? 'activity' : 'activities'}</span>}>
              {narrow ? (
                /* phone: what happened first (in full), then time · who and who approved it */
                <div className="ac-list">
                  {d.items.map((a) => (
                    <div key={a.id} className={`ac-item ${fresh.has(a.id) ? 'ac-is-new' : ''} ${isLogin(a) ? 'ac-is-login' : ''} ${a.level === 'attention' ? 'ac-is-attention' : ''}`}>
                      <div className="ac-what">
                        {a.level === 'attention' && <Badge tone="red"><Icon name="alert" size={11} /> Attention</Badge>}
                        {a.level === 'nostock' && <Badge tone="amber">No stock</Badge>}
                        <span>{a.action}</span>
                      </div>
                      <div className="ac-meta">
                        <span className="ac-time">{shortTime(a.at)}</span>
                        <b className="ac-who">{a.username || '—'}</b>
                        {a.role && <RoleBadge role={a.role} />}
                        {/* who approved it — not repeated when a Super Admin did it themself */}
                        {(a.approved_by ? a.approved_by !== a.username : a.super && a.role !== 'superadmin') && (
                          <span className="ac-ok">
                            <Badge tone={a.super ? 'amber' : 'violet'}><Icon name={a.super ? 'crown' : 'lock'} size={11} /> {a.approved_by ? `OK by ${a.approved_by}` : 'Super Admin'}</Badge>
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Time</th><th>Who</th><th>What happened</th><th>Approved by</th></tr></thead>
                  <tbody>
                    {d.items.map((a) => (
                      <tr key={a.id} className={`hover ${fresh.has(a.id) ? 'ac-new' : ''} ${isLogin(a) ? 'ac-login' : ''} ${a.level === 'attention' ? 'ac-attention' : ''}`}>
                        <td className="nowrap mono small">{timeOf(a.at)}</td>
                        <td className="nowrap"><b>{a.username || '—'}</b>{a.role && <> <RoleBadge role={a.role} /></>}</td>
                        <td>{a.level === 'attention' && <Badge tone="red"><Icon name="alert" size={12} /> Attention</Badge>}{a.level === 'nostock' && <Badge tone="amber">No stock</Badge>} {a.action}</td>
                        <td className="nowrap">{a.approved_by
                          ? <Badge tone={a.super ? 'amber' : 'violet'}><Icon name={a.super ? 'crown' : 'lock'} size={12} /> {a.approved_by}</Badge>
                          : a.super ? <Badge tone="amber"><Icon name="crown" size={12} /> Super Admin</Badge> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <p className="muted small mt-s">The newest {rows ? Math.min(rows.length, 1000) : 0} activities. New activity appears by itself.</p>
    </div>
  );
}
