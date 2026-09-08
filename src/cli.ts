#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium/node';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, styleText } from 'node:util';
import { resolveCapabilities } from './capabilities.js';
import { compare, type RefResults } from './compare.js';
import { findConfig, flagCombinations, flagLabel, loadSuite, type Suite, type Test } from './config.js';
import { runIsolated, runWorker } from './isolate.js';
import { cleanRefs, prepareRefs, repoRoot, type Ref } from './refs.js';
import { reportComparison, reportEnvironment, reportList, reportRun } from './report.js';
import { mapPool } from './pool.js';
import { runTest, type CaseResult } from './runner.js';

const usage = `Usage: zbench [options] [filter...]

Run the performance tests named by the config file. Filters match a test's name or path.

Options:
  -c, --config <path>     Config file. Discovered by default.
  -n, --iterations <n>    Timed runs per configuration.
  -w, --warmup <n>        Untimed runs before the timed ones.
  -R, --ref <ref>         Benchmark a git reference. Repeatable; the first one is the baseline.
                          Use "." for the working tree as it is.
  -f, --flag <name=json>  Restrict a flag to one value. Repeatable.
  -t, --threshold <pct>   Smallest change worth coloring. [1]
  -T, --timeout <s>       Seconds a matrix may take before it is killed and reported N/A. [300]
                          0 waits forever. A reference with a pathological regression can
                          otherwise hold the whole comparison open.
  -a, --all               Run every configuration, ignoring cpu/mem requirements.
  -J, --jobs <n>          Matrices to time at once. [one per hardware thread, 1 with --no-isolate]
                          Concurrent matrices contend for the machine, which widens the ± column;
                          pass -J 1 for the quietest numbers.
  -l, --list              List what would run, then exit.
  -j, --json <path>       Write the raw results as JSON.
      --cpu <n>           Override the detected CPU level.
      --mem <n>           Override the detected memory level.
      --no-isolate        Run in this process instead of one child per matrix.
      --build <cmd>       Command that makes a reference's worktree runnable.
      --rebuild           Rebuild reference worktrees even when they are up to date.
      --clean             Remove cached reference worktrees, then exit.
  -q, --quiet             Only print results.
  -h, --help              Show this message.
`;

const { values: opts, positionals: filters } = parseArgs({
	options: {
		config: { short: 'c', type: 'string' },
		iterations: { short: 'n', type: 'string' },
		warmup: { short: 'w', type: 'string' },
		ref: { short: 'R', type: 'string', multiple: true, default: [] },
		flag: { short: 'f', type: 'string', multiple: true, default: [] },
		threshold: { short: 't', type: 'string' },
		timeout: { short: 'T', type: 'string' },
		all: { short: 'a', type: 'boolean' },
		jobs: { short: 'J', type: 'string' },
		list: { short: 'l', type: 'boolean' },
		json: { short: 'j', type: 'string' },
		cpu: { type: 'string' },
		mem: { type: 'string' },
		isolate: { type: 'boolean', default: true },
		build: { type: 'string' },
		rebuild: { type: 'boolean' },
		clean: { type: 'boolean' },
		quiet: { short: 'q', type: 'boolean' },
		help: { short: 'h', type: 'boolean' },
		worker: { type: 'string' },
	},
	allowPositionals: true,
});

if (opts.help) {
	console.log(usage);
	process.exit(0);
}

if (opts.worker) {
	await runWorker(opts.worker);
	process.exit(0);
}

function fail(message: string): never {
	io.error(message);
	process.exit(1);
}

function number(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) fail(`--${name} expects a number, got ${JSON.stringify(value)}`);
	return parsed;
}

/** Parse `-f name=json`, falling back to the raw string when it isn't valid JSON. */
function parseFlagOverrides(entries: string[]): Record<string, unknown[]> {
	const overrides: Record<string, unknown[]> = {};
	for (const entry of entries) {
		const at = entry.indexOf('=');
		if (at < 0) fail(`--flag expects name=value, got ${JSON.stringify(entry)}`);
		const name = entry.slice(0, at);
		const raw = entry.slice(at + 1);
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			value = raw;
		}
		(overrides[name] ??= []).push(value);
	}
	return overrides;
}

const configPath = opts.config ? resolve(opts.config) : findConfig();
if (!configPath) fail('no config file found; pass --config or add one at tests/perf/config.json');

let suite: Suite;
try {
	suite = loadSuite(configPath);
} catch (e: any) {
	fail(e.message);
}

if (filters.length) {
	const matches = (test: Test) =>
		filters.some(f => test.name.toLowerCase().includes(f.toLowerCase()) || test.path.includes(f));
	suite.tests = suite.tests.filter(matches);
	if (!suite.tests.length) fail(`no test matches ${filters.map(f => JSON.stringify(f)).join(', ')}`);
}

if (opts.list) {
	reportList(suite);
	process.exit(0);
}

const cache = join(await repoRoot().catch(() => process.cwd()), '.zbench');

if (opts.clean) {
	await cleanRefs(cache);
	io.info('removed cached worktrees');
	process.exit(0);
}

const flagOverrides = parseFlagOverrides(opts.flag);
const { cpu, mem } = resolveCapabilities({ cpu: number(opts.cpu, 'cpu'), mem: number(opts.mem, 'mem') });
const threshold = number(opts.threshold, 'threshold') ?? 1;
const timeout = number(opts.timeout, 'timeout') ?? 300;
const iterations = number(opts.iterations, 'iterations');
const warmup = number(opts.warmup, 'warmup');

