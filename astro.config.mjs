// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// BASE_PATH is injected by the GitHub Pages workflow (e.g. "/repo-name").
// Locally it is unset, so the app serves from "/".
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  vite: {
    plugins: [tailwindcss()],
  },
});
