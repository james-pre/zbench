// SPDX-License-Identifier: LGPL-3.0-or-later

/**
 * Map over `items` with at most `limit` running at once, keeping the results in input order.
 * A `limit` of 1 is a plain serial loop.
 */
export async function mapPool<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const worker = async () => {
		for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i], i);
	};

	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}
