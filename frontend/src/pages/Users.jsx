import { Fragment, useMemo, useState } from 'react';
import { api, useApi, ROLE_NAME, isSuper } from '../lib.js';
import { PageHeader, Card, Icon, Loading, ErrorBox, Badge, Modal, Field, Segmented, Tabs, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const when = (s) => (s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Users() {
  const [tab, setTab] = useState('users');
  return (
    <div>
      <PageHeader title="Users & Security" subtitle="Who can log in, and a record of every important change and who approved it." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users' }, { value: 'log', label: 'Activity log' }, { value: 'rules', label: 'What needs admin approval' }]} />
      {tab === 'users' && <UserList />}
      {tab === 'log' && <ActivityLog />}
      {tab === 'rules' && <Rules />}
    </div>
  );
}

function UserList() {
  const { user: me } = useAuth();
  const { data, error, reload } = useApi('/users');
  const [edit, setEdit] = useState(null); // user | 'new'
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <Card pad={false} title="People who can log in" actions={<button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add user</button>}>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Last login</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id}>
              <td className="strong">{u.name} {u.id === me.id && <Badge tone="teal">You</Badge>}</td>
              <td>{u.username}</td>
              <td><Badge tone={u.role === 'superadmin' ? 'amber' : u.role === 'admin' ? 'violet' : 'blue'}>{ROLE_NAME[u.role]}</Badge></td>
              <td>{when(u.last_login)}</td>
              <td>{u.active ? <Badge tone="green">Active</Badge> : <Badge>Switched off</Badge>}</td>
              <td className="right">{(u.role !== 'superadmin' || isSuper(me)) && <button className="btn btn-sm" onClick={() => setEdit(u)}><Icon name="edit" size={15} /> Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {edit && <UserForm user={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Card>
  );
}

function UserForm({ user, onClose, onSaved }) {
  const toast = useToast();
  const { user: me } = useAuth();
  const [f, setF] = useState(user ? { ...user, password: '' } : { name: '', username: '', password: '', role: 'cashier', active: 1 });
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v && v.target ? (v.target.type === 'checkbox' ? v.target.checked : v.target.value) : v }));
  const save = async (e) => {
    e.preventDefault();
    try {
      if (user) await api.put(`/users/${user.id}`, f); else await api.post('/users', f);
      toast(user ? 'User updated' : 'User added');
      onSaved();
    } catch (err) { toast(err.message, 'error'); }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add a user'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="user-form">Save</button></>}>
      <form id="user-form" className="grid grid-2" onSubmit={save}>
        <Field label="Full name" required><input className="input" autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label="Username" required>{user ? <input className="input" value={f.username} disabled /> : <input className="input" value={f.username} onChange={set('username')} autoComplete="off" />}</Field>
        <Field label={user ? 'New password' : 'Password'} hint={user ? 'Leave empty to keep the current password' : 'At least 6 characters'} required={!user}>
          <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <Field label="Role">
          <Segmented value={f.role} onChange={set('role')} options={[
            { value: 'cashier', label: 'Cashier' }, { value: 'admin', label: 'Admin' },
            ...(isSuper(me) ? [{ value: 'superadmin', label: 'Super Admin' }] : []),
          ]} />
        </Field>
        <div className="span-2 muted small">
          {f.role === 'superadmin' ? 'The Super Admin can do everything, and is the only one who can change credit limits.'
            : f.role === 'admin' ? 'Admins can do everything except change credit limits, and can approve changes for cashiers.'
            : 'Cashiers can bill, receive goods and take payments. Important changes need an admin\'s password.'}
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

function Rules() {
  const list = [
    ['Customers', 'Changing credit days or old balance · making inactive · deleting · deleting a payment'],
    ['Billing', 'Selling below cost price · cancelling a bill'],
    ['Stock & prices', 'Changing expected price, MRP or pieces per set · stock corrections · adding a product manually · deleting a product'],
    ['Suppliers', 'Changing credit days, old balance or bank details · deleting · deleting a payment'],
    ['Shipments', 'Deleting a GRN'],
    ['System', 'Changing settings · downloading a full backup'],
  ];
  return (
    <Card>
      <p className="mb">When a <b>cashier</b> does one of these, the system asks for an <b>admin username and password</b> on the same screen. The approval works once, for that change only, and is written to the activity log. Admins are not asked.</p>
      <dl className="info-list">{list.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>
      <div className="alert alert-amber mt"><Icon name="shield" />
        <span><b>Super Admin only:</b> setting or changing a customer's <b>credit limit</b> — including raising it on the till when a credit bill would go over the limit. Admins are asked for the Super Admin password too.</span>
      </div>
      <p className="muted small mt-s">Credit bills are only for registered customers — never for walk-in customers.</p>
    </Card>
  );
}
