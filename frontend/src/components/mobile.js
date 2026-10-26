import { useEffect, useState } from 'react';

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
function labelTables(root) {
  for (const table of root.querySelectorAll('table.table, table.till-tbl')) {
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
      }
    }
  }
}

export function useTableLabels() {
  useEffect(() => {
    let queued = false;
    const run = () => { queued = false; labelTables(document); };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
    run();
    const watch = new MutationObserver(queue);
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
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
    const update = () => {
      const shrunk = vv ? vv.height < window.innerHeight * 0.78 : false;
      root.classList.toggle('kb-open', typingBox(document.activeElement) || shrunk);
    };
    const onIn = () => { clearTimeout(timer); update(); };
    const onOut = () => { clearTimeout(timer); timer = setTimeout(update, 120); };   // the next box may take the focus straight away
    document.addEventListener('focusin', onIn);
    document.addEventListener('focusout', onOut);
    vv?.addEventListener('resize', update);
    return () => {
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('focusout', onOut);
      vv?.removeEventListener('resize', update);
      clearTimeout(timer);
      root.classList.remove('kb-open');
    };
  }, []);
}
