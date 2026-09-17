/**
 * GREP-PARITY DIFFERENTIAL — the "can this replace grep?" test.
 *
 * The A/B (scratch/ab/RESULTS.md) established correctness at N=1 for ONE symbol
 * set on ONE model. That is a point measurement of an agent, not a property of
 * the tool. This harness measures the TOOL directly against an independent
 * oracle — GNU grep, a different engine and a different implementation of the
 * same patterns — over the whole vendored Zed checkout, for every symbol in a
 * set chosen to be hostile.
 *
 * It is a differential, not a unit test, so it is written as an executable
 * report rather than `node --test`. Three properties are checked per symbol:
 *
 *   COMPLETENESS (grep ⊆ tool)
 *     every definition site and every impl row grep finds, the tool finds.
 *
 *   SOUNDNESS (tool's negatives are true)
 *     a symbol the tool calls `absent` must have ZERO word-boundary occurrences.
 *     This is the property whose violation makes an agent delete working code,
 *     and it is the one v1 broke when it said "ABSENT … in 0 indexed file(s)".
 *
 *   SELF-SIDE PARITY
 *     `impl <Trait> for S` — what S implements. v1 returned 0 rows here while
 *     `grep 'for S'` returned all of them.
 *
 * Tool-EXTRA rows (things the tool finds that a line-oriented grep cannot) are
 * reported separately and are not failures, because the tool parses joined
 * multi-line `impl` headers. They are printed with their source line so the
 * claim is checkable by eye.
 *
 * Usage: node parity-check.mjs [--quick]
 *
 * THE TREE AND THE SYMBOL SET ARE BOTH OVERRIDABLE, so this differential is not
 * welded to one machine's vendored checkout:
 *
 *   SYMBOL_INDEX_FIXTURE=<dir>    the tree to search (default: the vendored Zed
 *                                 checkout below; a missing path stays the
 *                                 plugin's hard error, which reads nothing)
 *   SYMBOL_INDEX_SYMBOLS=a,b,c    the symbol set to diff (default: the hostile
 *                                 Zed set). Needed whenever the tree is not Zed,
 *                                 because the default names simply do not exist
 *                                 anywhere else.
 *
 * Example, over the committed subtoken fixture:
 *   SYMBOL_INDEX_FIXTURE=fixtures/subtoken \
 *   SYMBOL_INDEX_SYMBOLS=HttpFetcher,UserProfile,get_user_by_id,... node parity-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { loadTool, mockExec } from './harness.mjs'

const MODULE = new URL('./lib/index.js', import.meta.url).pathname
/** The vendored Zed checkout this differential was written against. */
const DEFAULT_ROOT = '/home/chaosbolt/.cargo/git/checkouts/zed-a70e2ad075855582/87a1ea3'
// Resolved, so a relative SYMBOL_INDEX_FIXTURE works: the tool resolves its root
// against the session cwd, and a relative root there would resolve against
// itself. A path that still does not exist stays the plugin's hard error.
const ROOT = resolvePath(process.env.SYMBOL_INDEX_FIXTURE ?? DEFAULT_ROOT)
const QUICK = process.argv.includes('--quick')

/**
 * Hostile symbol set. Every entry is here for a reason:
 *   Focusable           190 impls, the A/B's measured gap, qualified paths
 *   VisualContext       a `quote!` template names it in the same tree
 *   FocusOnlyModal      self-side only: defined in ONE file, 4 impls elsewhere
 *   Context             extremely common; stresses false-positive definition hits
 *   Render / AppContext traits implemented all over the tree
 *   Entity, Window      generic and widely used
 *   TerminalPanel       a plain struct, the easy case
 *   Picker              a generic trait with many impls
 *   PickerDelegate      an associated-type-heavy trait
 *   NoSuchSymbolXYZ123  absence soundness
 */
const DEFAULT_SYMBOLS = QUICK
  ? ['Focusable', 'VisualContext', 'FocusOnlyModal', 'NoSuchSymbolXYZ123']
  : [
    'Focusable', 'VisualContext', 'FocusOnlyModal', 'Context', 'Render', 'AppContext',
    'Entity', 'Window', 'TerminalPanel', 'Picker', 'PickerDelegate', 'NoSuchSymbolXYZ123',
  ]

