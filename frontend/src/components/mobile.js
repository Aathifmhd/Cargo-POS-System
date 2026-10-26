import { useEffect, useState } from 'react';

/** A phone or a touch screen: a choice in a pop-up acts on a tap (no Continue / Enter buttons), no keyboard hints. */
export function usePhone() {
  const narrow = useNarrow();
  const [touch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  return narrow || touch;
}

/** True on a phone-sized screen (follows the window as it is resized or turned). */
export function useNarrow(width = 900) {
  const q = `(max-width: ${width}px)`;
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const mm = window.matchMedia(q);
    const f = () => setOn(mm.matches);
    mm.addEventListener('change', f);
    return () => mm.removeEventListener('change', f);
  }, [q]);
  return on;
}

/*
 * Phones: every table (.table) is shown as cards — each row a card, each cell "Label …… value" (styles.css,
 * "Mobile"). The label of a cell is its column's heading, put on the cell as data-label. This keeps it so for
 * every table on every page, also when rows are added or the page changes.
 */
/** The cells a compact phone row shows: title, sub, value (the amount) and badge — the rest show when it is opened. */
function markRoles(tr) {
  const cells = [...tr.cells];
  if (cells.length < 2 || cells.some((c) => c.colSpan > 1)) { tr.classList.add('whole'); return; }   // a note or group row: shown whole
  const filled = (td) => td.textContent.trim() && td.getAttribute('data-label') !== '';
  // a page can name them: m-title, m-sub, m-value, m-badge on the cells
  const hint = (k) => cells.find((td) => td.classList.contains(`m-${k}`));
  const title = hint('title') || cells[0];
  const value = hint('value') || cells.find((td, i) => i > 0 && td.classList.contains('right') && td.classList.contains('strong') && filled(td))
    || cells.find((td, i) => i > 0 && td.classList.contains('right') && /(Rs|₹|\d)/.test(td.textContent) && filled(td))
    || cells.slice(1).reverse().find((td) => /(Rs|₹)\s?[\d,]/.test(td.textContent) && filled(td));
  const badge = hint('badge') || cells.find((td) => td !== title && td !== value && td.querySelector('.badge, .status-badge'));
  const sub = hint('sub') || cells.find((td) => td !== title && td !== value && td !== badge && filled(td) && !td.querySelector('button'));
  const role = (td) => (td === title ? 'title' : td === value ? 'value' : td === badge ? 'badge' : td === sub ? 'sub' : '');
  let more = false;
  for (const td of cells) {
    const r = role(td);
    if (td.getAttribute('data-role') !== r) { if (r) td.setAttribute('data-role', r); else td.removeAttribute('data-role'); }
    if (!r && td.textContent.trim()) more = true;
  }
  tr.classList.toggle('has-more', more);   // there is more to see: the row can be opened
}

function labelTables(root) {
  for (const table of root.querySelectorAll('table.table, table.till-tbl, .till-hits table')) {
    const heads = [...(table.tHead?.rows[0]?.cells || [])].map((th) => th.textContent.trim());
    if (!heads.length) continue;
    for (const body of [...table.tBodies, table.tFoot].filter(Boolean)) {
      for (const tr of body.rows) {
        let col = 0;
        for (const td of tr.cells) {
          const label = heads[col] || '';
          if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
          col += td.colSpan || 1;
        }
        if (table.classList.contains('table') && body !== table.tFoot) markRoles(tr);
      }
    }
  }
}

export function useTableLabels() {
  useEffect(() => {
    const tap = (e) => {
      if (!window.matchMedia('(max-width: 860px)').matches) return;
      const tr = e.target.closest?.('table.table tbody tr.has-more');
      if (!tr || tr.classList.contains('click') || e.target.closest('button, a, input, select, textarea, label')) return;
      tr.classList.toggle('open');
    };
    document.addEventListener('click', tap);
    let queued = false;
    const run = () => { queued = false; labelTables(document); };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
    run();
    const watch = new MutationObserver(queue);
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { watch.disconnect(); document.removeEventListener('click', tap); };
  }, []);
}

