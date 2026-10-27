import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

/*
 * Printing without a print page: bills and stickers are drawn in a hidden frame on this page and printed from
 * there (no new tab), while a short animation shows what is being printed — a bill coming out of the printer,
 * or labels running off the roll.
 */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Draws `element` in a hidden frame with the app's styles and the page size in `css`.
 * Returns { doc, win, cleanup } — print with win.print(), or send doc's html to the print agent.
 */
export async function printFrame({ title, width, height, css, element }) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width, height, border: '0' });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${String(title || 'Print').replace(/[<&]/g, '')}</title></head><body></body></html>`);
  doc.close();
  // the app's own styles, then the page size
  const loads = [];
  for (const n of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    const c = n.cloneNode(true);
    if (n.tagName === 'LINK') { c.href = n.href; loads.push(new Promise((r) => { c.onload = r; c.onerror = r; setTimeout(r, 2000); })); }
    doc.head.appendChild(c);
  }
  const page = doc.createElement('style');
  page.textContent = css;
  doc.head.appendChild(page);
  const root = createRoot(doc.body);
  flushSync(() => root.render(element));
  await Promise.all(loads);
  await wait(120);
  return { doc, win: frame.contentWindow, cleanup: () => setTimeout(() => { root.unmount(); frame.remove(); }, 1500) };
}

/* ---------------- the printing animation ---------------- */

function BillArt() {
  return (
    <div className="pa-printer">
      <div className="pa-paper pa-bill">
        <i className="w60" /><i className="w40" /><span className="pa-rule" />
        <i /><i className="w80" /><i className="w70" /><i /><span className="pa-rule" />
        <i className="w50 pa-total" />
      </div>
      <div className="pa-body"><span className="pa-light" /></div>
    </div>
  );
}
function LabelArt({ code }) {
  return (
    <div className="pa-labeler">
      <div className="pa-roll"><span /></div>
      <div className="pa-track">
        <div className="pa-strip">
          {Array.from({ length: 6 }, (_, k) => (
            <div key={k} className="pa-label"><i className="w70" /><b>{code || '0016'}</b><i className="w50" /></div>
          ))}
        </div>
      </div>
    </div>
  );
}
function PrintingCard({ kind, title, sub, state, code }) {
  return (
    <div className={`pa-overlay ${state}`} role="status" aria-live="polite">
      <div className="pa-card">
        <div className="pa-art">{kind === 'label' ? <LabelArt code={code} /> : <BillArt />}</div>
        <b className="pa-title">{state === 'done' ? '✓ Sent to the printer' : `Printing ${title}…`}</b>
        {sub && <span className="pa-sub">{sub}</span>}
      </div>
    </div>
  );
}

/**
 * Shows the animation while `job` runs: kind 'bill' or 'label'. The animation plays a moment first, then the job
 * prints; when it is done a tick shows and the card fades away. An error closes it and is thrown on.
 */
export async function withPrinting({ kind, title, sub, code }, job) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const show = (state) => flushSync(() => root.render(<PrintingCard kind={kind} title={title} sub={sub} code={code} state={state} />));
  const close = async (ms) => { await wait(ms); show('out'); await wait(250); root.unmount(); host.remove(); };
  show('run');
  try {
    await wait(1300);   // let it be seen before the printer (or the print window) takes over
    const result = await job();
    show('done');
    close(1100);
    return result;
  } catch (e) {
    close(0);
    throw e;
  }
}
