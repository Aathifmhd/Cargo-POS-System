/*
 * The logo's M, drawn (traced from the Mizdoo logo, its outlines smoothed): the mark in the menu, the phone bar and
 * on bills. It takes the colour of the text around it — white in the menu, dark on light pages, black on a bill.
 * In the logo's own units: 'centred' has the M's square in the middle (the tick reaching out to the right),
 * 'tight' is just the letter.
 */
const M_PATH = 'M4.5 10.3L31.4 9.9L251.4 9.9L267.4 10.1L282.1 10.8L282.6 66.7L283.5 85.5L297 73.8L322.8 50.2L335.6 39.2L326 50.5L315.3 62.3L242.7 141L224.8 159.7L213.8 148.6L197.8 130.8L153 82.4L135.1 63.6L125.1 54L120.5 50.2L116.6 47.5L112.5 45.3L108.3 43.8L104.1 43.1L100.9 43.4L97.9 44.3L95.2 45.9L93.5 47.5L92 49.4L89.9 54.1L88.6 60.3L88.1 68L87.8 144.9L88 175.9L87.7 203.8L88 245.8L87.7 269.8L87.2 287.7L72.4 288.3L56.4 288.5L24.4 288.5L4.5 288L3.9 269.2L3.8 236.2L3.8 39.2L3.9 24.2ZM163.5 201.2L171.3 207L177.2 212.1L200.3 235.5L207.6 242L211.4 244.8L215.5 246.9L219.6 248.2L223 248.6L226.3 248.3L230.4 247L234.4 245L238.2 242.2L244 237L265 215.8L281.2 201.3L282.1 212.7L282.4 224.5L282.5 265.5L282.1 287.4L265.4 288.2L242.5 288.5L183.5 288.4L160.7 287.6L160 265.8L160.7 222L161.5 211.4Z';
const BOX = { centred: '-62 7 410 284', tight: '3 9 345 280' };

export function MLogo({ className, fit = 'centred' }) {
  return (
    <svg className={className} viewBox={BOX[fit]} aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d={M_PATH} />
    </svg>
  );
}
