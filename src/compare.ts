// SPDX-License-Identifier: LGPL-3.0-or-later
import { columns, matrices, timing, type Column, type Matrix } from './measure.js';
import type { CaseResult } from './types.js';
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
	/** Indexed by state first (baseline first), then by column */
	cells: Cell[][];
	/**
	 * One per state, from the primary column.
	 * The metrics of a matrix are proportional to each other, so every column would report the
	 * same factor; taking it from one keeps the table free of repeated numbers.
	 */
	deltas: Delta[];
}

/** One matrix, with every column it reports lined up across the states being compared. */
export interface Comparison {
	test: Test;
	/** Flag combination, empty when the test has no flags */
	label: string;
	/** Columns reported once per configuration. The first is the one `deltas` come from. */
	columns: Column[];
	rows: ComparisonRow[];
	/** Columns reported once for the whole matrix rather than once per row */
	aggregateColumns: Column[];
	/** The single row those columns fill, when there are any */
	aggregate: ComparisonRow | null;
	/** Whether any row's factor beat both the threshold and the noise */
	changed: boolean;
	/** How many states produced at least one number here. Below 2 there is nothing to compare. */
	reported: number;
}

function key(result: CaseResult): string {
	return `${result.test}\0${JSON.stringify(result.flags)}\0${result.configuration}`;
}

function cell(column: Column, result: CaseResult | undefined): Cell {
	if (!result || result.skipped || result.error) return { value: null, noise: 0, missing: true };
	return { value: column.value(result), noise: timing(result).rsd, missing: false };
}

const noDelta: Delta = { factor: null, change: null, significant: false, better: false };

/**
 * Compare a cell against the baseline.
 * A change is only called out when it is bigger than both `threshold` and the two runs' combined noise.
 */
export function delta(baseline: Cell, other: Cell, higherIsBetter: boolean, threshold: number): Delta {
	if (baseline.value === null || other.value === null || !baseline.value) return noDelta;

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
 * The columns a comparison reports for a matrix.
 * A test that marks any measurement with `compare` gets only those; otherwise everything but
 * `ops/s`, which is just the reciprocal of `avg`.
 */
export function comparedColumns(matrix: Matrix): Column[] {
	const all = columns(matrix);
	const selected = all.filter(column => column.compare);
	return selected.length ? selected : all.filter(column => column.label != 'ops/s');
}

/** Line up one configuration's cells across every state, with the primary column's delta. */
function row(configuration: string, cells: Cell[][], primary: Column | undefined, threshold: number): ComparisonRow {
	return {
		configuration,
		cells,
		deltas: primary
			? cells.map(c => delta(cells[0][0], c[0], primary.higherIsBetter, threshold))
			: cells.map(() => noDelta),
	};
}

/** The matrix-wide value for each state, compared the same way a row is. */
function aggregateRow(matrix: Matrix, cols: Column[], refs: RefResults[], threshold: number): ComparisonRow {
	const flags = JSON.stringify(matrix.flags);

	const cells = refs.map((ref): Cell[] => {
		const cases = ref.cases.filter(r => r.test == matrix.test.id && JSON.stringify(r.flags) == flags);
		const noise = cases.filter(c => c.samples.length).map(c => timing(c).rsd);
		// An aggregate spans the whole matrix, so its noise is the matrix's, not any one row's
		const spread = noise.length ? noise.reduce((sum, v) => sum + v, 0) / noise.length : 0;

		return cols.map((column): Cell => {
			const total = column.total?.(cases) ?? null;
			return { value: total, noise: spread, missing: total === null };
		});
	});

	return row('aggregate', cells, cols[0], threshold);
}

/**
 * Line up every state's results against the baseline, one comparison per matrix.
 * Every column of a matrix lands in the same table, so a speedup factor is reported once rather
 * than once per measurement.
 */
export function compare(suite: Suite, refs: RefResults[], threshold: number): Comparison[] {
	const [baseline, ...others] = refs;
	if (!baseline || !others.length) return [];

	const indexes = refs.map(ref => new Map(ref.cases.map(result => [key(result), result])));
	const comparisons: Comparison[] = [];

	for (const test of suite.tests) {
		for (const matrix of matrices(test, baseline.cases)) {
			const selected = comparedColumns(matrix);
			const perRow = selected.filter(column => !column.aggregate);
			const aggregateColumns = selected.filter(column => column.aggregate);

			const rows = perRow.length
				? matrix.cases.map(result =>
						row(
							result.configuration,
							indexes.map(index => perRow.map(column => cell(column, index.get(key(result))))),
							perRow[0],
							threshold
						)
					)
				: [];

			const aggregate = aggregateColumns.length ? aggregateRow(matrix, aggregateColumns, refs, threshold) : null;

			const all = aggregate ? [...rows, aggregate] : rows;

			comparisons.push({
				test,
				label: matrix.label,
				columns: perRow,
				rows,
				aggregateColumns,
				aggregate,
				// The baseline's delta against itself is never significant, so this only counts real changes
				changed: all.some(r => r.deltas.some(d => d.significant)),
				reported: refs.filter((_, r) => all.some(row => row.cells[r].some(c => c.value !== null))).length,
			});
		}
	}

	return comparisons;
}
