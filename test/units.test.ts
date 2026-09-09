// SPDX-License-Identifier: LGPL-3.0-or-later
import assert from 'node:assert/strict';
import { suite, test } from 'node:test';
import { duration, inferCostSpan, inferThroughputSpan, sig, unitScale } from 'zbench-js/units';

suite('units', () => {
	test('significant figures drop trailing zeroes', () => {
		assert.equal(sig(28.4213), '28.42');
		assert.equal(sig(1280), '1280');
		assert.equal(sig(0.028), '0.028');
		assert.equal(sig(0), '0');
		assert.equal(sig(Infinity), '-');
	});

	test('durations pick a readable timespan', () => {
		assert.equal(duration(0.000042), '42ns');
		assert.equal(duration(0.42), '420us');
		assert.equal(duration(42), '42ms');
		assert.equal(duration(4200), '4.2s');
	});

	test('throughput timespans land the value in [1, 1000)', () => {
		// 128 MB in 100 ms is 1280 MB/s but only 1.28 MB/ms
		assert.equal(inferThroughputSpan(128, 100), 'ms');
		// 4 entries in 100 ms is 40 per second
		assert.equal(inferThroughputSpan(4, 100), 's');
	});

	test('cost timespans land the value in [1, 1000)', () => {
		// 100 ms for 1000 entries is 0.1 ms each, but 100 us each
		assert.equal(inferCostSpan(1000, 100), 'us');
		assert.equal(inferCostSpan(10, 100), 'ms');
	});

	test('byte units scale amounts counted in bytes', () => {
		assert.equal(unitScale('MB'), 1e-6);
		assert.equal(unitScale('MiB'), 1 / 2 ** 20);
		assert.equal(unitScale('entries'), 1);
	});
});
