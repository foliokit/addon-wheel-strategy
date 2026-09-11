import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Everything the host already provides. These must stay aligned with
// `hostDependencies` in manifest.json, or the bundle ships duplicate React.
const hostProvidedDependencies = [
  '@tanstack/react-query',
  '@wealthfolio/addon-sdk',
  '@wealthfolio/addon-sdk/goal-progress',
  '@wealthfolio/addon-sdk/host-api',
  '@wealthfolio/addon-sdk/host-dependencies',
  '@wealthfolio/addon-sdk/manifest',
  '@wealthfolio/addon-sdk/permissions',
  '@wealthfolio/addon-sdk/query-keys',
  '@wealthfolio/addon-sdk/types',
  '@wealthfolio/addon-sdk/utils',
  '@wealthfolio/ui',
  '@wealthfolio/ui/chart',
  'date-fns',
  'lucide-react',
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-dev-runtime',
  'react/jsx-runtime',
  'recharts',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: {
      entry: 'src/addon.tsx',
      fileName: () => 'addon.js',
      formats: ['es'],
    },
    outDir: 'dist',
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
    },
    // No `watch` block here on purpose: a non-null `build.watch` puts *every*
    // `vite build` into watch mode, so `pnpm build` would never exit and
    // `pnpm bundle` would hang before packaging. The `dev` script passes
    // `--watch` on the CLI, which is where watch mode belongs.
  },
});
