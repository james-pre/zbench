// SPDX-License-Identifier: LGPL-3.0-or-later

/** Summary of a set of timing samples, in whatever unit the samples were taken in. */
export interface Stats {
	n: number;
	total: number;
	mean: number;
	median: number;
	min: number;
	max: number;
	/** Sample standard deviation */
	stddev: number;
	/** Standard deviation as a percentage of the mean. This is the noise floor for comparisons. */
	rsd: number;
}

export function stats(samples: number[]): Stats {
	const n = samples.length;
	if (!n) return { n, total: 0, mean: 0, median: 0, min: 0, max: 0, stddev: 0, rsd: 0 };

	const total = samples.reduce((sum, v) => sum + v, 0);
	const mean = total / n;
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = n >> 1;

	// Bessel's correction: a single sample has no spread to estimate
	const variance = n < 2 ? 0 : samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
	const stddev = Math.sqrt(variance);

	return {
		n,
		total,
		mean,
		median: n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
		min: sorted[0],
		max: sorted[n - 1],
		stddev,
		rsd: mean ? (stddev / mean) * 100 : 0,
	};
}

/**
 * The combined noise of two independent measurements, as a percentage.
 * A change smaller than this is indistinguishable from run-to-run variance.
 */
export function combinedNoise(a: number, b: number): number {
	return Math.sqrt(a ** 2 + b ** 2);
}
