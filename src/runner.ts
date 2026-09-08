// SPDX-License-Identifier: LGPL-3.0-or-later
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { flagCombinations, type Test } from './config.js';
import type { Amounts, TestModule } from './types.js';

/** The measurements taken for one test at one point in its matrix. */
export interface CaseResult {
	/** The test's id, i.e. its path as written in the config */
	test: string;
	flags: Record<string, unknown>;
	configuration: string;
	value: Record<string, number>;
	/** Milliseconds `setup` took */
	setup: number;
	/** Milliseconds each timed iteration took */
	samples: number[];
	/** Raw amounts summed over every timed iteration, keyed by quantity */
	amounts: Amounts;
	/** Present when the configuration was not run */
	skipped?: string;
	/** Present when the test threw */
	error?: string;
}

export interface RunOptions {
	/** Overrides the test's own iteration count */
	iterations?: number;
	warmup?: number;
	/** The machine's budget. Configurations asking for more are skipped. */
	cpu?: number;
	mem?: number;
	/** Run every configuration, whatever the budget says */
	all?: boolean;
	/** Restricts a flag to a subset of its declared values */
	flags?: Record<string, unknown[]>;
	/** Called before each configuration so callers can show progress */
	onCase?(test: Test, flags: Record<string, unknown>, configuration: string, index: number, total: number): void;
}

/** `import()` the test module and check that it is one. */
export async function loadTest(test: Test): Promise<TestModule> {
	const module = (await import(pathToFileURL(test.file).href)) as TestModule;
	if (typeof module.test != 'function') throw new Error(`${test.path} does not export a \`test\` function`);
	return module;
}

/**
 * Time one configuration.
 * `setup`/`teardown` run once, `before`/`after` run around each iteration, and only `test` is timed.
 */
async function runCase(
	module: TestModule,
	test: Test,
	flags: Record<string, unknown>,
	configuration: Test['configurations'][number],
	options: RunOptions
): Promise<CaseResult> {
	const config = { ...flags, ...configuration.value };
	const iterations = options.iterations ?? test.iterations;
	const warmup = options.warmup ?? test.warmup;

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
		state = await module.setup?.(config);
	} catch (e: any) {
		result.error = `setup: ${e?.stack ?? e}`;
		return result;
	}
	result.setup = performance.now() - setupStart;

	try {
		for (let i = 0; i < warmup + iterations; i++) {
			const timed = i >= warmup;

			await module.before?.(config, state);
			globalThis.gc?.();

			const start = performance.now();
			const amounts = await module.test(config, state);
			const elapsed = performance.now() - start;

			await module.after?.(config, state);

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
			await module.teardown?.(config, state);
		} catch (e: any) {
			result.error ??= `teardown: ${e?.stack ?? e}`;
		}
	}

	return result;
}

/** Whether a configuration fits in the budget, and why not when it doesn't. */
export function skipReason(configuration: Test['configurations'][number], options: RunOptions): string | undefined {
	if (options.all) return undefined;
	if (options.cpu !== undefined && configuration.cpu > options.cpu) return `needs cpu ${configuration.cpu}`;
	if (options.mem !== undefined && configuration.mem > options.mem) return `needs mem ${configuration.mem}`;
	return undefined;
}

/** Narrow a test's flags to the values the caller asked for, dropping the rest. */
function selectFlags(test: Test, options: RunOptions): Record<string, unknown>[] {
	const flags: Record<string, unknown[]> = {};
	for (const [name, values] of Object.entries(test.flags)) {
		const wanted = options.flags?.[name];
		flags[name] = wanted ? values.filter(v => wanted.some(w => Object.is(w, v))) : values;
	}
	return flagCombinations(flags);
}

/** Run every configuration of a test, once per flag combination. */
export async function runTest(test: Test, options: RunOptions = {}): Promise<CaseResult[]> {
	const module = await loadTest(test);
	const combinations = selectFlags(test, options);
	const results: CaseResult[] = [];

	const total = combinations.length * test.configurations.length;
	let index = 0;

	for (const flags of combinations) {
		for (const configuration of test.configurations) {
			options.onCase?.(test, flags, configuration.name, index++, total);

			const skipped = skipReason(configuration, options);
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

			results.push(await runCase(module, test, flags, configuration, options));
		}
	}

	return results;
}
