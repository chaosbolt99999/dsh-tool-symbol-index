/**
 * `symbol-index` — a preset-local Cordis plugin that answers symbol and text
 * questions in ONE call instead of a grep sweep.
 *
 * WHY THIS EXISTS. A `subagent-worker` child spent 394 greps and 238 steps
 * sweeping a vendored Zed checkout for an API it could not resolve, then re-ran
 * one byte-identical search 41 times because a stable negative read to it as an
 * incomplete lookup rather than as an answer. The unit of waste was the call:
 * each grep carried a full context re-send and returned raw text matches the
 * model could re-litigate. This tool changes the unit — many symbols per call,
 * and a VERDICT per symbol that says what was searched and that the answer is
 * final — and keeps an in-process index so the next question is nearly free.
 *
 * WHY v2 (measured, not assumed). A controlled A/B (identical task, identical
 * model, `scratch/ab/RESULTS.md`) found the tool correct but INCOMPLETE, and the
 * incompleteness — not the report format — was what cost tokens. Re-reading the
 * arm-B transcript call by call:
 *
 *   - 25,697 chars of raw grep (`Focusable for`) existed purely because the impl
 *     enumeration missed `impl gpui::Focusable for FocusOnlyModal`: the trait was
 *     indexed as `gpui::Focusable` and only ever compared against the literal
 *     `Focusable`, so every qualified-path impl was silently dropped (189/190).
 *   - 50,000 chars of `find … | uniq -c` existed because the report said "88
 *     indexed file(s) of this tree" without saying that `target/` had been pruned
 *     (127 .rs on disk, 88 searched). A negative that cannot name its scope is
 *     not trusted, so the agent went and measured the scope by hand.
 *   - The remaining greps existed because nothing reported the OTHER side of an
 *     impl: `impl <Trait> for <Symbol>` — which is exactly what `grep 'for X'`
 *     answers and what the tool returned as zero rows.
 *
 * The fix is therefore completeness and scope evidence, not terseness. Three
 * states are now distinguishable in the text, never by implication:
 *   (i)   hard error      — path missing: nothing was searched, and the message
 *                           names the nearest existing ancestor and candidates;
 *   (ii)  evidenced negative — "ABSENT in the N files searched", with the scope
 *                           stated once in the header and any limit that made the
 *                           answer unfinishable reported as `inconclusive`;
 *   (iii) match.
 * A negative verdict from ZERO ingested files, from a capped index, or with
 * unreadable files is never reported as `absent` — it is `inconclusive`.
 *
 * CONTRACT CONSTRAINTS THIS FILE MUST KEEP (all three are load-bearing):
 *  1. NO IMPORTS. A preset-local plugin loads under the bare Node ESM loader
 *     with only lossless-JS values crossing it, so this file imports nothing —
 *     including no `node:` builtins. All I/O goes through `ctx.fs`.
 *  2. HAND-ROLLED `Config`. No schemastery import either: the schema is the
 *     `~standard` validate object cordis reads, and it returns `{ value }` or
 *     `{ issues: [{ message, path }] }`.
 *  3. The executed VALUE must satisfy `output.schema` exactly — the registry
 *     validates it (`validateJsonSchemaValue`), and the schema declares
 *     `additionalProperties: false`, so no field may be smuggled onto it for
 *     `render` to read later. `render` reconstructs the report from the value
 *     alone. Every node carrying `enum`/`items`/`properties`/`required`/
 *     `additionalProperties` must ALSO declare `type` or the mount fails with
 *     "… requires type or oneOf" (see RESTART-NOTES.md).
 *
 * A hand-rolled tool also gets NO argument validation from the registry
 * (`defineTool`'s wrapper is where that normally happens), so `execute()`
 * validates its own arguments and throws ordinary Errors with actionable text.
 *
 * Byte-identical copies of this file are kept in every user-authored preset
 * directory, because a preset-local plugin resolves relative to its own
 * `agent.cordis.yml`. Keep the copies byte-identical.
 */

const name = 'preset-symbol-index'

/** Host registries this row contributes to. All are host-plane singletons. */
const inject = ['tools', 'fs', 'systemPrompt']

/** Guidance section name, registered in the tool-guidance band (order 116). */
const SECTION_NAME = 'preset:symbol-index:guidance'

/** Bumped whenever the report contract changes; reported in the register log. */
const VERSION = 2

/**
 * Extension -> language family. The family selects the definition table below.
 * An extension absent here is never indexed; a verdict names the set it searched.
 */
const LANGUAGE_BY_EXTENSION = {
  '.rs': 'rust',
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
}

/** Default extension allow-list; a call may override it via `include`. */
const DEFAULT_INCLUDE = Object.keys(LANGUAGE_BY_EXTENSION)

/**
 * Directories pruned during the walk (matched by basename, at any depth).
 * Pruning is reported, never silent: a verdict says which names were pruned so
 * the caller can judge whether the omission matters, and `includeExcluded`
 * searches them anyway.
 */
const DEFAULT_EXCLUDE_DIRS = [
  '.git', '.hg', '.svn', 'node_modules', 'target', 'dist', 'build', 'out',
  '.venv', 'venv', '__pycache__', '.next', '.cache', '.tox', '.mypy_cache',
  '.pytest_cache', 'vendor', '.idea', '.vscode', '.gradle',
]

/** Default caps. Every one is overridable through the row's config. */
const DEFAULT_CAPS = {
  maxFiles: 20000,
  maxFileBytes: 2000000,
  maxIndexEntries: 300000,
  indexTtlMs: 600000,
  maxSitesPerSymbol: 12,
  maxTargetNames: 400,
  maxTextSites: 60,
  maxMentionSites: 12,
  maxOutputChars: 14000,
  timeoutMs: 30000,
}

/**
 * Definition patterns, per language family. Each entry is a regex with a named
 * `name` group and a `kind` label; the table lives in one place so it stays
 * auditable. Patterns are deliberately conservative: a false "defined" is worse
 * than a miss, because a miss still falls through to the mention scan.
 */
