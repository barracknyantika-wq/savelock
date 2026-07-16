// Renders the PWA icon PNGs from the SaveLock lock mark before `astro build`
// copies public/ into dist/. Keeps binaries out of the repo; sharp is a
// devDependency. Skips work when all four files already exist (delete
// public/icons/ to force a re-render after changing the artwork).

import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const targets = [
  ['icon-192.png', 192, 'rounded'],
  ['icon-512.png', 512, 'rounded'],
  ['maskable-512.png', 512, 'fullBleed'],
  ['apple-touch-icon.png', 180, 'fullBleed'],
];

if (targets.every(([name]) => existsSync(join(OUT, name)))) {
  console.log('icons already present, skipping');
  process.exit(0);
}

// Same artwork as public/favicon.svg: cream lock, ochre keyhole, dark canvas.
const glyph = `
  <path d="M176 232v-44a80 80 0 0 1 160 0v44" fill="none" stroke="#f4f1ea" stroke-width="36" stroke-linecap="round"/>
  <rect x="140" y="224" width="232" height="180" rx="40" fill="#f4f1ea"/>
  <circle cx="256" cy="298" r="28" fill="#c9922e"/>
  <rect x="243" y="310" width="26" height="52" rx="13" fill="#c9922e"/>
`;

const svgs = {
  // Rounded tile with transparent corners — manifest purpose "any".
  rounded: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="116" fill="#14120f"/>
    ${glyph}
  </svg>`,
  // Full-bleed square, glyph shrunk into the 80% safe zone — maskable/apple.
  fullBleed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="#14120f"/>
    <g transform="translate(51.2 51.2) scale(0.8)">${glyph}</g>
  </svg>`,
};

mkdirSync(OUT, { recursive: true });
for (const [name, size, variant] of targets) {
  await sharp(Buffer.from(svgs[variant])).resize(size, size).png().toFile(join(OUT, name));
}
console.log('icons generated');
