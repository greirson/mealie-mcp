import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/helpers/msw.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    testTimeout: 10000,
  },
});