const DEFINITION_TABLE = {
  rust: [
    { kind: 'trait', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'struct', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?struct\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'enum', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?enum\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'union', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?union\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'fn', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'mod', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'type', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'const', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?const\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*:/ },
    { kind: 'static', re: /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?static\s+(?:mut\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*:/ },
    { kind: 'macro', re: /^\s*macro_rules!\s*(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
  ],
  ts: [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'interface', re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'type', re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'enum', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/ },
  ],
  py: [
    { kind: 'class', re: /^\s*class\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'def', re: /^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
  ],
  go: [
    { kind: 'func', re: /^\s*func\s+(?:\([^)]*\)\s*)?(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
    { kind: 'type', re: /^\s*type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)/ },
  ],
}

/**
 * Kind ranking for rendering: the kinds that DEFINE an addressable type come
 * first, so the most useful site is the one the caller reads first. (Aider's
 * repo map ranks by reference in-degree; this is the cheap kind-axis half.)
 */
const KIND_RANK = {
  trait: 0, struct: 0, enum: 0, union: 0, class: 0, interface: 0,
  type: 0, mod: 1, module: 1,
  fn: 2, function: 2, def: 2, func: 2, method: 2,
  const: 3, static: 3, macro: 3,
}

/** Cap one stored source line so the index stays bounded. */
const MAX_LINE_TEXT = 200

/**
 * A macro metavariable in a type position (`#type_name`, `$t`). A `quote!` body
 * or a `macro_rules!` arm contains text like
 *   impl #impl_generics gpui::VisualContext for #type_name #type_generics
 * which is a TEMPLATE, not an impl of any named type. Folding it into the target
 * set corrupts the answer (`#type_name #type_generics #where_clause` is not a
 * type), and silently dropping it hides that the tree contains generated impls.
 * They are therefore excluded from attribution and COUNTED in the report.
 */
const METAVARIABLE_RE = /(?:#|\$)[A-Za-z_]/

/** How many pruned directory names and unsearched extensions a report names. */
const MAX_REPORTED_NAMES = 10

/** How many continuation lines a multi-line `impl` header may span. */
const MAX_IMPL_HEADER_LINES = 6

/** Check one raw config value against this plugin's contract. */
function validateConfig(config) {
  if (typeof config !== 'object' || config === null) {
    return { issues: [{ message: 'config must be a map of keys', path: [] }] }
  }
  const issues = []
  const requireStringArray = (value, key) => {
    if (value === undefined) return
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
      issues.push({ message: key + ' must be an array of strings', path: [key] })
    }
  }
  if (config.toolName !== undefined && (typeof config.toolName !== 'string' || config.toolName === '')) {
    issues.push({ message: 'toolName must be a non-empty string', path: ['toolName'] })
  }
  if (config.guidanceSection !== undefined && typeof config.guidanceSection !== 'boolean') {
    issues.push({ message: 'guidanceSection must be a boolean', path: ['guidanceSection'] })
  }
  requireStringArray(config.roots, 'roots')
  requireStringArray(config.include, 'include')
  requireStringArray(config.excludeDirs, 'excludeDirs')
  for (const key of Object.keys(DEFAULT_CAPS)) {
    const value = config[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      issues.push({ message: key + ' must be a positive finite number', path: [key] })
    }
  }
  if (issues.length > 0) return { issues }
  const value = {
    toolName: config.toolName === undefined ? 'find_symbol' : config.toolName,
    roots: config.roots === undefined ? [] : config.roots.slice(),
    include: config.include === undefined ? DEFAULT_INCLUDE.slice() : config.include.slice(),
    excludeDirs: config.excludeDirs === undefined
      ? DEFAULT_EXCLUDE_DIRS.slice()
      : config.excludeDirs.slice(),
    guidanceSection: config.guidanceSection !== false,
  }
  for (const key of Object.keys(DEFAULT_CAPS)) {
    value[key] = config[key] === undefined ? DEFAULT_CAPS[key] : config[key]
  }
  return { value }
}

/** Standard-schema view of this plugin's config contract (see validateConfig). */
const Config = {
  '~standard': {
    version: 1,
    vendor: 'preset-symbol-index',
    validate: validateConfig,
  },
}

/** Lowercased extension of a path; '' when there is none. */
function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** Basename of a path. */
function baseNameOf(path) {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Directory part of a path; '' when there is none. */
function dirNameOf(path) {
  return path.slice(0, path.lastIndexOf('/'))
}

/** Join a directory path and a child name without doubling separators. */
function joinPath(dir, child) {
  return dir.endsWith('/') ? dir + child : dir + '/' + child
}

/** Whether a path contains an upward `..` segment. */
function hasParentSegment(path) {
  return path.split('/').includes('..')
}

/** Trim and cap one stored source line. */
function lineText(line) {
  const trimmed = line.trim()
  return trimmed.length > MAX_LINE_TEXT ? trimmed.slice(0, MAX_LINE_TEXT) + '\u2026' : trimmed
}

/** Collapse runs of whitespace into single spaces. */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** Whether a chunk of text looks binary (a NUL byte in the inspection window). */
function looksBinary(head) {
  for (let index = 0; index < head.length; index += 1) {
    if (head.charCodeAt(index) === 0) return true
  }
  return false
}

/**
 * Last-resort working directory when the executing agent carries none. This
 * file imports nothing, so `process` is read defensively: the global exists in
 * a Node preset-local module but not in every host this plugin can be mounted
 * into, and a missing root must degrade rather than throw.
 */
function fallbackCwd() {
  try {
    if (typeof process !== 'undefined' && process !== null && typeof process.cwd === 'function') {
      return process.cwd()
    }
  } catch (error) {
    return '/'
  }
  return '/'
}

/** Count non-overlapping occurrences of a literal name in a line. */
function countOccurrences(line, needle) {
  let count = 0
  let from = 0
  for (;;) {
    const at = line.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/** Add `count` to one counter. */
function bump(map, key, count) {
  if (key === '') return
  map.set(key, (map.get(key) === undefined ? 0 : map.get(key)) + count)
}

// ---------------------------------------------------------------------------
// Name normalisation
//
// The incident this tool exists for turned on one comparison: the tree contains
// `impl gpui::Focusable for FocusOnlyModal`, and the tool stored the trait as
// the literal string `gpui::Focusable` and compared it to `Focusable`. Every
// qualified-path impl in the tree was indexed and then never attributed.
//
// universal-ctags solves the same problem by keeping only the last identifier
// before `for`/`<`/`{` (`parseQualifiedType`, whose comment says so outright),
// and tree-sitter-rust solves it by not solving it: its `impl_item trait:
// (type_identifier)` capture cannot match a `scoped_identifier` at all. Keeping
// only the last segment is false-negative-free but false-positive-prone; keeping
// only the full path is the reverse. This stores BOTH — the written path is the
// canonical row and the last segment is an alias — and DISCLOSES which form
// matched, so a last-segment hit is never silently presented as an exact one.
// ---------------------------------------------------------------------------

/** Index just past the balanced `<…>` group starting at `from`, ignoring `->`. */
function skipGenerics(text, from) {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '<') { depth += 1; continue }
    if (ch !== '>') continue
    if (text[index - 1] === '-') continue
    depth -= 1
    if (depth === 0) return index + 1
  }
  return text.length
}

/** Whether an index sits on a word boundary in `text`. */
function atWordBoundary(text, index, length) {
  const before = index === 0 ? '' : text[index - 1]
  const after = index + length >= text.length ? '' : text[index + length]
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)
}

/** The `where` keyword at bracket depth 0, at or after `from`; -1 when absent. */
function findWhereClause(text, from) {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '<' || ch === '(' || ch === '[') { depth += 1; continue }
    if (ch === '>' || ch === ')' || ch === ']') {
      if (depth > 0 && !(ch === '>' && text[index - 1] === '-')) depth -= 1
      continue
    }
    if (depth !== 0) continue
    if (ch === 'w' && text.startsWith('where', index) && atWordBoundary(text, index, 5)) return index
  }
  return -1
}

/** The `for` keyword at bracket depth 0, surrounded by spaces; -1 when absent. */
function findForKeyword(text, from) {
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '<' || ch === '(' || ch === '[') { depth += 1; continue }
    if (ch === '>' || ch === ')' || ch === ']') {
      if (depth > 0 && !(ch === '>' && text[index - 1] === '-')) depth -= 1
      continue
    }
    if (depth !== 0 || ch !== 'f') continue
    if (!text.startsWith('for', index)) continue
    // `for<'a>` is a higher-ranked bound, never the impl separator, so require
    // whitespace on both sides rather than a mere word boundary.
    if (text[index - 1] !== ' ' || text[index + 3] !== ' ') continue
    return index
  }
  return -1
}

/** Cut a type expression at the top-level `where`, `{` or `;` that ends it. */
function cutTypeTail(text) {
  const whereAt = findWhereClause(text, 0)
  let limit = whereAt === -1 ? text.length : whereAt
  let depth = 0
  for (let index = 0; index < limit; index += 1) {
    const ch = text[index]
    if (ch === '<' || ch === '(' || ch === '[') { depth += 1; continue }
    if (ch === '>' || ch === ')' || ch === ']') {
      if (depth > 0 && !(ch === '>' && text[index - 1] === '-')) depth -= 1
      continue
    }
    if (depth === 0 && (ch === '{' || ch === ';')) { limit = index; break }
  }
  return text.slice(0, limit).trim()
}

/** Remove every balanced `<…>` group from a type expression. */
function stripGenerics(text) {
  let out = ''
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]
    if (ch === '<') { depth += 1; continue }
    if (ch === '>' && depth > 0) {
      if (text[index - 1] === '-') { if (depth === 0) out += ch; continue }
      depth -= 1
      continue
    }
    if (depth === 0) out += ch
  }
  return out
}

/** The last `::`-separated segment of a path. */
function lastSegment(text) {
  const at = text.lastIndexOf('::')
  return at === -1 ? text : text.slice(at + 2)
}

/**
 * Every form of a written type/trait name that should resolve to the same
 * symbol: as written, without generics, and the last path segment of each.
 * @returns a Set of non-empty names, most specific first (Set preserves order).
 */
