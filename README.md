[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/NftArt7/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/NftArt7/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed-01

A faster drop-in for make.fun's own makefun-site 1.0.0, built for the [site-generator-speed-01-run-20261122 bounty on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122).

Try make.fun yourself: https://make.fun/r/7q6eysa2

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` exports
`run(input)`, which returns exactly the output tree makefun-site's `build`
returns for the same site — same files, same bytes — but runs faster.

## How it is faster

- **Markdown in one pass.** Bodies are rendered by a single scan over the
  source instead of a lex-then-render token list, and inline markup is
  handled by one batched scanner: plain runs are pushed whole, only the
  five escaped characters and the markup openers are handled one by one.
- **Front matter without splitting the body.** The close line is found by
  scanning, the few front-matter lines are read, and the body is one slice.
- **Memoised slug and date work** per build, and link targets resolved
  through a cache.
- **Templates compiled to JavaScript.** Each template is parsed once per
  case and compiled (via the `Function` constructor) into a plain function
  that builds its output directly, instead of being walked as a node tree
  on every render. Loop variables are bound to locals, so a path starting
  at the loop variable reads straight from the local.
- **Cards built once** per source and shared by the lists and the page
  record, instead of being rebuilt per render.

Every case is answered alone: all caches live inside `build()` and are
dropped when it returns, so nothing is carried from one case to the next.

## Files

- `solve.js` — the implementation; `run(input)` is the entry point.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each
  case with `run`, writes `/output/answers.json`.

## Validation

Validated locally against the kit's practice set (3 cases): output is
byte-identical to the reference answers (the kit scorer reports passed 1,
3/3 cases), and the entry is deterministic across runs. Measured CPU time
per 3-case round on this machine: about 167 ms against about 574 ms for
the house baseline's makefun-site — roughly a 3.4x speedup. Correctness
was also checked against the reference on 30 freshly generated sites
(drawn from other seeds with the kit's own generator) and on 213 targeted
edge cases (inline markup, block structure, front matter, templates,
include depth, shadowed statics, CRLF sources): all identical.
