// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium/node';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as z from 'zod';
import { timespanOrder, unitScale, type Timespan } from './units.js';

const Timespan = z.literal(timespanOrder);

/** A measurement is either derived at an inferred timespan (`true`) or at an explicit one. */
export const MeasureValue = z.union([z.boolean(), Timespan], {
	error: 'expected true, false, or a timespan ("ns", "us", "ms", "s")',
});

export type MeasureValue = z.infer<typeof MeasureValue>;

/** The four ways a quantity can be turned into a reported measurement. */
const measurements = ['throughput', 'aggregate_throughput', 'cost', 'aggregate_cost'] as const;

/**
 * How to turn one of a test's quantities into a reported measurement.
 * The quantity's amount per iteration comes from what `test` returns, falling back to the configuration value.
 */
export const MeasureConfig = z
	.object({
		// `<unit>`s per `<timespan>` for each configuration, e.g. `MB/s`
		throughput: MeasureValue.optional(),
		// `<unit>`s per `<timespan>` across every configuration in the matrix
		aggregate_throughput: MeasureValue.optional(),
		// `<timespan>` per `<unit>` for each configuration, e.g. `ms/entry`
		cost: MeasureValue.optional(),
		// `<timespan>` per `<unit>` across every configuration in the matrix
		aggregate_cost: MeasureValue.optional(),
		// What the amount is counted in. Defaults to the quantity's key.
		unit: z.string().optional(),
		// Multiplier from the raw amount to `unit`. Defaults to 1, except for byte units, where amounts are bytes.
		scale: z.number().optional(),
		// If any of a test's measurements set this, comparisons report only those, and the first is
		// the one speedup factors are computed from
		compare: z.boolean().optional(),
	})
	.refine(
		cfg => measurements.some(field => cfg[field] !== undefined && cfg[field] !== false),
		'declares no measurements; set at least one of throughput, cost, aggregate_throughput, aggregate_cost'
	);

export interface MeasureConfig extends z.infer<typeof MeasureConfig> {}

/** One point in a test's matrix. */
export const CaseConfig = z.object({
	// Defaults to the configuration's values, e.g. `size=128, entries=1000`
	name: z.string().optional(),
	// Minimum CPU level needed to run this configuration. Levels are logarithmic: `n + 1` costs about twice `n`.
	cpu: z.number().optional(),
	// Minimum memory level needed to run this configuration. Also logarithmic.
	mem: z.number().optional(),
	// Passed to the test, and the source of measurement amounts
	value: z.record(z.string(), z.number()),
});

export interface CaseConfig extends z.infer<typeof CaseConfig> {}

/** A non-empty list of values a flag can take. */
const flagValues = z.array(z.unknown()).min(1, 'expected a non-empty array of values');

export const TestConfig = z.object({
	// Resolved relative to the config file
	path: z.string(),
	// Defaults to `path`
	name: z.string().optional(),
	measure: z.record(z.string(), MeasureConfig).optional(),
	configurations: z.array(CaseConfig).min(1, 'expected at least one configuration'),
	// Flags from the suite's pool to apply, or flags declared inline. The matrix runs once per combination.
	flags: z
		.union([z.array(z.string()), z.record(z.string(), flagValues)], {
			error: 'expected an array of flag names or an object of flag values',
		})
		.optional(),
	iterations: z.number().optional(),
	warmup: z.number().optional(),
});

export interface TestConfig extends z.infer<typeof TestConfig> {}

export const SuiteConfig = z
	.object({
		// Timed runs per configuration. @default 5
		iterations: z.number().optional(),
		// Untimed runs before the timed ones. @default 1
		warmup: z.number().optional(),
		// Flag pool that tests can draw from by name
		flags: z.record(z.string(), flagValues).optional(),
		// Shell command that makes a git reference's worktree runnable
		build: z.string().optional(),
		// Directory copied into a reference's worktree so every reference runs today's tests.
		// Defaults to the config file's directory.
		root: z.string().optional(),
		tests: z.array(TestConfig),
	})
	// Neither of these is about one test's shape: a flag name is only meaningful against the pool,
	// and a duplicate id only shows up once the other tests are known
	.superRefine((spec, ctx) => {
		const pool = spec.flags ?? {};
		const seen = new Set<string>();

		for (const [i, test] of spec.tests.entries()) {
			if (Array.isArray(test.flags)) {
				for (const [j, name] of test.flags.entries()) {
					if (name in pool) continue;
					ctx.addIssue({
						code: 'custom',
						path: ['tests', i, 'flags', j],
						message: `no flag named ${JSON.stringify(name)} is declared by the suite`,
					});
				}
			}

			// Results are keyed by id, so a duplicate would silently merge two tests' numbers
			const id = test.name ?? test.path;
			if (seen.has(id))
				ctx.addIssue({
					code: 'custom',
					path: ['tests', i, test.name === undefined ? 'path' : 'name'],
					message: `more than one test is named ${JSON.stringify(id)}`,
				});
			seen.add(id);
		}
	});

export interface SuiteConfig extends z.infer<typeof SuiteConfig> {}

