import shared from 'utilium/eslint';

export default [
	...shared(import.meta.dirname),
	{
		rules: {
			'@typescript-eslint/no-empty-object-type': ['warn', { allowInterfaces: 'with-single-extends' }],
		},
	},
];
