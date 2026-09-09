// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * How much work one iteration did, keyed by quantity.
 * Returning this from `test` overrides the amounts taken from the configuration,
 * which matters whenever the real amount is not known until the test runs.
 */
export type Amounts = Record<string, number>;

/**
 * What a test file exports.
 * Only `test` is required; everything else fills in the gaps around it.
 *
 * @typeParam C The configuration, i.e. one entry's `value` merged with the active flags
 * @typeParam S Whatever `setup` hands to the rest of the lifecycle
 */
export interface TestModule<C = any, S = any> {
	/** Run once per configuration, before any iteration. Its time is reported separately and never counted as the test's. */
	setup?(config: C, ...args: never[]): S | Promise<S>;

	/** Run before each iteration, untimed. Use it to restore state the test consumes. */
	before?(config: C, state: S): unknown;

	/** The timed operation. Return {@link Amounts} to report what it actually processed. */
	test(config: C, state: S): Amounts | void | Promise<Amounts | void>;

	/** Run after each iteration, untimed. */
	after?(config: C, state: S): unknown;

	/** Run once per configuration, after every iteration. */
	teardown?(config: C, state: S): unknown;
}

/** The measurements taken for one test at one point in its matrix. */
export interface CaseResult {
	/** The test's id, i.e. its path as written in the config */
	test: string;
	flags: Record<string, unknown>;
	configuration: string;
	value: Record<string, number>;
	/** Milliseconds `setup` took */
	setup: number;
	/** Milliseconds each timed iteration took */
	samples: number[];
	/** Raw amounts summed over every timed iteration, keyed by quantity */
	amounts: Amounts;
	/** Present when the configuration was not run */
	skipped?: string;
	/** Present when the test threw */
	error?: string;
}
