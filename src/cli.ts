#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-or-later
import type { JobResult } from 'ioium/jobs';
import * as io from 'ioium/node';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs, styleText } from 'node:util';
import { resolveCapabilities } from './capabilities.js';
import { compare, type RefResults } from './compare.js';
import { findConfig, flagCombinations, flagLabel, loadSuite, type Suite, type Test } from './config.js';
import { runIsolated } from './isolate.js';
import { cleanRefs, prepareRef, repoRoot, workingRefs, type Ref } from './refs.js';
import { reportComparison, reportEnvironment, reportList, reportRun } from './report.js';
import type { CaseResult } from './types.js';
import { duration } from './units.js';

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
  -J, --jobs <n>          Matrices to time at once. [one per two hardware threads]
                          Concurrent matrices contend for the machine, which widens the ± column;
                          pass -J 1 for the quietest numbers.
  -l, --list              List what would run, then exit.
  -j, --json <path>       Write the raw results as JSON.
      --overlap           Let matrices from different references run at the same time. By default
                          a reference is finished before the next one starts, so every matrix of a
                          reference meets the same contention.
      --no-runs           When comparing, skip each reference's own tables and only report changes.
      --unchanged         Also report matrices where nothing beat the threshold.
      --partial           Also report matrices where fewer than two references produced numbers.
      --cpu <n>           Override the detected CPU level.
      --mem <n>           Override the detected memory level.
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
		overlap: { type: 'boolean' },
		runs: { type: 'boolean', default: true },
		unchanged: { type: 'boolean' },
		partial: { type: 'boolean' },
		cpu: { type: 'string' },
		mem: { type: 'string' },
		build: { type: 'string' },
		rebuild: { type: 'boolean' },
		clean: { type: 'boolean' },
		quiet: { short: 'q', type: 'boolean' },
		help: { short: 'h', type: 'boolean' },
	},
	allowPositionals: true,
	allowNegative: true,
});

if (opts.help) {
	console.log(usage);
	process.exit(0);
}

const dim = (text: string) => styleText('gray', text);

const ignore = () => {};

// Results go to the console directly, so silencing ioium leaves them in place while the job lines,
// the progress line and the incidental notices go away
if (opts.quiet) {
	io.useOutput({ debug: ignore, log: ignore, info: ignore, warn: console.warn, error: console.error });
	io.jobs.useDraw(ignore);
	io.jobs.useClear(ignore);
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

const refNames = opts.ref.length ? opts.ref : ['.'];

const jobs = Math.max(1, number(opts.jobs, 'jobs') ?? (Math.round((navigator.hardwareConcurrency || 0) / 2) || 1));

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

if (!opts.quiet) reportEnvironment(cpu, mem, iterations ?? 5, warmup ?? 1, jobs);

const repo = await repoRoot().catch(() => process.cwd());

const refOptions = { cache, build: opts.build ?? suite.build, root: suite.root, rebuild: opts.rebuild };
const prepared = new Array<Ref>(refNames.length);

// The working tree is used where it is, so the usual case has nothing to report and no job to run
if (refNames.every(name => workingRefs.includes(name))) {
	prepared.splice(0, refNames.length, ...(await Promise.all(refNames.map(name => prepareRef(name, refOptions)))));
} else {
	const failures: string[] = [];

	await io.jobs.runWithData(
		{
			concurrency: refNames.length,
			jobStartText: dim('preparing'),
			name: ({ name }) => name,
			async run({ name, index }, progress): Promise<JobResult> {
				try {
					prepared[index] = await prepareRef(name, { ...refOptions, onStep: m => progress(dim(m)) });
					return { status: 'succeeded', text: dim('ready') };
				} catch (e: any) {
					const text = String(e?.stderr || e?.message || e).trim();
					const reason = text.split('\n').filter(Boolean).at(-1) ?? 'failed';
					failures.push(`${name}: ${reason}`);
					return { status: 'failed', text: reason };
				}
			},
		},
		refNames.map((name, index) => ({ name, index }))
	);

	// A reference that will not build has no numbers at all, so there is nothing left to compare
	if (failures.length) fail(`could not prepare references:\n  ${failures.join('\n  ')}`);
}

/** One matrix of one reference: the unit of work, and the unit of isolation. */
interface MatrixJob {
	/** Position in `results`, so a matrix stays where it was planned however late it finishes */
	index: number;
	ref: Ref;
	test: Test;
	flags: Record<string, unknown>;
}

const plan = [...planned(suite)];
const queue: MatrixJob[] = [];

// Every reference's matrices go into one queue, so a reference that finishes early does not leave
// the machine idle while a slow one is still running
for (const ref of prepared) for (const [test, flags] of plan) queue.push({ index: queue.length, ref, test, flags });

const results = new Array<CaseResult[]>(queue.length);
const comparing = prepared.length > 1;

await io.jobs.runWithData<MatrixJob>(
	{
		concurrency: jobs,
		jobStartText: 'running',
		name: job =>
			[job.test.name, flagLabel(job.flags)].filter(Boolean).join(' ')
			+ (comparing ? dim(' @ ' + job.ref.name) : ''),
		group: opts.overlap ? undefined : job => job.ref,
		async run(job): Promise<JobResult> {
			const config = job.ref.sha ? join(job.ref.dir, relative(repo, suite.file)) : suite.file;
			const started = performance.now();

			try {
				results[job.index] = await runIsolated(
					{ config, test: job.test.id, flags: job.flags, iterations, warmup, cpu, mem, all: opts.all },
					timeout
				);

				return { status: 'succeeded', text: styleText('blue', duration(performance.now() - started)) };
			} catch (e: any) {
				const error = String(e?.message ?? e);

				// A matrix that cannot run is one reference's problem, not the whole comparison's:
				// report it as N/A and let the references that did run still be compared
				results[job.index] = job.test.configurations.map((configuration): CaseResult => ({
					test: job.test.id,
					flags: job.flags,
					configuration: configuration.name,
					value: configuration.value,
					setup: 0,
					samples: [],
					amounts: {},
					error,
				}));

				return { status: 'failed', text: error.split('\n')[0] };
			}
		},
	},
	queue
);

// The queue is reference-major, so each reference owns one contiguous run of the results
const refs: RefResults[] = prepared.map((ref, i) => ({
	ref: ref.name,
	cases: results.slice(i * plan.length, (i + 1) * plan.length).flat(),
}));

// With one reference there is no comparison to fall back on, so its own tables are the whole report
if (opts.runs || !comparing) {
	for (const [i, ref] of refs.entries()) {
		if (comparing && !opts.quiet) {
			const { sha } = prepared[i];
			console.log();
			console.log(styleText(['bold', 'underline'], ref.ref) + (sha ? dim('  ' + sha.slice(0, 8)) : ''));
		}
		reportRun(suite, ref.cases);
	}
}

if (comparing) {
	console.log();
	console.log(styleText(['bold', 'underline'], `Change vs ${refs[0].ref}`));
	reportComparison(compare(suite, refs, threshold), refs, {
		unchanged: opts.unchanged,
		partial: opts.partial,
	});
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
		for (const at of where.slice(0, 4)) console.error(dim('    ' + at));
		if (where.length > 4) console.error(dim(`    ...and ${where.length - 4} more`));
	}

	process.exit(1);
}
