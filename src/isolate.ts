// SPDX-License-Identifier: LGPL-3.0-or-later
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSuite } from './config.js';
import { runTest, type CaseResult } from './runner.js';

/** Everything a child process needs to run exactly one matrix. */
export interface WorkerSpec {
	/** Path to the config file, as seen from the child's working directory */
	config: string;
	/** The test's id */
	test: string;
	/** The single flag combination to run */
	flags: Record<string, unknown>;
	iterations?: number;
	warmup?: number;
	cpu?: number;
	mem?: number;
	all?: boolean;
	/** Where the child writes its results */
	out: string;
}

/** Run one matrix and write the results where the parent expects them. */
export async function runWorker(specPath: string): Promise<void> {
	const spec: WorkerSpec = JSON.parse(await readFile(specPath, 'utf-8'));
	const suite = loadSuite(spec.config);
	const test = suite.tests.find(t => t.id == spec.test);
	if (!test) throw new Error(`no test with id ${JSON.stringify(spec.test)} in ${spec.config}`);

	const results = await runTest(test, {
		iterations: spec.iterations,
		warmup: spec.warmup,
		cpu: spec.cpu,
		mem: spec.mem,
		all: spec.all,
		flags: Object.fromEntries(Object.entries(spec.flags).map(([k, v]) => [k, [v]])),
	});

	await writeFile(spec.out, JSON.stringify(results));
}

/**
 * Run one matrix in a fresh process.
 * Every matrix gets its own heap and its own module graph, which is what keeps one configuration
 * from warming up (or poisoning) the next, and what lets a git reference's own build be loaded.
 */
export async function runIsolated(
	spec: Omit<WorkerSpec, 'out'>,
	cwd: string,
	cli: string,
	/** Seconds before the worker is killed. 0 waits forever. */
	timeout: number = 0
): Promise<CaseResult[]> {
	const dir = await mkdtemp(join(tmpdir(), 'zbench-'));
	const specPath = join(dir, 'spec.json');
	const out = join(dir, 'results.json');

	try {
		await writeFile(specPath, JSON.stringify({ ...spec, out }));

		// Output is buffered rather than inherited: with several workers running it would interleave,
		// and it is only worth reading when one of them fails
		let output = '';
		let timedOut = false;

		const code = await new Promise<number>((resolve, reject) => {
			const extra: string[] = [];
			if (!process.features.typescript) extra.push('--disable-warning=ExperimentalWarning');

			const child = spawn(process.execPath, [...process.execArgv, ...extra, cli, '--worker', specPath], {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			const collect = (chunk: Buffer) => (output += chunk.toString());
			child.stdout.on('data', collect);
			child.stderr.on('data', collect);

			const timer = timeout
				? setTimeout(() => {
						timedOut = true;
						child.kill('SIGKILL');
					}, timeout * 1000)
				: undefined;

			child.on('error', reject);
			child.on('close', c => {
				clearTimeout(timer);
				resolve(c ?? 1);
			});
		});

		if (timedOut) throw new Error(`timed out after ${timeout}s`);
		if (code != 0) throw new Error(`worker exited with code ${code}\n${output.trim()}`);

		return JSON.parse(await readFile(out, 'utf-8'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
