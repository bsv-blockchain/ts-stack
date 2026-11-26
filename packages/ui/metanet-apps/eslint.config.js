import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import tsStandard from 'ts-standard'
import pluginJest from 'eslint-plugin-jest'

export default [
  tsStandard,
  {
    ignorePatterns: ['src/primitives/Point.ts'],
    files: ['src/**/*.ts', '**/*.{js,mjs,cjs,ts,jsx,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        process: 'readonly',
        ...globals.jest
      },
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: process.cwd()
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      jest: pluginJest
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...pluginJs.configs.recommended.rules,

      'jest/no-disabled-tests': 'warn',
      'jest/no-focused-tests': 'error',
      'jest/no-identical-title': 'error',
      'jest/prefer-to-have-length': 'warn',
      'jest/valid-expect': 'error'
    }
  }
]
