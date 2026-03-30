import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

export default [
	{ ignores: ['**/dist', 'node_modules/**'] },
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				console: 'readonly',
				process: 'readonly',
				URL: 'readonly',
				window: 'readonly',
				fetch: 'readonly',
				AbortController: 'readonly',
				setTimeout: 'readonly',
				clearTimeout: 'readonly',
			},
		},
	},
	js.configs.recommended,
	prettier,
];
