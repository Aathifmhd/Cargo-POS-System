import { useEffect, useState } from 'react';
import { api, lkr, inr, niceDateTime } from '../lib.js';
import { useOffline, sync, retry, discard, deviceNo, setDeviceNo, isOnline } from '../offline.js';
import { Icon, Modal, useToast } from './ui.jsx';

/**
 * The strip at the top when there is no internet, or when bills and payments made offline are waiting to go:
 * "Offline — 3 waiting", "Sending 3…", or "1 couldn't be saved" (tap to see why, try again or remove it).
 * Also gives this device its number for offline bills (OFF1-…), the first time it is online.
 */
export default function OfflineBar({ user }) {
  const { online, syncing, items } = useOffline();
  const [open, setOpen] = useState(false);
  const toast = useToast();

  useEffect(() => {
    try { localStorage.setItem('cargo-pos-user', user.username); } catch { /* private mode */ }
    if (!deviceNo() && isOnline()) api.post('/sales/device', { label: navigator.userAgent.slice(0, 80) }).then((d) => setDeviceNo(d.device)).catch(() => {});
    sync();   // anything left from before (the app was closed while offline)
  }, [user.username]);
  useEffect(() => {
    const done = (e) => toast(`Internet is back — ${e.detail.sent} bill${e.detail.sent === 1 ? '' : 's'} / payment${e.detail.sent === 1 ? '' : 's'} made offline sent`);
    window.addEventListener('cargo-pos-synced', done);
    return () => window.removeEventListener('cargo-pos-synced', done);
  }, [toast]);

  const waiting = items.filter((i) => i.status === 'pending');
  const failed = items.filter((i) => i.status === 'failed');
  if (online && !items.length) return null;
  const tone = failed.length ? 'bad' : !online ? 'off' : 'sync';
  return (
    <>
      <button type="button" className={`offline-bar ${tone}`} onClick={() => setOpen(true)}>
        <Icon name={failed.length ? 'alert' : online ? 'refresh' : 'info'} size={16} />
        <span>
          {!online ? <><b>No internet — working offline.</b> New Sale and payments still work; they are kept on this device and sent by themselves when the internet is back. Other pages show the data as last seen.</>
            : syncing ? <b>Internet is back — sending {waiting.length} made offline…</b>
              : waiting.length ? <b>{waiting.length} made offline waiting to send</b> : null}
          {failed.length > 0 && <> <b>{failed.length} made offline could not be saved — tap to see why.</b></>}
        </span>
        {(waiting.length > 0 || failed.length > 0) && <em>{waiting.length} waiting{failed.length ? ` · ${failed.length} not saved` : ''}</em>}
      </button>
      {open && (
        <Modal title="Made offline" subtitle={online ? 'Sent by themselves, oldest first' : 'No internet — these are sent by themselves when it is back'} onClose={() => setOpen(false)}
          footer={<><button className="btn" onClick={() => setOpen(false)}>Close</button>{online && waiting.length > 0 && <button className="btn btn-primary" disabled={syncing} onClick={() => sync()}><Icon name="refresh" size={15} /> {syncing ? 'Sending…' : 'Send now'}</button>}</>}>
          {!items.length ? <p className="muted">Nothing waiting — everything made offline has been sent.</p> : (
            <div className="offline-list">
              {items.map((it) => (
                <div key={it.id} className={`offline-item ${it.status}`}>
                  <div className="offline-top">
                    <b>{it.label}</b>
                    <span className="spacer" />
                    <b>{it.money === 'INR' ? inr(it.amount) : lkr(it.amount)}</b>
                  </div>
                  <div className="muted small">{it.kind === 'sale' ? 'Bill' : 'Payment'} · made {niceDateTime(new Date(it.at).toISOString().slice(0, 19).replace('T', ' '))}{it.status === 'pending' ? ' · waiting' : ''}</div>
                  {it.status === 'failed' && (
                    <div className="offline-fail">
                      <span className="text-red small"><Icon name="alert" size={13} /> Not saved: {it.error}</span>
                      <span className="spacer" />
                      <button className="btn btn-sm" disabled={!online} onClick={() => retry(it.id)}>Try again</button>
                      <button className="btn btn-sm btn-ghost text-red" onClick={() => { if (confirm(`Remove "${it.label}"? It was not saved in the system, and will not be.`)) discard(it.id); }}>Remove</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
