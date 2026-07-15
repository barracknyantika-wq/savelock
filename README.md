# SaveLock

A personal savings-discipline PWA. Installable to your phone's home screen, works
fully offline, no app store and no account needed.

**SaveLock holds no money.** The real cash stays in your own M-Shwari Lock / bank
account — this app is the coach on top: it tracks a daily spending allowance and
keeps score while you wait out a savings lock.

## Features

**Daily allowance**

- Set a daily limit (e.g. KSh 500) and see a big "left today" number.
- Log spends in two taps — quick amounts (50/100/200) or a custom amount with a note.
- Resets to the full limit at local midnight.
- Streak counter: every day ended at or above zero extends it; a day over the
  limit resets it.
- Today's spends are listed and deletable if mis-entered.

**Savings goal lock**

- Create a goal with a name, target amount and withdraw date.
- Days-remaining countdown and a progress bar toward the target.
- You update the saved amount manually to mirror the real lock.
- **Breaking a goal early is deliberately high-friction**: a full-screen confirm
  shows the days you'd quit early and the streak you'd lose, and requires typing
  `YES`. The friction is the feature. No money moves — the break is only recorded.
- Celebration state when the withdraw date arrives or the target is hit.

## Data

Everything is stored in `localStorage` on the device. Nothing is sent anywhere.
Settings → Backup exports a JSON file and re-imports it, so data survives a
browser clear or a phone switch.

## Stack

[Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com) +
[Alpine.js](https://alpinejs.dev). No backend, no database, no analytics.

The PWA layer is hand-rolled: `public/manifest.webmanifest` plus a service worker
generated at build time (`scripts/generate-sw.mjs` walks `dist/`, precaches every
built file, and stamps a content-hash cache version so each deploy invalidates
the previous cache).

## Development

```sh
npm install
npm run dev        # dev server (no service worker in dev)
npm run build      # builds to dist/ and generates dist/sw.js
npm run preview    # serve the production build locally
```

## Deployment

Pushes to `main` trigger `.github/workflows/static.yml`, which builds the site
and deploys `dist/` to GitHub Pages. The base path is injected automatically via
`BASE_PATH`, so the app works both at a domain root and under a repo subpath.

Icons: `public/icons/*.png` are rendered at build time by
`scripts/generate-icons.mjs` from the lock mark in `public/favicon.svg` (rounded
tile for regular icons, full-bleed with an 80% safe zone for the maskable/apple
ones), so no binaries live in the repo.

## Install to home screen

Open the deployed URL on your phone:

- **Android (Chrome):** menu ⋮ → "Add to Home screen" / "Install app".
- **iOS (Safari):** Share → "Add to Home Screen".

It opens standalone (no browser chrome) and keeps working with no connection.
