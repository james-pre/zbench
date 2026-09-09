// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium/node';
import { styleText } from 'node:util';
import type { Comparison, ComparisonRow, RefResults } from './compare.js';
import type { Suite, Test } from './config.js';
import { columns, matrices, timing, type Column, type Matrix } from './measure.js';
import type { CaseResult } from './runner.js';
import { duration, sig } from './units.js';

const dim = (text: string) => styleText('gray', text);
const bold = (text: string) => styleText('bold', text);

/** `io.table` declares an `indent` option but does not apply it, so the first column carries it. */
const indent = '  ';

/** Heading for one test, with its file path when that isn't already the name. */
function heading(test: Test): string {
	return bold(test.name) + (test.name == test.path ? '' : dim('  ' + test.path));
}

/**
 * What a cell shows when there is no measurement.
 * The reason is kept out of the cell so one failure cannot stretch every column in the table.
 */
function na(result: CaseResult): string {
	return result.error ? styleText('red', 'N/A') : dim('N/A');
}

/** Why some rows have no numbers, one line per distinct reason. */
function notes(cases: CaseResult[]): string[] {
	const byReason = new Map<string, string[]>();

	for (const result of cases) {
		const reason = result.skipped ?? result.error?.split('\n')[0].trim();
		if (!reason) continue;
		if (!byReason.has(reason)) byReason.set(reason, []);
		byReason.get(reason)!.push(result.configuration);
	}

	return [...byReason].map(([reason, where]) => `${indent}${dim('N/A: ' + where.join(', ') + ' — ' + reason)}`);
}

/** Print one matrix as a table, followed by its aggregate measurements. */
export function reportMatrix(matrix: Matrix): void {
	if (matrix.label) console.log('  ' + dim(matrix.label));

	const all = columns(matrix);
	const perRow = all.filter(c => !c.aggregate);
	const aggregates = all.filter(c => c.aggregate);

	io.table<CaseResult>(
		[
			{ name: indent + 'configuration', text: result => indent + result.configuration, grow: 0 },
			{ name: 'setup', text: result => (result.setup ? duration(result.setup) : ''), padStart: true, grow: 0 },
			{
				name: 'total',
				text: result => (result.samples.length ? duration(timing(result).total) : na(result)),
				padStart: true,
				grow: 0,
			},
			...perRow.map(column => ({
				name: column.label,
				text: (result: CaseResult) => {
					const value = column.value(result);
					return value === null ? na(result) : column.format(value);
				},
				padStart: true,
				grow: 0,
			})),
			{
				name: '±',
				text: (result: CaseResult) => (result.samples.length ? sig(timing(result).rsd, 2) + '%' : ''),
				padStart: true,
				grow: 0,
			},
		],
		{ formatHead: dim },
		matrix.cases
	);

	for (const note of notes(matrix.cases)) console.log(note);

	if (!aggregates.length) return;

	const totals = aggregates
		.map(column => {
			const value = column.total?.(matrix.cases) ?? null;
			return value === null ? null : `${column.format(value)} ${column.label}`;
		})
		.filter(text => text !== null);

	if (totals.length) console.log('  ' + dim('aggregate') + '  ' + totals.join(dim(', ')));
}

/** Print every test's tables for a single state. */
export function reportRun(suite: Suite, cases: CaseResult[]): void {
	for (const test of suite.tests) {
		const found = matrices(test, cases);
		if (!found.length) continue;

		console.log();
		console.log(heading(test));
		for (const matrix of found) reportMatrix(matrix);
	}
}

/** `1.35x` when better, `0.74x` when worse, colored only when the change beats the noise. */
function factorText(row: ComparisonRow, index: number): string {
	const { factor, significant, better } = row.deltas[index];
	if (factor === null) return '';
	const text = sig(factor, 3) + 'x';
	if (!significant) return dim(text);
	return styleText(better ? 'green' : 'red', text);
}

/**
 * One table holding every column of a matrix, grouped by state.
 * Each state gets a value per column and a single factor, since the columns of a matrix are
 * proportional and would otherwise repeat the same speedup.
 */
function comparisonTable(names: string[], cols: Column[], rows: ComparisonRow[]): void {
	if (!cols.length || !rows.length) return;

	io.table<ComparisonRow>(
		[
			{ name: indent + 'configuration', text: row => indent + row.configuration, grow: 0 },
			...names.flatMap((name, r) => [
				{ name, text: () => '', grow: 0 },
				...cols.map((column, c) => ({
					name: column.label,
					text: (row: ComparisonRow) => {
						const { value } = row.cells[r][c];
						return value === null ? dim('N/A') : column.format(value);
					},
					padStart: true,
					grow: 0,
				})),
				...(r == 0
					? []
					: [{ name: '', text: (row: ComparisonRow) => factorText(row, r), padStart: true, grow: 0 }]),
			]),
		],
		{ formatHead: dim },
		rows
	);
}

export interface ComparisonOptions {
	/** Also report matrices where nothing beat the threshold */
	unchanged?: boolean;
	/** Also report matrices where fewer than two states produced numbers */
	partial?: boolean;
}

/** Print the delta tables that follow each state's own tables. */
export function reportComparison(comparisons: Comparison[], refs: RefResults[], options: ComparisonOptions = {}): void {
	const names = refs.map(ref => ref.ref);
	let heading: Test | null = null;
	let unchanged = 0;
	let partial = 0;
	let shown = 0;

	for (const comparison of comparisons) {
		if (comparison.reported < 2) {
			if (!options.partial) {
				partial++;
				continue;
			}
		} else if (!comparison.changed && !options.unchanged) {
			unchanged++;
			continue;
		}
		if (!comparison.rows.length && !comparison.aggregate) continue;

		console.log();
		if (comparison.test != heading) console.log(bold((heading = comparison.test).name));

		if (comparison.label) console.log('  ' + dim(comparison.label));

		comparisonTable(names, comparison.columns, comparison.rows);

		if (comparison.aggregate) {
			if (comparison.columns.length) console.log();
			comparisonTable(names, comparison.aggregateColumns, [comparison.aggregate]);
		}

		shown++;
	}

	const hidden = [
		unchanged && `${unchanged} unchanged (--unchanged)`,
		partial && `${partial} reported by one reference (--partial)`,
	].filter(Boolean);

	if (!hidden.length) return;
	if (!shown) console.log();
	console.log(indent + dim(`${hidden.join(', ')}`));
}

/** A one-line note about what the numbers were produced under. */
export function reportEnvironment(cpu: number, mem: number, iterations: number, warmup: number, jobs: number): void {
	console.log(
		dim(
			`${process.version} on ${process.platform}/${process.arch}`
				+ `  cpu=${cpu} mem=${mem}  ${iterations} iterations, ${warmup} warmup`
				+ (jobs > 1 ? `, ${jobs} at a time` : '')
		)
	);
}

/** List the tests and configurations that would run, without running them. */
export function reportList(suite: Suite): void {
	for (const test of suite.tests) {
		console.log();
		console.log(heading(test));
		for (const config of test.configurations) {
			const needs = [config.cpu && `cpu ${config.cpu}`, config.mem && `mem ${config.mem}`].filter(Boolean);
			console.log('  ' + config.name + (needs.length ? dim('  needs ' + needs.join(', ')) : ''));
		}
		for (const [name, values] of Object.entries(test.flags))
			console.log('  ' + dim(`flag ${name}: ${values.map(v => JSON.stringify(v)).join(', ')}`));
	}
}
