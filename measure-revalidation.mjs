/**
 * REVALIDATION COST — the measurement the write-triggered invalidation change
 * needs on its own.
 *
 * The change makes a REUSED index re-check itself against the working tree before
 * it answers (see `indexIsFresh` in lib/index.js). That is strictly more work per
 * warm call than serving the pooled build blindly, and it is only defensible if
 * the extra work is small next to the answer it protects. This measures it on the
 * vendored Zed checkout: how long revalidation takes when nothing changed, how
 * many filesystem probes it costs, and what happens when something did change.
 *
 * Usage:
 *   node --expose-gc measure-revalidation.mjs
 *   SYMBOL_INDEX_FIXTURE=<dir> node --expose-gc measure-revalidation.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadTool, mockExec, realFs } from './harness.mjs'

const MODULE = new URL('./lib/index.js', import.meta.url).pathname
const DEFAULT_ROOT = '/home/chaosbolt/.cargo/git/checkouts/zed-a70e2ad075855582/87a1ea3'
const ROOT = process.env.SYMBOL_INDEX_FIXTURE ?? DEFAULT_ROOT
/**
 * Two symbol sets on purpose. The warm cost of REVALIDATION can only be read
 * from a call that does nothing else: an unresolved name triggers the mention
 * text scan, which re-reads every indexed file and would swamp it. The negative
 * set is measured separately, because that is the call the footgun lives in.
 */
const RESOLVING = ['Focusable', 'Context']
const WITH_NEGATIVE = ['Focusable', 'NoSuchSymbolXYZ123']

let statCalls = 0
let resolveCalls = 0
const countingFs = {
  async resolve(path, opts) { resolveCalls += 1; return realFs.resolve(path, opts) },
  processPath(t) { return realFs.processPath(t) },
  async stat(t) { statCalls += 1; return realFs.stat(t) },
  async listDir(t) { return realFs.listDir(t) },
  async readText(t) { return realFs.readText(t) },
}

const { tool } = await loadTool(MODULE, {}, countingFs)
const call = (args) => tool.execute({ symbols: RESOLVING, path: ROOT, ...args }, mockExec(ROOT))

// ── cold build ──────────────────────────────────────────────────────────────
let started = Date.now()
const cold = await call({})
const coldMs = Date.now() - started
console.log('files indexed        :', cold.index.files)
console.log('cold build           :', coldMs + 'ms', '(plugin reports', cold.index.builtMs + 'ms)')
console.log('  probes in cold call:', statCalls, 'stat /', resolveCalls, 'resolve')
console.log('  reused:', cold.index.reused, '· validated:', cold.index.validated)

// ── warm call, tree untouched, every name resolving: REVALIDATION ONLY ─────
statCalls = 0
resolveCalls = 0
started = Date.now()
const warm = await call({})
const warmMs = Date.now() - started
const warmStat = statCalls
const warmResolve = resolveCalls
console.log('')
console.log('warm, unchanged      :', warmMs + 'ms   <- revalidation cost alone')
console.log('  probes:', warmStat, 'stat /', warmResolve, 'resolve')
console.log('  reused:', warm.index.reused, '· validated:', warm.index.validated,
  '· staleRebuilt:', warm.index.staleRebuilt, '· same id:', warm.index.id === cold.index.id)
console.log('  =>', (warmMs / coldMs * 100).toFixed(1) + '% of the cold build,',
  warmStat, 'stats for', cold.index.files, 'files')

// ── warm call that must answer a NEGATIVE: revalidation + mention scan ────
started = Date.now()
const negative = await tool.execute(
  { symbols: WITH_NEGATIVE, path: ROOT }, mockExec(ROOT))
const negativeMs = Date.now() - started
console.log('')
console.log('warm, with a negative:', negativeMs + 'ms',
  '(revalidation + the mention scan of', cold.index.files, 'files that was already there)')
console.log('  validated:', negative.index.validated, '· staleRebuilt:', negative.index.staleRebuilt,
  '· verdict:', negative.symbols[1].status)

// ── warm call after a real edit: detect + rebuild ─────────────────────────
const victim = join(ROOT, 'crates/gpui/src/gpui.rs')
const original = readFileSync(victim, 'utf8')
try {
  writeFileSync(victim, original + '\n// revalidation probe\n')
  started = Date.now()
  const edited = await call({})
  const editedMs = Date.now() - started
  console.log('')
  console.log('warm call after edit :', editedMs + 'ms')
  console.log('  reused:', edited.index.reused, '· validated:', edited.index.validated,
    '· staleRebuilt:', edited.index.staleRebuilt)
  console.log('  => the edit is reflected without `refresh: true`:',
    edited.symbols.find(s => s.name === 'Focusable') !== undefined)
} finally {
  writeFileSync(victim, original)
}

// ── warm call after the tree is restored ──────────────────────────────────
started = Date.now()
const restored = await call({})
console.log('')
console.log('warm call after revert:', (Date.now() - started) + 'ms · staleRebuilt:',
  restored.index.staleRebuilt)
console.log('')
console.log('JSON', JSON.stringify({
  files: cold.index.files,
  coldMs,
  coldBuiltMs: cold.index.builtMs,
  warmMs,
  warmStat,
  warmResolve,
  negativeMs,
  warmShareOfCold: Number((warmMs / coldMs).toFixed(3)),
  victim: victim.replace(ROOT + '/', ''),
  victimBytes: statSync(victim).size,
}))
