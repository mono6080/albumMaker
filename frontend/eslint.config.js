import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // 未安裝 eslint-plugin-react 時，core no-unused-vars 不會辨識 JSX component 引用。
      // 保留 PascalCase／單字母 component 與 `_unused` 慣例，但不再放過 ALL_CAPS 死常數。
      'no-unused-vars': ['error', {
        varsIgnorePattern: '^(?:_|[A-Z]$|[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*)',
      }],
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['playwright.config.js', 'tests/e2e/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
])
