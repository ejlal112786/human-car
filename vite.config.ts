import { defineConfig } from 'vite';

// Static build for Vercel Drop / any static host.
// `base: './'` makes every asset URL relative, so dist/ works from any path or sub-folder.
//
// `__QA_HOOK__` is a compile-time constant that controls the automated-test hook
// (window.__cityRacer: snapshot / time-advance / teleport). It is:
//   - true  for the dev server (`npm run dev`)
//   - true  for `npm run build:qa` (mode "qa", output in dist-qa/; never deploy that folder)
//   - false for the release build (`npm run build` → dist/). The hook code is then removed
//     by dead-code elimination, and scripts/check-dist.mjs fails the build if any of it remains.
export default defineConfig(({ command, mode }) => {
  // (`vite preview` only serves an existing build, so `define` does not affect it.)
  const qaHook = command === 'serve' ? mode !== 'production' : mode === 'qa';
  return {
    base: './',
    define: {
      __QA_HOOK__: JSON.stringify(qaHook),
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      allowedHosts: true,
      // Build outputs and QA screenshots must not trigger dev-server reloads.
      watch: { ignored: ['**/dist/**', '**/dist-qa/**', '**/qa-shots/**', '**/*.zip'] },
    },
    preview: {
      host: '0.0.0.0',
      port: mode === 'qa' ? 4174 : 4173,
      allowedHosts: true,
    },
    build: {
      outDir: mode === 'qa' ? 'dist-qa' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      // Rapier (compat build) embeds its ~3 MB WASM binary as base64 in its JS chunk
      // (~1.6 MB gzipped). This is expected and avoids extra WASM loader plugins.
      chunkSizeWarningLimit: 4500,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            rapier: ['@dimforge/rapier3d-compat'],
          },
        },
      },
    },
  };
});
