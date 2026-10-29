import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/api/**/*.test.ts', 'tests/task-service/**/*.test.ts', 'tests/rental/**/*.test.ts', 'tests/discord-auth/**/*.test.ts', 'tests/mailbox/**/*.test.ts', 'tests/contacts/**/*.test.ts'],
    environment: 'node',
    // Lists every test by name, so recorded gate logs show exactly what ran.
    reporters: ['verbose'],
  },
});
