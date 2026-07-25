import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    // DB-backed integration files each provision an isolated Postgres schema
    // and run `prisma migrate deploy` in beforeAll; under concurrent file
    // startup that legitimately exceeds the 10s default. Race tests hold
    // advisory locks across deliberate pauses, so they also need headroom.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
