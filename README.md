# dsh-tool-symbol-index

`find_symbol` — a code-symbol search plugin for **DeepSeek Harness** (DSH) agent presets.

It answers symbol questions about a source tree in **one call** instead of a grep sweep:
where a name is defined, **both sides of every `impl`**, whether a name exists at all, and a
literal/regex text search over the same tree. It replaces `grep` for the common cases a coding
agent actually asks, and it says exactly what it searched so a negative answer can be trusted.

Dependency-free: one ESM file, no imports, no build step, no language server, no `ctags`.

```yaml
# add to an agent preset's agent.cordis.yml
- id: symbol-index
  name: dsh-tool-symbol-index
  config:
    toolName: find_symbol
```

## Why it exists

A DSH worker subagent spent 394 greps and 238 steps sweeping a vendored Zed checkout for an
API it could not resolve, then re-ran one byte-identical search 41 times — because a stable
negative read as an incomplete lookup rather than as an answer. The unit of waste was the
call: each grep re-sent the whole context and returned raw matches the model could
re-litigate.

A controlled A/B on an identical task showed where the cost really was. `find_symbol`'s own
output was **9,180 of the arm's 110,484 characters** of tool output. Three *other* calls
produced 96,074 (**87%**): a 50,000-char `find | uniq -c` census, a 25,697-char
`grep 'Focusable for'`, and a 20,377-char mention grep. **Every one of them existed because of
a gap in the tool, not because of its output format.**

A rerun of the same byte-identical task then measured the fixes (three arms, one model, both
source trees unchanged):

| metric | A1 grep | B1 `find_symbol` | **A2 grep** | **B2 `find_symbol`** | **C2 unguided** |
| --- | --- | --- | --- | --- | --- |
| tool calls | 37 | 19 | 47 | 24 | **18** |
| steps | 25 | 14 | 40 | 22 | **13** |
| tokens in (summed) | 237k | 331k | 314k | **146k** | 162k |
| peak single-step input | 22.0k | 46.8k | 23.6k | **13.8k** | 23.7k |
| wall clock | 227 s | 246 s | 263 s | **165 s** | 336 s |
| correctness | ✔ | ✔ | ✔ | ✔ | ✔ |

**v1 → v2 on the tool-directed arm: input tokens −56%, peak context −71%, wall clock −33%** —
at *more* calls (19→24) and steps (14→22). The win is context cost, not call count, and the
full 10-symbol / 2-root report is 11,039 chars with no truncation.

### The result that shaped the report format

Every arm was 20/20 correct, so the round turned on the one large trait set (185 names /
190 sites):

| | A2 grep | B2 `find_symbol` | C2 unguided |
| --- | --- | --- | --- |
| `Focusable` targets | 187 — 2 false positives | 184 — 1 missing | **185 — exact** |
| `FocusOnlyModal` (the v1 defect) | present | absent | present |

The tool's own answer was **complete and correct** — 190 impls, `FocusOnlyModal` enumerated,
186 entries diffing to the truth with zero extras and zero omissions. B2's miss was
self-inflicted: it read the report's smaller count beside the larger as *"capped at 186"* and
rebuilt the set with a grep whose pattern could not match a 4-space-indented
`impl gpui::Focusable for X`, discarding an answer it already had.

**Both manual corrections in that round made the answer worse than the tool's own answer**, in
opposite directions, and the best arm was the one given the tool with no doctrine attached.
Two consequences are built into this plugin:

- the report never presents a count an agent could read as a cap — `impl-sites 12 of 190 shown
  (detail rows capped)` and `impl-targets 186 unique type(s) from 190 impl site(s) — COMPLETE
  list, do not re-derive it` are labelled, related, and explicit about which is which;
- the tool is designed to be *added*, not *doctrined around*.

## What it does

| capability | detail |
| --- | --- |
| many symbols per call | 1–12 names, one report |
| definitions | every site, kind-classified, best kind first |
| **both sides of an impl** | what implements `X`, **and** what `X` implements — including inherent `impl X { … }` |
| qualified paths | `impl gpui::Focusable for X` is attributed to `Focusable`, and the written path is preserved |
| scoped negatives | `defined` / `impls-only` / `mentions-only` / `absent` / `inconclusive` |
| coverage evidence | what was searched, what was pruned, what caps were hit |
| text search | `query` for literal or regex, with an exact total |
| mention sites | `mentions: true` instead of grepping for uses |
| no re-walk cost | process-wide index pool; later questions revalidate cheaply instead of re-walking |
| **drop-in `grep`/`glob`** | opt-in replacements that keep the built-in call shapes but carry scope evidence |

