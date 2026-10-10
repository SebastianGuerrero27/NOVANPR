/**
 * ESLint 8 (configuración clásica) para el frontend: reglas recomendadas de JavaScript y de
 * TypeScript, y las de hooks de React (dependencias de efectos y orden de llamada).
 *   npm run lint
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'plugin:react-hooks/recommended'],
  ignorePatterns: ['dist', 'node_modules', 'scripts', '*.cjs', 'vite.config.ts'],
};
