// SPDX-License-Identifier: LGPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isTimespan, unitScale, type Timespan } from './units.js';

/** A measurement is either derived at an inferred timespan (`true`) or at an explicit one. */
export type MeasureValue = boolean | Timespan;

/**
 * How to turn one of a test's quantities into a reported measurement.
 * The quantity's amount per iteration comes from what `test` returns, falling back to the configuration value.
 */
export interface MeasureSpec {
	/** `<unit>`s per `<timespan>` for each configuration, e.g. `MB/s` */
	throughput?: MeasureValue;
	/** `<unit>`s per `<timespan>` across every configuration in the matrix */
	aggregate_throughput?: MeasureValue;
	/** `<timespan>` per `<unit>` for each configuration, e.g. `ms/entry` */
	cost?: MeasureValue;
	/** `<timespan>` per `<unit>` across every configuration in the matrix */
	aggregate_cost?: MeasureValue;
	/** What the amount is counted in. Defaults to the quantity's key. */
	unit?: string;
	/**
	 * Multiplier from the raw amount to `unit`.
	 * Defaults to 1, except for byte units (`MB`, `MiB`, ...), where amounts are taken to be bytes.
	 */
	scale?: number;
}

/** One point in a test's matrix. */
export interface ConfigurationSpec {
	/** Defaults to the configuration's values, e.g. `size=128, entries=1000` */
	name?: string;
	/**
	 * Minimum CPU level needed to run this configuration.
	 * Levels are logarithmic: `n + 1` costs about twice as much as `n`.
	 */
	cpu?: number;
	/** Minimum memory level needed to run this configuration. Also logarithmic. */
	mem?: number;
	/** Passed to the test, and the source of measurement amounts. */
	value: Record<string, number>;
}

export interface TestSpec {
	/** Resolved relative to the config file */
	path: string;
	/** Defaults to `path` */
	name?: string;
	measure?: Record<string, MeasureSpec>;
	configurations: ConfigurationSpec[];
	/** Flags from the suite's pool to apply, or flags declared inline. The matrix runs once per combination. */
	flags?: string[] | Record<string, unknown[]>;
	iterations?: number;
	warmup?: number;
}

export interface SuiteSpec {
	/** Timed runs per configuration. @default 5 */
	iterations?: number;
	/** Untimed runs before the timed ones. @default 1 */
	warmup?: number;
	/** Flag pool that tests can draw from by name. */
	flags?: Record<string, unknown[]>;
	/** Shell command that makes a git reference's worktree runnable. */
	build?: string;
	/** Directory copied into a reference's worktree so every reference runs today's tests. Defaults to the config file's directory. */
	root?: string;
	tests: TestSpec[];
}

/** Config files are looked for at these paths, in order, relative to the working directory. */
export const configPaths = ['tests/perf/config.json', 'tests/perf.json', 'tests/perf.config.json', 'zbench.json'];

export const defaultBuild = 'npm install --no-audit --no-fund && npm run build';

/** A single reported column, derived from one `MeasureSpec` entry. */
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
	configurations: Required<Pick<ConfigurationSpec, 'name' | 'cpu' | 'mem' | 'value'>>[];
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

class ConfigError extends Error {
	public constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = 'ConfigError';
	}
}

