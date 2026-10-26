import { useState } from 'react';
import { downloadFile, today, addDays, niceDate } from '../lib.js';
import { Icon, Segmented, DateInput, useToast } from './ui.jsx';

/** Reports → Download reports: Excel sheets of the shop's records for a chosen period. */
const REPORTS = [
  { key: 'grns', icon: 'truck', label: 'GRN details', text: 'Every GRN in the period (supplier, bale, cargo, costs, paid and balance), and a sheet of their items.' },
  { key: 'stock', icon: 'box', label: 'Stock details', text: 'Stock on hand today, one line per product and cost, with its value — and the stock movements in the period.' },
  { key: 'invoices', icon: 'receipt', label: 'Invoice details', text: 'Every bill in the period with time, customer, totals, cost, profit and balance — and a sheet of the bill items.' },
  { key: 'customers', icon: 'users', label: 'Customer details', text: 'All customers with contact details, credit limit, what they bought in the period, and what they owe today.' },
  { key: 'suppliers', icon: 'factory', label: 'Supplier details', text: 'All suppliers with contact and bank details, GRNs in the period, and what is to pay today.' },
  { key: 'cargo', icon: 'truck', label: 'Cargo details', text: 'All cargo companies with contact details, shipments and payments in the period, and what is to pay today — and a sheet of their cargo bills with the Extra & Short settled with them.' },
  { key: 'payments', icon: 'wallet', label: 'Payment details', text: 'Two sheets: cash, bank and card payments (received and paid), and cheques (received and given) — in the period.' },
  { key: 'dues', icon: 'clock', label: 'Payment due details', text: 'Three sheets as on today: to receive from customers, to pay suppliers, and to pay cargo.' },
];
const PERIODS = {
  month: () => [today().slice(0, 8) + '01', today()],
  lastMonth: () => { const first = today().slice(0, 8) + '01'; const end = addDays(first, -1); return [end.slice(0, 8) + '01', end]; },
  last30: () => [addDays(today(), -29), today()],
  year: () => [today().slice(0, 5) + '01-01', today()],
  all: () => ['2000-01-01', today()],
};

export default function DownloadReports() {
  const toast = useToast();
  const [preset, setPreset] = useState('month');
  const [[from, to], setRange] = useState(PERIODS.month());
  const [chosen, setChosen] = useState(() => new Set(REPORTS.map((r) => r.key)));
  const [busy, setBusy] = useState(null);   // the report being made ('all' = the chosen ones)

  const pick = (p) => { setPreset(p); setRange(PERIODS[p]()); };
  const toggle = (k) => setChosen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const get = async (keys, id) => {
    if (!keys.length) return toast('Choose at least one report', 'error');
    if (from > to) return toast('The "from" date is after the "to" date', 'error');
    setBusy(id);
    try {
      const name = keys.length === 1 ? REPORTS.find((r) => r.key === keys[0]).label.toLowerCase().replace(/\s+/g, '-') : 'reports';
      await downloadFile(`/export?reports=${keys.join(',')}&from=${from}&to=${to}`, `cargo-pos-${name}-${from}-to-${to}.xlsx`);
      toast(keys.length === 1 ? `${REPORTS.find((r) => r.key === keys[0]).label} downloaded` : `${keys.length} reports downloaded in one Excel file`);
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(null); }
  };
  const allTime = preset === 'all';

  return (
    <div className="set-form dl-reports">
      <div className="dl-period">
        <div className="pay-step-title">Time period</div>
        <Segmented value={preset} onChange={pick} options={[
          { value: 'month', label: 'This month' }, { value: 'lastMonth', label: 'Last month' }, { value: 'last30', label: '30 days' },
          { value: 'year', label: 'This year' }, { value: 'all', label: 'All time' },
        ]} />
        <div className="row gap-s wrap mt-s">
          <DateInput style={{ width: 160 }} value={allTime ? '' : from} placeholder="From" onChange={(e) => { setPreset(''); setRange([e.target.value, to]); }} />
          <span className="muted">to</span>
          <DateInput style={{ width: 160 }} value={to} onChange={(e) => { setPreset(''); setRange([allTime ? '2000-01-01' : from, e.target.value]); }} />
          <span className="muted small">{allTime ? `Everything up to ${niceDate(to)}` : `${niceDate(from)} – ${niceDate(to)}`}</span>
        </div>
      </div>

      <div className="dl-list">
        {REPORTS.map((r) => (
          <label key={r.key} className={`dl-item ${chosen.has(r.key) ? 'on' : ''}`}>
            <input type="checkbox" checked={chosen.has(r.key)} onChange={() => toggle(r.key)} />
            <span className="dl-icon"><Icon name={r.icon} size={18} /></span>
            <span className="dl-text"><b>{r.label}</b><small>{r.text}</small></span>
            <button type="button" className="btn btn-sm" disabled={busy != null} onClick={(e) => { e.preventDefault(); get([r.key], r.key); }}>
              <Icon name="download" size={14} /> {busy === r.key ? 'Making…' : 'Excel'}
            </button>
          </label>
        ))}
      </div>

      <div className="row gap-s wrap mt">
        <button className="btn btn-primary" disabled={busy != null || !chosen.size} onClick={() => get(REPORTS.filter((r) => chosen.has(r.key)).map((r) => r.key), 'all')}>
          <Icon name="download" size={16} /> {busy === 'all' ? 'Making the Excel file…' : `Download ${chosen.size === REPORTS.length ? 'all reports' : `${chosen.size} selected`} in one Excel file`}
        </button>
        <span className="muted small">Each report is a sheet (tab) in the file. Balances, stock on hand and dues are as on today.</span>
      </div>
    </div>
  );
}
