# zbench

Reproducible, data-driven performance testing.

`node:test` is the wrong tool for benchmarks: it reports pass/fail, not throughput, and it has no
notion of a matrix, a baseline, or noise. zbench is the other tool. You describe the matrix in JSON,
write a `test` function, and it handles iteration, measurement, machine gating, process isolation,
and comparison across git references.

```
npm i -D zbench
```

## The shape of a suite

A config file lists tests. Each test names a module and the configurations to run it under.

`tests/perf/config.json`:

```json
{
	"tests": [
		{
			"path": "unpack.ts",
			"name": "Unpack a zip of random data",
			"measure": {
				"bytes": { "throughput": "s", "unit": "MB" },
				"entries": { "cost": true, "aggregate_cost": true, "unit": "entry" }
			},
			"configurations": [
				{ "name": "1000x 128KB", "value": { "size": 131072, "entries": 1000 } },
				{ "value": { "size": 131072, "entries": 2000 } },
				{ "cpu": 1, "value": { "size": 524288, "entries": 1000 } },
				{ "mem": 1, "value": { "size": 131072, "entries": 16000 } }
			]
		}
	]
}
```

`tests/perf/unpack.ts`:

```ts
interface Config {
	size: number;
	entries: number;
}

export function setup(config: Config) {
	return buildArchive(config.entries, config.size);
}

export async function test(config: Config, archive: Archive) {
	const unpacked = await unpack(archive);
	return { bytes: unpacked.byteLength, entries: unpacked.count };
}
```

Then `npx zbench`.

The config file is discovered at `tests/perf/config.json`, `tests/perf.json`,
`tests/perf.config.json`, or `zbench.json`, searching upward from the working directory. Test paths
resolve relative to it.

## What a test module exports

Only `test` is required.

| Export     | When it runs           | Timed                           |
| ---------- | ---------------------- | ------------------------------- |
| `setup`    | once per configuration | separately, reported as `setup` |
| `before`   | before every iteration | no                              |
| `test`     | the operation          | **yes**                         |
| `after`    | after every iteration  | no                              |
| `teardown` | once per configuration | no                              |

`setup` returns state, which every other hook receives as its second argument. `before` is where
you restore anything the test consumes, so each iteration starts from the same place.

`test` receives the configuration's `value` merged with the active flags. It may return an object of
amounts — how much work it actually did — which overrides the amounts taken from the configuration.
Return them whenever the real amount is not known until the test runs.

Node strips types rather than resolving them, so a test that imports a sibling `.ts` file has to
name the real extension (`./fixtures.ts`). Set `allowImportingTsExtensions` in the tsconfig that
covers your tests.

## Measurements

Every test reports `setup`, `total`, `avg`, `ops/s`, and `±` (relative standard deviation — the
noise floor) without asking. `measure` adds columns derived from the quantities the test works in.

| Key                    | Reports                                     | Example    |
| ---------------------- | ------------------------------------------- | ---------- |
| `throughput`           | units per timespan, per configuration       | `MB/s`     |
| `cost`                 | timespan per unit, per configuration        | `ms/entry` |
| `aggregate_throughput` | units per timespan, across the whole matrix | `MB/s`     |
| `aggregate_cost`       | timespan per unit, across the whole matrix  | `ms/entry` |

Each takes `"ns"`, `"us"`, `"ms"`, `"s"`, or `true` to pick whichever timespan keeps the number
readable. The timespan is settled once per matrix, so a column has one heading.

`unit` names the quantity in the column heading and defaults to the key. Byte units (`B`, `KB`,
`MB`, `GB`, `TB`, `KiB`, `MiB`, ...) also scale the amount, so a test that counts bytes and declares
`"unit": "MB"` reports MB/s with no further arithmetic. `scale` sets the multiplier explicitly and
overrides that.

## Flags

Flags are alternative code paths rather than points in the matrix: the whole matrix runs once per
combination, and each combination gets its own table. Declare them once and let tests draw from the
pool by name:

```json
{
	"flags": { "lazy": [true, false] },
	"tests": [{ "path": "mount.ts", "flags": ["lazy"], "configurations": [] }]
}
```

A test can also declare its own inline: `"flags": { "lazy": [true, false] }`. Flag values are merged
into the configuration the test receives. `-f lazy=true` restricts a run to one value.

## Machine requirements

A configuration can say what it needs:

```json
{ "cpu": 2, "mem": 1, "value": { "entries": 32000 } }
```

Both are logarithmic — level `n + 1` is about twice level `n`. zbench calibrates the machine at
startup and reports rows it cannot afford as `N/A`, so the same config file runs everywhere without
timing out a laptop. Override with `--cpu` / `--mem` (or `ZBENCH_CPU` / `ZBENCH_MEM`), or ignore the
gating entirely with `-a`.

## Comparing states

```
zbench -R v3.2.1 -R main -R HEAD
```

Each reference is checked out into a cached worktree under `.zbench/`, built, and run. The first is
the baseline; every other column shows its value and a speedup factor that is `> 1` when better,
whichever direction the column improves in. A change is only colored when it is larger than both
`--threshold` (default 1%) and the two runs' combined noise — so a green number means the change
outran the variance, and a gray one means it did not.

Use `.` for the working tree as it is, without a checkout or a build.

The tests themselves always come from the working tree and are copied into each worktree, so an old
reference is benchmarked with today's tests. `--build` sets the command that makes a worktree
runnable (default `npm install --no-audit --no-fund && npm run build`), `--rebuild` forces it, and
`--clean` removes the cached worktrees.

## Isolation and concurrency

Each matrix runs in a fresh process by default, so one configuration cannot warm up or poison the
next, and a reference's own build is what gets loaded. `--no-isolate` runs everything in-process for
debugging or profiling.

`-J` sets how many matrices are timed at once, defaulting to half the number of hardware threads. Concurrent
matrices contend for the machine, which inflates absolute numbers and widens `±`; the comparison
factors hold up because every reference runs under the same contention, but pass `-J 1` when the
absolute numbers are the point.

A matrix that crashes or outruns `--timeout` (default 300s) is reported as `N/A` rather than
bringing down the run, so the references that did finish are still compared. This matters when the
thing you are looking for is a quadratic: the configuration that takes 30 ms on the fix can take ten
minutes on the commit before it.

## Options

```
  -c, --config <path>     Config file. Discovered by default.
  -n, --iterations <n>    Timed runs per configuration.
  -w, --warmup <n>        Untimed runs before the timed ones.
  -R, --ref <ref>         Benchmark a git reference. Repeatable; the first one is the baseline.
  -f, --flag <name=json>  Restrict a flag to one value. Repeatable.
  -t, --threshold <pct>   Smallest change worth coloring. [1]
  -T, --timeout <s>       Seconds a matrix may take before it is killed and reported N/A. [300]
  -a, --all               Run every configuration, ignoring cpu/mem requirements.
  -J, --jobs <n>          Matrices to time at once.
  -l, --list              List what would run, then exit.
  -j, --json <path>       Write the raw results as JSON.
      --cpu <n>           Override the detected CPU level.
      --mem <n>           Override the detected memory level.
      --no-isolate        Run in this process instead of one child per matrix.
      --build <cmd>       Command that makes a reference's worktree runnable.
      --rebuild           Rebuild reference worktrees even when they are up to date.
      --clean             Remove cached reference worktrees, then exit.
  -q, --quiet             Only print results.
```

Positional arguments filter tests by name or path.
