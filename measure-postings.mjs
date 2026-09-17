/**
 * CHANGE 4 PROTOTYPE + MEASUREMENT — occurrence postings for use-sites.
 *
 * The index holds DECLARATIONS AND IMPL HEADERS ONLY. Everything about *uses*
 * goes through `scanText`, which for every mention scan re-reads every indexed
 * file from disk and loops `filePaths × needles`. On the Zed checkout that is
 * 2,013 file reads per call, paid again on every call.
 *
 * The proposal: during the existing walk — where the file text is already in
 * memory — record `token -> (fileId, line)` postings, so a mention scan becomes
 * a lookup plus a bounded re-read of only the matched files.
 *
 * This file is the prototype AND the measurement. It exists because Change 4's
 * gate is a measurement, not an argument, and because the decision recorded in
 * the README is "do not land it", which has to be justified with numbers.
 *
 * THE HARD SEMANTIC REQUIREMENT. `mentions.count` is a true SUBSTRING count
 * (`countOccurrences`). Any postings index yields a TOKEN count, and the two
 * differ. This prototype therefore preserves the substring count exactly:
 *
 *   - postings are keyed by the maximal IDENTIFIER RUN of each line, lowercased;
 *   - a needle that lies inside one run can only occur in a line whose run
 *     contains it, so "every key that CONTAINS the needle" is a complete superset
 *     of the matching lines — it cannot miss one;
 *   - the candidate files are then re-read and counted with the same
 *     `countOccurrences`, so the number stays the substring count.
 *
 * Subtoken keys (as the handoff sketches) CANNOT do this: a needle like `xtMenu`
 * occurs inside the run `ContextMenu` but inside none of its subtokens, so a
 * subtoken lookup under-counts and a postings-derived negative would be false.
 *
 * WHAT THE MEASUREMENT CAUGHT. The first version tokenised with `[A-Za-z0-9]+`,
 * which cannot contain a needle with an underscore in it. Every snake_case
 * needle — most Rust symbols, the primary use case — would have selected ZERO
 * candidate files and reported a confident count of 0. That is the
 * silent-wrong-number failure this plugin's whole discipline exists to prevent,
 * and it was invisible until a snake_case needle was actually timed. The
 * tokeniser is now `[A-Za-z0-9_$]+`, and a needle containing anything outside
 * that class (a qualified `a::b`, a literal with a space) cannot be narrowed by
 * containment at all, so it falls back to a full scan rather than guessing.
 *
 * The comparison is like-for-like. The tool counts occurrences of the name it
 * RESOLVED, not of the raw query — `gpui::Focusable` resolves to `Focusable` via
 * the path-segment tier and reports that name's count — so `baseline` writes its
 * resolved name and count to a JSON artifact and the postings modes compare
 * against that same string. Comparing against the raw query instead is how the
 * first run appeared to disagree by 435 vs 7.
 *
 * Usage:
 *   node --expose-gc measure-postings.mjs baseline
 *   node --expose-gc measure-postings.mjs postings
 *   node --expose-gc measure-postings.mjs postings-files
 *   SYMBOL_INDEX_FIXTURE=<dir> ... (default: the vendored Zed checkout)
 *
 * `postings-files` is the same prototype with the line numbers dropped: since the
 * count is recomputed by re-reading the candidate files, only the candidate FILE
 * set is needed, and one entry per (token, file) is much smaller than one per
 * (token, line). It is measured so the memory axis is explored rather than
 * assumed — but it is a different change from the one specified, and it is not
 * landed either.
 *
 * Each mode runs in its own process so the heap numbers are not one mode's
 * garbage measured inside the other.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadTool, mockExec } from './harness.mjs'

const MODULE = new URL('./lib/index.js', import.meta.url).pathname
const DEFAULT_ROOT = '/home/chaosbolt/.cargo/git/checkouts/zed-a70e2ad075855582/87a1ea3'
const ROOT = process.env.SYMBOL_INDEX_FIXTURE ?? DEFAULT_ROOT
const MODE = process.argv[2]
const MODES = ['baseline', 'postings', 'postings-files']
const ARTIFACT = '/tmp/dsh-symbol-index-postings-baseline.json'

/** Line numbers are packed into the same integer as the file id. */
const LINE_STRIDE = 1 << 21

/**
 * The needles the mention path is timed on, chosen for their occurrence counts
 * and their SHAPE: ubiquitous, mid-frequency, rare, never-present, snake_case
 * (the shape the first tokeniser silently broke on), and qualified (which cannot
 * be narrowed by containment at all). The A/B's own complaint was about
 * unresolved symbols, so the zero-hit case matters most.
 */
const NEEDLES = ['Context', 'Focusable', 'Picker', 'TerminalPanel', 'FocusOnlyModal',
  'NoSuchSymbolXYZ123', 'focus_handle', 'gpui::Focusable']

const mb = (bytes) => Math.round(bytes / 1048576 * 10) / 10

