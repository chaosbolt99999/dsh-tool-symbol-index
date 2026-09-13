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

A controlled A/B on an identical task then showed where the cost really was. `find_symbol`'s
own output was **9,180 of the arm's 110,484 characters** of tool output. Three *other* calls
produced 96,074 (**87%**): a 50,000-char `find | uniq -c` census, a 25,697-char
`grep 'Focusable for'`, and a 20,377-char mention grep. **Every one of them existed because of
a gap in the tool, not because of its output format.** This version closes those gaps.

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

Rust, TypeScript/JavaScript, Python and Go are indexed; the extension set is configurable.

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

## Status: known delivery issue on the reference deployment

The plugin code is complete and verified (see below), but on **one** DSH deployment it has not
yet been observed to reach an agent's tool catalog. The evidence, so nobody repeats it:

- a fresh child agent on a preset containing this row gets the plugin's **prompt section**
  (order 116) but **not** its tool;
- the plugin's own diagnostic confirms `ctx.tools.register()` returned normally;
- a separate control proves the mechanism works: disabling the `tool-bash` **package** row
  removed `bash` from the same child, so preset rows *do* deliver tools;
- the failure reproduces identically with the row as a relative file, an absolute path, and a
  package name; with a minimal hand-rolled probe tool registered from the same `apply()`; with
  and without `ctx.effect`; with a `~standard` `Config`, a minimal `Config` and no `Config`;
  with and without a `default` export; and across clean process restarts.

So the shape of the plugin matches the working package rows and the row form is not the
variable. What is left is the tool-registry layer/view path inside DSH, which needs debugging
harness-side. **Read the section above as "the plugin is correct", not "it is installed and
working"** — verify with one child agent asking for `find_symbol` before relying on it. The
most promising workaround, if you hit this, is to register the tool against the child's own
scope at composition time rather than from a preset row.

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

Every cap is optional and overridable per row: `toolName`, `guidanceSection`, `roots`,
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
