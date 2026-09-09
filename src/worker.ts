// SPDX-License-Identifier: LGPL-3.0-or-later
// The entry point `runIsolated` starts a thread on. It exists as its own module so the parent can
// point a Worker at a file that does nothing but run one matrix and hand the results back.
import { parentPort, workerData } from 'node:worker_threads';
import type { WorkerConfig } from './isolate.js';
import { loadSuite } from './config.js';
import { runTest } from './runner.js';

if (!parentPort) throw new Error('zbench/worker is only meant to be run as a worker thread');

const config = workerData as WorkerConfig;

const suite = loadSuite(config.config);
const test = suite.tests.find(t => t.id == config.test);
if (!test) throw new Error(`no test with id ${JSON.stringify(config.test)} in ${config.config}`);

const results = await runTest(test, {
	iterations: config.iterations,
	warmup: config.warmup,
	cpu: config.cpu,
	mem: config.mem,
	all: config.all,
	flags: Object.fromEntries(Object.entries(config.flags).map(([k, v]) => [k, [v]])),
});

parentPort.postMessage(results);