/** Sample `heapUsed` while work is in flight. */
function sampler() {
  let peak = process.memoryUsage().heapUsed
  const timer = setInterval(() => {
    const used = process.memoryUsage().heapUsed
    if (used > peak) peak = used
  }, 5)
  timer.unref()
  return {
    stop() {
      clearInterval(timer)
      const used = process.memoryUsage().heapUsed
      if (used > peak) peak = used
      return peak
    },
  }
}

/** Retained heap, with a real collection when the runtime exposes one. */
function retained() {
  if (typeof global.gc === 'function') global.gc()
  return process.memoryUsage().heapUsed
}

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

function looksBinary(head) {
  for (let index = 0; index < head.length; index += 1) {
    if (head.charCodeAt(index) === 0) return true
  }
  return false
}

/**
 * Every lowercased maximal identifier run on a line. The `_` is INSIDE the run:
 * a snake_case needle must be found by containment, and `[A-Za-z0-9]+` cannot
 * contain one — see "WHAT THE MEASUREMENT CAUGHT" above.
 */
function runsOf(line) {
  const runs = []
  const expression = /[A-Za-z0-9_$]+/g
  let match = expression.exec(line)
  while (match !== null) {
    runs.push(match[0].toLowerCase())
    match = expression.exec(line)
  }
  return runs
}

/** A needle that lies wholly inside one identifier run, so containment can find it. */
const NARROWABLE = /^[A-Za-z0-9_$]+$/

/** Walk exactly the way the plugin's index walk does, reading each file once. */
function walkAndIndex(storeLines) {
  const include = ['.rs', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi', '.go']
  const excludeDirs = ['.git', '.hg', '.svn', 'node_modules', 'target', 'dist', 'build', 'out',
    '.venv', 'venv', '__pycache__', '.next', '.cache', '.tox', '.mypy_cache', '.pytest_cache',
    'vendor', '.idea', '.vscode', '.gradle']
  const postings = new Map()
  const filePaths = []
  const queue = [{ path: ROOT, relative: '' }]
  while (queue.length > 0) {
    const current = queue.shift()
    let info
    try {
      info = statSync(current.path)
    } catch (error) {
      continue
    }
    if (!info.isDirectory()) continue
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      const childRelative = current.relative === '' ? entry.name : current.relative + '/' + entry.name
      if (entry.isDirectory()) {
        if (excludeDirs.includes(entry.name)) continue
        queue.push({ path: join(current.path, entry.name), relative: childRelative })
        continue
      }
      if (!entry.isFile()) continue
      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
      if (!include.includes(extension)) continue
      const path = join(current.path, entry.name)
      let size
      try {
        size = statSync(path).size
      } catch (error) {
        continue
      }
      if (size > 2000000) continue
      let text
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        continue
      }
      if (looksBinary(text.slice(0, 8192))) continue
      const fileId = filePaths.length
      filePaths.push(childRelative)
      const lines = text.split('\n')
      for (let number = 0; number < lines.length; number += 1) {
        for (const run of runsOf(lines[number])) {
          const packed = storeLines ? fileId * LINE_STRIDE + number : fileId
          const bucket = postings.get(run)
          if (bucket === undefined) postings.set(run, [packed])
          else if (bucket[bucket.length - 1] !== packed) bucket.push(packed)
        }
      }
    }
  }
  return { postings, filePaths }
}

/** Mention lookup: containing keys -> candidate files -> exact substring count. */
function mentionsViaPostings(index, needle, cap, storeLines) {
  const lowered = needle.toLowerCase()
  const candidateFiles = new Set()
  const narrowable = NARROWABLE.test(needle)
  if (narrowable) {
    for (const [token, packedEntries] of index.postings) {
      if (!token.includes(lowered)) continue
      for (const packed of packedEntries) {
        candidateFiles.add(storeLines ? Math.floor(packed / LINE_STRIDE) : packed)
      }
    }
  } else {
    // A needle with a separator in it (`gpui::Focusable`, `a b`) is not contained
    // in any single run, so the postings cannot narrow it. Scanning every file is
    // the only honest answer; guessing here is what produces a confident wrong
    // count.
    for (let fileId = 0; fileId < index.filePaths.length; fileId += 1) candidateFiles.add(fileId)
  }
  let count = 0
  const sites = []
  const filesTouched = candidateFiles.size
  for (const fileId of candidateFiles) {
    let text
    try {
      text = readFileSync(join(ROOT, index.filePaths[fileId]), 'utf8')
    } catch (error) {
      continue
    }
    const lines = text.split('\n')
    for (let position = 0; position < lines.length; position += 1) {
      const found = countOccurrences(lines[position], needle)
      if (found === 0) continue
      count += found
      if (sites.length < cap) sites.push({ path: index.filePaths[fileId], line: position + 1 })
    }
  }
  return { count, sites, filesTouched, narrowable }
}

