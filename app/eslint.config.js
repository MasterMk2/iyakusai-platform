import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // reference/ is the frozen Python source; src/rental-web/ is the field-tested phone screen served as is.
  { ignores: ['dist/**', 'node_modules/**', '.tmp/**', 'data/**', '.ai/**', 'reference/**', 'src/rental-web/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/server/**/*.ts', 'src/task-service/**/*.ts', 'tests/**/*.ts', 'tests/**/*.mjs', '*.config.ts', '*.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The public demo's boot script runs in the browser before the app (a classic script, not a module).
    files: ['scripts/pages-demo/web/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Render mail HTML only through the sandboxed iframe.' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
