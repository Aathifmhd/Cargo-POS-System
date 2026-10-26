import { Fragment, useMemo, useState } from 'react';
import { api, useApi, isSuper, PERMS, ROLE_PERMS } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Badge, RoleBadge, Modal, Field, Segmented, Tabs, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const when = (s) => (s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Users() {
  const [tab, setTab] = useState('users');
  return (
    <div>
      <PageHeader title="Users & Security" subtitle="Who can log in, and a record of every important change and who approved it." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users' }, { value: 'log', label: 'Activity log' }, { value: 'rules', label: 'Super admin approvals' }]} />
      {tab === 'users' && <UserList />}
      {tab === 'log' && <ActivityLog />}
      {tab === 'rules' && <Rules />}
    </div>
  );
}

function UserList() {
  const { user: me } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useApi('/users');
  const [edit, setEdit] = useState(null); // user | 'new'
  // deleting needs the Super Admin's password; the Super Admin can never be deleted
  const remove = async (u) => {
    if (!confirm(`Delete ${u.name} (${u.username})? They will no longer be able to log in. Their past bills and activity stay.`)) return;
    try { await api.del(`/users/${u.id}`); toast(`${u.name} deleted`); reload(); } catch (err) { toast(err.message, 'error'); }
  };
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <Card pad={false} title="People who can log in" actions={<button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add user</button>}>
      <div className="alert alert-amber small users-note"><Icon name="crown" size={16} /> Adding, editing or deleting a user always needs the Super Admin's password. The Super Admin can't be deleted.</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last login</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id}>
              <td className="strong">{u.name} {u.id === me.id && <Badge tone="teal">You</Badge>}</td>
              <td>{u.username}</td>
              <td><RoleBadge role={u.role} />{u.custom_perms && u.role !== 'superadmin' && <div className="sub" title={PERMS.filter((p) => u.perms?.[p.key]).map((p) => p.label).join(', ')}>custom permissions</div>}</td>
              <td>{when(u.last_login)}</td>
              <td>{u.active ? <Badge tone="green">Active</Badge> : <Badge>Switched off</Badge>}</td>
              <td className="right nowrap">
                <button className="btn btn-sm" onClick={() => setEdit(u)}><Icon name="edit" size={15} /> Edit</button>
                {u.role !== 'superadmin' && u.id !== me.id && <button className="btn btn-sm btn-ghost btn-icon" title="Delete user" onClick={() => remove(u)}><Icon name="trash" size={15} /></button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit && <UserForm users={data || []} user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Card>
  );
}

/** The roles, and what each can do. The system has one Super Admin only. */
const ROLES = [
  { value: 'cashier', label: 'Cashier', text: 'Bills and takes payments. Doesn\'t see what products cost — the cost code only. Important changes need an admin\'s password.' },
  { value: 'kp', label: 'KP', text: 'Like a cashier: doesn\'t see what products cost — the cost code only. Important changes need an admin\'s password.' },
  { value: 'employee', label: 'Employee', text: 'Like a cashier: doesn\'t see what products cost — the cost code only. Important changes need an admin\'s password.' },
  { value: 'admin', label: 'Admin', text: 'Sees costs and profit, enters the GRNs (receive goods), and approves changes for the others. Can\'t change credit limits.' },
  { value: 'superadmin', label: 'Super Admin', text: 'Can do everything. There is only one Super Admin in the system.' },
];