if (!MODES.includes(MODE)) {
  console.error('usage: node --expose-gc measure-postings.mjs ' + MODES.join('|'))
  process.exit(2)
}

console.log('mode:', MODE, '· root:', ROOT)
const baselineBefore = retained()
const sample = sampler()

if (MODE === 'baseline') {
  // Today's behaviour: the plugin's own index, then mention scans that re-read
  // every indexed file from disk.
  const { tool } = await loadTool(MODULE, {})
  const built = await tool.execute({ symbols: NEEDLES, path: ROOT }, mockExec(ROOT))
  const afterBuild = retained()
  const peak = sample.stop()
  console.log('files indexed:', built.index.files, '· build ms:', built.index.builtMs)
  console.log('heap before:', mb(baselineBefore), 'MB · retained after build:',
    mb(afterBuild), 'MB · delta:', mb(afterBuild - baselineBefore), 'MB')
  console.log('peak sampled heap:', mb(peak), 'MB · delta:', mb(peak - baselineBefore), 'MB')
  console.log('index retained delta is the WHOLE plugin index (definitions, impls, maps),')
  console.log('of which the postings prototype is compared against the standalone cost of.')
  const timings = []
  for (const needle of NEEDLES) {
    const started = Date.now()
    const value = await tool.execute({ symbols: [needle], path: ROOT, mentions: true }, mockExec(ROOT))
    const elapsed = Date.now() - started
    const symbol = value.symbols[0]
    timings.push({ needle, matchedName: symbol.matchedName, count: symbol.mentions.count, elapsed })
    console.log(`mention scan ${needle.padEnd(20)} ${String(elapsed).padStart(6)}ms`
      + ` · resolved ${symbol.matchedName.padEnd(16)} · count ${symbol.mentions.count}`
      + ` · files re-read ${built.index.files}`)
  }
  writeFileSync(ARTIFACT, JSON.stringify({
    root: ROOT,
    files: built.index.files,
    retainedDeltaMb: mb(afterBuild - baselineBefore),
    peakDeltaMb: mb(peak - baselineBefore),
    buildMs: built.index.builtMs,
    timings,
  }, null, 2))
  console.log('baseline written to', ARTIFACT)
} else {
  const storeLines = MODE === 'postings'
  const baselineRun = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  if (baselineRun.root !== ROOT) {
    console.error('the baseline artifact is for a different root:', baselineRun.root)
    process.exit(2)
  }
  const buildStarted = Date.now()
  const index = walkAndIndex(storeLines)
  const buildMs = Date.now() - buildStarted
  const afterBuild = retained()
  const peak = sample.stop()
  let postings = 0
  for (const bucket of index.postings.values()) postings += bucket.length
  console.log('files indexed:', index.filePaths.length, '· build ms:', buildMs
    + ' (plugin baseline ' + baselineRun.buildMs + 'ms)')
  console.log('postings entries:', postings, '· distinct runs:', index.postings.size,
    storeLines ? '(with line numbers)' : '(file ids only)')
  console.log('heap before:', mb(baselineBefore), 'MB · retained after build:',
    mb(afterBuild), 'MB · delta:', mb(afterBuild - baselineBefore), 'MB')
  console.log('peak sampled heap:', mb(peak), 'MB · delta:', mb(peak - baselineBefore), 'MB')
  let mismatches = 0
  const timings = []
  for (const baseline of baselineRun.timings) {
    // Count the string the baseline actually counted. The tool reports the
    // occurrences of the name it RESOLVED, which for `gpui::Focusable` is
    // `Focusable` — the path-segment tier resolved it.
    const needle = baseline.matchedName
    const started = Date.now()
    const result = mentionsViaPostings(index, needle, 12, storeLines)
    const elapsed = Date.now() - started
    const match = result.count === baseline.count
    if (!match) mismatches += 1
    timings.push({ needle, rawQuery: baseline.needle, elapsed, count: result.count,
      baselineCount: baseline.count, match, files: result.filesTouched, narrowable: result.narrowable })
    console.log(`${(match ? 'MATCH  ' : 'MISMATCH').padEnd(9)} ${baseline.needle.padEnd(20)}`
      + ` baseline ${String(baseline.elapsed).padStart(4)}ms/${baseline.count}`
      + ` · postings ${String(elapsed).padStart(4)}ms/${result.count}`
      + ` · files re-read ${String(result.filesTouched).padStart(4)}/${index.filePaths.length}`
      + (result.narrowable ? '' : ' (not narrowable — full scan)'))
  }
  console.log('count mismatches against the plugin:', mismatches)
  console.log('JSON', JSON.stringify({
    mode: MODE,
    retainedDeltaMb: mb(afterBuild - baselineBefore),
    peakDeltaMb: mb(peak - baselineBefore),
    files: index.filePaths.length,
    postings,
    distinctRuns: index.postings.size,
    buildMs,
    mismatches,
    timings,
  }))
  if (mismatches > 0) process.exitCode = 1
}
