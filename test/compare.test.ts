// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { delta, type Cell } from 'zbench-js/compare';
import { combinedNoise, stats } from 'zbench-js/stats';

const cell = (value: number, noise = 0): Cell => ({ value, noise, missing: false });

suite('stats', () => {
	test('summarizes a set of samples', () => {
		const s = stats([2, 4, 4, 4, 5, 5, 7, 9]);
		assert.equal(s.n, 8);
		assert.equal(s.total, 40);
		assert.equal(s.mean, 5);
		assert.equal(s.median, 4.5);
		assert.equal(s.min, 2);
		assert.equal(s.max, 9);
		// Sample standard deviation, not the population's
		assert.ok(Math.abs(s.stddev - 2.13809) < 1e-4);
	});

	test('a single sample has no spread', () => {
		assert.deepEqual(stats([5]).stddev, 0);
		assert.deepEqual(stats([]).mean, 0);
	});

	test('noise adds in quadrature', () => {
		assert.equal(combinedNoise(3, 4), 5);
	});
});

suite('compare', () => {
	test('the factor is a speedup whichever way the column improves', () => {
		// Lower is better: halving the time is 2x
		assert.equal(delta(cell(100), cell(50), false, 1).factor, 2);
		// Higher is better: doubling the throughput is also 2x
		assert.equal(delta(cell(50), cell(100), true, 1).factor, 2);
	});

	test('change is the signed percentage of the raw value', () => {
		assert.equal(delta(cell(100), cell(50), false, 1).change, -50);
		assert.equal(delta(cell(100), cell(150), true, 1).change, 50);
	});

	test('a change inside the noise is not significant', () => {
		// 5% apart, but each run varies by 10%
		assert.equal(delta(cell(100, 10), cell(105, 10), false, 1).significant, false);
		// The same 5% from quiet runs is
		assert.equal(delta(cell(100, 0.1), cell(105, 0.1), false, 1).significant, true);
	});

	test('the threshold is a floor under the noise, not a replacement for it', () => {
		// Quiet runs, but a change too small to care about
		assert.equal(delta(cell(100, 0), cell(100.5, 0), false, 1).significant, false);
		assert.equal(delta(cell(100, 0), cell(102, 0), false, 1).significant, true);
	});

	test('a missing side has no delta', () => {
		const missing: Cell = { value: null, noise: 0, missing: true };
		assert.deepEqual(delta(cell(100), missing, false, 1), {
			factor: null,
			change: null,
			significant: false,
			better: false,
		});
		assert.equal(delta(missing, cell(100), false, 1).factor, null);
	});
});