function check(condition: unknown, path: string, message: string): asserts condition {
	if (!condition) throw new ConfigError(path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value == 'object' && value !== null && !Array.isArray(value);
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

function parseMeasureValue(value: unknown, path: string): Timespan | null | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return null;
	check(isTimespan(value), path, `expected true, false, or a timespan ("ns", "us", "ms", "s")`);
	return value;
}

function parseMetrics(measure: unknown, path: string): Metric[] {
	if (measure === undefined) return [];
	check(isRecord(measure), path, 'expected an object');

	const metrics: Metric[] = [];

	for (const [key, raw] of Object.entries(measure)) {
		const at = `${path}.${key}`;
		check(isRecord(raw), at, 'expected an object');

		const spec = raw as MeasureSpec;
		const unit = spec.unit ?? key;
		check(typeof unit == 'string', `${at}.unit`, 'expected a string');
		check(spec.scale === undefined || typeof spec.scale == 'number', `${at}.scale`, 'expected a number');
		const scale = spec.scale ?? unitScale(unit);

		for (const kind of ['throughput', 'cost'] as const) {
			for (const aggregate of [false, true]) {
				const field = aggregate ? `aggregate_${kind}` : kind;
				const span = parseMeasureValue((spec as Record<string, unknown>)[field], `${at}.${field}`);
				if (span === undefined) continue;
				metrics.push({ key, kind, aggregate, span, scale, unit, higherIsBetter: kind == 'throughput' });
			}
		}

		check(
			metrics.some(m => m.key == key),
			at,
			'declares no measurements; set at least one of throughput, cost, aggregate_throughput, aggregate_cost'
		);
	}

	return metrics;
}

function defaultName(value: Record<string, number>): string {
	return Object.entries(value)
		.map(([k, v]) => `${k}=${v}`)
		.join(', ');
}

function parseFlags(
	flags: unknown,
	pool: Record<string, unknown[]>,
	path: string
): Record<string, unknown[]> | undefined {
	if (flags === undefined) return undefined;

	if (Array.isArray(flags)) {
		const selected: Record<string, unknown[]> = {};
		for (const name of flags) {
			check(typeof name == 'string', path, 'expected an array of flag names');
			check(name in pool, path, `no flag named ${JSON.stringify(name)} is declared by the suite`);
			selected[name] = pool[name];
		}
		return selected;
	}

	check(isRecord(flags), path, 'expected an array of flag names or an object of flag values');
	const inline: Record<string, unknown[]> = {};
	for (const [name, values] of Object.entries(flags)) {
		check(Array.isArray(values) && values.length > 0, `${path}.${name}`, 'expected a non-empty array of values');
		inline[name] = values;
	}
	return inline;
}

/** Parse and validate an already-loaded suite. `file` is used to resolve test paths. */
export function parseSuite(data: unknown, file: string): Suite {
	const dir = dirname(resolve(file));

	const spec: SuiteSpec = Array.isArray(data) ? { tests: data } : (data as SuiteSpec);
	check(isRecord(spec), 'config', 'expected an array of tests or an object with a `tests` array');
	check(Array.isArray(spec.tests), 'config.tests', 'expected an array');

	const pool: Record<string, unknown[]> = {};
	if (spec.flags !== undefined) {
		check(isRecord(spec.flags), 'config.flags', 'expected an object of flag values');
		for (const [name, values] of Object.entries(spec.flags)) {
			check(
				Array.isArray(values) && values.length > 0,
				`config.flags.${name}`,
				'expected a non-empty array of values'
			);
			pool[name] = values;
		}
	}

	const iterations = spec.iterations ?? 5;
	const warmup = spec.warmup ?? 1;

	const tests = spec.tests.map((test, i): Test => {
		const at = `config.tests[${i}]`;
		check(isRecord(test), at, 'expected an object');
		check(typeof test.path == 'string', `${at}.path`, 'expected a string');
		check(Array.isArray(test.configurations), `${at}.configurations`, 'expected an array');

		const configurations = test.configurations.map((config, j) => {
			const cat = `${at}.configurations[${j}]`;
			check(isRecord(config), cat, 'expected an object');
			check(isRecord(config.value), `${cat}.value`, 'expected an object');
			for (const [k, v] of Object.entries(config.value))
				check(typeof v == 'number', `${cat}.value.${k}`, 'expected a number');

			return {
				name: config.name ?? defaultName(config.value),
				cpu: config.cpu ?? 0,
				mem: config.mem ?? 0,
				value: config.value,
			};
		});

		check(configurations.length > 0, `${at}.configurations`, 'expected at least one configuration');

		return {
			// The name, so one file can back several tests that differ only in their matrix
			id: test.name ?? test.path,
			name: test.name ?? test.path,
			file: isAbsolute(test.path) ? test.path : resolve(dir, test.path),
			path: test.path,
			metrics: parseMetrics(test.measure, `${at}.measure`),
			configurations,
			flags: parseFlags(test.flags, pool, `${at}.flags`) ?? {},
			iterations: test.iterations ?? iterations,
			warmup: test.warmup ?? warmup,
		};
	});

	// Results are keyed by id, so a duplicate would silently merge two tests' numbers
	const seen = new Set<string>();
	for (const test of tests) {
		check(!seen.has(test.id), `config.tests`, `more than one test is named ${JSON.stringify(test.id)}`);
		seen.add(test.id);
	}

	return {
		file: resolve(file),
		root: spec.root ? resolve(dir, spec.root) : dir,
		build: spec.build ?? defaultBuild,
		tests,
	};
}

export function loadSuite(file: string): Suite {
	let data: unknown;
	try {
		data = JSON.parse(readFileSync(file, 'utf-8'));
	} catch (e: any) {
		throw new ConfigError(file, e.message);
	}
	return parseSuite(data, file);
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
