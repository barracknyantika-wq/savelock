// Hand-feel SVG generators, returned as markup strings and injected with
// x-html so Alpine re-draws them whenever the underlying store data changes.

const PALETTE = {
  lit: '#b07e1f', // ochre on cream
  unlit: '#d9d2c0',
  litLow: '#b4452f', // brick when nearly nothing left
  barPast: 'rgba(92, 86, 74, 0.38)',
  barToday: '#b07e1f',
  barOver: '#b4452f',
  baseline: '#c9c2b0',
  label: '#8a8272',
};

// Semicircular gauge built from short radial ticks, like a hand-inked dial.
export function tickGauge(ratio, { ticks = 35, low = false, dark = false } = {}) {
  const n = Math.max(0, Math.min(1, ratio));
  const lit = Math.round(n * ticks);
  const cx = 100;
  const cy = 98;
  const r1 = 72;
  const r2 = 93;
  let lines = '';
  for (let i = 0; i < ticks; i++) {
    const a = Math.PI * (1 - i / (ticks - 1));
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const isLit = i < lit;
    const color = isLit ? (low ? PALETTE.litLow : PALETTE.lit) : dark ? 'rgba(244,241,234,0.16)' : PALETTE.unlit;
    // faint hand-drawn wobble so ticks don't feel machine-set
    const wob = ((i * 7919) % 5 - 2) * 0.35;
    lines += `<line x1="${(cx + cos * (r1 + wob)).toFixed(1)}" y1="${(cy - sin * (r1 + wob)).toFixed(1)}" x2="${(cx + cos * r2).toFixed(1)}" y2="${(cy - sin * r2).toFixed(1)}" stroke="${color}" stroke-width="${isLit ? 3.4 : 2.4}" stroke-linecap="round"/>`;
  }
  return `<svg viewBox="0 0 200 102" aria-hidden="true" style="width:100%;height:auto;display:block">${lines}</svg>`;
}

// Small sketchy bar chart of the last few days of spending.
// days: [{ label, spent, limit, today }]
export function sketchBars(days) {
  const W = 300;
  const H = 96;
  const chartH = 64;
  const top = 8;
  const n = days.length;
  const bw = 24;
  const gap = (W - n * bw) / (n + 1);
  const max = Math.max(1, ...days.map((d) => d.spent), ...days.map((d) => d.limit || 0));
  let out = '';

  // hand-drawn dashed limit line
  const limit = days[days.length - 1]?.limit || 0;
  if (limit > 0) {
    const ly = top + chartH - (limit / max) * chartH;
    out += `<line x1="6" y1="${(ly + 1.2).toFixed(1)}" x2="${W - 6}" y2="${(ly - 1.2).toFixed(1)}" stroke="${PALETTE.label}" stroke-width="1.4" stroke-dasharray="6 5" stroke-linecap="round" opacity="0.75"/>`;
  }

  days.forEach((d, i) => {
    const x = gap + i * (bw + gap);
    const h = d.spent > 0 ? Math.max(4, (d.spent / max) * chartH) : 0;
    const y = top + chartH - h;
    const over = d.limit > 0 && d.spent > d.limit;
    const fill = over ? PALETTE.barOver : d.today ? PALETTE.barToday : PALETTE.barPast;
    const rot = (((i * 37) % 5) - 2) * 0.7;
    if (h > 0) {
      out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="3.5" fill="${fill}" transform="rotate(${rot} ${(x + bw / 2).toFixed(1)} ${(top + chartH).toFixed(1)})"/>`;
    } else {
      out += `<line x1="${(x + 3).toFixed(1)}" y1="${top + chartH - 1}" x2="${(x + bw - 3).toFixed(1)}" y2="${top + chartH - 1}" stroke="${PALETTE.unlit}" stroke-width="3" stroke-linecap="round"/>`;
    }
    out += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="10" font-family="inherit" fill="${d.today ? PALETTE.lit : PALETTE.label}" font-weight="${d.today ? 700 : 400}">${d.label}</text>`;
  });

  // baseline with a slight hand tilt
  out += `<line x1="4" y1="${top + chartH + 1.6}" x2="${W - 4}" y2="${top + chartH + 0.4}" stroke="${PALETTE.baseline}" stroke-width="1.6" stroke-linecap="round"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true" style="width:100%;height:auto;display:block">${out}</svg>`;
}

// Hand-drawn squiggle underline for positive states.
export function squiggle(color = PALETTE.lit) {
  return `<svg viewBox="0 0 120 8" aria-hidden="true" style="width:7rem;height:0.5rem;display:block"><path d="M2 5 C 18 1, 32 7, 50 4 S 86 1.5, 118 5" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="round"/></svg>`;
}

// Hand-drawn check for celebration states.
export function handCheck(color = PALETTE.lit) {
  return `<svg viewBox="0 0 26 22" aria-hidden="true" style="width:1.5rem;height:1.3rem;display:inline-block;vertical-align:-0.2em"><path d="M2.5 11 C 6 13.5, 8.5 16.5, 10.5 19 C 13.5 12, 18 6, 24 2.5" fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