/**
 * While the phone's keyboard is open (typing in a box), <html> gets the class "kb-open": the tab bar and the
 * Take Payment bar are hidden then, so they never ride up on top of the keyboard. Known from the box in focus,
 * and from the visible screen getting much shorter than the window (the keyboard taking its place).
 */
export function useKeyboardOpen() {
  useEffect(() => {
    const root = document.documentElement;
    const typingBox = (el) => el && (el.tagName === 'TEXTAREA' || el.isContentEditable
      || (el.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range', 'color', 'file', 'date'].includes(el.type))
      || el.tagName === 'SELECT');
    const vv = window.visualViewport;
    let timer;
    let touchedAt = 0;   // the last tap: a box focused without one (autofocus) doesn't open the phone's keyboard
    let tapped = false;
    const update = () => {
      const shrunk = vv ? vv.height < window.innerHeight * 0.78 : false;
      root.classList.toggle('kb-open', (tapped && typingBox(document.activeElement)) || shrunk);
    };
    const onTouch = () => { touchedAt = Date.now(); };
    const onIn = () => { clearTimeout(timer); tapped = Date.now() - touchedAt < 1000; update(); };
    const onOut = () => { clearTimeout(timer); timer = setTimeout(() => { if (!typingBox(document.activeElement)) tapped = false; update(); }, 120); };   // the next box may take the focus straight away
    document.addEventListener('touchstart', onTouch, { passive: true });
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    vv?.addEventListener('resize', update);
    return () => {
      document.removeEventListener('touchstart', onTouch);
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      vv?.removeEventListener('resize', update);
      clearTimeout(timer);
      root.classList.remove('kb-open');
    };
  }, []);
}

/**
 * Phones: pull the page down from the top to refresh it (the browser's own pull-to-refresh is off, so the page
 * doesn't bounce). The whole page slides down with the finger and the refresh arrow shows in the space it leaves
 * at the top, turning with the pull; at a quarter turn (90°) the pull stops and the page reloads with fresh data (a bill or GRN being made is kept — they are saved as
 * you go). A short tug springs back. Not while a pop-up or the menu is open, while typing, or once the page is
 * scrolled down. Returns how far it is pulled (0 … 1+, of PULL_TRIGGER) — the page is moved by pull × PULL_TRIGGER px.
 */
export const PULL_TRIGGER = 64;   // px the page has to come down to refresh
export function usePullToRefresh(enabled = true) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let startY = null; let dist = 0;
    const blocked = (el) => document.querySelector('.modal') || document.documentElement.classList.contains('kb-open')
      || document.querySelector('.nav-open') || el?.closest?.('.modal, .sidebar, .till-hits, .table-wrap[style*="overflow"]');
    const onStart = (e) => {
      if (e.touches.length !== 1 || window.scrollY > 0 || blocked(e.target)) { startY = null; return; }
      startY = e.touches[0].clientY; dist = 0;
    };
    const onMove = (e) => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || window.scrollY > 0) { dist = 0; setPull(0); return; }
      dist = dy * 0.55;   // resistance: the page moves about half as far as the finger (and stops at the trigger)
      if (e.cancelable) e.preventDefault();
      setPull(dist / PULL_TRIGGER);   // the icon only turns while pulling; the page refreshes when the finger lets go
    };
    const onCancel = () => { startY = null; dist = 0; setPull(0); };
    const onEnd = () => {
      if (startY == null) return;
      startY = null;
      if (dist >= PULL_TRIGGER) { setRefreshing(true); setPull(1); setTimeout(() => window.location.reload(), 150); }
      else setPull(0);
      dist = 0;
    };
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onCancel);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onCancel);
    };
  }, [enabled]);
  return { pull, refreshing };
}
