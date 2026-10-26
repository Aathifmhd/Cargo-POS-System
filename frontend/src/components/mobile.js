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
