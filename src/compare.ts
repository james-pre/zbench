// SPDX-License-Identifier: LGPL-3.0-or-later
import { columns, matrices, timing, type Column, type Matrix } from './measure.js';
import type { CaseResult } from './runner.js';
import { combinedNoise } from './stats.js';
import type { Suite, Test } from './config.js';

/** Results for one of the states being compared. */
export interface RefResults {
	/** How the state was named on the command line, e.g. `main` or `v3.2.1` */
	ref: string;
	cases: CaseResult[];
}

/** One value alongside how noisy the run that produced it was. */
export interface Cell {
	value: number | null;
	/** Relative standard deviation of the timings, as a percentage */
	noise: number;
	missing: boolean;
}

/** How one state's value relates to the baseline's. */
export interface Delta {
	/** Speedup: always `> 1` when better, whichever direction the column improves in */
	factor: number | null;
	/** Percentage change of the raw value, signed */
	change: number | null;
	/** Whether the change stands out from run-to-run variance */
	significant: boolean;
	better: boolean;
}

export interface ComparisonRow {
	configuration: string;
	/** Indexed the same as the states being compared, baseline first */
	cells: Cell[];
	deltas: Delta[];
}

export interface Comparison {
	test: Test;
	/** Flag combination, empty when the test has no flags */
	label: string;
	column: Column;
	rows: ComparisonRow[];
	/** Present for aggregate metrics, which have one value per state rather than one per row */
	aggregate?: ComparisonRow;
}

function key(result: CaseResult): string {
	return `${result.test}\0${JSON.stringify(result.flags)}\0${result.configuration}`;
}

function cell(column: Column, result: CaseResult | undefined): Cell {
	if (!result || result.skipped || result.error) return { value: null, noise: 0, missing: true };
	return { value: column.value(result), noise: timing(result).rsd, missing: false };
}

/**
 * Compare a cell against the baseline.
 * A change is only called out when it is bigger than both `threshold` and the two runs' combined noise.
 */
export function delta(baseline: Cell, other: Cell, higherIsBetter: boolean, threshold: number): Delta {
	if (baseline.value === null || other.value === null || !baseline.value)
		return { factor: null, change: null, significant: false, better: false };

	const factor = higherIsBetter ? other.value / baseline.value : baseline.value / other.value;
	const change = ((other.value - baseline.value) / baseline.value) * 100;
	const noise = combinedNoise(baseline.noise, other.noise);

	return {
		factor,
		change,
		significant: Math.abs(change) > Math.max(threshold, noise),
		better: factor > 1,
	};
}

/**
 * Line up every state's results against the baseline, one comparison per matrix column.
 * `ops/s` is left out because it is just the reciprocal of `avg`.
 */
export function compare(suite: Suite, refs: RefResults[], threshold: number): Comparison[] {
	const [baseline, ...others] = refs;
	if (!baseline || !others.length) return [];

	const indexes = refs.map(ref => new Map(ref.cases.map(result => [key(result), result])));
	const comparisons: Comparison[] = [];

	for (const test of suite.tests) {
		for (const matrix of matrices(test, baseline.cases)) {
			for (const column of columns(matrix).filter(c => c.label != 'ops/s')) {
				const rows = matrix.cases.map(result => {
					const cells = indexes.map(index => cell(column, index.get(key(result))));
					return {
						configuration: result.configuration,
						cells,
						deltas: cells.map(c => delta(cells[0], c, column.higherIsBetter, threshold)),
					};
				});

				comparisons.push({
					test,
					label: matrix.label,
					column,
					rows: column.aggregate ? [] : rows,
					aggregate: column.aggregate ? aggregateRow(matrix, column, refs, threshold) : undefined,
				});
			}
		}
	}

	return comparisons;
}

/** The matrix-wide value for each state, compared the same way a row is. */
function aggregateRow(matrix: Matrix, column: Column, refs: RefResults[], threshold: number): ComparisonRow {
	const flags = JSON.stringify(matrix.flags);

	const cells = refs.map((ref): Cell => {
		const cases = ref.cases.filter(r => r.test == matrix.test.id && JSON.stringify(r.flags) == flags);
		const total = column.total?.(cases) ?? null;
		const noise = cases.filter(c => c.samples.length).map(c => timing(c).rsd);
		return {
			value: total,
			noise: noise.length ? noise.reduce((sum, v) => sum + v, 0) / noise.length : 0,
			missing: total === null,
		};
	});

	return {
		configuration: 'aggregate',
		cells,
		deltas: cells.map(c => delta(cells[0], c, column.higherIsBetter, threshold)),
	};
}
