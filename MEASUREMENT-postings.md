# Occurrence postings for use-sites: measured, not landed

**Decision: the change is NOT landed.** `lib/index.js` is unchanged by it. This document is
the measurement the gate asked for, the numbers behind the decision, and the two defects the
measurement itself caught.

Reproduce with `measure-postings.mjs` (each mode in its own process, so one mode's garbage is
never measured inside another):

```sh
node --expose-gc measure-postings.mjs baseline        # today's behaviour
node --expose-gc measure-postings.mjs postings        # token -> (fileId, line)
node --expose-gc measure-postings.mjs postings-files  # token -> fileId
```

## The problem it addresses

The index holds **declarations and impl headers only**. Everything about *uses* goes through
`scanText`, which for every mention scan re-reads **every indexed file from disk** and loops
`filePaths × needles`. On this tree that is 2,013 file reads per call, paid again on every call —
for `mentions: true`, and for every unresolved symbol whose negative has to be checked against
raw text.

## Measurements (vendored Zed checkout, 2,013 files, Node 26.7.0)

Heap is retained `heapUsed` after a forced collection, measured from a fresh process; the
baseline figure is the **whole** plugin index (73,252 definitions, 9,355 impls, and every lookup
map), which is what a postings structure would be added on top of.

| | baseline (plugin index) | postings `(fileId, line)` | postings `(fileId)` only |
| --- | --- | --- | --- |
| retained heap, index | 121.9 MB | **+64.3 MB** | **+25.2 MB** |
| cold build | 752 ms | 846 ms (+13%) | 763 ms (+1.5%) |
| postings entries | — | 4,453,198 | 720,517 |
| distinct runs | — | 120,282 | 120,282 |

Mention-path wall time, and the files actually re-read, per needle:

| needle (occurrences) | baseline | postings `(fileId, line)` | postings `(fileId)` |
| --- | --- | --- | --- |
| `Context` (22,542) | 103 ms · 2013 files | 94 ms · 1207 | 90 ms · 1207 |
| `focus_handle` (3,814) | 105 ms · 2013 | 35 ms · 258 | 34 ms · 258 |
| `Picker` (1,592) | 101 ms · 2013 | 20 ms · 129 | 20 ms · 129 |
| `Focusable` (435) | 102 ms · 2013 | 30 ms · 206 | 29 ms · 206 |
| `TerminalPanel` (85) | 100 ms · 2013 | 8 ms · 12 | 7 ms · 12 |
| `FocusOnlyModal` (9) | 98 ms · 2013 | 2 ms · 1 | 2 ms · 1 |
| `NoSuchSymbolXYZ123` (0) | 106 ms · 2013 | 1 ms · 0 | 2 ms · 0 |
| **count mismatches vs the plugin** | — | **0** | **0** |

The counts are identical on every needle, including snake_case and a path-qualified query. That
is the point of the run-based design described below.

## Why the counts still agree

`mentions.count` is a true **substring** count. A postings index yields a **token** count, and
the two differ. The prototype keeps the substring count exactly:

- postings are keyed by the maximal **identifier run** of each line (`[A-Za-z0-9_$]+`),
  lowercased;
- a needle that lies inside one run can only occur on a line whose run contains it, so *every
  key that contains the needle* is a complete superset of the matching lines — it cannot miss
  one;
- the candidate files are then re-read and counted with the same `countOccurrences`.

A needle containing a separator (`gpui::Focusable`, `a b`) is not contained in any run, so the
postings cannot narrow it and the prototype falls back to a full scan rather than guessing.

Subtoken keys — the design the handoff sketches — cannot do this. A needle like `xtMenu` occurs
inside the run `ContextMenu` but inside none of its subtokens, so a subtoken lookup under-counts,
and a postings-derived `absent` would be false. That is the same class of defect as v1's
`ABSENT … in 0 indexed file(s)`.

## Two defects the measurement caught

Both were silent, and both would have produced a confident wrong number.

1. **The first tokeniser broke every snake_case needle.** It split runs with `[A-Za-z0-9]+`,
   which cannot contain `_`. A needle like `focus_handle` matched **zero** keys, so it selected
   zero candidate files and would have reported a count of 0 with no indication anything was
   wrong. Most Rust symbols are snake_case: this would have been wrong on the primary use case,
   and it was invisible until a snake_case needle was actually timed. The run class is now
   `[A-Za-z0-9_$]+`.
2. **The first comparison was not like-for-like.** The tool counts occurrences of the name it
   *resolved*, not of the raw query: `gpui::Focusable` resolves to `Focusable` through the
   path-segment tier and reports that name's count of 435. Counting the raw query gave 7, which
   looked like a postings bug and was a harness bug. `baseline` now writes its resolved name and
   count to an artifact, and the postings modes compare against that same string.

## Why it is not landed

**The design the handoff specifies fails its own memory gate.** Postings with line numbers cost
**+64.3 MB per index** — a 53% increase on the 121.9 MB index. The pool is process-wide and holds
up to `MAX_POOL_ENTRIES = 8` indexes, so the worst case is roughly **+514 MB** on top of an
already roughly 1 GB worst case. Worse, the line numbers are **data the mention path does not
use**: the count and the site text both come from re-reading the candidate files anyway.

**The variant that would pass is a different change.** Dropping the line numbers costs
**+25.2 MB** and does not slow the cold build measurably (763 ms vs 752 ms, within run-to-run
noise), with the same 0-count-mismatch result. That is the shape a future attempt should take —
but it is not the change that was specified, so it gets its own decision rather than being
smuggled in under this one.

**The benefit is concentrated where it matters least, in absolute terms.** Rare and absent
needles — the cases the A/B identified as dominant — go from ~100 ms to 1–2 ms, which is a real
100× win. Ubiquitous ones go from 103 ms to 90 ms, because 1,207 of 2,013 files still match. The
A/B's measured problem, though, was **context and token cost** (25,697 characters of
`grep 'Focusable for'`), not 100 ms of scan latency; every one of the four changes in this round
targets that cost, and this one does not.

**And it touches the most safety-critical path in the file.** `scanText` is what keeps a
negative from becoming a false `absent` — design decisions #3 and #4, the two the README calls
load-bearing. Rewriting it for a ~100 ms win, on a plugin whose whole value proposition is that
its negatives can be trusted, is not a trade this measurement supports.

## What a future attempt would need

- file ids only (no line numbers), which is the variant that passes the memory gate;
- the run class `[A-Za-z0-9_$]+`, plus a full-scan fallback for any needle that is not a single
  identifier run, and a test for that fallback;
- a test that asserts the postings count equals the scan count on snake_case, camelCase,
  qualified, multi-occurrence-per-line, and zero-hit needles;
- a re-run of `parity-check.mjs`, whose soundness property is exactly what a wrong postings
  lookup would break;
- and a decision about the config surface, since `splitSubtokens`-style behaviour would then
  depend on a new per-mount flag.
