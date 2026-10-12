import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/** Pruebas del frontend (npm test): componentes con Testing Library sobre jsdom. */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
});
