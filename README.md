# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/albertod12-ops/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/albertod12-ops/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files: one patch tool
for every AI edit format — unified diffs, SEARCH/REPLACE blocks, V4A patches
and JSON editor calls. Each edit finds its lines at the first of three
matching tiers (exact, trailing whitespace, full whitespace), re-indents at
the drift tier, and writes every change or none. A move prints one
`R old -> new` line; a failure names its edit and the rest still run.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; no dependencies to install. `PATCH`
is the patch file, or `-` (or absent) to read it from standard input.
`--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or
`json`; `--check` reports what would change without writing; `--strict`
matches lines exactly. See `main.ts` for the implementation and the
competition kit's `SPEC.md` for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rbvcjbg9&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