function UserForm({ users = [], user, onClose, onSaved }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const superUser = users.find((u) => u.role === 'superadmin');   // the one Super Admin
  const [f, setF] = useState(user ? { ...user, password: '', perms: { ...ROLE_PERMS[user.role], ...(user.perms || {}) } } : { name: '', username: '', password: '', role: 'cashier', active: 1, perms: { ...ROLE_PERMS.cashier } });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  // a new role starts from that role's permissions (they can be changed below)
  const setRole = (e) => { const role = e.target.value; setF((x) => ({ ...x, role, perms: { ...ROLE_PERMS[role] } })); };
  const togglePerm = (k) => setF((x) => {
    const perms = { ...x.perms, [k]: !x.perms[k] };
    if (perms.receive_goods || perms.reports) perms.see_cost = true;   // these show costs
    return { ...x, perms };
  });
  const isSuperUser = f.role === 'superadmin';
  const changedFromRole = !isSuperUser && PERMS.some((p) => Boolean(f.perms?.[p.key]) !== Boolean(ROLE_PERMS[f.role]?.[p.key]));
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { ...f, perms: changedFromRole ? f.perms : {} };   // the role default is saved as "no changes"
      if (user) await api.put(`/users/${user.id}`, body); else await api.post('/users', body);
      toast(user ? 'User updated' : 'User added');
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a user'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="user-form">Save</button></>}>
      {/* autofill and password-manager pop-ups are kept off this form: it is for other people, not the person logged in */}
      <form id="user-form" className="grid grid-2" onSubmit={save} autoComplete="off">
        <Field label="Full name" required><input className="input" autoFocus value={f.name} onChange={set('name')} name="staff-full-name" autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" /></Field>
        <Field label="Username" required><input className="input" value={f.username} onChange={set('username')} name="staff-login" autoComplete="off" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" /></Field>
        <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave empty to keep the current password' : 'At least 6 characters'} required={!user}>
          <input className="input" type="password" value={f.password} onChange={set('password')} name="staff-new-password" autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" data-bwignore="true" data-form-type="other" />
        </Field>
        <Field label="Role" hint={superUser && superUser.id !== user?.id ? `Only one Super Admin — "${superUser.username}" is the Super Admin` : ''}>
          {user?.role === 'superadmin'
            ? <div className="input input-static strong">Super Admin (the only one)</div>
            : (
              <select className="input" value={f.role} onChange={setRole}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value} disabled={r.value === 'superadmin' && (Boolean(superUser) || !isSuper(me))}>
                    {r.label}{r.value === 'superadmin' ? (superUser ? ' — only one, already set' : ' — only one') : ''}
                  </option>
                ))}
              </select>
            )}
        </Field>
        <div className="span-2 muted small">{ROLES.find((r) => r.value === f.role)?.text}</div>
        <div className="span-2 perm-box">
          <div className="perm-head">
            <b>What this user can see and do</b>
            {isSuperUser ? <span className="muted small">The Super Admin has everything</span>
              : changedFromRole ? <button type="button" className="link-btn" onClick={() => setF((x) => ({ ...x, perms: { ...ROLE_PERMS[x.role] } }))}>Back to the {ROLES.find((r) => r.value === f.role)?.label} default</button>
              : <span className="muted small">The {ROLES.find((r) => r.value === f.role)?.label} default</span>}
          </div>
          <div className="perm-list">
            {PERMS.map((p) => {
              const on = isSuperUser || Boolean(f.perms?.[p.key]);
              const locked = isSuperUser || (p.key === 'see_cost' && (f.perms?.receive_goods || f.perms?.reports));
              return (
                <label key={p.key} className={`perm ${on ? 'on' : ''} ${locked ? 'locked' : ''}`}>
                  <input type="checkbox" checked={on} disabled={locked} onChange={() => togglePerm(p.key)} />
                  <span><b>{p.label}</b><small>{p.text}</small></span>
                </label>
              );
            })}
          </div>
        </div>
        {user && <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Can log in</label>}
      </form>
    </Modal>
  );
}

