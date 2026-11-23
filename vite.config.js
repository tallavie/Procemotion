import { defineConfig } from 'vite';

// Three pages: the home page of the site (index.html), the how-to guide (guide/index.html) and the app itself
// (app/index.html). public/ holds what is copied as it is: the Draco decoder, the demo models with their credits
// (public/demo/) and the pictures of the site (public/img/).
export default defineConfig({
  base: './',
  server: { port: 5184, strictPort: false, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { home: 'index.html', guide: 'guide/index.html', app: 'app/index.html' } },
  },
});
