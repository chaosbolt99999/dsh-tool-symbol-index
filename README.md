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
| no re-walk cost | process-wide index pool; later questions are nearly free |
| **drop-in `grep`/`glob`** | opt-in replacements that keep the built-in call shapes but carry scope evidence |

Rust, TypeScript/JavaScript, Python and Go are indexed; the extension set is configurable.

## Replacing `grep` at the tool level

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
the reverse. `matchedOn: exact | path-segment-or-generic | case-insensitive` discloses which
form resolved, instead of silently presenting a last-segment hit as an exact one.

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
- Impls for concrete types produced by a derive macro are not visible to a syntactic indexer.

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