Rust, TypeScript/JavaScript, Python and Go are indexed; the extension set is configurable.

## Replacing `grep` at the tool level

> **Resolved 2026-09-14 — the earlier "do not enable" warning was a misattribution.**
> This section previously warned that turning `provideSearchTools` on made `find_symbol`
> stop reaching agents. It did not. `find_symbol` was already invisible on that path, for a
> reason that has nothing to do with this plugin or with the harness: the delegating
> `tool-subagent-preset` row's `toolFilter.allow`, in the preset plugin's `cordis.patch.yml`,
> listed `bash, read, write, edit, glob, grep, read_image, crew_wait, todo_write` and did not
> list `find_symbol`. A filter is a **global-tool mask**, so every name it omits is removed
> from the child's view even though this row registers it and the preset's order-115 section
> tells the child to use it. `grep` and `glob` arrived because they were on the list; the
> named tool did not because it was not — which is exactly the observed split, and why
> reverting the flag restored nothing.
>
> Two independent checks pin the cause. **Differential:** the same preset, plane and process
> deliver `find_symbol` to a crew role, whose allow-list (Settings → Plugins → crews) *does*
> name it, and withhold it from a `subagent_preset` child, whose list does not. **Static:**
> composing the boot tree prints the row's effective filter, and it is the list above —
> `node scripts/render-composition.mjs web tool-subagent-preset` (in the preset plugin).
> The fix is one name on that list, applied there; nothing in this package or in the harness
> needed to change, and `provideSearchTools` was never implicated.
>
> The replacement still pairs with disabling `tool-fs-search` (see below), and it has not yet
> been re-measured end to end with `find_symbol` visible — the earlier live runs could not have
> measured it, because the tool under test was being filtered out of the catalog.

Set `provideSearchTools: true` and the row registers **drop-in `grep` and `glob`** beside
`find_symbol`. They keep the same call shapes, so nothing about how an agent works has to
change — it calls `grep` and gets a better one:

```
grep "TODO" · 3 match(es) in 3 file(s)
index crates@…: 88 files (built in 24ms)
SEARCHED: .rs×88
coverage: complete — 88 file(s) searched. Every allow-listed file under this root was read,
          so a "not found" here is final
crates/kernel/src/lib.rs:47: // TODO: …
```

What that buys, relative to the built-in:

- **a negative carries its scope**, so it can be believed instead of re-checked by hand;
- **a path that does not exist is a hard error that read nothing**, naming the nearest existing
  directory and the closest names in it — never an empty result an agent can read as
  "not found";
- **counts are exact even when rows are capped**, and the report says which is which.

Pair it with disabling the row that provides the built-in search tools, because both register
into the same preset layer and a duplicate name in one layer is an error rather than a shadow:

```yaml
- id: symbol-index
  name: dsh-tool-symbol-index
  config:
    toolName: find_symbol
    provideSearchTools: true

# Disabled in favour of the index-backed grep/glob above. Re-enable this row and
# drop provideSearchTools to revert.
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  disabled: true
```

### Why a drop-in replacement and not a redirect

`tools/pre-execute` can allow, deny or ask — it **cannot substitute a result** — so
intercepting a grep and "redirecting" it would cost one round trip per search. Worse, it adds
doctrine, and the A/B measured where doctrine leads: the only arm to lose correctness was the
one told how to work, and it lost it by second-guessing an answer that was already right. A
`grep` that simply returns scoped, exact-count results needs no instruction and cannot be
second-guessed into being wrong.

`glob` is served from its own path-only walk, not from the index, precisely so that it still
finds `Cargo.toml`, `Makefile` and fixtures — files the source index deliberately never reads.
There is a regression test for that.

## The four deliberate design decisions

**1. Both sides of an `impl`.** `universal-ctags` keeps only the identifier before `for` (its
parser says so outright), and `tree-sitter-rust`'s `impl_item trait: (type_identifier)`
capture cannot match a `scoped_identifier` at all — so neither can answer "what implements
trait X". Storing the trait *and* the self type costs one row and answers both directions.