function nameVariants(raw) {
  const variants = new Set()
  let text = String(raw).trim()
  for (let round = 0; round < 4; round += 1) {
    const before = text
    text = text.replace(/^&(?:\s*'[A-Za-z_][A-Za-z0-9_]*)?\s*(?:mut\s+)?/, '')
    text = text.replace(/^(?:dyn|impl)\s+/, '')
    if (text === before) break
  }
  const add = (value) => {
    const trimmed = String(value).trim()
    if (trimmed !== '') variants.add(trimmed)
  }
  add(raw)
  add(text)
  const bare = stripGenerics(text).trim()
  add(bare)
  add(lastSegment(text))
  add(lastSegment(bare))
  return variants
}

/**
 * Parse a Rust `impl` header.
 *
 * Grammar followed (universal-ctags `parsers/rust.c`):
 *   "impl" [<type_bounds>] [!] <qualified_ident>[<type_bounds>]
 *          ["for" <qualified_ident>[<type_bounds>]] ["where" …] ("{" | ";")
 *
 * `header` must be whitespace-collapsed and start at the `impl` keyword. Angle
 * brackets are skipped by DEPTH, never by `[^>]*`, because `Fn() -> Vec<u8>`
 * contains a `>` that closes nothing.
 * @returns `{ traitName, forType, negative, inherent }` or null.
 */
function parseRustImplHeader(header) {
  const implAt = header.indexOf('impl')
  if (implAt === -1) return null
  let index = implAt + 4
  while (header[index] === ' ') index += 1
  if (header[index] === '<') index = skipGenerics(header, index)
  while (header[index] === ' ') index += 1
  let negative = false
  if (header[index] === '!') {
    negative = true
    index += 1
    while (header[index] === ' ') index += 1
  }
  const forAt = findForKeyword(header, index)
  const traitName = forAt === -1 ? '' : collapse(header.slice(index, forAt))
  const typeStart = forAt === -1 ? index : forAt + 3
  const forType = cutTypeTail(header.slice(typeStart))
  if (forType === '') return null
  return {
    traitName: traitName.replace(/^!/, '').trim(),
    forType,
    negative,
    inherent: forAt === -1,
  }
}

/**
 * The full `impl` header beginning on `lines[at]`, joined across continuation
 * lines until the opening brace or the terminator. rustfmt wraps long headers
 * routinely, so a single-line pattern misses real impls.
 * @returns `{ text, span }` where span is how many lines were consumed.
 */
function collectImplHeader(lines, at) {
  let text = lines[at]
  let span = 0
  while (span < MAX_IMPL_HEADER_LINES && !/[;{]/.test(text) && at + span + 1 < lines.length) {
    span += 1
    text += ' ' + lines[at + span]
  }
  return { text: collapse(text), span }
}

/**
 * Extract definitions, trait impls, and mention counts from one file's text.
 * @returns `{ definitions, impls, mentions }` — mentions is a name -> count map.
 */
function scanSource(text, language, relativePath) {
  const definitions = []
  const impls = []
  const templates = []
  const mentions = new Map()
  const table = DEFINITION_TABLE[language]
  if (table === undefined) return { definitions, impls, templates, mentions }
  const implStart = language === 'rust'
    ? /^\s*(?:unsafe\s+|default\s+|const\s+)*impl\b/
    : null
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    if (implStart !== null && implStart.test(line)) {
      const header = collectImplHeader(lines, index)
      if (METAVARIABLE_RE.test(header.text)) {
        templates.push({ path: relativePath, line: lineNumber, text: lineText(header.text) })
        index += header.span
        continue
      }
      const parsed = parseRustImplHeader(header.text)
      if (parsed !== null) {
        impls.push({
          path: relativePath,
          line: lineNumber,
          trait: parsed.traitName,
          forType: parsed.forType,
          negative: parsed.negative,
          inherent: parsed.inherent,
          text: lineText(line),
        })
        if (!parsed.inherent) bump(mentions, lastSegment(parsed.traitName), 1)
        bump(mentions, lastSegment(parsed.forType), 1)
        index += header.span
        continue
      }
    }
    for (const entry of table) {
      const match = entry.re.exec(line)
      if (match === null) continue
      const symbol = match.groups === undefined ? undefined : match.groups.name
      if (symbol === undefined || symbol === '') continue
      definitions.push({
        path: relativePath,
        line: lineNumber,
        kind: entry.kind,
        name: symbol,
        text: lineText(line),
      })
      bump(mentions, symbol, 1)
      break
    }
  }
  return { definitions, impls, templates, mentions }
}

/** Sort definitions so the kinds that define an addressable type come first. */
function compareDefinitions(left, right) {
  const leftRank = KIND_RANK[left.kind] === undefined ? 4 : KIND_RANK[left.kind]
  const rightRank = KIND_RANK[right.kind] === undefined ? 4 : KIND_RANK[right.kind]
  if (leftRank !== rightRank) return leftRank - rightRank
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return left.line - right.line
}

/**
 * Resolve one requested name against the index.
 *
 * Both sides of every `impl` are resolved, because they answer different
 * questions and grep answers both: `impls` are the impls whose TRAIT is this
 * symbol ("what implements X") and `implsFor` are the impls whose SELF TYPE is
 * this symbol ("what does X implement"). v1 answered only the first, and only
 * for unqualified trait names, so `grep 'for FocusOnlyModal'` returned 4 rows
 * where the tool returned 0.
 *
 * @returns the resolution record consumed by {@link verdictOf}.
 */
function resolveSymbol(index, requested) {
  const variants = [...nameVariants(requested)]
  let matchedName = requested
  let matchedOn = 'exact'
  let definitions = index.definitionsByVariant.get(requested)
  if (definitions === undefined) {
    definitions = []
    for (const variant of variants) {
      const hit = index.definitionsByVariant.get(variant)
      if (hit !== undefined && hit.length > 0) {
        definitions = hit
        matchedName = variant
        matchedOn = 'path-segment-or-generic'
        break
      }
    }
  }
  if (definitions.length === 0) {
    const hit = index.definitionsByLower.get(requested.toLowerCase())
    if (hit !== undefined && hit.length > 0) {
      definitions = hit
      matchedName = hit[0].name
      matchedOn = 'case-insensitive'
    }
  }
  const seenTrait = new Set()
  const traitImpls = []
  for (const variant of variants) {
    for (const impl of index.implsByTrait.get(variant) === undefined ? [] : index.implsByTrait.get(variant)) {
      if (seenTrait.has(impl)) continue
      seenTrait.add(impl)
      traitImpls.push(impl)
    }
  }
  const seenFor = new Set()
  const selfImpls = []
  for (const variant of variants) {
    for (const impl of index.implsByFor.get(variant) === undefined ? [] : index.implsByFor.get(variant)) {
      if (seenFor.has(impl)) continue
      seenFor.add(impl)
      selfImpls.push(impl)
    }
  }
  return {
    requested,
    matchedName,
    matchedOn,
    definitions: definitions.slice().sort(compareDefinitions),
    traitImpls,
    selfImpls,
    indexedMentions: index.mentions.get(matchedName) === undefined ? 0 : index.mentions.get(matchedName),
    textScan: null,
    scannedFiles: index.files,
    coverage: '',
  }
}

/** Collapse a definition/impl list into the complete sorted set of names. */
function targetNames(entries, key, cap) {
  const names = []
  const seen = new Set()
  for (const entry of entries) {
    const value = entry[key]
    if (value === '' || value === undefined || seen.has(value)) continue
    seen.add(value)
    names.push(value)
  }
  names.sort()
  return { names: names.slice(0, cap), total: names.length }
}

/**
 * Final status + verdict prose for one resolution, after any mention text scan.
 * The verdict states the finding and its finality; the SCOPE it is final for is
 * stated once per report, not repeated per symbol.
 */
function verdictOf(resolution, index) {
  const parts = []
  const name = resolution.matchedName
  const implCount = resolution.traitImpls.length
  if (resolution.definitions.length > 0) {
    const kinds = [...new Set(resolution.definitions.map(entry => entry.kind))].join('/')
    const first = resolution.definitions[0]
    parts.push('DEFINED ' + first.path + ':' + first.line + ' (' + kinds + ')'
      + (resolution.definitions.length > 1
        ? ' +' + (resolution.definitions.length - 1) + ' more site(s)'
        : ''))
    if (implCount > 0) {
      // State BOTH counts and their relationship in one clause: a bare
      // "190 impl(s)" beside a 186-name list is what read as a cap.
      const uniqueTargets = new Set(resolution.traitImpls.map(entry => entry.forType)).size
      parts.push(implCount + ' impl site(s) across ' + uniqueTargets
        + ' unique target type(s) (a generic type may be implemented at several sites)')
    }
    if (resolution.selfImpls.length > 0) {
      const uniqueTraits = new Set(resolution.selfImpls.map(entry => entry.trait)).size
      parts.push('this type has ' + resolution.selfImpls.length + ' impl(s) of '
        + uniqueTraits + ' distinct trait(s)')
    }
    if (resolution.matchedOn === 'path-segment-or-generic') {
      parts.push('resolved via the last path segment/generic-stripped form of "'
        + resolution.requested + '", not an exact name match')
    } else if (resolution.matchedOn === 'case-insensitive') {
      parts.push('matched case-insensitively as "' + name + '"')
    }
    return { status: 'defined', verdict: parts.join('; ') }
  }
  if (implCount > 0) {
    return {
      status: 'impls-only',
      verdict: 'NO definition of "' + name + '" in the searched files, but ' + implCount
        + ' impl(s) of a trait with this name exist, so it is a trait defined outside this tree'
        + ' (or behind a pruned path)',
    }
  }
  if (resolution.selfImpls.length > 0) {
    return {
      status: 'impls-only',
      verdict: 'NO definition of "' + name + '" in the searched files, but it is the self type of '
        + resolution.selfImpls.length + ' impl(s), so it is a type defined outside this tree'
        + ' (or behind a pruned path)',
    }
  }
  const scan = resolution.textScan
  if (scan !== null && scan.count > 0) {
    return {
      status: 'mentions-only',
      verdict: 'NO definition in the searched files; a text scan of those same files found '
        + scan.count + ' textual mention(s), so this name is used/imported/bound here but not defined here',
    }
  }
  if (index.partial) {
    return {
      status: 'inconclusive',
      verdict: 'NOT FOUND — but this is NOT a final negative: ' + index.partialReason
        + '. Re-run with a narrower path, a raised cap, or the offending path removed from `excludeDirs`'
        + ' before treating this name as absent',
    }
  }
  return {
    status: 'absent',
    verdict: 'ABSENT — no definition, no impl, and no textual mention of "' + name
      + '" anywhere in the ' + index.files + ' file(s) searched (scope above). This negative is final',
  }
}

/**
 * Process-level index pool, keyed by `root\u0000extensions`.
 *
 * Deliberately MODULE scope, not per-mount: a preset is mounted once per agent,
 * so a closure-local cache would rebuild the same tree for every subagent and
 * for every crew role in sequence. One pool per process means a worker's second
 * question — and a sibling agent's first — costs no walk at all. Entries are
 * dropped on the `indexTtlMs` window and bounded by `MAX_POOL_ENTRIES` so a long
 * process cannot accumulate trees without limit.
 */
const INDEX_POOL = new Map()
const INDEX_INFLIGHT = new Map()
const MAX_POOL_ENTRIES = 8

/**
 * The pool key for one (root, indexing policy) pair. Every cap that changes what
 * an index CONTAINS must be part of the key: two mounts configured with a
 * different `maxFileBytes` or `include` set describe different indexes, and
 * keying on the root alone would silently serve one mount another's index.
 */
function indexKey(rootPath, include, caps, config, includeExcluded) {
  return JSON.stringify([
    rootPath,
    include.slice().sort(),
    config.excludeDirs.slice().sort(),
    caps.maxFiles,
    caps.maxFileBytes,
    caps.maxIndexEntries,
    includeExcluded === true,
  ])
}

/**
 * Drop the least recently used pool entry when the pool is over its bound.
 * Map iteration order is insertion order, and every reuse re-inserts, so the
 * first key is the least recently used.
 */
function trimPool() {
  while (INDEX_POOL.size > MAX_POOL_ENTRIES) {
    const oldest = INDEX_POOL.keys().next()
    if (oldest.done === true) return
    INDEX_POOL.delete(oldest.value)
  }
}

/**
 * The explicit contradiction answer: does `expect` appear among this symbol's
 * impl targets? This is the clause that ended the incident's 41-step loop — the
 * model was trying to establish "there is no impl for Context", and this states
 * it rather than leaving it to be inferred from a list.
 */
function expectAnswer(impls, expect) {
  const wanted = new Set([...nameVariants(expect)])
  const candidates = new Set()
  for (const impl of impls) {
    candidates.add(impl.forType)
    candidates.add(lastSegment(impl.forType))
  }
  for (const candidate of candidates) {
    for (const variant of nameVariants(candidate)) {
      if (wanted.has(variant)) {
        return 'YES — ' + expect + ' IS among the impl targets above'
      }
    }
  }
  const listed = [...candidates].length === 0 ? 'none' : [...candidates].slice(0, 20).join(', ')
  return 'NO — ' + expect + ' is NOT an impl target here (impl targets: ' + listed
    + (candidates.size > 20 ? ', +' + (candidates.size - 20) + ' more' : '') + ')'
}

/**
 * Describe the index's coverage as evidence, so a negative can be trusted.
 * Three things are stated: what was read, what was deliberately not read, and
 * whether any LIMIT (as opposed to a policy) made the answer unfinishable. Only
 * the last of those turns a not-found into `inconclusive`; a reported policy
 * omission stays a final `absent`, because the caller can see and override it.
 * @returns `{ text, partial, partialReason }`
 */
function coverageOf(index) {
  const limits = []
  if (index.files === 0) {
    limits.push('no file under this path matched the extension allow-list, so NOTHING was searched')
  }
  if (index.truncated) {
    limits.push('the walk stopped at a cap, so part of the tree was never read')
  }
  if (index.unreadable > 0) limits.push(index.unreadable + ' file(s) could not be read')
  if (index.binary > 0) limits.push(index.binary + ' file(s) looked binary and were skipped')
  if (index.oversize > 0) limits.push(index.oversize + ' file(s) exceeded maxFileBytes')
  const partial = limits.length > 0
  const parts = []
  parts.push(index.files + ' file(s) searched')
  if (index.skipped > 0) parts.push(index.skipped + ' skipped')
  if (index.prunedDirs > 0) {
    parts.push(index.prunedDirs + ' dir(s) pruned by policy ('
      + index.prunedNames.join(', ') + ')' + (index.prunedCapped ? ' …' : ''))
  }
  if (partial) {
    return {
      text: 'INCOMPLETE — ' + parts.join('; ') + '. LIMIT: ' + limits.join('; ')
        + '. A "not found" here is NOT final',
      partial: true,
      partialReason: limits.join('; '),
    }
  }
  return {
    text: 'complete — ' + parts.join('; ')
      + '. Every allow-listed file under this root was read, so a "not found" here is final',
    partial: false,
    partialReason: '',
  }
}

/**
 * Build the tool definition. Caps arrive per mount; the index pool is shared
 * process-wide (see {@link INDEX_POOL}).
 */
function buildTool(ctx, caps, config) {
  /** Rank candidate names against a target basename for the missing-path error. */
  function rankCandidates(target, names) {
    const lowered = target.toLowerCase()
    const scored = []
    for (const candidate of names) {
      const name = candidate.toLowerCase()
      let score = 0
      if (name === lowered) score = 100
      else if (name.startsWith(lowered) || lowered.startsWith(name)) score = 60
      else if (name.includes(lowered) || lowered.includes(name)) score = 40
      else {
        let shared = 0
        while (shared < name.length && shared < lowered.length && name[shared] === lowered[shared]) shared += 1
        score = shared >= 3 ? shared : 0
      }
      if (score > 0) scored.push({ candidate, score })
    }
    scored.sort((left, right) => (right.score - left.score) || (left.candidate < right.candidate ? -1 : 1))
    return scored.slice(0, 8).map(entry => entry.candidate)
  }

  /**
   * Resolve the search root for one call; enforces the containment rule.
   *
   * A missing path is a HARD ERROR that says nothing was searched — never a
   * silent negative, and never a bare "cannot resolve". The message names the
   * nearest existing ancestor and the candidates sitting in it, because the
   * failure this replaces is an agent guessing a filename, getting nothing
   * readable back, and guessing again.
   */
  async function resolveRoot(ctx, rawPath, cwd, signal) {
    const requested = rawPath === undefined ? cwd : rawPath
    const candidates = [requested].concat(config.roots)
    let lastError
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '' || hasParentSegment(candidate)) continue
      try {
        const target = await ctx.fs.resolve(candidate, { cwd, signal })
        const info = await ctx.fs.stat(target, signal)
        if (info === undefined) { lastError = new Error('no such path'); continue }
        const rootPath = ctx.fs.processPath(target)
        if (info.type !== 'directory' && info.type !== 'file') {
          lastError = new Error('exists but is neither a file nor a directory (' + info.type + ')')
          continue
        }
        return { target, rootPath, kind: info.type }
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(await describeMissingRoot(ctx, requested, cwd, lastError, signal))
  }

  /** Build the actionable text for a root that could not be resolved. */
  async function describeMissingRoot(ctx, requested, cwd, lastError, signal) {
    const lines = ['find_symbol: NOTHING WAS SEARCHED — ' + JSON.stringify(requested)
      + ' could not be resolved to a readable file or directory.']
    if (typeof requested === 'string' && requested === '') {
      lines.push('  `path` was an empty string. Omit it to use the session working directory '
        + '(' + cwd + ').')
      return lines.join('\n')
    }
    for (const candidate of config.roots) {
      lines.push('  configured fallback root ' + JSON.stringify(candidate) + ' did not resolve either.')
    }
    // Walk up to the nearest ancestor that does exist and list what is in it.
    if (typeof requested === 'string' && requested !== '') {
      const absolute = requested.startsWith('/') ? requested : joinPath(cwd, requested)
      let probe = dirNameOf(absolute) === '' ? '/' : dirNameOf(absolute)
      const missingTail = [baseNameOf(absolute)]
      for (let depth = 0; depth < 12 && probe !== '' && probe !== '/'; depth += 1) {
        let target
        let info
        try {
          target = await ctx.fs.resolve(probe, { signal })
          info = await ctx.fs.stat(target, signal)
        } catch (error) {
          info = undefined
        }
        if (info !== undefined && info.type === 'directory') {
          lines.push('  nearest existing directory: ' + probe
            + '  (you asked for ' + missingTail.join('/') + ' below it, which does not exist)')
          try {
            const entries = await ctx.fs.listDir(target, signal)
            const ranked = rankCandidates(missingTail[0], entries.map(entry => entry.name))
            if (ranked.length > 0) {
              lines.push('  closest names in it: ' + ranked.join(', '))
            }
            // Listing a huge directory is noise; the count plus the directories
            // is what tells the caller whether it is even looking in the right
            // place, which is the whole point of this message.
            const directories = entries.filter(entry => entry.type === 'directory')
            if (entries.length <= MAX_REPORTED_NAMES * 4) {
              lines.push('  it contains ' + entries.length + ' entr(ies): '
                + entries.slice(0, 40).map(entry => entry.name + (entry.type === 'directory' ? '/' : ''))
                  .join(', ') + (entries.length > 40 ? ', …' : ''))
            } else {
              lines.push('  it contains ' + entries.length + ' entries, of which '
                + directories.length + ' are directories: '
                + directories.slice(0, MAX_REPORTED_NAMES).map(entry => entry.name + '/').join(', ')
                + (directories.length > MAX_REPORTED_NAMES ? ', …' : ''))
            }
          } catch (error) {
            lines.push('  (it could not be listed: ' + String(error) + ')')
          }
          break
        }
        missingTail.unshift(baseNameOf(probe))
        const parent = dirNameOf(probe)
        if (parent === probe) break
        probe = parent === '' ? '/' : parent
      }
    }
    if (typeof requested === 'string' && !requested.includes('/') && !requested.includes('.')) {
      lines.push('  "' + requested + '" looks like a SYMBOL NAME, not a path. If you meant to locate a'
        + ' symbol, pass it in `symbols` and give `path` the directory to search.')
    }
    lines.push('  No index was built and no file was read. Re-run with an existing path;'
      + ' omit `path` to search the session working directory (' + cwd + ').')
    if (lastError !== undefined && lastError.message !== 'no such path') {
      lines.push('  underlying error: ' + String(lastError && lastError.message ? lastError.message : lastError))
    }
    return lines.join('\n')
  }

  /** Walk and parse one root, single-flighted per key. */
  async function buildIndex(ctx, rootTarget, rootKind, rootPath, include, includeExcluded, signal, effectiveConfig) {
    const key = indexKey(rootPath, include, caps, effectiveConfig, includeExcluded)
    const cached = INDEX_POOL.get(key)
    if (cached !== undefined && Date.now() - cached.builtAtMs <= caps.indexTtlMs) {
      return { index: cached, reused: true }
    }
    const running = INDEX_INFLIGHT.get(key)
    if (running !== undefined) return { index: await running, reused: true }
    const build = (async () => {
      const started = Date.now()
      const index = {
        // The id names the revision the verdict is final for; the caps suffix
        // distinguishes two mounts that index the same root under different
        // policies, so a report can never be read as the other one's answer.
        id: baseNameOf(rootPath) + '@' + started
          + (caps.maxFileBytes === DEFAULT_CAPS.maxFileBytes ? '' : '/mb' + caps.maxFileBytes)
          + (caps.maxFiles === DEFAULT_CAPS.maxFiles ? '' : '/mf' + caps.maxFiles),
        cacheKey: key,
        rootPath,
        builtAtMs: started,
        files: 0,
        skipped: 0,
        unreadable: 0,
        oversize: 0,
        binary: 0,
        truncated: false,
        definitions: [],
        impls: [],
        templates: [],
        mentions: new Map(),
        filePaths: [],
        census: new Map(),
        prunedNames: [],
        prunedDirCount: 0,
        prunedCapped: false,
      }
      const prunedSeen = new Set()
      const queue = [rootTarget]
      const relativeOf = new Map([[rootTarget.targetKey, '']])
      while (queue.length > 0) {
        if (index.files + index.skipped >= caps.maxFiles) { index.truncated = true; break }
        if (signal !== undefined && signal.aborted) throw new Error('find_symbol: aborted while indexing')
        const target = queue.shift()
        const relative = relativeOf.get(target.targetKey)
        let info
        try {
          info = await ctx.fs.stat(target, signal)
        } catch (error) {
          index.skipped += 1
          index.unreadable += 1
          continue
        }
        if (info === undefined) { index.skipped += 1; index.unreadable += 1; continue }
        if (info.type === 'directory') {
          let entries
          try {
            entries = await ctx.fs.listDir(target, signal)
          } catch (error) {
            index.skipped += 1
            index.unreadable += 1
            continue
          }
          for (const entry of entries) {
            const childRelative = relative === '' ? entry.name : relative + '/' + entry.name
            if (entry.type === 'directory') {
              if (includeExcluded !== true && effectiveConfig.excludeDirs.includes(entry.name)) {
                index.prunedDirCount += 1
                if (!prunedSeen.has(entry.name)) {
                  prunedSeen.add(entry.name)
                  if (index.prunedNames.length < MAX_REPORTED_NAMES) index.prunedNames.push(entry.name)
                  else index.prunedCapped = true
                }
                continue
              }
              relativeOf.set(entry.target.targetKey, childRelative)
              queue.push(entry.target)
              continue
            }
            if (entry.type !== 'file') continue
            // Census EVERY file seen, including ones the allow-list rejects, so
            // the report can answer "what did you not look at?" without the
            // caller spending a call on `find | uniq -c`.
            const extension = extensionOf(entry.name)
            bump(index.census, extension === '' ? '(none)' : extension, 1)
            if (!include.includes(extension)) continue
            relativeOf.set(entry.target.targetKey, childRelative)
            queue.push(entry.target)
          }
          continue
        }
        if (info.type !== 'file') { index.skipped += 1; continue }
        if (typeof info.size === 'number' && info.size > caps.maxFileBytes) {
          index.skipped += 1
          index.oversize += 1
          continue
        }
        const relativePath = relative === '' ? baseNameOf(rootPath) : relative
        const language = LANGUAGE_BY_EXTENSION[extensionOf(relativePath)]
        if (language === undefined) { index.skipped += 1; continue }
        let text
        try {
          text = await ctx.fs.readText(target, signal)
        } catch (error) {
          index.skipped += 1
          index.unreadable += 1
          continue
        }
        if (looksBinary(text.slice(0, 8192))) {
          index.skipped += 1
          index.binary += 1
          continue
        }
        index.files += 1
        index.filePaths.push(relativePath)
        const scan = scanSource(text, language, relativePath)
        for (const definition of scan.definitions) index.definitions.push(definition)
        for (const impl of scan.impls) index.impls.push(impl)
        for (const template of scan.templates) index.templates.push(template)
        for (const [symbol, count] of scan.mentions) bump(index.mentions, symbol, count)
        if (index.definitions.length + index.impls.length > caps.maxIndexEntries) {
          index.truncated = true
          break
        }
      }
      // Name lookups, so resolving twelve symbols is twelve dictionary hits
      // rather than twelve linear scans of a 70k-entry definition list.
      index.definitionsByVariant = new Map()
      index.definitionsByLower = new Map()
      for (const definition of index.definitions) {
        const exact = index.definitionsByVariant.get(definition.name)
        if (exact === undefined) index.definitionsByVariant.set(definition.name, [definition])
        else exact.push(definition)
        const lowered = definition.name.toLowerCase()
        const loose = index.definitionsByLower.get(lowered)
        if (loose === undefined) index.definitionsByLower.set(lowered, [definition])
        else loose.push(definition)
      }
      index.implsByTrait = new Map()
      index.implsByFor = new Map()
      for (const impl of index.impls) {
        if (impl.trait !== '') {
          for (const variant of nameVariants(impl.trait)) {
            const list = index.implsByTrait.get(variant)
            if (list === undefined) index.implsByTrait.set(variant, [impl])
            else list.push(impl)
          }
        }
        for (const variant of nameVariants(impl.forType)) {
          const list = index.implsByFor.get(variant)
          if (list === undefined) index.implsByFor.set(variant, [impl])
          else list.push(impl)
        }
      }
      const coverage = coverageOf(index)
      index.coverageText = coverage.text
      index.partial = coverage.partial
      index.partialReason = coverage.partialReason
      index.builtMs = Date.now() - started
      INDEX_POOL.delete(key)
      INDEX_POOL.set(key, index)
      trimPool()
      return index
    })()
    INDEX_INFLIGHT.set(key, build)
    try {
      return { index: await build, reused: false }
    } finally {
      INDEX_INFLIGHT.delete(key)
    }
  }

  /**
   * Re-read the indexed files and count textual occurrences of each needle.
   * Used for the mention scan that keeps a "no definition" from becoming a
   * false "absent", and as the engine behind `query`.
   * @returns a Map of needle -> `{ count, sites: [{ path, line, text }] }`.
   */
  async function scanText(ctx, index, needles, include, signal, cap, matcher) {
    const found = new Map()
    for (const needle of needles) found.set(needle, { count: 0, sites: [] })
    for (const relativePath of index.filePaths) {
      if (signal !== undefined && signal.aborted) throw new Error('find_symbol: aborted while scanning')
      if (!include.includes(extensionOf(relativePath))) continue
      let text
      try {
        const target = await ctx.fs.resolve(joinPath(index.rootPath, relativePath), { signal })
        text = await ctx.fs.readText(target, signal)
      } catch (error) {
        continue
      }
      const lines = text.split('\n')
      for (let position = 0; position < lines.length; position += 1) {
        const line = lines[position]
        for (const needle of needles) {
          const count = matcher(line, needle)
          if (count === 0) continue
          const record = found.get(needle)
          record.count += count
          if (record.sites.length < cap) {
            record.sites.push({ path: relativePath, line: position + 1, text: lineText(line) })
          }
        }
      }
    }
    return found
  }

  /** Literal matcher. */
  function literalMatcher(line, needle) {
    return countOccurrences(line, needle)
  }

  /** Render the resolved value into the one model-facing text block. */
  function renderReport(value) {
    const lines = []
    lines.push('find_symbol: ' + value.symbols.length + ' symbol(s) · root ' + value.root)
    lines.push('index ' + value.index.id + ': ' + value.index.files + ' files, '
      + value.index.definitions + ' defs, ' + value.index.impls + ' impls ('
      + (value.index.reused ? 'reused' : 'built in ' + value.index.builtMs + 'ms') + ')')
    if (value.index.searched.length > 0) {
      lines.push('SEARCHED: ' + value.index.searched
        .map(entry => entry.extension + '×' + entry.files).join(' '))
    }
    if (value.index.notSearched.length > 0) {
      lines.push('NOT SEARCHED (outside the allow-list): ' + value.index.notSearched
        .map(entry => entry.extension + '×' + entry.files).join(' ')
        + (value.index.notSearchedMore > 0 ? ' +' + value.index.notSearchedMore + ' more extensions' : ''))
    }
    if (value.index.prunedDirs > 0) {
      lines.push('PRUNED DIRS (policy, contents never listed): ' + value.index.prunedNames.join(', ')
        + (value.index.prunedCapped ? ' …' : '') + ' — ' + value.index.prunedDirs + ' director(ies)')
    }
    if (value.index.templates > 0) {
      lines.push('MACRO TEMPLATES skipped (not an impl of any named type): ' + value.index.templates
        + (value.index.templateSamples.length > 0
          ? ' — e.g. `' + value.index.templateSamples[0] + '`' : ''))
    }
    lines.push('coverage: ' + value.index.coverage)
    if (value.text.count > 0 || value.text.pattern !== '') {
      lines.push('')
      lines.push('## text matches for ' + value.text.pattern
        + (value.text.regex ? ' (regex)' : ' (literal)') + ': ' + value.text.count
        + ' match(es) in ' + value.text.files + ' file(s)')
      for (const site of value.text.sites) {
        lines.push('  ' + site.path + ':' + site.line + ': ' + site.text)
      }
      if (value.text.capped) {
        lines.push('  … list capped at ' + value.text.sites.length + ' of ' + value.text.count
          + ' matches (count is exact; narrow the pattern for the rest)')
      }
    }
    for (const symbol of value.symbols) {
      lines.push('')
      lines.push('## ' + symbol.name + (symbol.matchedName !== symbol.name
        ? ' (matched as ' + symbol.matchedName + ')'
        : ''))
      for (const definition of symbol.definitions) {
        lines.push('def ' + definition.kind + ' ' + definition.path + ':' + definition.line
          + '  ' + definition.text)
      }
      // ── impls where this symbol is the TRAIT (what implements it) ──────────
      //
      // TWO counts appear here and they are NOT the same number, which is a
      // measurement-backed trap: 190 impl SITES can cover 186 unique TARGET
      // TYPES, because a generic type may be implemented at more than one site.
      // A v2 A/B arm read the smaller number sitting beside the larger as "the
      // list is capped at 186", then rebuilt the set by grep with a pattern that
      // could not match a 4-space-indented qualified impl — turning a correct,
      // complete answer into its only correctness regression. Both counts are
      // therefore labelled, related, and the list is marked complete or capped
      // explicitly; a bare "(186)" next to "190 impl(s)" is not enough.
      if (symbol.implsTotal > 0 || symbol.implTargetsTotal > 0) {
        const sitesCapped = symbol.implsTotal > symbol.impls.length
        if (symbol.implsTotal > 0) {
          lines.push('impl-sites ' + symbol.impls.length + ' of ' + symbol.implsTotal
            + (sitesCapped ? ' shown (detail rows capped)' : ' (all site rows shown)') + ':')
        }
        for (const impl of symbol.impls) {
          lines.push('  ' + impl.forType + '  ' + impl.path + ':' + impl.line)
        }
        lines.push('impl-targets ' + symbol.implTargetsTotal + ' unique type(s) from '
          + symbol.implsTotal + ' impl site(s) — '
          + (symbol.implsCapped
            ? 'CAPPED, only ' + symbol.implTargets.length + ' named'
            : 'COMPLETE list, do not re-derive it') + ': '
          + symbol.implTargets.join(', ')
          + (symbol.implsCapped
            ? ' … +' + (symbol.implTargetsTotal - symbol.implTargets.length) + ' more' : ''))
      }
      for (const impl of symbol.implsFor) {
        lines.push('impl-of ' + (impl.trait === '' ? '(inherent)' : impl.trait)
          + '  ' + impl.path + ':' + impl.line)
      }
      if (symbol.implForTargetsTotal > 0) {
        const forCapped = symbol.implForTargetsTotal > symbol.implsFor.length
        lines.push('implements-for ' + symbol.implForTargetsTotal + ' impl(s) — '
          + (symbol.implsForTotal > symbol.implsFor.length
            ? symbol.implsFor.length + ' of ' + symbol.implsForTotal + ' site rows shown'
            : 'all site rows shown') + ': '
          + symbol.implForTargets.join(', ')
          + (symbol.implForTargets.length < symbol.implForTargetsTotal
            ? ' … +' + (symbol.implForTargetsTotal - symbol.implForTargets.length) + ' more' : '')
          + (forCapped ? '' : ''))
      }
      if (symbol.mentions.scanned && symbol.mentions.count > 0) {
        const sites = symbol.mentions.sites
          .map(site => site.path + ':' + site.line)
          .join(', ')
        lines.push('mentions ' + symbol.mentions.count + (sites === '' ? '' : ' — ' + sites))
      }
      lines.push('verdict [' + symbol.status + ']: ' + symbol.verdict + '.')
    }
    const trailer = 'final for ' + value.index.id + ' — re-running this same search cannot change it.'
    let text = lines.join('\n')
    if (text.length > caps.maxOutputChars) {
      text = text.slice(0, caps.maxOutputChars) + '\n… output truncated at ' + caps.maxOutputChars
        + ' chars; the counts above are exact — ask for fewer symbols to see every row.'
    }
    return text + '\n' + trailer
  }

  return {
    name: config.toolName,
    description: 'Answer "where is X defined", "what implements X", "what does X implement" and'
      + ' "does X exist here" for a source tree in ONE call, and search the same tree for a literal'
      + ' or regex pattern — use it INSTEAD of a series of grep/rg calls. Give it every symbol name'
      + ' you are about to search for. It returns per symbol: definition sites, the complete set of'
      + ' `impl <Trait> for <Type>` on BOTH sides (what implements the symbol, and what the symbol'
      + ' implements), mention sites, and an explicit verdict. Negatives are scoped: the report'
      + ' states exactly which files were searched, which extensions and directories were not, and'
      + ' whether any cap made the answer INCOMPLETE — an "absent" verdict is final, an'
      + ' "inconclusive" one is not, and a bad path is a hard error that read nothing. Works on any'
      + ' directory, including vendored dependency checkouts outside your workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symbol names to resolve, 1-12 per call. Prefer one call with every name over'
            + ' several calls; one call costs one report, several calls cost several. Required unless'
            + ' `query` is given.',
        },
        query: {
          type: 'string',
          description: 'Literal text (or a regex when `regex` is true) to find across the same tree,'
            + ' e.g. an error message, a config key, or a call site. Returns path:line:text matches'
            + ' with an exact total count. Use this instead of grep for anything that is not a symbol'
            + ' name. Requires `symbols` to be omitted.',
        },
        regex: {
          type: 'boolean',
          description: 'Treat `query` as a JavaScript regular expression instead of a literal string.',
        },
        path: {
          type: 'string',
          description: 'Root file or directory to search. Defaults to the session working directory.'
            + ' A path that does not exist is a hard error naming the nearest existing directory and'
            + ' the closest names inside it — it never returns an empty result.',
        },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extension allow-list override, e.g. [".rs"]. Defaults to a common source set;'
            + ' the report always states which extensions were and were not searched.',
        },
        excludeDirs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Directory basenames to prune, replacing the default list (target, node_modules,'
            + ' dist, …). Pass [] to search everything, including build output.',
        },
        includeExcluded: {
          type: 'boolean',
          description: 'Search the default-pruned directories too (target/, node_modules/, .git/, …).'
            + ' Much slower; use it when a negative must cover generated or vendored code.',
        },
        refresh: {
          type: 'boolean',
          description: 'Rebuild the index instead of reusing the cached one (use after editing files).',
        },
        expect: {
          type: 'string',
          description: 'Optional name to check directly, e.g. symbol "VisualContext" with expect "Context".'
            + ' The verdict then states explicitly whether that name IS or is NOT among the impl'
            + ' targets — the fastest way to answer "does X implement Y here?".',
        },
        mentions: {
          type: 'boolean',
          description: 'Also scan the tree for textual mention sites of every symbol (path:line),'
            + ' not just counts. Costs a re-read of the indexed files; use it instead of grepping for'
            + ' the uses of a symbol you already located.',
        },
        maxSites: {
          type: 'number',
          description: 'Raise the per-symbol cap on detail rows (definitions, impl sites, target names).'
            + ' Counts are always exact even when rows are capped.',
        },
      },
    },
    timeoutMs: caps.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec === undefined ? undefined : exec.signal
      const sessionCwd = exec === undefined || exec.agent === undefined
        ? undefined
        : exec.agent.session.header.cwd
      const cwd = sessionCwd === undefined ? fallbackCwd() : sessionCwd
      if (typeof args !== 'object' || args === null) {
        throw new Error('find_symbol: arguments must be an object')
      }
      const hasQuery = args.query !== undefined
      if (hasQuery && (typeof args.query !== 'string' || args.query === '')) {
        throw new Error('find_symbol: `query` must be a non-empty string')
      }
      if (hasQuery && args.symbols !== undefined) {
        throw new Error('find_symbol: pass either `symbols` or `query`, not both — `symbols` resolves'
          + ' names and reports impls; `query` finds raw text.')
      }
      const seen = new Set()
      const names = []
      if (Array.isArray(args.symbols)) {
        for (const raw of args.symbols) {
          if (typeof raw !== 'string' || raw.trim() === '') {
            throw new Error('find_symbol: every entry of `symbols` must be a non-empty string')
          }
          const trimmed = raw.trim()
          const key = trimmed.toLowerCase()
          if (seen.has(key)) continue
          seen.add(key)
          names.push(trimmed)
        }
      } else if (args.symbols !== undefined) {
        throw new Error('find_symbol: `symbols` must be an array of names')
      }
      if (!hasQuery && names.length === 0) {
        throw new Error('find_symbol: pass `symbols` (1-12 names) to resolve definitions and impls,'
          + ' or `query` to find a literal/regex text match in the same tree.')
      }
      if (names.length > 12) {
        throw new Error('find_symbol: at most 12 distinct symbols per call (got ' + names.length
          + '); split the request instead of repeating searches')
      }
      let expect
      if (args.expect !== undefined) {
        if (typeof args.expect !== 'string' || args.expect.trim() === '') {
          throw new Error('find_symbol: `expect` must be a non-empty string naming the impl target to check')
        }
        expect = args.expect.trim()
      }
      let include = config.include
      if (args.include !== undefined) {
        if (!Array.isArray(args.include) || args.include.length === 0
          || args.include.some(entry => typeof entry !== 'string' || !entry.startsWith('.'))) {
          throw new Error('find_symbol: `include` must be a non-empty array of extensions'
            + ' starting with "."')
        }
        include = args.include.map(entry => entry.toLowerCase())
      }
      const excludeDirs = Array.isArray(args.excludeDirs)
        && args.excludeDirs.every(entry => typeof entry === 'string')
        ? args.excludeDirs
        : config.excludeDirs
      const effectiveConfig = excludeDirs === config.excludeDirs
        ? config
        : { ...config, excludeDirs }
      if (args.maxSites !== undefined
        && (typeof args.maxSites !== 'number' || !Number.isFinite(args.maxSites) || args.maxSites <= 0)) {
        throw new Error('find_symbol: `maxSites` must be a positive number')
      }
      const siteCap = args.maxSites === undefined
        ? caps.maxSitesPerSymbol
        : Math.min(Math.floor(args.maxSites), 2000)
      const root = await resolveRoot(ctx, args.path, cwd, signal)
      const key = indexKey(root.rootPath, include, caps, effectiveConfig, args.includeExcluded)
      if (args.refresh === true) INDEX_POOL.delete(key)
      const { index, reused } = await buildIndex(
        ctx, root.target, root.kind, root.rootPath, include, args.includeExcluded === true, signal,
        effectiveConfig,
      )

      // ---- text-query mode: grep parity for anything that is not a symbol ----
      let textResult = { pattern: '', regex: false, count: 0, files: 0, sites: [], capped: false }
      if (hasQuery) {
        const pattern = args.query
        let expression
        if (args.regex === true) {
          try {
            expression = new RegExp(pattern, 'g')
          } catch (error) {
            throw new Error('find_symbol: `query` is not a valid regular expression ('
              + String(error && error.message ? error.message : error) + ')')
          }
        }
        const matcher = args.regex === true
          ? (line) => {
            expression.lastIndex = 0
            let count = 0
            while (expression.exec(line) !== null) {
              count += 1
              if (expression.lastIndex === 0) break
            }
            return count
          }
          : literalMatcher
        const hits = await scanText(ctx, index, [pattern], include, signal, caps.maxTextSites, matcher)
        const record = hits.get(pattern)
        const fileSet = new Set(record.sites.map(site => site.path))
        textResult = {
          pattern,
          regex: args.regex === true,
          count: record.count,
          files: fileSet.size,
          sites: record.sites,
          capped: record.count > record.sites.length,
        }
      }

      // ---- symbol mode ----
      const resolutions = hasQuery ? [] : names.map(symbol => resolveSymbol(index, symbol))
      const unresolved = resolutions.filter(entry => entry.definitions.length === 0
        && entry.traitImpls.length === 0 && entry.selfImpls.length === 0)
      if (unresolved.length > 0) {
        // A negative that has not looked at raw text is not yet a negative.
        const scanned = await scanText(ctx, index, unresolved.map(entry => entry.matchedName),
          include, signal, caps.maxMentionSites, literalMatcher)
        for (const entry of unresolved) {
          const found = scanned.get(entry.matchedName)
          entry.textScan = found === undefined ? { count: 0, sites: [] } : found
        }
      }
      if (args.mentions === true) {
        const targets = resolutions.filter(entry => entry.definitions.length > 0
          && entry.textScan === null)
        if (targets.length > 0) {
          const scanned = await scanText(ctx, index, targets.map(entry => entry.matchedName),
            include, signal, caps.maxMentionSites, literalMatcher)
          for (const entry of targets) {
            const found = scanned.get(entry.matchedName)
            entry.textScan = found === undefined ? { count: 0, sites: [] } : found
          }
        }
      }
      const symbols = resolutions.map(entry => {
        const resolved = verdictOf(entry, index)
        const verdict = expect === undefined
          ? resolved.verdict
          : resolved.verdict + '; expect ' + expect + ': ' + expectAnswer(entry.traitImpls, expect)
        const targets = targetNames(entry.traitImpls, 'forType', caps.maxTargetNames)
        const forTargets = targetNames(entry.selfImpls.filter(impl => impl.trait !== ''), 'trait', caps.maxTargetNames)
        return {
          name: entry.requested,
          matchedName: entry.matchedName,
          matchedOn: entry.matchedOn,
          status: resolved.status,
          verdict,
          definitions: entry.definitions.slice(0, siteCap).map(definition => ({
            path: definition.path,
            line: definition.line,
            kind: definition.kind,
            text: definition.text,
          })),
          definitionsTotal: entry.definitions.length,
          impls: entry.traitImpls.slice(0, siteCap).map(impl => ({
            path: impl.path,
            line: impl.line,
            trait: impl.trait,
            forType: impl.forType,
            text: impl.text,
          })),
          implsTotal: entry.traitImpls.length,
          implTargets: targets.names,
          implTargetsTotal: targets.total,
          implsCapped: targets.total > targets.names.length,
          implsFor: entry.selfImpls.slice(0, siteCap).map(impl => ({
            path: impl.path,
            line: impl.line,
            trait: impl.trait,
            forType: impl.forType,
            text: impl.text,
          })),
          implsForTotal: entry.selfImpls.length,
          implForTargets: forTargets.names,
          implForTargetsTotal: forTargets.total,
          mentions: {
            count: entry.textScan === null ? entry.indexedMentions : entry.textScan.count,
            scanned: entry.textScan !== null,
            sites: (entry.textScan === null ? [] : entry.textScan.sites)
              .slice(0, caps.maxMentionSites)
              .map(site => ({ path: site.path, line: site.line })),
          },
          coverage: index.coverageText,
        }
      })
      // Per-extension accounting, so a file count is explained rather than
      // surprising: a polyglot tree indexes more files than its .rs subset.
      // Kept as an array because the enforced schema subset supports only a
      // boolean `additionalProperties`, not a map schema.
      const searchedCounts = new Map()
      for (const relativePath of index.filePaths) {
        const extension = extensionOf(relativePath)
        const key2 = extension === '' ? '(none)' : extension
        searchedCounts.set(key2, (searchedCounts.get(key2) === undefined ? 0 : searchedCounts.get(key2)) + 1)
      }
      const searched = [...searchedCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([extension, files]) => ({ extension, files }))
      const notSearchedAll = [...index.census.entries()]
        .filter(([extension]) => !include.includes(extension))
        .sort((left, right) => right[1] - left[1])
      const notSearched = notSearchedAll.slice(0, MAX_REPORTED_NAMES)
        .map(([extension, files]) => ({ extension, files }))
      return {
        root: root.rootPath,
        index: {
          id: index.id,
          files: index.files,
          definitions: index.definitions.length,
          impls: index.impls.length,
          builtMs: index.builtMs,
          reused,
          skipped: index.skipped,
          truncated: index.truncated,
          partial: index.partial,
          coverage: index.coverageText,
          searched,
          notSearched,
          notSearchedMore: Math.max(0, notSearchedAll.length - notSearched.length),
          prunedNames: index.prunedNames,
          prunedDirs: index.prunedDirCount,
          prunedCapped: index.prunedCapped,
          templates: index.templates.length,
          templateSamples: index.templates.slice(0, 3).map(template => template.text),
        },
        text: textResult,
        symbols,
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['root', 'index', 'text', 'symbols'],
        properties: {
          root: { type: 'string' },
          index: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'files', 'definitions', 'impls', 'builtMs', 'reused', 'skipped',
              'truncated', 'partial', 'coverage', 'searched', 'notSearched', 'notSearchedMore',
              'prunedNames', 'prunedDirs', 'prunedCapped', 'templates', 'templateSamples'],
            properties: {
              id: { type: 'string' },
              files: { type: 'integer' },
              definitions: { type: 'integer' },
              impls: { type: 'integer' },
              builtMs: { type: 'number' },
              reused: { type: 'boolean' },
              skipped: { type: 'integer' },
              truncated: { type: 'boolean' },
              partial: { type: 'boolean' },
              coverage: { type: 'string' },
              searched: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['extension', 'files'],
                  properties: {
                    extension: { type: 'string' },
                    files: { type: 'integer' },
                  },
                },
              },
              notSearched: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['extension', 'files'],
                  properties: {
                    extension: { type: 'string' },
                    files: { type: 'integer' },
                  },
                },
              },
              notSearchedMore: { type: 'integer' },
              prunedNames: { type: 'array', items: { type: 'string' } },
              prunedDirs: { type: 'integer' },
              prunedCapped: { type: 'boolean' },
              templates: { type: 'integer' },
              templateSamples: { type: 'array', items: { type: 'string' } },
            },
          },
          text: {
            type: 'object',
            additionalProperties: false,
            required: ['pattern', 'regex', 'count', 'files', 'sites', 'capped'],
            properties: {
              pattern: { type: 'string' },
              regex: { type: 'boolean' },
              count: { type: 'integer' },
              files: { type: 'integer' },
              capped: { type: 'boolean' },
              sites: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['path', 'line', 'text'],
                  properties: {
                    path: { type: 'string' },
                    line: { type: 'integer' },
                    text: { type: 'string' },
                  },
                },
              },
            },
          },
          symbols: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'matchedName', 'matchedOn', 'status', 'verdict', 'definitions',
                'definitionsTotal', 'impls', 'implsTotal', 'implTargets', 'implTargetsTotal',
                'implsCapped', 'implsFor', 'implsForTotal', 'implForTargets', 'implForTargetsTotal',
                'mentions', 'coverage'],
              properties: {
                name: { type: 'string' },
                matchedName: { type: 'string' },
                matchedOn: {
                  type: 'string',
                  enum: ['exact', 'path-segment-or-generic', 'case-insensitive'],
                },
                status: {
                  type: 'string',
                  enum: ['defined', 'impls-only', 'mentions-only', 'absent', 'inconclusive'],
                },
                verdict: { type: 'string' },
                definitionsTotal: { type: 'integer' },
                definitions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['path', 'line', 'kind', 'text'],
                    properties: {
                      path: { type: 'string' },
                      line: { type: 'integer' },
                      kind: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
                implsTotal: { type: 'integer' },
                impls: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['path', 'line', 'trait', 'forType', 'text'],
                    properties: {
                      path: { type: 'string' },
                      line: { type: 'integer' },
                      trait: { type: 'string' },
                      forType: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
                implTargets: { type: 'array', items: { type: 'string' } },
                implTargetsTotal: { type: 'integer' },
                implsCapped: { type: 'boolean' },
                implsForTotal: { type: 'integer' },
                implsFor: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['path', 'line', 'trait', 'forType', 'text'],
                    properties: {
                      path: { type: 'string' },
                      line: { type: 'integer' },
                      trait: { type: 'string' },
                      forType: { type: 'string' },
                      text: { type: 'string' },
                    },
                  },
                },
                implForTargets: { type: 'array', items: { type: 'string' } },
                implForTargetsTotal: { type: 'integer' },
                mentions: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['count', 'scanned', 'sites'],
                  properties: {
                    count: { type: 'integer' },
                    scanned: { type: 'boolean' },
                    sites: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['path', 'line'],
                        properties: {
                          path: { type: 'string' },
                          line: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
                coverage: { type: 'string' },
              },
            },
          },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: renderReport(value) }]
      },
    },
  }
}

