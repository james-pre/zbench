// SPDX-License-Identifier: LGPL-3.0-or-later

/** Timespans from shortest to longest. */
export const timespanOrder = ['ns', 'us', 'ms', 's'] as const;

/** A unit of time a measurement can be expressed in. */
export type Timespan = (typeof timespanOrder)[number];

/** Milliseconds in each timespan, since every duration is measured in milliseconds. */
export const timespans = { ns: 1e-6, us: 1e-3, ms: 1, s: 1e3 } as const satisfies Record<Timespan, number>;

export function isTimespan(value: unknown): value is Timespan {
	return typeof value == 'string' && value in timespans;
}

/**
 * Units whose amounts are counted in bytes, so `unit: "MB"` on a byte count reports MB/s without a `scale`.
 * Both decimal and binary prefixes are recognized; an explicit `scale` overrides this.
 */
export const byteUnits = {
	B: 1,
	kB: 1e3,
	KB: 1e3,
	MB: 1e6,
	GB: 1e9,
	TB: 1e12,
	KiB: 2 ** 10,
	MiB: 2 ** 20,
	GiB: 2 ** 30,
	TiB: 2 ** 40,
} as const satisfies Record<string, number>;

/** The multiplier that converts a raw amount into `unit`. */
export function unitScale(unit: string): number {
	return unit in byteUnits ? 1 / byteUnits[unit as keyof typeof byteUnits] : 1;
}

/**
 * Round to `digits` significant figures, then render without trailing zeroes.
 * Exponential notation is kept for values too small to read otherwise.
 */
export function sig(value: number, digits: number = 4): string {
	if (!Number.isFinite(value)) return '-';
	if (value == 0) return '0';
	return Number(value.toPrecision(digits)).toString();
}

/** Render a duration in milliseconds using whichever timespan keeps it readable. */
export function duration(ms: number): string {
	if (!Number.isFinite(ms)) return '-';
	if (ms == 0) return '0';
	const span = pick(timespanOrder, s => ms / timespans[s]);
	return sig(ms / timespans[span]) + span;
}

/**
 * Choose the first candidate whose value lands in `[1, 1000)`.
 * When none does, the closest one is used, so the result is always readable rather than empty.
 */
function pick<T>(candidates: readonly T[], value: (candidate: T) => number): T {
	let best = candidates[0];
	let distance = Infinity;

	for (const candidate of candidates) {
		const v = Math.abs(value(candidate));
		if (v >= 1 && v < 1000) return candidate;

		const from1 = v > 0 && Number.isFinite(v) ? Math.abs(Math.log10(v)) : Infinity;
		if (from1 < distance) {
			distance = from1;
			best = candidate;
		}
	}

	return best;
}

/**
 * Pick the timespan that makes `amount` per timespan readable.
 * Throughput grows with the timespan, so the search runs from longest to shortest.
 */
export function inferThroughputSpan(amount: number, ms: number): Timespan {
	return pick([...timespanOrder].reverse(), span => (amount * timespans[span]) / ms);
}

/** Pick the timespan that makes the time per unit readable. Cost shrinks with the timespan. */
export function inferCostSpan(amount: number, ms: number): Timespan {
	return pick(timespanOrder, span => ms / timespans[span] / amount);
}
