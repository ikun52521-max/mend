[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun · rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ikun52521-max/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun · reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ikun52521-max/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend — one patch tool for every AI edit format

`mend` applies AI-written edits in four formats to a tree of files:

- **Unified diffs** — with wrong line numbers, renames, creates, deletes and moves
- **SEARCH/REPLACE blocks** — the `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` form
- **V4A patches** — `*** Begin Patch` / `*** Add File` / `*** Update File` / `*** End Patch`
- **JSON tool calls** — a JSON array or JSON Lines of `create`, `str_replace` and `insert` edits

It matches old text on three tiers (exact, trailing whitespace, then leading and
trailing whitespace), re-indents replacements to the file's own indentation, keeps
each file's line endings, and applies every edit atomically: a failed edit changes
nothing, later edits still run, and when any edit fails no file is written at all.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a path relative to the tree root (the current directory), or stdin when
absent or `-`. `--format` is one of `unified`, `search-replace`, `v4a`, `json` or
`auto` (the default). `--check` prints what would change without writing anything;
`--strict` matches exactly, with no whitespace forgiveness.

Exit codes: `0` when every edit applied, `1` when any edit failed (one
`error: <code> <path>` line per failure, then `failed: <k> of <n> edits`), `2` for
usage, missing patch, unknown format and parse errors (exactly one `error:` line).

## Running the practice set

The kit's `check.ts` runs the 100 public practice checks against `main.ts`:

```sh
node check.ts <practice.json>
```

## Built for make.fun

This entry was built for the [make.fun](https://make.fun) bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122):
"Build mend, one patch tool for every AI edit format". Node 22+ with the standard
library only; no dependencies, no install step.

## License

MIT — see [LICENSE](LICENSE).
