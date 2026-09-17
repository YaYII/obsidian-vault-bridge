import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'main.js',
      'node_modules/**',
      '.code-review/**',
      'coverage/**',
      'vault-bridge-plugin.zip',
      'tools/obsidian-host-mock.mjs',
      'tools/verify-bundle.mjs',
      'tools/install.mjs',
      'tools/tunnel.sh',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // 与 Obsidian 官方样例一致的宽松度：允许显式 any，但要求不留未使用变量
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  }
);
