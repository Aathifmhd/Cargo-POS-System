import { useEffect, useRef, useState } from 'react';

/* Sizes are stored as text, e.g. "S, M, L" or "28/32, 30/36" or "Free size". */
// Used only when a product's category isn't in the shop's catalogue (Settings → Categories & products).
export const SIZE_SYSTEMS = {
  letter: { label: 'Shirts · T-shirts', sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'] },
  waist: { label: 'Pants (waist)', sizes: ['28', '29', '30', '31', '32', '33', '34', '35', '36'] },
};
const FREE = 'Free size';

const split = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const same = (a, b) => a.toUpperCase() === b.toUpperCase();

function guessMode(value, options, hint = '') {
  const tokens = split(value);
  if (tokens.length === 1 && /^free/i.test(tokens[0])) return 'free';
  if (options?.length) return 'list';
  if (tokens.length && tokens.every((t) => /^\d{2}$/.test(t))) return 'waist';
  if (tokens.length) return 'letter';
  return /pant|trouser|jean|denim|track|short|bottom/i.test(hint) ? 'waist' : 'letter';
}

/**
 * Tap the sizes that come in the pack.
 * options: the sizes of the product's category (from Settings). Without it, generic lists are offered.
 * onChange(text, count) — count is how many single sizes are ticked (0 when a range like "28/32" is
 * ticked, since a range is already a pack), so the caller can suggest "1 piece of each size per set".
 */
export default function SizePicker({ value, onChange, options, hint }) {
  const hasList = Boolean(options?.length);
  const [mode, setMode] = useState(() => guessMode(value, options, hint));
  // when the category (and so the size list) changes, show that category's sizes
  const optionsKey = (options || []).join('|');
  useEffect(() => { setMode(guessMode(value, options, hint)); }, [optionsKey]); // eslint-disable-line

  // the latest choice, even before the parent has re-rendered — so quick taps build on each other
  const latest = useRef(value);
  latest.current = value;
  const chosen = split(value);
  const base = mode === 'list' ? options || [] : SIZE_SYSTEMS[mode]?.sizes || [];
  // sizes already on this product that are no longer in the list stay shown (tap to remove)
  const list = mode === 'free' ? [] : [...base, ...chosen.filter((c) => c !== FREE && !base.some((b) => same(b, c)))];
  const emit = (arr) => {
    latest.current = arr.join(', ');
    onChange(latest.current, arr.every((s) => !s.includes('/')) ? arr.length : 0);
  };

  const switchMode = (m) => {
    setMode(m);
    if (m === 'free') return emit([FREE]);
    const next = m === 'list' ? options : SIZE_SYSTEMS[m].sizes;
    emit(next.filter((x) => chosen.some((c) => same(c, x))));   // keep what still fits
  };
  const toggle = (s) => {
    const now = split(latest.current);
    const on = now.some((c) => same(c, s));
    emit(list.filter((x) => (same(x, s) ? !on : now.some((c) => same(c, x)))));   // keep list order
  };
  const modes = hasList
    ? [['list', 'Sizes'], ['free', 'Free size']]
    : [['letter', 'S – 5XL'], ['waist', '28 – 36'], ['free', 'Free size']];

  return (
    <div className="size-picker">
      <div className="sp-modes">
        {modes.map(([m, label]) => (
          <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => switchMode(m)}>{label}</button>
        ))}
      </div>
      {list.length > 0 && (
        <div className="sp-sizes">
          {list.map((s) => (
            <button key={s} type="button" className={`sp-size ${chosen.some((c) => same(c, s)) ? 'on' : ''}`} onClick={() => toggle(s)}>{s}</button>
          ))}
        </div>
      )}
      {mode === 'free' && <div className="sp-note">One size fits all</div>}
    </div>
  );
}
