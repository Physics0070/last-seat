import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globalSetup: ['test/global-setup.js'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
