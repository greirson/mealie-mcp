import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // No msw here: integration tests talk to a real Mealie container.
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 180000,
    hookTimeout: 180000,
  },
});
