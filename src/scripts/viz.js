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

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
}

// Horizontal sketchy bar chart of spend-by-category, highest first. Only
// the relative bars + category names live in the SVG (matching sketchBars'
// minimal-data-in-chart approach) — exact amounts are rendered as normal
// text alongside it so currency formatting stays with the caller.
// items: [{ category, total, pct }], already sorted highest-first.
export function categoryBars(items) {
  if (!items.length) {
    return `<svg viewBox="0 0 300 32" aria-hidden="true" style="width:100%;height:auto;display:block"><text x="0" y="20" font-size="12" font-family="inherit" fill="${PALETTE.label}">Nothing logged yet.</text></svg>`;
  }
  const W = 300;
  const rowH = 28;
  const H = items.length * rowH + 8;
  const max = Math.max(1, ...items.map((i) => i.total));
  const labelW = 76;
  const barMaxW = W - labelW - 8;
  let out = '';
  items.forEach((item, i) => {
    const y = i * rowH + 6;
    const bw = Math.max(4, (item.total / max) * barMaxW);
    const rot = (((i * 41) % 5) - 2) * 0.4;
    const color = i === 0 ? PALETTE.lit : 'rgba(176, 126, 31, 0.5)';
    out += `<text x="0" y="${(y + 12).toFixed(1)}" font-size="11" font-family="inherit" fill="${PALETTE.label}">${escapeXml(item.category)}</text>`;
    out += `<rect x="${labelW}" y="${(y + 2).toFixed(1)}" width="${bw.toFixed(1)}" height="14" rx="4" fill="${color}" transform="rotate(${rot} ${labelW} ${(y + 9).toFixed(1)})"/>`;
  });
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

// Small ink-splat, like a stamp landing, for the instant a spend is logged
// (manual or SMS-detected). Deliberately irregular rather than a perfect
// circle, same hand-inked feel as everything else here. Meant to be shown
// briefly (see the ink-pop animation in global.css) then let go, not a
// permanent UI element.
export function inkBlot(color = PALETTE.lit) {
  return `<svg viewBox="0 0 40 40" aria-hidden="true" style="width:100%;height:100%;display:block">
    <path d="M20 4 C 27 3, 33 8, 34 15 C 35 21, 31 26, 33 31 C 34 35, 28 37, 23 35 C 18 37, 11 36, 8 31 C 4 27, 6 20, 5 15 C 4 9, 12 4, 20 4 Z" fill="${color}" opacity="0.85"/>
    <circle cx="7" cy="34" r="1.8" fill="${color}" opacity="0.7"/>
    <circle cx="34" cy="6" r="1.3" fill="${color}" opacity="0.6"/>
  </svg>`;
}

// The bigger moment for a confirmed M-Pesa deposit: a hand-inked stamp
// (scalloped ring, deliberately wobbled rather than a perfect circle) with
// a bold checkmark and a radiating burst, more prominent than handCheck's
// small inline mark since a real deposit clearing is a bigger deal than an
// ordinary milestone banner.
export function depositStamp(color = PALETTE.lit) {
  const cx = 60;
  const cy = 60;
  const r = 46;
  const scallops = 16;
  let ring = '';
  for (let i = 0; i <= scallops; i++) {
    const a = (i / scallops) * Math.PI * 2;
    const wob = ((i * 5) % 3) - 1;
    const x = (cx + Math.cos(a) * (r + wob * 1.2)).toFixed(1);
    const y = (cy + Math.sin(a) * (r + wob * 1.2)).toFixed(1);
    ring += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
  }
  let burst = '';
  const bursts = 12;
  for (let i = 0; i < bursts; i++) {
    const a = (i / bursts) * Math.PI * 2 + 0.15;
    const x1 = (cx + Math.cos(a) * (r + 6)).toFixed(1);
    const y1 = (cy + Math.sin(a) * (r + 6)).toFixed(1);
    const x2 = (cx + Math.cos(a) * (r + 17)).toFixed(1);
    const y2 = (cy + Math.sin(a) * (r + 17)).toFixed(1);
    burst += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="2.6" stroke-linecap="round" opacity="0.7"/>`;
  }
  return `<svg viewBox="0 0 120 120" aria-hidden="true" style="width:100%;height:auto;display:block">
    ${burst}
    <path d="${ring} Z" fill="none" stroke="${color}" stroke-width="4.5" stroke-linejoin="round"/>
    <path d="M39 62 C 47 70, 53 78, 57 85 C 65 65, 76 47, 92 33" fill="none" stroke="${color}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// A small hand-drawn sprout that visibly grows with the current daily
// streak, a second, more emotional signal alongside the existing numeric
// "N days under budget" text, not a replacement for it. Leaf count is
// capped at 6 (this is a subtle accent, not a literal counter), and a
// small blossom appears once the streak actually reaches the same 7-day
// mark the "First Week" badge already uses, so the sprout's one visual
// milestone lines up with a milestone the rest of the app already treats
// as meaningful, rather than an arbitrary one invented just for this.
export function streakSprout(count) {
  const color = count > 0 ? PALETTE.lit : PALETTE.unlit;
  const leaves = Math.max(0, Math.min(6, count));
  const flowering = count >= 7;
  const H = 58;
  const baseY = H - 4;
  const topY = baseY - 8 - leaves * 6;
  let out = `<line x1="20" y1="${baseY}" x2="20" y2="${topY.toFixed(1)}" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`;
  for (let i = 0; i < leaves; i++) {
    const y = baseY - 12 - i * 6;
    const side = i % 2 === 0 ? 1 : -1;
    const wob = ((i * 13) % 3) - 1;
    const x2 = 20 + side * (7 + wob);
    out += `<path d="M 20 ${y} Q ${(20 + side * 5).toFixed(1)} ${(y - 3).toFixed(1)} ${x2.toFixed(1)} ${(y - 1).toFixed(1)}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (flowering) {
    const petals = [0, 72, 144, 216, 288].map((deg) => {
      const a = (deg * Math.PI) / 180;
      const px = (20 + Math.cos(a) * 5).toFixed(1);
      const py = (topY - 5 + Math.sin(a) * 5).toFixed(1);
      return `<circle cx="${px}" cy="${py}" r="2.6" fill="${PALETTE.lit}" opacity="0.85"/>`;
    }).join('');
    out += petals + `<circle cx="20" cy="${(topY - 5).toFixed(1)}" r="2" fill="${PALETTE.litLow}"/>`;
  }
  out += `<circle cx="20" cy="${baseY}" r="2.4" fill="${color}"/>`;
  return `<svg viewBox="0 0 40 ${H}" aria-hidden="true" style="width:1.75rem;height:${(H / 16).toFixed(2)}rem;display:block">${out}</svg>`;
}
