// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { suite, test } from 'node:test';
import { flagCombinations, parseSuite } from 'zbench/config';

const file = join(import.meta.dirname, 'config.json');

const minimal = (over: object = {}) => ({
	tests: [{ path: 'fixtures/simple.ts', configurations: [{ value: { items: 1 } }], ...over }],
});

suite('config', () => {
	test('a bare array is a list of tests', () => {
		const parsed = parseSuite(minimal().tests, file);
		assert.equal(parsed.tests.length, 1);
		assert.equal(parsed.tests[0].file, join(import.meta.dirname, 'fixtures/simple.ts'));
	});

	test('configurations without a name are named after their values', () => {
		const parsed = parseSuite({ tests: [{ path: 'a.ts', configurations: [{ value: { a: 1, b: 2 } }] }] }, file);
		assert.equal(parsed.tests[0].configurations[0].name, 'a=1, b=2');
	});

	test('measurements flatten into one metric per declared key', () => {
		const parsed = parseSuite(
			minimal({ measure: { bytes: { throughput: 's', aggregate_cost: true, unit: 'MB' } } }),
			file
		);

		const [throughput, cost] = parsed.tests[0].metrics;
		assert.equal(parsed.tests[0].metrics.length, 2);
		assert.deepEqual(
			{ kind: throughput.kind, span: throughput.span, aggregate: throughput.aggregate },
			{ kind: 'throughput', span: 's', aggregate: false }
		);
		assert.deepEqual(
			{ kind: cost.kind, span: cost.span, aggregate: cost.aggregate },
			{ kind: 'cost', span: null, aggregate: true }
		);
		// A byte unit means the amounts are bytes, so no explicit scale is needed
		assert.equal(throughput.scale, 1e-6);
	});

	test('an explicit scale beats the byte-unit default', () => {
		const parsed = parseSuite(minimal({ measure: { bytes: { throughput: true, unit: 'MB', scale: 2 } } }), file);
		assert.equal(parsed.tests[0].metrics[0].scale, 2);
	});

	test('tests draw flags from the suite pool by name', () => {
		const parsed = parseSuite({ flags: { lazy: [true, false] }, tests: minimal({ flags: ['lazy'] }).tests }, file);
		assert.deepEqual(parsed.tests[0].flags, { lazy: [true, false] });
	});

	test('a test with no flags declared runs once', () => {
		const parsed = parseSuite({ flags: { lazy: [true, false] }, tests: minimal().tests }, file);
		assert.deepEqual(parsed.tests[0].flags, {});
	});

	test('names are the id, so duplicates are rejected', () => {
		const tests = [
			{ path: 'a.ts', name: 'same', configurations: [{ value: {} }] },
			{ path: 'b.ts', name: 'same', configurations: [{ value: {} }] },
		];
		assert.throws(() => parseSuite({ tests }, file), /more than one test is named "same"/);
	});

	test('bad configs name what is wrong and where', () => {
		assert.throws(() => parseSuite({ tests: [{ configurations: [] }] }, file), /tests\[0\]\.path/);
		assert.throws(() => parseSuite({ tests: [{ path: 'a.ts' }] }, file), /tests\[0\]\.configurations/);
		assert.throws(() => parseSuite({ tests: [{ path: 'a.ts', configurations: [] }] }, file), /at least one/);
		assert.throws(
			() => parseSuite({ tests: [{ path: 'a.ts', configurations: [{ value: { n: 'x' } }] }] }, file),
			/configurations\[0\]\.value\.n/
		);
		assert.throws(() => parseSuite(minimal({ measure: { n: { throughput: 'weeks' } } }), file), /timespan/);
		assert.throws(() => parseSuite(minimal({ measure: { n: {} } }), file), /declares no measurements/);
		assert.throws(() => parseSuite(minimal({ flags: ['nope'] }), file), /no flag named "nope"/);
	});

	test('flag combinations are the full product, in declaration order', () => {
		assert.deepEqual(flagCombinations({}), [{}]);
		assert.deepEqual(flagCombinations({ a: [1, 2], b: ['x'] }), [
			{ a: 1, b: 'x' },
			{ a: 2, b: 'x' },
		]);
	});
});
