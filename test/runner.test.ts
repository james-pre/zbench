// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { suite, test } from 'node:test';
import { parseSuite, type SuiteSpec } from 'zbench-js/config';
import { aggregateValue, caseValue, columns, matrices, resolveMetrics } from 'zbench-js/measure';
import { runTest } from 'zbench-js/runner';
import { counts } from './fixtures/simple.ts';

const file = join(import.meta.dirname, 'config.json');

function build(over: Partial<SuiteSpec['tests'][number]> = {}) {
	return parseSuite(
		{
			tests: [
				{
					path: 'fixtures/simple.ts',
					name: 'simple',
					measure: { items: { throughput: 'ms', aggregate_throughput: 'ms' } },
					configurations: [{ value: { items: 10 } }, { value: { items: 20 } }],
					...over,
				},
			],
		},
		file
	).tests[0];
}

suite('runner', () => {
	test('every configuration is timed the requested number of times', async () => {
		const test = build();
		const results = await runTest(test, { iterations: 3, warmup: 1 });

		assert.equal(results.length, 2);
		for (const result of results) {
			assert.equal(result.samples.length, 3);
			assert.ok(result.samples.every(s => s > 0));
			assert.ok(result.setup >= 0);
			assert.equal(result.error, undefined);
		}
		// Amounts are summed over the timed iterations only, so warmup does not inflate them
		assert.equal(results[0].amounts.items, 30);
		assert.equal(results[1].amounts.items, 60);
	});

	test('the lifecycle runs where it says it does', async () => {
		for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
		await runTest(build(), { iterations: 3, warmup: 2 });

		assert.equal(counts.setup, 2, 'once per configuration');
		assert.equal(counts.teardown, 2, 'once per configuration');
		assert.equal(counts.before, 10, 'warmup and timed iterations, both configurations');
		assert.equal(counts.after, 10);
	});

	test('flags multiply the matrix and land in the configuration', async () => {
		const results = await runTest(build({ flags: { slow: [false, true] } }), { iterations: 1, warmup: 0 });

		assert.equal(results.length, 4);
		assert.deepEqual(
			results.map(r => r.flags.slow),
			[false, false, true, true]
		);
	});

	test('configurations beyond the budget are skipped, not run', async () => {
		const test = build({
			configurations: [
				{ value: { items: 10 } },
				{ cpu: 9, value: { items: 20 } },
				{ mem: 9, value: { items: 30 } },
			],
		});
		const results = await runTest(test, { iterations: 1, warmup: 0, cpu: 1, mem: 1 });

		assert.equal(results[0].skipped, undefined);
		assert.equal(results[1].skipped, 'needs cpu 9');
		assert.equal(results[2].skipped, 'needs mem 9');
		assert.equal(results[1].samples.length, 0);
	});

	test('--all overrides the budget', async () => {
		const test = build({ configurations: [{ cpu: 9, value: { items: 10 } }] });
		const [result] = await runTest(test, { iterations: 1, warmup: 0, cpu: 0, mem: 0, all: true });
		assert.equal(result.skipped, undefined);
		assert.equal(result.samples.length, 1);
	});

	test('a throwing test is recorded rather than thrown', async () => {
		const test = build({ path: 'fixtures/broken.ts', name: 'broken', measure: undefined });
		const results = await runTest(test, { iterations: 1, warmup: 0 });
		assert.match(results[0].error!, /deliberate/);
		assert.equal(results[0].samples.length, 0);
	});
});

suite('measure', () => {
	test('one matrix per flag combination, in run order', async () => {
		const test = build({ flags: { slow: [false, true] } });
		const found = matrices(test, await runTest(test, { iterations: 1, warmup: 0 }));

		assert.equal(found.length, 2);
		assert.deepEqual(
			found.map(m => m.label),
			['slow=false', 'slow=true']
		);
		assert.equal(found[0].cases.length, 2);
	});

	test('metrics divide amounts by elapsed time', async () => {
		const test = build();
		const [matrix] = matrices(test, await runTest(test, { iterations: 2, warmup: 0 }));
		const [metric] = resolveMetrics(matrix);

		assert.equal(metric.label, 'items/ms');

		const [first] = matrix.cases;
		const elapsed = first.samples.reduce((a, b) => a + b, 0);
		assert.equal(caseValue(metric, first), first.amounts.items / elapsed);

		// The aggregate is the matrix's totals, not the mean of the rows
		const totalItems = matrix.cases.reduce((sum, c) => sum + c.amounts.items, 0);
		const totalMs = matrix.cases.flatMap(c => c.samples).reduce((a, b) => a + b, 0);
		assert.equal(aggregateValue({ ...metric, aggregate: true }, matrix), totalItems / totalMs);
	});

	test('a column evaluates the same way against another state s results', async () => {
		const test = build();
		const a = await runTest(test, { iterations: 1, warmup: 0 });
		const b = await runTest(test, { iterations: 1, warmup: 0 });

		const [matrix] = matrices(test, a);
		const column = columns(matrix).find(c => c.aggregate)!;

		// Evaluating A's column over B's cases must not re-infer the timespan, or the two are not comparable
		assert.ok(column.total!(matrices(test, b)[0].cases)! > 0);
	});
});