**2. A qualified name is stored under both forms and says which matched.** Keeping only the
last segment is false-negative-free but false-positive-prone; keeping only the full path is
the reverse. `matchedOn: exact | path-segment-or-generic | case-insensitive |
subtoken-normalized` discloses which form resolved, instead of silently presenting a
last-segment or convention-normalised hit as an exact one.

**3. A negative must name its scope.** The mechanism that stops an agent re-searching is not
the phrase "no results" but the *presence of scope evidence*. Every report carries
`SEARCHED`, `NOT SEARCHED`, `PRUNED DIRS` and a `coverage:` line; a `find | uniq -c` census is
therefore unnecessary. Report writing for agent tools is full of cases where an unscoped
`No matches found` made a model conclude a symbol did not exist and recreate an existing file.

**4. A limit is not a policy.** A missing path is a **hard error that read nothing**, naming
the nearest existing directory and its closest names — never an empty result. A negative from
zero ingested files, from a capped index, or with unreadable files is `inconclusive`, never
`absent`. A disclosed policy omission (a pruned `target/`) stays a final `absent`, because the
caller can see it and override it with `includeExcluded: true`.

### Naming-convention equivalence, as the last tier

Rust is snake_case end to end, so inside a pure Rust tree a convention mismatch never shows up.
It shows up at every boundary — serde `rename_all`, JSON keys, `invoke("get_user_by_id")` string
literals, generated bindings, TS↔Rust FFI, CLI flags — where the caller writes a symbol in the
spelling its binding uses. `get_user_by_id` and `getUserById` used to be different keys.

A deterministic splitter (camelCase boundaries, `snake_case`, `kebab-case`, `SCREAMING_SNAKE`,
alpha/digit transitions, case-folded, empties dropped) now keys an additional definition map, and
the query is normalised with the **same** function. The tier runs **last**: exact →
path-segment-or-generic → case-insensitive → subtoken-normalized, and a stricter tier's hit is
never overridden by a looser one.

```
## getUserById (matched as get_user_by_id)
def fn lib.rs:8  pub fn get_user_by_id(id: u64) -> UserProfile {
verdict [defined]: DEFINED lib.rs:8 (fn); no definition of "getUserById" as written; resolved by
naming-convention normalisation to "get_user_by_id" (different spelling, same identifier
tokens — no exact, path-segment or case-insensitive form matched).
```

Two deliberate consequences, both on the safe side:

- **Subtoken resolution resolves definitions only.** The impl maps are not subtoken-keyed, so a
  looser tier can never inflate `implTargets` — which is exactly the set the `expect` gate
  compares against, and therefore the set that could turn "does X implement Y" into a YES with
  no evidence. A symbol reached by a different spelling reports its definitions and no impls;
  `matchedOn` says why.
- **One token apart does not collapse.** `list_user_profile`/`list_user_profiles` and
  `list_user_id`/`list_user_ids` resolve to different symbols, because keys are token lists
  joined by a separator that cannot occur inside a token.

This widens what a name query can hit, so it is measured rather than assumed — see the subtoken
oracle below.

### A bad symbol names its closest candidates

Decision #4 already ranked candidates for a bad **path**: a missing directory yields the nearest
existing ancestor and the closest names inside it, never a bare "cannot resolve". It did not do
that for a bad **symbol** — an unresolvable name produced a bare `absent` and nothing else, which
is exactly what starts an agent guessing spellings. An `absent` verdict now names the closest
names the index actually saw, ranked by bounded case-folded edit distance over the stored
definition and impl names:

```
verdict [absent]: ABSENT — no definition, no impl, and no textual mention of "VisualContxt" …
near-miss 1 of 1 name(s) within edit distance 3 of "VisualContxt" (candidates from the index,
advisory — the verdict above is unchanged): VisualContext
```

The candidates come from the index alone — no extra file read, no new walk, no new pass — the
list is capped and labelled like every other list (shown-of-total, then the remainder), and no
candidate list can turn an `absent` into anything else. On the Zed checkout, twelve absent
symbols cost 342 ms warm, alongside the mention scan that was already there.

### The index revalidates itself, so an edit is never answered from a stale build

