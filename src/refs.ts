// SPDX-License-Identifier: LGPL-3.0-or-later
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/** Names that mean "whatever is in the working tree right now", which is never built or checked out. */
export const workingRefs = ['.', 'working', 'wip'];

/** A state to benchmark: either the working tree or a git worktree checked out at some reference. */
export interface Ref {
	/** As given on the command line */
	name: string;
	/** Where the tests run */
	dir: string;
	/** `null` for the working tree */
	sha: string | null;
}

export interface RefOptions {
	/** Where worktrees are kept between runs */
	cache: string;
	/** Shell command that makes a worktree runnable */
	build: string;
	/** Directory holding the tests, copied into each worktree so every reference runs the same tests */
	root: string;
	/** Build even when the worktree is already at the right commit */
	rebuild?: boolean;
	onStep?(message: string): void;
}

async function git(repo: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFile('git', ['-C', repo, ...args], { maxBuffer: 1 << 26 });
	return stdout.trim();
}

/** The root of the repository containing `from`. */
export async function repoRoot(from: string = process.cwd()): Promise<string> {
	return await git(from, 'rev-parse', '--show-toplevel');
}

function slug(ref: string): string {
	return ref.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ref';
}

/**
 * Copy the tests into a worktree.
 *
 * The tests have to come from the working tree rather than the checkout, since an old reference
 * predates them; they have to be copied rather than symlinked, since Node resolves bare imports
 * from a file's real path and a symlink would reach the working tree's `node_modules` instead of
 * the worktree's.
 */
async function copyTests(repo: string, dir: string, root: string): Promise<void> {
	const target = join(dir, relative(repo, root));
	if (resolve(target) == resolve(root)) return;

	await cp(root, target, {
		recursive: true,
		filter: source => {
			const name = basename(source);
			return name != 'node_modules' && !name.startsWith('.');
		},
	});
}

/**
 * Check out every reference and make it runnable.
 *
 * Checkout is serial because `git worktree add` takes a repository-wide lock, but building is not,
 * and building is where nearly all of the time goes. Nothing here is timed, so the concurrency
 * costs the measurements nothing.
 */
export async function prepareRefs(names: string[], options: RefOptions): Promise<Ref[]> {
	const repo = await repoRoot();
	const staged: (Ref & { build: boolean })[] = [];

	for (const name of names) {
		if (workingRefs.includes(name)) {
			staged.push({ name, dir: repo, sha: null, build: false });
			continue;
		}

		const sha = await git(repo, 'rev-parse', name + '^{commit}');
		const dir = join(options.cache, slug(name));
		const stamp = join(dir, '.zbench-ref');

		const current = existsSync(stamp) ? (await readFile(stamp, 'utf-8')).trim() : null;
		if (current == sha && !options.rebuild) {
			staged.push({ name, dir, sha, build: false });
			continue;
		}

		if (existsSync(dir)) {
			await git(repo, 'worktree', 'remove', '--force', dir).catch(() => {});
			await rm(dir, { recursive: true, force: true });
		}

		await mkdir(options.cache, { recursive: true });
		options.onStep?.(`checking out ${name} (${sha.slice(0, 8)})`);
		await git(repo, 'worktree', 'add', '--detach', dir, sha);
		staged.push({ name, dir, sha, build: true });
	}

	const building = staged.filter(ref => ref.build).map(ref => ref.name);
	if (building.length) options.onStep?.(`building ${building.join(', ')}`);

	await Promise.all(
		staged.map(async ({ dir, sha, build }) => {
			if (sha === null) return;
			await copyTests(repo, dir, options.root);
			if (!build) return;
			await execFile('sh', ['-c', options.build], { cwd: dir, maxBuffer: 1 << 26 });
			await writeFile(join(dir, '.zbench-ref'), sha + '\n');
		})
	);

	return staged.map(({ name, dir, sha }) => ({ name, dir, sha }));
}

/** Check out one reference into a reusable worktree, build it, and stage the tests inside it. */
export async function prepareRef(name: string, options: RefOptions): Promise<Ref> {
	const [ref] = await prepareRefs([name], options);
	return ref;
}

/** Remove every cached worktree. */
export async function cleanRefs(cache: string): Promise<void> {
	const repo = await repoRoot();
	if (!existsSync(cache)) return;

	const listed = await git(repo, 'worktree', 'list', '--porcelain');
	for (const line of listed.split('\n')) {
		if (!line.startsWith('worktree ')) continue;
		const dir = line.slice('worktree '.length);
		if (resolve(dir).startsWith(resolve(cache))) await git(repo, 'worktree', 'remove', '--force', dir);
	}

	await rm(cache, { recursive: true, force: true });
	await git(repo, 'worktree', 'prune');
}
