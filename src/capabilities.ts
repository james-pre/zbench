// SPDX-License-Identifier: LGPL-3.0-or-later
import { totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

/**
 * What the current machine can be asked to run.
 * A configuration is skipped when it asks for more than these.
 */
export interface Capabilities {
	cpu: number;
	mem: number;
}

/** Milliseconds the calibration loop takes on the machine level 0 is defined against. */
const cpuReference = 40;

/** Memory a level 0 machine is assumed to have. */
const memReference = 4 * 2 ** 30;

function calibrate(): number {
	const run = () => {
		let x = 0;
		for (let i = 0; i < 5e6; i++) x = (x + Math.imul(i, 2654435761)) >>> 0;
		return x;
	};

	run(); // let the JIT settle before the timed pass

	const start = performance.now();
	run();
	return performance.now() - start;
}

let detected: Capabilities | undefined;

/**
 * Measure what this machine can handle. Levels are logarithmic, so `n + 1` is about twice `n`.
 * The result is cached, since calibration costs real time.
 */
export function capabilities(): Capabilities {
	detected ??= {
		cpu: Math.max(0, Math.round(Math.log2(cpuReference / calibrate()))),
		mem: Math.max(0, Math.floor(Math.log2(totalmem() / memReference))),
	};
	return detected;
}

/** Resolve the budget from overrides, the environment, and finally calibration. */
export function resolveCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
	const env = (name: string): number | undefined => {
		const value = process.env[name];
		if (value === undefined) return undefined;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	};

	const cpu = overrides.cpu ?? env('ZBENCH_CPU');
	const mem = overrides.mem ?? env('ZBENCH_MEM');

	if (cpu !== undefined && mem !== undefined) return { cpu, mem };

	const auto = capabilities();
	return { cpu: cpu ?? auto.cpu, mem: mem ?? auto.mem };
}