const cli = resolve(import.meta.dirname, 'cli.js');
const refNames = opts.ref.length ? opts.ref : ['.'];

// Concurrent work in one process would interleave the tests' own awaits into each other's timings
const jobs = Math.max(
	1,
	number(opts.jobs, 'jobs') ?? (opts.isolate ? Math.round((navigator.hardwareConcurrency || 0) / 2) || 1 : 1)
);
if (jobs > 1 && !opts.isolate) fail('--jobs above 1 needs process isolation, so it cannot be used with --no-isolate');

/** Overwrite the progress line, if there is one to overwrite. */
const progress = {
	active: false,
	show(message: string) {
		if (opts.quiet || !process.stdout.isTTY) return;
		this.clear();
		process.stdout.write(styleText('gray', message));
		this.active = true;
	},
	clear() {
		if (!this.active) return;
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
		this.active = false;
	},
};

/** Every (test, flag combination) pair that will run, i.e. one table each. */
function* planned(suite: Suite): Generator<[Test, Record<string, unknown>]> {
	for (const test of suite.tests) {
		const narrowed = Object.fromEntries(
			Object.entries(test.flags).map(([name, values]) => [
				name,
				flagOverrides[name] ? values.filter(v => flagOverrides[name].some(w => Object.is(w, v))) : values,
			])
		);
		for (const flags of flagCombinations(narrowed)) yield [test, flags];
	}
}

async function runRef(ref: Ref, repo: string): Promise<CaseResult[]> {
	const config = ref.sha ? join(ref.dir, relative(repo, suite.file)) : suite.file;
	const matrices = [...planned(suite)];
	let done = 0;

	const results = await mapPool(matrices, jobs, async ([test, flags]) => {
		const label = [test.name, flagLabel(flags)].filter(Boolean).join(' ');
		progress.show(`[${done + 1}/${matrices.length}] ${label}${ref.sha ? ` @ ${ref.name}` : ''}...`);

		try {
			return opts.isolate
				? await runIsolated(
						{ config, test: test.id, flags, iterations, warmup, cpu, mem, all: opts.all },
						ref.dir,
						cli,
						timeout
					)
				: await runTest(test, {
						iterations,
						warmup,
						cpu,
						mem,
						all: opts.all,
						flags: Object.fromEntries(Object.entries(flags).map(([k, v]) => [k, [v]])),
					});
		} catch (e: any) {
			// A matrix that cannot run is one reference's problem, not the whole comparison's:
			// report it as N/A and let the references that did run still be compared
			return test.configurations.map((configuration): CaseResult => ({
				test: test.id,
				flags,
				configuration: configuration.name,
				value: configuration.value,
				setup: 0,
				samples: [],
				amounts: {},
				error: String(e?.message ?? e),
			}));
		} finally {
			done++;
		}
	});

	progress.clear();
	return results.flat();
}

if (!opts.quiet) reportEnvironment(cpu, mem, iterations ?? 5, warmup ?? 1, jobs);

const repo = await repoRoot().catch(() => process.cwd());

let prepared: Ref[];
try {
	prepared = await prepareRefs(refNames, {
		cache,
		build: opts.build ?? suite.build,
		root: suite.root,
		rebuild: opts.rebuild,
		onStep: message => progress.show(message + '...'),
	});
} catch (e: any) {
	progress.clear();
	fail(`could not prepare references: ${e.stderr || e.message}`);
}
progress.clear();

const refs: RefResults[] = [];

for (const ref of prepared) {
	if (prepared.length > 1 && !opts.quiet) {
		console.log();
		console.log(
			styleText(['bold', 'underline'], ref.name) + (ref.sha ? styleText('gray', '  ' + ref.sha.slice(0, 8)) : '')
		);
	}

	const cases = await runRef(ref, repo);
	reportRun(suite, cases);
	refs.push({ ref: ref.name, cases });
}

if (refs.length > 1) {
	console.log();
	console.log(styleText(['bold', 'underline'], `Change vs ${refs[0].ref}`));
	reportComparison(compare(suite, refs, threshold), refs);
}

if (opts.json) {
	await writeFile(
		opts.json,
		JSON.stringify(
			{
				node: process.version,
				platform: `${process.platform}/${process.arch}`,
				capabilities: { cpu, mem },
				refs,
			},
			null,
			'\t'
		)
	);
}

const failed = refs.flatMap(r => r.cases).filter(c => c.error);
if (failed.length) {
	// One failing code path usually fails in every configuration, so report each distinct message once
	const byMessage = new Map<string, string[]>();
	for (const c of failed) {
		const message = c.error!.split('\n')[0].trim();
		const where = [c.test, flagLabel(c.flags), c.configuration].filter(Boolean).join(' · ');
		if (!byMessage.has(message)) byMessage.set(message, []);
		byMessage.get(message)!.push(where);
	}

	console.log();
	for (const [message, where] of byMessage) {
		io.error(`${message}  (${where.length} configuration${where.length == 1 ? '' : 's'})`);
		for (const at of where.slice(0, 4)) console.error(styleText('gray', '    ' + at));
		if (where.length > 4) console.error(styleText('gray', `    ...and ${where.length - 4} more`));
	}

	process.exit(1);
}