function ActivityLog() {
  const { data, error, reload } = useApi('/audit');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('changes');
  const rows = useMemo(() => (data || []).filter((a) =>
    (only === 'all' || !/^Logged (in|out)$/.test(a.action)) &&
    (only !== 'approved' || a.approved_by) &&
    (!q || `${a.username} ${a.action} ${a.approved_by || ''}`.toLowerCase().includes(q.toLowerCase()))), [data, q, only]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="toolbar">
        <Segmented value={only} onChange={setOnly} options={[{ value: 'changes', label: 'Changes' }, { value: 'approved', label: 'Approved by admin' }, { value: 'all', label: 'Everything' }]} />
        <div className="search"><Icon name="search" size={16} /><input className="input" placeholder="Search user or action…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="btn btn-sm" onClick={reload}>Refresh</button>
      </div>
      <Card pad={false}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>User</th><th>What happened</th><th>Approved by</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={4} className="center muted">Nothing here yet.</td></tr>}
              {rows.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{when(a.at)}</td>
                  <td className="strong">{a.username || '—'}</td>
                  <td>{a.action}</td>
                  <td>{a.approved_by ? <Badge tone="amber"><Icon name="lock" size={12} /> {a.approved_by}</Badge> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

/** Users & Security → Super admin approvals: what only the Super Admin can open, and what needs the Super Admin's password. */
function Rules() {
  const only = [
    ['Action Center', 'Every activity as it happens, Super Admin approvals, and Attention — Admins only if given the "Action Center" permission'],
    ['Sales & Profit', 'Every sale, the Profit & loss, gross and net profit, losses with their reasons, past periods'],
    ['Stock Take', 'Starting, counting, uploading the count sheet, finishing the count, the P&L + stock Excel'],
    ['Start Fresh', 'After a finished stock take, once — the sales and the profit & loss start again'],
  ];
  const superPw = [
    ['Users', 'Adding, editing or deleting a user — their role and permissions too. Only one Super Admin; it can never be deleted'],
    ['Customers', 'Adding, editing or deleting a customer (NIC included) · setting or changing a credit limit — also on New Sale when a credit bill would go over it'],
    ['Suppliers', 'Adding, editing or deleting a supplier'],
    ['Bills & goods', 'Deleting a bill · editing a GRN'],
    ['Money', 'Undoing a payment (Payment Portal → History) · editing or deleting a cheque · marking a due as uncollectable, or undoing it'],
    ['Stock Take', 'Finishing the stock count · Start Fresh'],
  ];
  const adminPw = [
    ['Billing', 'Selling below cost price · cancelling a bill'],
    ['Stock & prices', 'Changing expected price or pieces per set · Stock Count (remove / add stock) · adding a product manually · deleting a product'],
    ['Customers & suppliers', 'Deleting a customer\'s or a supplier\'s payment · supplier bank details and credit days'],
    ['Cheques & GRNs', 'Passing, returning or holding a cheque · Extra & Short decisions · deleting a GRN'],
    ['System', 'Changing settings · downloading reports or a full backup'],
  ];
  return (
    <div className="stack">
      <Card title={<span className="row gap-s"><Icon name="crown" size={16} /> Only the Super Admin can open</span>}>
        <p className="muted small mb">Nobody else sees these in the menu, and the system refuses them.</p>
        <dl className="info-list">{only.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      </Card>
      <Card title={<span className="row gap-s"><Icon name="shield" size={16} /> Needs the Super Admin password</span>}>
        <p className="muted small mb">Whoever does these must type the <b>Super Admin password</b> — the Super Admin too, as a check. The approval works once, for that change only, and is written to the activity log.</p>
        <dl className="info-list">{superPw.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      </Card>
      <Card title={<span className="row gap-s"><Icon name="lock" size={16} /> Needs an Admin's password</span>}>
        <p className="muted small mb">When a <b>Cashier, KP or Employee</b> does one of these, the system asks for an <b>Admin's username and password</b> on the same screen. Admins and the Super Admin are not asked.</p>
        <dl className="info-list">{adminPw.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      </Card>
      <p className="muted small">What each user can see — costs, GRNs, suppliers, reports, the Payment Portal, the Cheque Desk, Settings, the Action Center — is set per user in <b>Users → Edit</b>. Credit bills are only for registered customers — never for walk-in customers.</p>
    </div>
  );
}