The pool serves a build for `indexTtlMs` (10 minutes by default), so for that window an answer
could predate the working tree. Disclosure was the first fix — the report states the build's age
and never presents a negative as final *for the tree* when it is only final *for the build*:

```
index crates@1789651513254: 2013 files, 73252 defs, 9355 impls
  (reused — built 1m30s ago, revalidated against the tree just now)
```

But disclosure alone still left a footgun, and the warning was the wrong shape of fix: the agent
most likely to search next is the agent that just edited a file, and it has no reason to know the
answer came from a cache. So a **reused** index now re-checks itself against the working tree
before it answers, and rebuilds when anything moved:

```
index crates@1789651513254: 2013 files, 73252 defs, 9355 impls
  (rebuilt — the pooled build was stale, the tree had changed since it was built)
```

- `ctx.fs.stat` hands out a `version` freshness token, composed by the local backend from
  `dev:ino:size:mtimeNs:ctimeNs`, so the comparison is exact rather than heuristic. Files **and
  directories** are stamped: a directory's version moves when an entry is added, removed or
  renamed, which is the case a per-file mtime check cannot see — an agent that creates a new file
  and then asks whether its symbol exists is the same footgun one step earlier.
- The check is bounded by the index (one stat per indexed file plus one per directory walked),
  short-circuits on the first mismatch, and runs only when a pooled build is about to answer; a
  cold build needs no check because it just read the tree. On the Zed checkout it costs **9 ms**
  for 2,013 files — 1.2% of the 778 ms cold build — and detection-plus-rebuild after an edit is
  ~700 ms, once.
- `refresh: true` still forces a rebuild, and is now only needed to override a *policy* change
  (a different `excludeDirs`, say) rather than to pick up an edit.
- If a backend's `stat` reports no `version`, the build cannot be *proven* current, so the report
  falls back to the older age disclosure verbatim rather than asserting currency it cannot check:
  `index staleness: a negative below is final for that build, not for the tree as it is now`.

The verdict is still deliberately **not** downgraded to `inconclusive`: revalidation is the fix,
and the steady state — several questions with no edit in between — keeps its final negatives.

Reproduce the numbers with `node measure-revalidation.mjs`.

## Verified against GNU grep

`parity-check.mjs` is a differential over the whole vendored Zed checkout (2,013 files) against
an independently written grep oracle, on a deliberately hostile symbol set:

```
PASS  Focusable        impls(trait) grep=190/186 tool=190/186   defs grep=1 tool=1
PASS  Render           impls(trait) grep=431/373 tool=431/373
PASS  PickerDelegate   impls(trait) grep=54/54   tool=54/54
PASS  Context          defs grep=13 tool=13      impls(self) grep=7 tool=7
PASS  Entity           impls(self)  grep=78 tool=78  +6 inherent grep cannot see
PASS  NoSuchSymbolXYZ123  absent, and grep finds 0 word occurrences
RESULT: 12 pass, 0 fail
```

Three properties are checked: **completeness** (everything grep finds, the tool finds),
**soundness** (an `absent` verdict has zero word-boundary occurrences), and **self-side
parity**. Inherent impls are reported additively, because grep's `for NAME` pattern cannot
see `impl Window { … }` — which is nevertheless an impl of `Window`.

### The subtoken oracle

Subtoken resolution widens what a name query hits, and the property a widening can hurt is
soundness. It is therefore re-measured, not assumed. `parity-check.mjs` runs a second, always-on
oracle over `fixtures/subtoken/` — the committed convention tree — where every case is checked
against grep:

```
PASS  getUserById          -> get_user_by_id       subtoken-normalized  ·  grep-word-hits=0
PASS  listUserProfile      -> list_user_profile    subtoken-normalized  ·  grep-word-hits=0
PASS  listUserProfiles     -> list_user_profiles   subtoken-normalized  ·  grep-word-hits=0
PASS  http_fetcher         -> HttpFetcher          subtoken-normalized  ·  grep-word-hits=0
PASS  get_user_ids         -> null                 exact                ·  grep-word-hits=0
SUBTOKEN ORACLE RESULT: 20 pass, 0 fail  (20 cases)
```

A resolved convention pair must have **zero** grep definition rows under its own spelling — so
the tier was genuinely needed — and zero word hits besides. A name that is not token-equivalent
to anything must stay `absent` and grep must agree. Names one token apart must resolve to
different symbols, asserted against each other. And the same symbol reached both ways must not
move the impl-target set. Run against the previous revision the oracle reports 10 failures, so
it gates the change rather than describing it.

