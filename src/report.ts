// SPDX-License-Identifier: LGPL-3.0-or-later
import * as io from 'ioium/node';
import { styleText } from 'node:util';
import type { Comparison, ComparisonRow, RefResults } from './compare.js';
import type { Suite, Test } from './config.js';
import { columns, matrices, timing, type Matrix } from './measure.js';
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

/** Print the delta tables that follow each state's own tables. */
export function reportComparison(comparisons: Comparison[], refs: RefResults[]): void {
	const names = refs.map(ref => ref.ref);
	let heading: string | null = null;

	for (const comparison of comparisons) {
		const rows = comparison.aggregate ? [comparison.aggregate] : comparison.rows;
		if (!rows.length) continue;

		const label = comparison.test.name + (comparison.label ? dim('  ' + comparison.label) : '');
		if (label != heading) {
			console.log();
			console.log(bold((heading = label)));
		}

		console.log('  ' + dim(comparison.column.label) + (comparison.aggregate ? dim(' (aggregate)') : ''));

		io.table<ComparisonRow>(
			[
				{ name: indent + 'configuration', text: row => indent + row.configuration, grow: 0 },
				{
					name: names[0],
					text: row =>
						row.cells[0].value === null ? dim('N/A') : comparison.column.format(row.cells[0].value),
					padStart: true,
					grow: 0,
				},
				...names.slice(1).flatMap((name, i) => [
					{
						name,
						text: (row: ComparisonRow) => {
							const cell = row.cells[i + 1];
							return cell.value === null ? dim('N/A') : comparison.column.format(cell.value);
						},
						padStart: true,
						grow: 0,
					},
					{ name: '', text: (row: ComparisonRow) => factorText(row, i + 1), padStart: true, grow: 0 },
				]),
			],
			{ formatHead: dim },
			rows
		);
	}
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
