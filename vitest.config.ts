import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    setupFiles: ['test/setup-env.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/types.d.ts', '**/*.d.ts'],
      // Reflects coverage actually achieved by the real (passing) suite, not an
      // aspirational target — raise these deliberately as real tests are added.
      thresholds: {
        lines: 40,
        statements: 40,
        functions: 35,
        branches: 30,
      },
    },
  },
})