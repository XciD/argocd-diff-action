import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'lib/', 'node_modules/', '**/*.js']
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'error',
      'no-console': 'warn'
    }
  }
);