/**
 * The overridable symbol set. Splitting on `,` and dropping blanks means a shell
 * list cannot smuggle an empty symbol into the differential, where it would
 * silently compare nothing against nothing.
 */
const SYMBOLS = process.env.SYMBOL_INDEX_SYMBOLS === undefined
  ? DEFAULT_SYMBOLS
  : process.env.SYMBOL_INDEX_SYMBOLS.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
if (SYMBOLS.length === 0) {
  console.error('SYMBOL_INDEX_SYMBOLS was set but contained no symbol names.')
  process.exit(1)
}

/** Run grep over the tree, returning `path:line:text` rows with ./ stripped. */
function grep(pattern) {
  try {
    const out = execFileSync('grep', ['-rnE', '--include=*.rs', pattern, '.'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    })
    return out.split('\n').filter(Boolean).map(line => line.replace(/^\.\//, ''))
  } catch (error) {
    // grep exits 1 on no match, which is not an error here.
    if (error.status === 1) return []
    throw error
  }
}

/** `path:line` of a grep row. */
function siteOf(row) {
  const at = row.indexOf(':')
  const next = row.indexOf(':', at + 1)
  return row.slice(0, next)
}

/**
 * The definition oracle: a transcription of the plugin's own DEFINITION_TABLE
 * into ERE. Deliberately written from the table's semantics rather than copied
 * from its source, so the two disagree when one of them is wrong.
 */
function definitionPattern(name) {
  const vis = '(pub(\\([^)]*\\))?[[:space:]]+)?'
  return [
    `^[[:space:]]*${vis}(unsafe[[:space:]]+)?trait[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}struct[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}enum[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}union[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}(default[[:space:]]+)?(const[[:space:]]+)?(async[[:space:]]+)?(unsafe[[:space:]]+)?(extern[[:space:]]+"[^"]*"[[:space:]]+)?fn[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}mod[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}type[[:space:]]+${name}\\b`,
    `^[[:space:]]*${vis}const[[:space:]]+${name}[[:space:]]*:`,
    `^[[:space:]]*${vis}static[[:space:]]+(mut[[:space:]]+)?${name}[[:space:]]*:`,
    `^[[:space:]]*macro_rules![[:space:]]*${name}\\b`,
  ].join('|')
}

/** `impl <Trait> for <Type>` rows where NAME is the TRAIT. */
function traitImplPattern(name) {
  return `^[[:space:]]*(unsafe[[:space:]]+|default[[:space:]]+|const[[:space:]]+)*impl\\b[^;{]*\\b${name}\\b[[:space:]]+for\\b`
}

/** `impl <Trait> for <Type>` rows where NAME is the SELF TYPE. */
function selfImplPattern(name) {
  return `^[[:space:]]*(unsafe[[:space:]]+|default[[:space:]]+|const[[:space:]]+)*impl\\b[^;{]*\\bfor[[:space:]]+${name}\\b`
}

/**
 * Extract the self type from `impl … for <Type>` rows, as grep sees them.
 * Note this reads AFTER the last ` for ` on the line, so a `where` clause is
 * trimmed too.
 */
function selfTypes(rows) {
  const found = new Set()
  for (const row of rows) {
    const body = row.replace(/^[^:]*:\d+:/, '')
    const match = /\bfor\s+(.+)$/.exec(body)
    if (match === null) continue
    let type = match[1].trim().replace(/\{$/, '').trim()
    const whereAt = type.search(/\bwhere\b/)
    if (whereAt !== -1) type = type.slice(0, whereAt).trim()
    if (type !== '') found.add(type)
  }
  return found
}

/**
 * The TRAIT written on an `impl … for …` row, as grep sees it — the other side
 * of `selfTypes`. Depth-aware so `impl<F: Fn() -> Vec<u8>> Trait for X` does not
 * mistake the `->` for a bracket.
 */
function traitOfRow(row) {
  const body = row.replace(/^[^:]*:\d+:/, '')
  const at = body.search(/\bimpl\b/)
  if (at === -1) return ''
  let rest = body.slice(at + 4)
  let index = 0
  while (rest[index] === ' ') index += 1
  if (rest[index] === '<') {                       // skip balanced generics
    let depth = 0
    for (; index < rest.length; index += 1) {
      const ch = rest[index]
      if (ch === '<') depth += 1
      else if (ch === '>' && rest[index - 1] !== '-') {
        depth -= 1
        if (depth === 0) { index += 1; break }
      }
    }
  }
  rest = rest.slice(index).replace(/^\s*!\s*/, '')
  let depth = 0
  for (let scan = 0; scan < rest.length; scan += 1) {
    const ch = rest[scan]
    if (ch === '<' || ch === '(' || ch === '[') { depth += 1; continue }
    if (ch === '>' || ch === ')' || ch === ']') {
      if (depth > 0 && !(ch === '>' && rest[scan - 1] === '-')) depth -= 1
      continue
    }
    if (depth !== 0) continue
    if (rest[scan] === ' ' && /^ for /.test(rest.slice(scan, scan + 5))) {
      return rest.slice(0, scan).trim()
    }
  }
  return ''
}
/**
 * A `quote!`/`macro_rules!` TEMPLATE row: grep counts it as an impl, but
 * `impl #impl_generics Trait for #type_name` is not an impl of any named type.
 * The tool excludes these and reports the count; the oracle must exclude them
 * too or it over-counts. Reported separately so the exclusion is visible.
 */
function isTemplateRow(row) {
  return /(?:#|\$)[A-Za-z_]/.test(row.replace(/^[^:]*:\d+:/, ''))
}

const { tool } = await loadTool(MODULE, {})
const report = { pass: 0, fail: 0, failures: [], extras: [] }

console.log('='.repeat(78))
console.log('GREP-PARITY DIFFERENTIAL over', ROOT
  + (ROOT === DEFAULT_ROOT ? ' (default Zed checkout)' : ' (SYMBOL_INDEX_FIXTURE override)'))
console.log('symbols:', SYMBOLS.join(', ')
  + (process.env.SYMBOL_INDEX_SYMBOLS === undefined ? ' (default hostile set)' : ' (SYMBOL_INDEX_SYMBOLS override)'))
console.log('='.repeat(78))

const started = Date.now()
// maxSites: 2000 so the differential compares COMPLETE sets, not capped reports.
const value = await tool.execute({ symbols: SYMBOLS, path: ROOT, maxSites: 2000 }, mockExec(ROOT))
console.log(`index: ${value.index.files} files, ${value.index.definitions} defs, ${value.index.impls} impls`
  + ` · built ${value.index.builtMs}ms · wall ${Date.now() - started}ms`)
console.log('')

for (const symbol of SYMBOLS) {
  const entry = value.symbols.find(item => item.name === symbol)
  const problems = []
  const lines = []

  // ---- definitions ----
  const defRows = grep(definitionPattern(symbol))
  const defGrep = new Set(defRows.map(siteOf))
  const defTool = new Set(entry.definitions.map(site => `${site.path}:${site.line}`))
  const defMissing = [...defGrep].filter(site => !defTool.has(site))
  const defExtra = [...defTool].filter(site => !defGrep.has(site))
  if (defMissing.length > 0) {
    problems.push(`definitions MISSING ${defMissing.length}: ${defMissing.slice(0, 3).join(' ')}`)
  }
  lines.push(`defs grep=${defGrep.size} tool=${defTool.size}`
    + (defExtra.length > 0 ? ` (+${defExtra.length} tool-only: multi-line/other-kind)` : ''))

  // ---- trait-side impls ----
  const traitRowsRaw = grep(traitImplPattern(symbol))
  const templateRows = traitRowsRaw.filter(isTemplateRow)
  const traitRows = traitRowsRaw.filter(row => !isTemplateRow(row))
  const traitTargetsGrep = selfTypes(traitRows)
  const traitMissing = [...traitTargetsGrep].filter(target => !entry.implTargets.includes(target))
  if (traitRows.length > 0 && traitMissing.length > 0) {
    problems.push(`impl targets MISSING ${traitMissing.length}: ${traitMissing.slice(0, 5).join(', ')}`)
  }
  if (traitRows.length > entry.implsTotal) {
    problems.push(`impl rows tool=${entry.implsTotal} < grep=${traitRows.length}`)
  }
  lines.push(`impls(trait) grep=${traitRows.length}/${traitTargetsGrep.size} targets`
    + ` tool=${entry.implsTotal}/${entry.implTargetsTotal} targets`
    + (templateRows.length > 0 ? ` [grep over-counts ${templateRows.length} template row(s)]` : ''))

  // ---- self-side impls (v1 returned 0 for every symbol here) ----
  const selfRows = grep(selfImplPattern(symbol)).filter(row => !isTemplateRow(row))
  const selfTargetsGrep = new Set(selfRows.map(traitOfRow).filter(name => name !== ''))
  const selfMissing = [...selfTargetsGrep].filter(target => !entry.implForTargets.includes(target))
  if (selfRows.length > 0 && selfMissing.length > 0) {
    problems.push(`self-impl traits MISSING ${selfMissing.length}: ${selfMissing.slice(0, 5).join(', ')}`)
  }
  if (selfRows.length > entry.implsForTotal) {
    problems.push(`self-impl rows tool=${entry.implsForTotal} < grep=${selfRows.length}`)
  }
  // Split the tool's self-side rows so the comparison is exact rather than
  // "tool >= grep": grep's `for NAME` pattern cannot see an INHERENT impl
  // (`impl Window { … }`), which is nevertheless an impl of Window. The
  // trait-impl counts must match grep exactly; the inherent rows are additive.
  const inherentRows = entry.implsFor.filter(impl => impl.trait === '')
  const traitSideRows = entry.implsForTotal - inherentRows.length
  if (selfRows.length !== traitSideRows) {
    problems.push(`self-impl trait rows tool=${traitSideRows} !== grep=${selfRows.length}`)
  }
  lines.push(`impls(self)  grep=${selfRows.length} tool=${traitSideRows} trait-impls`
    + ` +${inherentRows.length} inherent (grep cannot see those)`)

  // ---- SOUNDNESS: a final negative must be true ----
  const wordRows = grep(`\\b${symbol}\\b`)
  if (entry.status === 'absent' && wordRows.length > 0) {
    problems.push(`ABSENT is FALSE — grep -w found ${wordRows.length} occurrence(s), `
      + `first at ${siteOf(wordRows[0])}`)
  }
  if (entry.status === 'defined' && defRows.length === 0) {
    problems.push('reported DEFINED but grep finds no definition line')
  }
  lines.push(`status=${entry.status} grep-word-hits=${wordRows.length}`)

  // Tool-only definition rows are interesting, never a failure.
  for (const site of defExtra.slice(0, 2)) {
    report.extras.push(`${symbol}: tool-only definition at ${site}`)
  }

  if (problems.length === 0) {
    report.pass += 1
    console.log(`PASS  ${symbol.padEnd(20)} ${lines.join('  ·  ')}`)
  } else {
    report.fail += 1
    console.log(`FAIL  ${symbol.padEnd(20)} ${lines.join('  ·  ')}`)
    for (const problem of problems) {
      console.log(`        ${problem}`)
      report.failures.push(`${symbol}: ${problem}`)
    }
  }
}

console.log('')
console.log('='.repeat(78))
console.log(`RESULT: ${report.pass} pass, ${report.fail} fail  (${SYMBOLS.length} symbols)`)
if (report.extras.length > 0) {
  console.log(`note: ${report.extras.length} tool-only definition row(s), e.g.`)
  for (const extra of report.extras.slice(0, 4)) console.log('  ' + extra)
}
if (report.fail > 0) {
  console.log('FAILURES:')
  for (const failure of report.failures) console.log('  ' + failure)
  process.exitCode = 1
}
