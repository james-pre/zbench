// SPDX-License-Identifier: LGPL-3.0-or-later
import { parentPort, workerData } from 'node:worker_threads';
import { flagCombinations, loadSuite, type Test } from './config.js';
import type { WorkerConfig } from './isolate.js';
import type { CaseResult } from './types.js';
import type { TestModule } from './types.js';

if (!parentPort) throw new Error('zbench/worker is only meant to be run as a worker thread');

const config = workerData as WorkerConfig;

const suite = loadSuite(config.config);
const test = suite.tests.find(t => t.id == config.test);
if (!test) throw new Error(`no test with id ${JSON.stringify(config.test)} in ${config.config}`);

const flagsConfig = Object.fromEntries(Object.entries(config.flags).map(([k, v]) => [k, [v]]));

/** Narrow a test's flags to the values the caller asked for, dropping the rest. */
function selectFlags(test: Test): Record<string, unknown>[] {
	const flags: Record<string, unknown[]> = {};
	for (const [name, values] of Object.entries(test.flags)) {
		const wanted = flagsConfig?.[name];
		flags[name] = wanted ? values.filter(v => wanted.some(w => Object.is(w, v))) : values;
	}
	return flagCombinations(flags);
}

/** Whether a configuration fits in the budget, and why not when it doesn't. */
export function skipReason(configuration: Test['configurations'][number]): string | undefined {
	if (config.all) return undefined;
	if (config.cpu !== undefined && configuration.cpu > config.cpu) return `needs cpu ${configuration.cpu}`;
	if (config.mem !== undefined && configuration.mem > config.mem) return `needs mem ${configuration.mem}`;
	return undefined;
}

const module = (await import(test.file)) as TestModule;
if (typeof module.test != 'function') throw new Error(`${test.path} does not export a \`test\` function`);

const combinations = selectFlags(test);
const results: CaseResult[] = [];

const total = combinations.length * test.configurations.length;
let index = 0;

for (const flags of combinations) {
	for (const configuration of test.configurations) {
		config.onCase?.(test, flags, configuration.name, index++, total);

		const skipped = skipReason(configuration);
		if (skipped) {
			results.push({
				test: test.id,
				flags,
				configuration: configuration.name,
				value: configuration.value,
				setup: 0,
				samples: [],
				amounts: {},
				skipped,
			});
			continue;
		}

		const testConfig = { ...flags, ...configuration.value };
		const iterations = config.iterations ?? test.iterations;
		const warmup = config.warmup ?? test.warmup;

		const result: CaseResult = {
			test: test.id,
			flags,
			configuration: configuration.name,
			value: configuration.value,
			setup: 0,
			samples: [],
			amounts: {},
		};

		// By key, not by metric: a key with both a per-configuration and an aggregate metric is one quantity
		const quantities = [...new Set(test.metrics.map(metric => metric.key))];

		const setupStart = performance.now();
		let state: unknown;
		try {
			state = await module.setup?.(testConfig);
		} catch (e: any) {
			result.error = `setup: ${e?.stack ?? e}`;
			results.push(result);
			continue;
		}
		result.setup = performance.now() - setupStart;

		try {
			for (let i = 0; i < warmup + iterations; i++) {
				const timed = i >= warmup;

				await module.before?.(testConfig, state);
				globalThis.gc?.();

				const start = performance.now();
				const amounts = await module.test(testConfig, state);
				const elapsed = performance.now() - start;

				await module.after?.(testConfig, state);

				if (!timed) continue;

				result.samples.push(elapsed);
				for (const key of quantities) {
					const amount = amounts?.[key] ?? configuration.value[key];
					if (amount === undefined) continue;
					result.amounts[key] = (result.amounts[key] ?? 0) + amount;
				}
			}
		} catch (e: any) {
			result.error = String(e?.stack ?? e);
		} finally {
			try {
				await module.teardown?.(testConfig, state);
			} catch (e: any) {
				result.error ??= `teardown: ${e?.stack ?? e}`;
			}
		}

		results.push(result);
	}
}

parentPort.postMessage(results);
