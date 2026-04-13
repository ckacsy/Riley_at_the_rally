'use strict';

const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      // Match existing code style
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',  // console is used extensively for logging
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['warn', 'smart'],  // existing code uses == in some places (e.g. holdAmount == null)
      'curly': ['warn', 'multi-line'],
      'no-throw-literal': 'error',
      'no-implicit-globals': 'error',
      'no-duplicate-imports': 'error',
    },
  },
  {
    // Test files: relax some rules
    files: ['tests/**/*.js', 'tests/**/*.test.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    // Ignore non-backend files, node_modules, generated files
    ignores: [
      'node_modules/**',
      'uploads/**',
      'sessions.sqlite',
      '*.sqlite',
    ],
  },
];