/**
 * Register the tool and its guidance section for the mounting agent scope.
 * @param ctx - an agent scope context (or the host context when mounted there).
 * @param config - validated plugin config.
 */
function apply(ctx, config) {
  const caps = {}
  for (const key of Object.keys(DEFAULT_CAPS)) caps[key] = config[key]
  // Registration is reported to a diagnostic file, because a row that mounts but
  // fails to register its tool is otherwise INVISIBLE: the prompt section still
  // reaches the model, the tool simply never appears, and nothing logs why. This
  // is the check that would have caught the schema rejection in one session
  // instead of several.
  // Serialized through one promise chain: two reports fired in the same tick
  // used to interleave their read-modify-write on the same file, and the loser's
  // line vanished. A missing line then reads as "registration never happened",
  // which is the opposite of the truth — a diagnostic that can lie is worse than
  // no diagnostic.
  let reportChain = Promise.resolve()
  const report = (outcome, detail) => {
    reportChain = reportChain.then(async () => {
      try {
        const fs = ctx.get('fs')
        if (fs === undefined) return
        const payload = JSON.stringify({
          at: String(Date.now()),
          version: VERSION,
          tool: config.toolName,
          outcome,
          ...(detail === undefined ? {} : { detail }),
        }) + '\n'
        const target = await fs.resolve('/tmp/dsh-symbol-index-register.log')
        let previous = ''
        try { previous = await fs.readText(target) } catch (error) { previous = '' }
        await fs.writeText(target, previous + payload)
      } catch (error) {
        // Diagnostics are never load-bearing.
      }
    })
  }
  // Construction and registration share ONE try, and a failure is RETHROWN.
  // The failure this guards against is the worst available outcome: the row
  // half-activates, the order-116 section tells the model to use `find_symbol`,
  // and the tool is not in its catalog, so every call the model makes fails as
  // `unknown tool`. A dangling prompt rule is worse than no row at all, so a
  // failed registration must fail the mount where it is visible rather than
  // being swallowed into a silent, self-contradicting composition.
  try {
    // Registered DIRECTLY, not through `ctx.effect(...)`. Every working
    // package row in this deployment registers directly
    // (`ctx.tools.register(defineTool({…}))`), and the effect wrapper was the
    // one structural difference left between this row and those rows once the
    // row form (relative file, absolute file, package) had been ruled out by
    // measurement. `register` already returns a fiber-scoped disposer.
    const tool = buildTool(ctx, caps, config)
    ctx.tools.register(tool)
    report('registered')
  } catch (error) {
    report('register-threw', String(error && error.message ? error.message : error))
    throw error
  }
  if (config.guidanceSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: 116,
      text: config.toolName + ' answers symbol questions in one call: give it every name you are about'
        + ' to search for and it returns each definition site, the complete set of `impl` on BOTH'
        + ' sides (what implements the name, and what the name implements), mention sites, and an'
        + ' explicit verdict when a name does not exist. Use it instead of a series of grep calls for'
        + ' "where is X defined", "what implements X", "what does X implement", and "does X exist'
        + ' here"; use its `query` argument instead of grep for literal or regex text searches over'
        + ' the same tree, and `mentions: true` instead of grepping for the uses of a symbol you'
        + ' already located. Its report states exactly what was searched, what was pruned or excluded,'
        + ' and whether a cap made the answer incomplete — so an "absent" verdict is final and an'
        + ' "inconclusive" one is not: never re-run the same search to re-check an absent verdict, and'
        + ' never treat a hard path error as "not found".',
    }), 'preset-symbol-index.section()')
  }
}

export { name, inject, Config, apply }

/**
 * Drop every pooled index. Exported for tests and for a caller that changed many
 * files at once and wants the next call to rebuild regardless of TTL; the tool's
 * own `refresh: true` argument covers the ordinary single-root case.
 */
export default { name, inject, Config, apply, evictIndexes }

export function evictIndexes() {
  INDEX_POOL.clear()
}