/** Config files are looked for at these paths, in order, relative to the working directory. */
export const configPaths = ['tests/perf/config.json', 'tests/perf.json', 'tests/perf.config.json', 'zbench.json'];

export const defaultBuild = 'npm install --no-audit --no-fund && npm run build';

/** A single reported column, derived from one `MeasureConfig` entry. */
export interface Metric {
	/** The quantity this is derived from */
	key: string;
	kind: 'throughput' | 'cost';
	/** Whether this collapses the whole matrix into one number */
	aggregate: boolean;
	/** `null` means infer per matrix */
	span: Timespan | null;
	scale: number;
	unit: string;
	higherIsBetter: boolean;
	/** Whether the measurement asked to be the one comparisons report */
	compare: boolean;
}

/** A test with its defaults filled in and its measurements flattened into metrics. */
export interface Test {
	id: string;
	name: string;
	/** Absolute path to the module */
	file: string;
	/** Path as written, for display */
	path: string;
	metrics: Metric[];
	configurations: Required<Pick<CaseConfig, 'name' | 'cpu' | 'mem' | 'value'>>[];
	flags: Record<string, unknown[]>;
	iterations: number;
	warmup: number;
}

export interface Suite {
	/** Absolute path to the config file */
	file: string;
	/** Absolute path to the directory copied into reference worktrees */
	root: string;
	build: string;
	tests: Test[];
}

/** Find the config file, starting from `from` and walking up to the filesystem root. */
export function findConfig(from: string = process.cwd()): string | null {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		for (const candidate of configPaths) {
			const path = join(dir, candidate);
			if (existsSync(path)) return path;
		}
		if (dir == dirname(dir)) return null;
	}
}

/** Flatten a test's measurements into one metric per declared timespan. */
function parseMetrics(measure: TestConfig['measure']): Metric[] {
	const metrics: Metric[] = [];

	for (const [key, spec] of Object.entries(measure ?? {})) {
		const unit = spec.unit ?? key;
		const scale = spec.scale ?? unitScale(unit);

		for (const kind of ['throughput', 'cost'] as const) {
			for (const aggregate of [false, true]) {
				const value = spec[aggregate ? (`aggregate_${kind}` as const) : kind];
				if (value === undefined || value === false) continue;

				metrics.push({
					key,
					kind,
					aggregate,
					span: value === true ? null : value,
					scale,
					unit,
					higherIsBetter: kind == 'throughput',
					compare: spec.compare ?? false,
				});
			}
		}
	}

	return metrics;
}

function defaultName(value: Record<string, number>): string {
	return Object.entries(value)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ');
}

/** A test's flags: the pool entries it named, the ones it declared inline, or none. */
function parseFlags(flags: TestConfig['flags'], pool: Record<string, unknown[]>): Record<string, unknown[]> {
	if (!flags) return {};
	// Every name was checked against the pool while the suite was validated
	if (Array.isArray(flags)) return Object.fromEntries(flags.map(name => [name, pool[name]]));
	return flags;
}

const ConfigFile = z.preprocess(data => (Array.isArray(data) ? { tests: data } : data), SuiteConfig);

/** Turn validated config data into a suite. `file` is what test paths resolve against. */
function toSuite(cfg: SuiteConfig, file: string): Suite {
	const dir = dirname(resolve(file));

	const iterations = cfg.iterations ?? 5;
	const warmup = cfg.warmup ?? 1;
	const pool = cfg.flags ?? {};

	const tests = cfg.tests.map((test): Test => ({
		id: test.name ?? test.path,
		name: test.name ?? test.path,
		file: isAbsolute(test.path) ? test.path : resolve(dir, test.path),
		path: test.path,
		metrics: parseMetrics(test.measure),
		configurations: test.configurations.map(config => ({
			name: config.name ?? defaultName(config.value),
			cpu: config.cpu ?? 0,
			mem: config.mem ?? 0,
			value: config.value,
		})),
		flags: parseFlags(test.flags, pool),
		iterations: test.iterations ?? iterations,
		warmup: test.warmup ?? warmup,
	}));

	return {
		file: resolve(file),
		root: cfg.root ? resolve(dir, cfg.root) : dir,
		build: cfg.build ?? defaultBuild,
		tests,
	};
}

/** Validate already-loaded config data. `file` is what test paths resolve against. */
export function parseSuite(data: unknown, file: string): Suite {
	try {
		return toSuite(ConfigFile.parse(data), file);
	} catch (e) {
		// eslint-disable-next-line @typescript-eslint/only-throw-error
		throw io.errorText(e);
	}
}

export function loadSuite(file: string): Suite {
	return toSuite(io.readJSON(file, ConfigFile), file);
}

/** Every combination of the given flags, in declaration order. Always at least one (possibly empty) combination. */
export function flagCombinations(flags: Record<string, unknown[]>): Record<string, unknown>[] {
	let combinations: Record<string, unknown>[] = [{}];
	for (const [name, values] of Object.entries(flags))
		combinations = combinations.flatMap(base => values.map(value => ({ ...base, [name]: value })));
	return combinations;
}

/** A stable, human-readable label for a flag combination. Empty when there are no flags. */
export function flagLabel(flags: Record<string, unknown>): string {
	return Object.entries(flags)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(', ');
}
