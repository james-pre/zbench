// SPDX-License-Identifier: LGPL-3.0-or-later

interface Config {
	items: number;
	slow?: boolean;
}

interface State {
	setups: number;
	runs: number;
}

/** Counts are asserted on, so the harness's lifecycle is checked rather than assumed. */
export const counts = { setup: 0, before: 0, after: 0, teardown: 0 };

export function setup(): State {
	counts.setup++;
	return { setups: 1, runs: 0 };
}

export function before(): void {
	counts.before++;
}

export function after(): void {
	counts.after++;
}

export function teardown(): void {
	counts.teardown++;
}

export function test(config: Config, state: State) {
	state.runs++;

	let sink = 0;
	for (let i = 0; i < config.items * (config.slow ? 2000 : 200); i++) sink += i;

	return { items: config.items, sink: sink && 0 };
}
