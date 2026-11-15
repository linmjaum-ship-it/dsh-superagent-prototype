import { defineConfig } from 'vitest/config'

// Demo-only vitest config: renders the official panel source against the
// official panel test fixtures and serializes the six documented pages.
// The official `vitest.config.ts` is left untouched, so `pnpm test` keeps
// running exactly the upstream suite under `tests/**`.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['demo/**/*.spec.tsx'],
    environment: 'jsdom',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