Both the tree and the symbol set are overridable, so the differential is not welded to one
machine's vendored checkout: `SYMBOL_INDEX_FIXTURE=<dir>` and `SYMBOL_INDEX_SYMBOLS=a,b,c`.
A missing path stays the plugin's hard error that reads nothing — pointing the harness at a
tree that does not exist fails loudly rather than comparing nothing against nothing.
`fixtures/subtoken/` is the committed tree that exercises naming-convention equivalence;
`fixture-replay.mjs` transcribes ground truth from one specific checkout, so against an
overridden fixture it runs only its tree-independent assertions and prints that the rest were
skipped rather than letting them pass silently.

Measured on the same inputs: cold index 0.7 s for 2,013 files, warm query ~0 ms, text scan
~110 ms.

## Honest limitations

- **Regex parsing, not a parser.** `impl … for …` inside a doc comment or string still
  produces a phantom impl; there is no lexer state. `quote!`/`macro_rules!` templates
  (`impl #impl_generics Trait for #type_name`) **are** detected, excluded from attribution and
  counted, so they cannot corrupt a target set.
- **Multi-line `impl` headers** are joined across up to 6 lines; headers longer than that are
  missed.
- **No semantic resolution.** A name shared by several modules resolves to all of them; the
  report does not claim which one a use refers to.
- **Subtoken hits under-report impls.** A symbol reached through the convention tier reports its
  definitions and no impl sites, because widening the impl set is what could corrupt the `expect`
  gate. Ask with the spelling that is actually defined to see the impls.
- **Revalidation costs one stat per indexed file.** 9 ms for 2,013 files, so it is paid on every
  warm call rather than only on a miss. It scales with the tree, and it is the price of never
  answering a negative from a build the tree has moved past.
- Impls for concrete types produced by a derive macro are not visible to a syntactic indexer.

## Measured and not landed: occurrence postings

`scanText` re-reads every indexed file for `mentions: true` and for every unresolved symbol's
negative check — 2,013 file reads per call on the Zed checkout, paid again on each call. A
postings index built during the walk (where the text is already in memory) would cut that to the
files that actually match. `measure-postings.mjs` builds that prototype and measures it; the
numbers and the reasoning are in [`MEASUREMENT-postings.md`](MEASUREMENT-postings.md).

The short version: postings with line numbers cost **+64.3 MB per index** — 53% on top of a
121.9 MB index, in a pool that holds up to eight of them — and the line numbers are data the
mention path never uses, because the count and the site text both come from re-reading the
candidate files anyway. So the specified design fails its own memory gate. Dropping the line
numbers costs +25.2 MB with no build-time regression and identical counts, but that is a
different change. Either way the win is ~100× on rare and absent needles and ~1.05× on ubiquitous
ones — in absolute terms about 100 ms per scan — against a rewrite of the code path whose whole
job is keeping a negative honest.

Both designs preserve the true substring count (`mentions.count` is not a token count): the
measurement reports **0 count mismatches** on every needle shape, including snake_case and a
path-qualified query.

## Configuration

Every cap is optional and overridable per row: `toolName`, `provideSearchTools`, `guidanceSection`, `roots`,
`include`, `excludeDirs`, `maxFiles`, `maxFileBytes`, `maxIndexEntries`, `indexTtlMs`,
`maxSitesPerSymbol`, `maxTargetNames`, `maxTextSites`, `maxMentionSites`, `maxOutputChars`,
`timeoutMs`. See `examples/preset-row.yml`.

The plugin declares `inject: ['tools', 'fs', 'systemPrompt']`, publishes no service, and
registers one tool plus one prompt section, so it needs no `isolate` realm.

## Install

```sh
# from a checkout
dsh plugin --profile <profile> add /path/to/dsh-tool-symbol-index
```

or link it into a profile the way this one is installed:

```json
// ~/.dsh/profiles/<profile>/package.json
{ "dependencies": { "dsh-tool-symbol-index": "link:/path/to/dsh-tool-symbol-index" } }
```

then reference it from a preset row by package name and restart DSH so the preset's standing
mount composes from the current bytes.

## License

MIT
