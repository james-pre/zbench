// SPDX-License-Identifier: LGPL-3.0-or-later
import { flagLabel, type Metric, type Test } from './config.js';
import type { CaseResult } from './runner.js';
import { stats, type Stats } from './stats.js';
import { duration, inferCostSpan, inferThroughputSpan, sig, timespans, type Timespan } from './units.js';

/** One test's results for one flag combination: the unit a table is printed for. */
export interface Matrix {
	test: Test;
	flags: Record<string, unknown>;
	/** Empty when the test has no flags */
	label: string;
	cases: CaseResult[];
}

/** A metric with its timespan settled, so every row in a matrix shares one column heading. */
export interface ResolvedMetric extends Metric {
	span: Timespan;
	/** Column heading, e.g. `MB/s` or `ms/entry` */
	label: string;
}

/** Split a test's results into one matrix per flag combination, in the order they were run. */
export function matrices(test: Test, cases: CaseResult[]): Matrix[] {
	const byFlags = new Map<string, Matrix>();

	for (const result of cases) {
		if (result.test != test.id) continue;
		const key = JSON.stringify(result.flags);
		let matrix = byFlags.get(key);
		if (!matrix)
			byFlags.set(key, (matrix = { test, flags: result.flags, label: flagLabel(result.flags), cases: [] }));
		matrix.cases.push(result);
	}

	return [...byFlags.values()];
}

/** Cases that actually produced samples. */
export function ran(matrix: Matrix): CaseResult[] {
	return matrix.cases.filter(c => c.samples.length > 0);
}

/** The scaled amount and elapsed milliseconds a metric is computed from, for one case. */
function terms(metric: Metric, result: CaseResult): [amount: number, ms: number] {
	return [(result.amounts[metric.key] ?? 0) * metric.scale, result.samples.reduce((sum, v) => sum + v, 0)];
}

/** The same terms, summed across the whole matrix. */
function totals(metric: Metric, matrix: Matrix): [amount: number, ms: number] {
	let amount = 0,
		ms = 0;
	for (const result of ran(matrix)) {
		const [a, t] = terms(metric, result);
		amount += a;
		ms += t;
	}
	return [amount, ms];
}

function compute(kind: Metric['kind'], span: Timespan, amount: number, ms: number): number | null {
	if (!ms || !amount) return null;
	return kind == 'throughput' ? (amount * timespans[span]) / ms : ms / timespans[span] / amount;
}

/**
 * Settle each metric's timespan against the matrix as a whole.
 * Inferring per row would give each row a different heading, so the totals decide it once.
 */
export function resolveMetrics(matrix: Matrix): ResolvedMetric[] {
	return matrix.test.metrics.map(metric => {
		const [amount, ms] = totals(metric, matrix);
		const span =
			metric.span
			?? (!amount || !ms
				? 'ms'
				: metric.kind == 'throughput'
					? inferThroughputSpan(amount, ms)
					: inferCostSpan(amount, ms));

		return {
			...metric,
			span,
			label: metric.kind == 'throughput' ? `${metric.unit}/${span}` : `${span}/${metric.unit}`,
		};
	});
}

/** A metric's value for one configuration, or `null` when there is nothing to divide. */
export function caseValue(metric: ResolvedMetric, result: CaseResult): number | null {
	return compute(metric.kind, metric.span, ...terms(metric, result));
}

/** A metric's value across the whole matrix. */
export function aggregateValue(metric: ResolvedMetric, matrix: Matrix): number | null {
	return compute(metric.kind, metric.span, ...totals(metric, matrix));
}

/** Timing statistics for a case, in milliseconds. */
export function timing(result: CaseResult): Stats {
	return stats(result.samples);
}

/** Iterations per second, the metric every test has whether or not it declares one. */
export function opsPerSecond(result: CaseResult): number | null {
	const { mean } = timing(result);
	return mean ? 1000 / mean : null;
}

/**
 * A reported quantity, resolved against one matrix.
 * Tables and comparisons both work in terms of these, so a column is defined once and reported the same way everywhere.
 */
export interface Column {
	label: string;
	higherIsBetter: boolean;
	format(value: number): string;
	/** `null` for a row the column does not apply to */
	value(result: CaseResult): number | null;
	/**
	 * The column's value across a set of cases, when it has one.
	 * The cases are a parameter rather than the matrix the column came from, so a comparison can
	 * evaluate one state's column against another state's results without re-inferring the timespan.
	 */
	total?(cases: CaseResult[]): number | null;
	/** Aggregate columns are reported once per matrix instead of once per row */
	aggregate: boolean;
	/** Whether the metric behind this column asked to be the one comparisons report. Never set on the built-ins. */
	compare: boolean;
}

/**
 * The columns a matrix reports: the built-in timings, then whatever the test declared.
 * Aggregate metrics come last since they hold a single number rather than a column of them.
 */
export function columns(matrix: Matrix): Column[] {
	const list: Column[] = [
		{
			label: 'avg',
			higherIsBetter: false,
			format: duration,
			value: result => timing(result).mean || null,
			aggregate: false,
			compare: false,
		},
		{
			label: 'ops/s',
			higherIsBetter: true,
			format: sig,
			value: opsPerSecond,
			aggregate: false,
			compare: false,
		},
	];

	for (const metric of resolveMetrics(matrix)) {
		list.push({
			label: metric.label,
			higherIsBetter: metric.higherIsBetter,
			format: sig,
			value: result => caseValue(metric, result),
			total: cases => aggregateValue(metric, { ...matrix, cases }),
			aggregate: metric.aggregate,
			compare: metric.compare,
		});
	}

	return list;
}
