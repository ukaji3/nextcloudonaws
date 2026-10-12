// @ts-check
// ESLint configuration for the CDK project.
// Project coding rules: strict typing (no `any`, prefer `unknown`), cyclomatic
// complexity <= 12, ordered imports, and JSDoc on functions and classes.
import eslint from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['cdk.out/**', 'node_modules/**', '**/*.js', '**/*.d.ts', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
      jsdoc,
    },
    rules: {
      complexity: ['error', 12],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['error', { allowExpressions: true }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // CDK constructs are instantiated for their side effects (they register
      // themselves in the construct tree), so `new X(this, ...)` is idiomatic.
      'no-new': 'off',
      'import-x/order': ['error', {
        groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
        'newlines-between': 'ignore',
      }],
      'import-x/no-duplicates': 'error',
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: false,
        require: {
          FunctionDeclaration: true,
          ClassDeclaration: true,
          MethodDefinition: true,
        },
        checkConstructors: false,
      }],
      'jsdoc/check-param-names': 'error',
      'jsdoc/require-param': 'error',
      'jsdoc/require-returns': 'error',
    },
  },
  {
    // Test files: assertions on synthesized templates use loosely typed JSON.
    files: ['test/**/*.ts'],
    rules: {
      'jsdoc/require-jsdoc': 'off',
    },
  },
);
