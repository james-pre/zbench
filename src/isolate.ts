// SPDX-License-Identifier: LGPL-3.0-or-later
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CaseResult } from './types.js';
import type { Test } from './config.js';

/** Everything a worker needs to run exactly one matrix. */
export interface WorkerConfig {
	/** Absolute path to the config file, inside the reference's worktree when there is one */
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
	onCase?(test: Test, flags: Record<string, unknown>, configuration: string, index: number, total: number): void;
}

/** Resolved next to this module, so it works from `dist` and from the sources alike. */
const entry = join(import.meta.dirname, import.meta.filename.endsWith('.ts') ? './worker.ts' : './worker.js');

/**
 * Run one matrix in a fresh worker thread.
 */
export async function runIsolated(
	spec: WorkerConfig,
	/** Seconds before the worker is killed. 0 waits forever. */
	timeout: number = 0
): Promise<CaseResult[]> {
	const worker = new Worker(entry, { workerData: spec, stdout: true, stderr: true });

	let output = '';
	let timedOut = false;

	const collect = (chunk: Buffer) => (output += chunk.toString());
	worker.stdout.on('data', collect);
	worker.stderr.on('data', collect);

	const timer = timeout
		? setTimeout(() => {
				timedOut = true;
				void worker.terminate();
			}, timeout * 1000)
		: undefined;

	try {
		const { promise, resolve, reject } = Promise.withResolvers<CaseResult[]>();
		worker.on('message', (results: CaseResult[]) => {
			resolve(results);
			// The results are in hand, so nothing the test left running is worth waiting on
			void worker.terminate();
		});
		worker.on('error', reject);
		worker.on('exit', code => {
			if (timedOut) reject(new Error(`timed out after ${timeout}s`));
			else reject(new Error(`worker exited with code ${code}\n${output.trim()}`));
		});
		return promise;
	} finally {
		clearTimeout(timer);
	}
}
