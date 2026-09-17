/**
 * Unit tests for `symbol-index.mjs` — run with `node --test`.
 *
 * Covers the classifier table per language family, trait-impl parsing including
 * generics and lifetimes, the case-insensitive fallback, cap/truncation
 * accounting, config accept/reject, the registry's output contract, and the
 * argument validation the registry does NOT do for a hand-rolled tool.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadTool, mockContext, mockExec, realFs, validateSubset, isLosslessJson, assertSupportedJsonSchema, assertRegistrationSchemas, HARNESS_CHECKOUT } from './harness.mjs'
import { evictIndexes } from './lib/index.js'

const MODULE = new URL('./lib/index.js', import.meta.url).pathname

/** Build a throwaway tree and return its root. */
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'symidx-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

evictIndexes()
test('Config accepts a minimal config and fills defaults', async () => {
  const { module } = await loadTool(MODULE, {})
  const validated = module.Config['~standard'].validate({})
  assert.equal(validated.issues, undefined)
  assert.equal(validated.value.toolName, 'find_symbol')
  assert.equal(validated.value.maxFiles, 20000)
  assert.ok(validated.value.include.includes('.rs'))
  assert.ok(validated.value.excludeDirs.includes('node_modules'))
})

evictIndexes()
test('Config rejects malformed config with actionable issues', async () => {
  const { module } = await loadTool(MODULE, {})
  const bad = module.Config['~standard'].validate({
    toolName: '',
    roots: 'not-an-array',
    maxFiles: -1,
    include: [1, 2],
    guidanceSection: 'yes',
  })
  const messages = bad.issues.map(issue => issue.message)
  assert.ok(messages.some(m => m.includes('toolName')), messages.join(' | '))
  assert.ok(messages.some(m => m.includes('roots')), messages.join(' | '))
  assert.ok(messages.some(m => m.includes('maxFiles')), messages.join(' | '))
  assert.ok(messages.some(m => m.includes('include')), messages.join(' | '))
  assert.ok(messages.some(m => m.includes('guidanceSection')), messages.join(' | '))
  assert.equal(module.Config['~standard'].validate(null).issues.length, 1)
})

evictIndexes()
test('registration declares the contract the registry requires', async () => {
  const { tool, sections } = await loadTool(MODULE, { toolName: 'find_symbol' })
  assert.equal(tool.name, 'find_symbol')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(typeof tool.timeoutMs, 'number')
  assert.equal(tool.isConcurrencySafe(), true)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].order, 116)
})

evictIndexes()
test('both registered schemas are inside the enforced subset (host checker, not a re-implementation)', async () => {
  const { tool } = await loadTool(MODULE, {})
  // The real registry assertion, imported from the harness checkout. Regression:
  // `status: { enum: [...] }` with no `type` passed every local check and then
  // failed the mount in a fresh preset session with
  // "schema.properties.symbols.items.properties.status.enum requires type or oneOf".
  assertRegistrationSchemas(tool)
  assert.equal(HARNESS_CHECKOUT, process.env.DSH_CHECKOUT ?? '/home/chaosbolt/deepseek-harness')
  // Every enum node must declare a type, which is the specific rule that bit.
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
    if (Object.hasOwn(node, 'enum')) {
      assert.ok(Object.hasOwn(node, 'type'), `${path}.enum without type is rejected by the registry`)
      assert.equal(node.type, 'string', `${path}.type must be string`)
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`)
  }
  walk(tool.output.schema, 'output.schema')
  assert.throws(() => assertSupportedJsonSchema({ type: 'object', properties: { s: { enum: ['a'] } } }), /requires type or oneOf/)
})

evictIndexes()
test('the rendered value satisfies output.schema and is lossless JSON', async () => {
  const root = fixtureTree({ 'a.rs': 'pub trait VisualContext: AppContext {\n}\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['VisualContext'], path: root }, mockExec(root))
  assert.deepEqual(validateSubset(tool.output.schema, value), [])
  assert.ok(isLosslessJson(value))
  const blocks = tool.output.render({ symbols: ['VisualContext'] }, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(typeof blocks[0].text, 'string')
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('execute validates its own arguments (the registry does not)', async () => {
  const { tool } = await loadTool(MODULE, {})
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n' })
  await assert.rejects(() => tool.execute({}, mockExec(root)), /pass `symbols`/)
  await assert.rejects(() => tool.execute({ symbols: [] }, mockExec(root)), /pass `symbols`/)
  await assert.rejects(() => tool.execute({ symbols: 'alpha' }, mockExec(root)), /must be an array/)
  await assert.rejects(() => tool.execute({ query: 'alpha', symbols: ['a'] }, mockExec(root)), /not both/)
  await assert.rejects(() => tool.execute({ query: '' }, mockExec(root)), /non-empty string/)
  await assert.rejects(() => tool.execute({ symbols: ['ok', ''] }, mockExec(root)), /non-empty string/)
  await assert.rejects(
    () => tool.execute({ symbols: Array.from({ length: 13 }, (_, i) => 's' + i) }, mockExec(root)),
    /at most 12/,
  )
  await assert.rejects(
    () => tool.execute({ symbols: ['a'], include: ['rs'] }, mockExec(root)),
    /starting with "\."/,
  )
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('rust definitions are classified by kind', async () => {
  const root = fixtureTree({
    'lib.rs': [
      'pub trait VisualContext: AppContext {',
      'pub struct Widget {',
      'pub(crate) enum Mode {',
      'pub union Bits {',
      'pub async fn render() {}',
      'pub(crate) const MAX: usize = 1;',
      'pub static NAME: &str = "x";',
      'macro_rules! helper {',
      'pub type Alias = u8;',
      'mod inner {',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({
    symbols: ['VisualContext', 'Widget', 'Mode', 'Bits', 'render', 'MAX', 'NAME', 'helper', 'Alias', 'inner'],
    path: root,
  }, mockExec(root))
  const kinds = Object.fromEntries(value.symbols.map(s => [s.name, s.definitions[0]?.kind]))
  assert.deepEqual(kinds, {
    VisualContext: 'trait', Widget: 'struct', Mode: 'enum', Bits: 'union', render: 'fn',
    MAX: 'const', NAME: 'static', helper: 'macro', Alias: 'type', inner: 'mod',
  })
  assert.ok(value.symbols.every(s => s.status === 'defined'))
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('trait impls parse generics, lifetimes, and multiple impls of one trait', async () => {
  const root = fixtureTree({
    'gpui.rs': 'pub trait VisualContext: AppContext {\n}\n',
    'async_context.rs': 'impl VisualContext for AsyncWindowContext {\n}\n',
    'bench_context.rs': 'impl VisualContext for BenchWindowContext<\'_, \'_> {\n}\n',
    'test_context.rs': 'impl VisualContext for VisualTestContext {\n}\n',
    'generic.rs': 'impl<T: Send> VisualContext for Wrapper<T> where T: Clone {\n}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['VisualContext'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.status, 'defined')
  assert.equal(entry.impls.length, 4)
  const forTypes = entry.impls.map(i => i.forType)
  assert.ok(forTypes.includes('AsyncWindowContext'))
  assert.ok(forTypes.includes('BenchWindowContext<\'_, \'_>'))
  assert.ok(forTypes.includes('VisualTestContext'))
  assert.ok(forTypes.includes('Wrapper<T>'))
  assert.match(entry.verdict, /4 impl site\(s\) across 4 unique target type\(s\)/)
  assert.deepEqual(entry.implTargets, [...entry.implTargets].sort(), 'target names are sorted')
  for (const forType of forTypes) assert.ok(entry.implTargets.includes(forType), forType)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a trait with no definition but real impls is "impls-only", never absent', async () => {
  const root = fixtureTree({ 'a.rs': 'impl Outer for Inner {\n}\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['Outer'], path: root }, mockExec(root))
  assert.equal(value.symbols[0].status, 'impls-only')
  assert.match(value.symbols[0].verdict, /NO definition of "Outer"/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('an absent name reports absence as a final verdict after a text scan', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['NonexistentThing'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.status, 'absent')
  assert.match(entry.verdict, /ABSENT/)
  assert.match(entry.verdict, /no definition, no impl, and no textual mention/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a name that only appears as a mention is "mentions-only", not absent', async () => {
  const root = fixtureTree({
    'a.rs': 'pub fn alpha() {}\n',
    'b.rs': 'use crate::alpha;\npub fn beta(x: Shape) {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['Shape'], path: root }, mockExec(root))
  assert.equal(value.symbols[0].status, 'mentions-only')
  assert.match(value.symbols[0].verdict, /textual mention/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('case-insensitive fallback is reported', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn renderThing() {}\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['renderthing'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.status, 'defined')
  assert.equal(entry.name, 'renderthing')
  assert.equal(entry.matchedName, 'renderThing')
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /matched as renderThing/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('ts, python and go families classify their own keywords', async () => {
  const root = fixtureTree({
    'a.ts': 'export async function loadThing() {}\nexport interface Shape {}\nconst TABLE = {}\n',
    'b.py': 'class Widget:\n    pass\nasync def run_task():\n    pass\n',
    'c.go': 'func (r Recv) Handle() {}\ntype Thing struct{}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({
    symbols: ['loadThing', 'Shape', 'TABLE', 'Widget', 'run_task', 'Handle', 'Thing'],
    path: root,
  }, mockExec(root))
  const kinds = Object.fromEntries(value.symbols.map(s => [s.name, s.definitions[0]?.kind]))
  assert.equal(kinds.loadThing, 'function')
  assert.equal(kinds.Shape, 'interface')
  assert.equal(kinds.TABLE, 'const')
  assert.equal(kinds.Widget, 'class')
  assert.equal(kinds.run_task, 'def')
  assert.equal(kinds.Handle, 'func')
  assert.equal(kinds.Thing, 'type')
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('extension allow-list override excludes other languages', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n', 'b.py': 'def alpha():\n    pass\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['alpha'], path: root, include: ['.rs'] }, mockExec(root))
  assert.equal(value.symbols[0].definitions.length, 1)
  assert.equal(value.symbols[0].definitions[0].path.endsWith('.rs'), true)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('excluded directories are pruned and never indexed', async () => {
  const root = fixtureTree({
    'keep.rs': 'pub fn alpha() {}\n',
    'node_modules/dep.rs': 'pub fn alpha() {}\n',
    'target/gen.rs': 'pub fn alpha() {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['alpha'], path: root }, mockExec(root))
  assert.equal(value.symbols[0].definitions.length, 1)
  assert.equal(value.index.files, 1)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('oversized files are skipped and counted, and the cap reports truncation', async () => {
  const big = 'pub fn bigOne() {}\n' + '// pad\n'.repeat(200)
  const root = fixtureTree({ 'small.rs': 'pub fn smallOne() {}\n', 'big.rs': big })

  const tinyCap = (await loadTool(MODULE, { maxFileBytes: 20 })).tool
  const allSkipped = await tinyCap.execute({ symbols: ['smallOne'], path: root }, mockExec(root))
  assert.equal(allSkipped.index.files, 0)
  assert.equal(allSkipped.index.skipped, 2)
  // v2: an index that read NOTHING can never pronounce a name absent. The old
  // "absent" here was a confident negative derived from zero evidence, which is
  // exactly the failure mode that sent an agent back to grep.
  assert.equal(allSkipped.index.partial, true)
  assert.equal(allSkipped.symbols[0].status, 'inconclusive')
  assert.match(allSkipped.symbols[0].verdict, /NOT a final negative/)

  const sizedCap = (await loadTool(MODULE, { maxFileBytes: 200 })).tool
  const value = await sizedCap.execute({ symbols: ['smallOne', 'bigOne'], path: root }, mockExec(root))
  assert.equal(value.index.files, 1)
  assert.equal(value.index.skipped, 1)
  assert.equal(value.index.partial, true, 'a skipped file makes the coverage partial')
  assert.equal(value.symbols[0].status, 'defined')
  // bigOne lives in the file the cap skipped, so its absence is unknowable.
  assert.equal(value.symbols[1].status, 'inconclusive')

  const truncTool = (await loadTool(MODULE, { maxFiles: 1 })).tool
  const truncated = await truncTool.execute({ symbols: ['smallOne'], path: root }, mockExec(root))
  assert.equal(truncated.index.truncated, true)
  const text = truncTool.output.render({}, truncated)[0].text
  assert.match(text, /coverage: INCOMPLETE/)
  assert.match(text, /stopped at a cap/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the index is reused on a second call and rebuilt on refresh', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n' })
  const { tool } = await loadTool(MODULE, {})
  const first = await tool.execute({ symbols: ['alpha'], path: root }, mockExec(root))
  assert.equal(first.index.reused, false)
  const second = await tool.execute({ symbols: ['alpha'], path: root }, mockExec(root))
  assert.equal(second.index.reused, true)
  assert.equal(second.index.id, first.index.id)
  const third = await tool.execute({ symbols: ['alpha'], path: root, refresh: true }, mockExec(root))
  assert.equal(third.index.reused, false)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('duplicate symbols collapse and the render stays within maxOutputChars', async () => {
  const files = {}
  for (let i = 0; i < 40; i += 1) files[`f${i}.rs`] = `pub fn sym${i}() {}\n`
  const root = fixtureTree(files)
  const { tool } = await loadTool(MODULE, { maxOutputChars: 500 })
  const names = Array.from({ length: 8 }, (_, i) => 'sym' + i)
  const value = await tool.execute({ symbols: names.concat(names) }, mockExec(root))
  assert.equal(value.symbols.length, 8)
  const text = tool.output.render({}, value)[0].text
  assert.ok(text.length <= 500 + 200, 'rendered length ' + text.length)
  assert.match(text, /output truncated/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a missing root is a hard error naming the nearest existing directory and its candidates', async () => {
  const parent = fixtureTree({
    'crates/terminal_panel.rs': 'pub struct TerminalPanel {}\n',
    'crates/terminal_view.rs': 'pub struct TerminalView {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  await assert.rejects(
    () => tool.execute({ symbols: ['x'], path: parent + '/crates/terminal_panel.rs.bak' }, mockExec(parent)),
    (error) => {
      // The three things a caller needs to fix the call instead of re-guessing.
      assert.match(error.message, /NOTHING WAS SEARCHED/)
      assert.match(error.message, new RegExp('nearest existing directory: ' + parent + '/crates'))
      assert.match(error.message, /closest names in it: .*terminal_panel\.rs/)
      assert.match(error.message, /No index was built and no file was read/)
      return true
    },
  )
  // A bare word is more likely a symbol than a path, and the message says so.
  await assert.rejects(
    () => tool.execute({ symbols: ['TerminalPanel'], path: 'TerminalPanel' }, mockExec(parent)),
    /looks like a SYMBOL NAME, not a path/,
  )
  rmSync(parent, { recursive: true, force: true })
})

evictIndexes()
test('concurrent calls single-flight the index build', async () => {
  const files = {}
  for (let i = 0; i < 60; i += 1) files[`f${i}.rs`] = `pub fn alpha${i}() {}\n`
  const root = fixtureTree(files)
  const { tool } = await loadTool(MODULE, {})
  const [a, b] = await Promise.all([
    tool.execute({ symbols: ['alpha1'], path: root }, mockExec(root)),
    tool.execute({ symbols: ['alpha2'], path: root }, mockExec(root)),
  ])
  assert.equal(a.index.id, b.index.id)
  assert.ok(a.index.reused || b.index.reused, 'one of the two calls reused the shared build')
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('realFs mirrors the contract the plugin consumes', async () => {
  const t = await realFs.resolve('/tmp')
  assert.equal((await realFs.stat(t)).type, 'directory')
  const entries = await realFs.listDir(t)
  assert.ok(entries.every(entry => typeof entry.name === 'string' && typeof entry.type === 'string'))
  assert.equal(realFs.processPath(t), '/tmp')
})

evictIndexes()
test('a different indexing policy never reuses another policy index', async () => {
  const root = fixtureTree({ 'small.rs': 'pub fn smallOne() {}\n', 'big.rs': 'pub fn bigOne() {}\n' + '// p\n'.repeat(100) })
  const wide = (await loadTool(MODULE, { maxFileBytes: 100000 })).tool
  const narrow = (await loadTool(MODULE, { maxFileBytes: 30 })).tool
  const a = await wide.execute({ symbols: ['bigOne'], path: root }, mockExec(root))
  const b = await narrow.execute({ symbols: ['bigOne'], path: root }, mockExec(root))
  assert.equal(a.index.files, 2)
  assert.equal(b.index.files, 1)
  assert.equal(b.index.reused, false, 'a different maxFileBytes must not reuse the pooled index')
  assert.notEqual(a.index.id, b.index.id)
  rmSync(root, { recursive: true, force: true })
})

test('a second mounted instance (another agent) reuses the process-level index', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n', 'b.rs': 'pub fn beta() {}\n' })
  // Two independent modules simulate two agents mounting the same preset; the
  // pool is module scope, so the second import observes a fresh cache while the
  // two tools built from ONE import share it.
  const { tool: first } = await loadTool(MODULE, {})
  const { tool: second } = await loadTool(MODULE, {})
  const a = await first.execute({ symbols: ['alpha'], path: root }, mockExec(root))
  const b = await second.execute({ symbols: ['beta'], path: root }, mockExec(root))
  assert.equal(a.index.id, b.index.id, 'two mounts of one preset must share one index')
  assert.equal(b.index.reused, true)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v2: the defects the A/B found, and the guarantees that replace them.
// ---------------------------------------------------------------------------

evictIndexes()
test('a qualified-path trait impl is attributed to the trait (the A/B defect)', async () => {
  // Ground truth from the vendored Zed checkout, crates/terminal_view/src/
  // terminal_panel.rs:2494 — `impl gpui::Focusable for FocusOnlyModal`. v1 stored
  // the trait as the literal "gpui::Focusable" and compared it to "Focusable",
  // so every qualified-path impl was indexed and then silently dropped. The A/B
  // found this as a 189-vs-190 gap; it is also why arm B spent 25,697 chars of
  // grep re-deriving the set by hand.
  const root = fixtureTree({
    'window.rs': 'pub trait Focusable: Sized {\n}\n',
    'panel.rs': 'impl gpui::Focusable for FocusOnlyModal {\n}\n',
    'plain.rs': 'impl Focusable for PlainThing {\n}\n',
    'generics.rs': "impl<T> Focusable for Wrapper<T> {\n}\n",
    'nested.rs': 'impl<F: Fn() -> Vec<u8>> Focusable for Hooked<F> {\n}\n',
    'negative.rs': 'impl !Send for FocusOnlyModal {\n}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['Focusable'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.status, 'defined')
  assert.equal(entry.implsTotal, 4, 'qualified, plain, generic and nested-generic impls all count')
  assert.deepEqual(entry.implTargets, ['FocusOnlyModal', 'Hooked<F>', 'PlainThing', 'Wrapper<T>'])
  // The written qualified path is preserved verbatim on the row, so the caller
  // can still tell `gpui::Focusable` from a local `Focusable` by eye.
  assert.ok(entry.impls.some(impl => impl.trait === 'gpui::Focusable'))
  // A negative impl is still an impl of that trait, and is indexed as one.
  const negative = await tool.execute({ symbols: ['Send'], path: root }, mockExec(root))
  assert.deepEqual(negative.symbols[0].implTargets, ['FocusOnlyModal'])
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('both sides of an impl resolve: what implements X, and what X implements', async () => {
  // `grep -rn 'for FocusOnlyModal'` returned 4 rows where v1 returned 0, because
  // impls were only ever filtered on the TRAIT. That asymmetry is the single
  // largest grep-parity hole in v1.
  const root = fixtureTree({
    'a.rs': [
      'impl gpui::EventEmitter<gpui::DismissEvent> for FocusOnlyModal {}',
      'impl gpui::Focusable for FocusOnlyModal {',
      'impl Render for FocusOnlyModal {',
      'impl workspace::ModalView for FocusOnlyModal {}',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['FocusOnlyModal'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.implsForTotal, 4)
  assert.deepEqual(entry.implForTargets, [
    'Render', 'gpui::EventEmitter<gpui::DismissEvent>', 'gpui::Focusable', 'workspace::ModalView',
  ].sort())
  assert.equal(entry.implsTotal, 0, 'it is not itself a trait')
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /impl-of gpui::Focusable/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a multi-line impl header is parsed, not skipped', async () => {
  // rustfmt wraps long headers; a line-oriented pattern sees only `impl<A, B>`
  // and reports no impl at all.
  const root = fixtureTree({
    'a.rs': 'impl<A, B>\n    VisualContext\n    for Wrapped<A, B>\n    where\n    A: Send,\n{\n}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['VisualContext'], path: root }, mockExec(root))
  assert.equal(value.symbols[0].implsTotal, 1)
  assert.equal(value.symbols[0].implTargets[0], 'Wrapped<A, B>')
  const forSelf = await tool.execute({ symbols: ['Wrapped'], path: root }, mockExec(root))
  assert.equal(forSelf.symbols[0].implsForTotal, 1)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('an index that read nothing never pronounces a name absent', async () => {
  // Reproduces the worst v2 candidate bug: "ABSENT — no definition and no
  // textual mention anywhere in 0 indexed file(s) of this tree" was a FINAL
  // negative derived from zero evidence.
  const root = fixtureTree({ 'notes.md': '# nothing indexable here\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['Terminal'], path: root }, mockExec(root))
  assert.equal(value.index.files, 0)
  assert.equal(value.index.partial, true)
  assert.equal(value.symbols[0].status, 'inconclusive')
  assert.match(value.symbols[0].verdict, /NOT a final negative/)
  assert.match(value.index.coverage, /INCOMPLETE/)
  assert.match(value.index.coverage, /NOTHING was searched/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a pruned directory is disclosed as scope, and does not fake an incomplete answer', async () => {
  // quantum has 127 .rs on disk and 88 outside target/. v1 said "ABSENT … in 88
  // indexed file(s) OF THIS TREE", which reads as the whole tree; arm B spent a
  // 50,000-char `find | uniq -c` establishing the difference by hand. The policy
  // omission is now named, and `includeExcluded` can search it anyway.
  const root = fixtureTree({
    'keep.rs': 'pub fn alpha() {}\n',
    'target/gen.rs': 'pub fn generatedOnly() {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['alpha', 'generatedOnly'], path: root }, mockExec(root))
  assert.equal(value.index.files, 1)
  assert.equal(value.index.prunedDirs, 1)
  assert.deepEqual(value.index.prunedNames, ['target'])
  // A disclosed policy omission is not a LIMIT: the caller can see and override it.
  assert.equal(value.index.partial, false)
  assert.equal(value.symbols[0].status, 'defined')
  assert.equal(value.symbols[1].status, 'absent')
  assert.match(tool.output.render({}, value)[0].text, /PRUNED DIRS.*target/)

  const wide = await tool.execute(
    { symbols: ['generatedOnly'], path: root, includeExcluded: true }, mockExec(root))
  assert.equal(wide.index.files, 2)
  assert.equal(wide.symbols[0].status, 'defined')
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the report censuses what it did NOT search, so no `find | uniq -c` is needed', async () => {
  const root = fixtureTree({
    'a.rs': 'pub fn alpha() {}\n',
    'readme.md': 'docs\n',
    'data.json': '{}\n',
    'style.css': 'a{}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['alpha'], path: root }, mockExec(root))
  const extensions = value.index.notSearched.map(entry => entry.extension)
  assert.ok(extensions.includes('.md'), extensions.join(','))
  assert.ok(extensions.includes('.json'))
  assert.ok(extensions.includes('.css'))
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /NOT SEARCHED \(outside the allow-list\)/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('counts stay exact when rows are capped', async () => {
  // "never let the count disagree with the rows" — the failure mode that makes
  // an agent re-run the search to find out which half it got.
  const lines = []
  for (let index = 0; index < 30; index += 1) lines.push(`impl VisualContext for Type${index} {}`)
  const root = fixtureTree({ 'a.rs': 'pub trait VisualContext {}\n' + lines.join('\n') })
  const { tool } = await loadTool(MODULE, { maxSitesPerSymbol: 5 })
  const value = await tool.execute({ symbols: ['VisualContext'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.implsTotal, 30, 'the count is exact')
  assert.equal(entry.impls.length, 5, 'the detail rows are capped')
  assert.equal(entry.implTargetsTotal, 30, 'the target SET is complete by default, not paginated')
  assert.equal(entry.implTargets.length, 30)
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /impl-targets 30 unique type\(s\) from 30 impl site\(s\)/)
  assert.match(text, /Type29/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('query mode searches the tree for literal and regex text', async () => {
  const root = fixtureTree({
    'a.rs': 'pub fn alpha() {}\n// TODO: fix the widget\n',
    'b.rs': 'pub fn beta() {}\n// TODO: fix the gadget\n',
    'c.rs': 'pub fn gamma() {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const literal = await tool.execute({ query: 'TODO', path: root }, mockExec(root))
  assert.equal(literal.text.count, 2)
  assert.equal(literal.text.files, 2)
  assert.equal(literal.text.sites.length, 2)
  assert.deepEqual(literal.text.sites.map(site => site.line), [2, 2])
  assert.equal(literal.symbols.length, 0)

  const pattern = await tool.execute({ query: 'widget|gadget', regex: true, path: root }, mockExec(root))
  assert.equal(pattern.text.count, 2)
  assert.equal(pattern.text.regex, true)

  const none = await tool.execute({ query: 'absent-string-xyz', path: root }, mockExec(root))
  assert.equal(none.text.count, 0)
  assert.match(tool.output.render({}, none)[0].text, /0 match\(es\) in 0 file\(s\)/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('mentions: true returns use sites instead of forcing a grep', async () => {
  const root = fixtureTree({
    'def.rs': 'pub struct VisualContext {}\n',
    'use1.rs': 'use crate::VisualContext;\n',
    'use2.rs': 'fn f(x: VisualContext) {}\n',
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['VisualContext'], path: root, mentions: true }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.mentions.scanned, true)
  assert.ok(entry.mentions.count >= 2, 'def + two uses, got ' + entry.mentions.count)
  assert.ok(entry.mentions.sites.length >= 2)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the two impl counts are labelled, related, and never read as a cap', async () => {
  // The v2 A/B's only correctness regression: an arm read
  //   implements this trait (186)   ... beside ...   190 impl(s) of this trait
  // as "the list is capped at 186", then rebuilt the set by grep with a pattern
  // that could not match a 4-space-indented `impl gpui::Focusable for X`, losing
  // a target it had already been given. Both counts are legitimate — a generic
  // type may be implemented at several SITES — so the report must state the
  // relationship and mark completeness explicitly.
  const root = fixtureTree({
    'a.rs': [
      'pub trait Focusable {}',
      'impl Focusable for Plain {}',
      'impl Focusable for Wrapper<T> {}',
      'impl Focusable for Other {}',
    ].join('\n'),
    // The SAME target written at a second site: 4 impl sites, 3 unique types.
    'b.rs': 'impl Focusable for Plain {}',
  })
  const { tool } = await loadTool(MODULE, { maxSitesPerSymbol: 2 })
  const value = await tool.execute({ symbols: ['Focusable'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.implsTotal, 4, 'four impl sites')
  assert.equal(entry.implTargetsTotal, 3, 'three unique target types')
  const text = tool.output.render({}, value)[0].text

  // Both numbers present, adjacent to each other, and related.
  assert.match(text, /impl-sites 2 of 4 shown \(detail rows capped\)/)
  assert.match(text, /impl-targets 3 unique type\(s\) from 4 impl site\(s\)/)
  // The target list is complete, and says so; the cap applies only to site rows.
  assert.match(text, /COMPLETE list, do not re-derive it/)
  assert.doesNotMatch(text, /impl-targets 3 unique type\(s\) from 4 impl site\(s\) — CAPPED/)
  // And the verdict carries the same pairing rather than a bare count.
  assert.match(entry.verdict, /4 impl site\(s\) across 3 unique target type\(s\)/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a genuinely capped target list says CAPPED instead of COMPLETE', async () => {
  const lines = []
  for (let index = 0; index < 8; index += 1) lines.push(`impl VisualContext for Type${index} {}`)
  const root = fixtureTree({ 'a.rs': 'pub trait VisualContext {}\n' + lines.join('\n') })
  const { tool } = await loadTool(MODULE, { maxTargetNames: 3 })
  const value = await tool.execute({ symbols: ['VisualContext'], path: root }, mockExec(root))
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /impl-targets 8 unique type\(s\) from 8 impl site\(s\) — CAPPED, only 3 named/)
  assert.match(text, /\+5 more/)
  assert.doesNotMatch(text, /COMPLETE list/)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The drop-in grep/glob replacement (config.provideSearchTools).
// ---------------------------------------------------------------------------

evictIndexes()
test('provideSearchTools registers drop-in grep and glob', async () => {
  const off = await loadTool(MODULE, {})
  assert.deepEqual((off.sections ?? []).length, 1)
  const plain = await loadTool(MODULE, {})
  assert.equal(plain.tool.name, 'find_symbol')

  const on = await loadTool(MODULE, { provideSearchTools: true })
  const names = (on.capturedAll ?? []).map(entry => entry.name).sort()
  assert.deepEqual(names, ['find_symbol', 'glob', 'grep'])
  // The row's own tool is still the LAST registration, so nothing that reads
  // `captured.tool` (or a preset row named by config) sees a replacement.
  assert.equal(on.tool.name, 'find_symbol')
})

evictIndexes()
test('the replacement grep carries scope evidence, exact counts and a hard missing-path error', async () => {
  const root = fixtureTree({
    'a.rs': 'pub fn alpha() {}\n// TODO: fix\n',
    'b.rs': '// TODO: fix again\n',
    'c.py': '# TODO: python\n',
  })
  const { capturedAll } = await loadTool(MODULE, { provideSearchTools: true })
  const grep = capturedAll.find(entry => entry.name === 'grep')
  assert.equal(typeof grep.execute, 'function')
  assertRegistrationSchemas(grep)

  // Exact total, capped rows.
  const value = await grep.execute({ pattern: 'TODO', path: root }, mockExec(root))
  assert.deepEqual(validateSubset(grep.output.schema, value), [])
  assert.equal(value.count, 3)
  assert.equal(value.files, 3)
  assert.equal(value.sites.length, 3)
  const text = grep.output.render({}, value)[0].text
  assert.match(text, /^grep "TODO" · 3 match\(es\) in 3 file\(s\)/)
  assert.match(text, /^SEARCHED: /m)
  assert.match(text, /^coverage: /m)

  // A negative says its scope is the whole basis for the answer.
  const none = await grep.execute({ pattern: 'nothing-here-xyz', path: root }, mockExec(root))
  assert.equal(none.count, 0)
  assert.match(grep.output.render({}, none)[0].text, /negative is final for that scope/)

  // Regex mode.
  const rx = await grep.execute({ pattern: 'TO+DO', regex: true, path: root }, mockExec(root))
  assert.equal(rx.count, 3)

  // A missing path is a hard error that names the nearest existing directory,
  // exactly like find_symbol — never an empty result.
  await assert.rejects(
    () => grep.execute({ pattern: 'TODO', path: root + '/nope.rs' }, mockExec(root)),
    (error) => {
      // The message names the tool the caller actually used, and says nothing
      // was searched — the whole point for a drop-in grep.
      assert.match(error.message, /^grep: NOTHING WAS SEARCHED/)
      assert.match(error.message, /nearest existing directory/)
      assert.match(error.message, /no file was read/)
      return true
    },
  )
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the replacement glob serves the walked files and explains exclusions', async () => {
  const root = fixtureTree({
    'src/a.rs': 'fn a() {}\n',
    'src/deep/b.rs': 'fn b() {}\n',
    'Cargo.toml': '[package]\n',
    'notes.md': 'x\n',
  })
  const { capturedAll } = await loadTool(MODULE, { provideSearchTools: true })
  const glob = capturedAll.find(entry => entry.name === 'glob')
  assertRegistrationSchemas(glob)

  const all = await glob.execute({ pattern: '**/*.rs', path: root }, mockExec(root))
  assert.deepEqual(validateSubset(glob.output.schema, all), [])
  assert.deepEqual(all.paths, ['src/a.rs', 'src/deep/b.rs'])

  // A basename-only pattern matches at any depth.
  const base = await glob.execute({ pattern: '*.rs', path: root }, mockExec(root))
  assert.equal(base.count, 2)

  // A single star does not cross a separator.
  const shallow = await glob.execute({ pattern: 'src/*.rs', path: root }, mockExec(root))
  assert.deepEqual(shallow.paths, ['src/a.rs'])

  // Non-source files must be found: serving glob from the index's allow-list
  // would silently lose Cargo.toml, which is a capability regression against
  // the built-in this replaces.
  const config = await glob.execute({ pattern: '*.toml', path: root }, mockExec(root))
  assert.deepEqual(config.paths, ['Cargo.toml'])
  const anyMd = await glob.execute({ pattern: '**/*.md', path: root }, mockExec(root))
  assert.deepEqual(anyMd.paths, ['notes.md'])

  const text = glob.output.render({}, all)[0].text
  assert.match(text, /^glob "\*\*\/\*\.rs" · 2 file\(s\)/)
  assert.match(text, /^coverage: /m)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v2.1: index-age disclosure.
// ---------------------------------------------------------------------------

evictIndexes()
test('a reused index discloses its age; a fresh build claims none', async () => {
  // The pool serves a build for indexTtlMs (10 minutes), so an edit inside that
  // window is invisible and an `absent` verdict can be final for a tree that no
  // longer exists. Date.now is driven here so the disclosed age is asserted
  // exactly rather than "some number went up".
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n' })
  const { tool } = await loadTool(MODULE, {})

  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  try {
    const first = await tool.execute({ symbols: ['alpha'], path: root }, mockExec(root))
    assert.equal(first.index.reused, false)
    assert.equal(first.index.ageMs, 0, 'a build this same call performed has no age to disclose')
    const freshText = tool.output.render({}, first)[0].text
    assert.match(freshText, /\(built in \d+ms\)/)
    assert.doesNotMatch(freshText, /index staleness/)

    offset = 90_000
    const second = await tool.execute(
      { symbols: ['alpha', 'NotDefinedAnywhere'], path: root }, mockExec(root))
    assert.equal(second.index.reused, true)
    assert.ok(second.index.ageMs >= 90_000, 'disclosed age ' + second.index.ageMs)
    const warmText = tool.output.render({}, second)[0].text
    assert.match(warmText, /reused — built 1m3\ds ago/)
    // The dangerous case: an absent verdict reached through a REUSED index is
    // accompanied by the age and the staleness line — the verdict itself stays
    // `absent` (accompanied, not downgraded; see INDEX_STALENESS_NOTE).
    assert.equal(second.symbols[1].status, 'absent')
    assert.match(warmText, /verdict \[absent\]/)
    assert.match(warmText, /index staleness: a negative below is final for that build, not for the tree as it is now/)
  } finally {
    Date.now = realNow
  }
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the replacement grep carries the same index-age disclosure', async () => {
  const root = fixtureTree({ 'a.rs': 'pub fn alpha() {}\n' })
  const { capturedAll } = await loadTool(MODULE, { provideSearchTools: true })
  const grep = capturedAll.find(entry => entry.name === 'grep')

  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  try {
    await grep.execute({ pattern: 'alpha', path: root }, mockExec(root))
    offset = 120_000
    const warm = await grep.execute({ pattern: 'alpha', path: root }, mockExec(root))
    assert.equal(warm.index.reused, true)
    assert.ok(warm.index.ageMs >= 120_000, 'disclosed age ' + warm.index.ageMs)
    assert.deepEqual(validateSubset(grep.output.schema, warm), [])
    assert.match(grep.output.render({}, warm)[0].text,
      /index staleness: a negative below is final for that build/)
  } finally {
    Date.now = realNow
  }
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v2.1: near-miss candidates on an absent verdict.
// ---------------------------------------------------------------------------

evictIndexes()
test('an absent symbol names its closest indexed candidates and stays absent', async () => {
  // A bare `absent` is what incites an agent to start guessing spellings —
  // exactly the name-enumeration waste this tool exists to remove. The bad-PATH
  // ranker already names the closest entries; a bad SYMBOL now does too.
  const root = fixtureTree({
    'lib.rs': [
      'pub fn get_user_by_id(id: u64) {}',
      'pub fn process_payment(amount: u64) {}',
      'pub fn renderReport() {}',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['process_paymnet'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  // A plausible transposition, NOT a convention difference (that is a
  // different, stricter tier — see the subtoken tests).
  assert.equal(entry.status, 'absent', 'a candidate list never changes the verdict')
  assert.equal(entry.definitions.length, 0)
  assert.equal(entry.nearMissDistance, 3)
  assert.ok(entry.nearMiss.includes('process_payment'), entry.nearMiss.join(', '))
  assert.ok(!entry.nearMiss.includes('get_user_by_id'), 'unrelated names are not candidates')

  const text = tool.output.render({}, value)[0].text
  assert.match(text, /verdict \[absent\]/)
  assert.match(text, /near-miss \d+ of \d+ name\(s\) within edit distance 3 of "process_paymnet"/)
  assert.match(text, /advisory — the verdict above is unchanged/)
  assert.match(text, /process_payment/)
  assert.deepEqual(validateSubset(tool.output.schema, value), [])
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a name with nothing close enough gets no near-miss list at all', async () => {
  const root = fixtureTree({ 'lib.rs': 'pub fn get_user_by_id(id: u64) {}\n' })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['ZzzQqqWwwEee'], path: root }, mockExec(root))
  assert.equal(value.symbols[0].status, 'absent')
  assert.deepEqual(value.symbols[0].nearMiss, [])
  assert.equal(value.symbols[0].nearMissTotal, 0)
  assert.doesNotMatch(tool.output.render({}, value)[0].text, /near-miss/)
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the near-miss list is capped and says how many candidates it is not showing', async () => {
  const files = {}
  for (let index = 0; index < 8; index += 1) files[`f${index}.rs`] = `pub fn worker_task_${index}() {}\n`
  const root = fixtureTree(files)
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({ symbols: ['worker_task_x'], path: root }, mockExec(root))
  const entry = value.symbols[0]
  assert.equal(entry.status, 'absent')
  assert.equal(entry.nearMissTotal, 8, 'all eight same-shaped names qualify')
  assert.equal(entry.nearMiss.length, 5, 'the list is capped')
  const text = tool.output.render({}, value)[0].text
  // Capped-list idiom: shown-of-total, then the remainder named as a remainder.
  assert.match(text, /near-miss 5 of 8 name\(s\) within edit distance 3 of "worker_task_x"/)
  assert.match(text, /… \+3 more/)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v2.1: subtoken normalisation (naming-convention equivalence).
// ---------------------------------------------------------------------------

evictIndexes()
test('a camelCase query resolves a snake_case symbol, disclosed as subtoken-normalized', async () => {
  // The boundaries where a name is spelled differently on each side: serde
  // `rename_all`, JSON keys, `invoke("get_user_by_id")`, generated bindings,
  // TS↔Rust FFI, CLI flags. Rust alone is snake_case end to end.
  const root = fixtureTree({
    'lib.rs': [
      'pub fn get_user_by_id(id: u64) {}',
      'pub struct UserProfile {}',
      'pub const MAX_RETRY_COUNT: u32 = 3;',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({
    symbols: ['getUserById', 'user_profile', 'maxRetryCount', 'get-user-by-id'],
    path: root,
  }, mockExec(root))
  const byName = Object.fromEntries(value.symbols.map(symbol => [symbol.name, symbol]))
  const pairs = [
    ['getUserById', 'get_user_by_id'],
    ['user_profile', 'UserProfile'],
    ['maxRetryCount', 'MAX_RETRY_COUNT'],
    ['get-user-by-id', 'get_user_by_id'],
  ]
  for (const [query, target] of pairs) {
    const entry = byName[query]
    assert.equal(entry.status, 'defined', query)
    assert.equal(entry.matchedName, target, query)
    assert.equal(entry.matchedOn, 'subtoken-normalized', query)
    assert.equal(entry.definitions[0].path.endsWith('lib.rs'), true)
  }
  const text = tool.output.render({}, value)[0].text
  assert.match(text, /## getUserById \(matched as get_user_by_id\)/)
  assert.match(text, /naming-convention normalisation to "get_user_by_id"/)
  assert.deepEqual(validateSubset(tool.output.schema, value), [])
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('the stricter tiers win and subtoken resolution only ever runs last', async () => {
  const root = fixtureTree({ 'lib.rs': 'pub struct UserProfile {}\n' })
  const { tool } = await loadTool(MODULE, {})

  const exact = await tool.execute({ symbols: ['UserProfile'], path: root }, mockExec(root))
  assert.equal(exact.symbols[0].matchedOn, 'exact')

  // A stricter tier's hit is never overridden by the looser one: the
  // case-insensitive tier resolves this before subtoken is ever consulted.
  const insensitive = await tool.execute({ symbols: ['userprofile'], path: root }, mockExec(root))
  assert.equal(insensitive.symbols[0].matchedOn, 'case-insensitive')
  assert.equal(insensitive.symbols[0].matchedName, 'UserProfile')

  // Only a spelling NO stricter tier can reach lands on the subtoken tier.
  const normalized = await tool.execute({ symbols: ['user_profile'], path: root }, mockExec(root))
  assert.equal(normalized.symbols[0].matchedOn, 'subtoken-normalized')
  assert.equal(normalized.symbols[0].matchedName, 'UserProfile')
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('subtoken resolution never collapses adjacent distinct names', async () => {
  // A splitter that dropped a trailing `s`, or joined tokens without a
  // separator, would silently merge these. Both are defined exactly, so an
  // exact-tier hit is available either way — the subtoken keys themselves are
  // what must stay distinct.
  const root = fixtureTree({
    'lib.rs': [
      'pub fn get_user_id() {}',
      'pub fn get_user_ids() {}',
      'pub fn list_user_profile() {}',
      'pub fn list_user_profiles() {}',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const value = await tool.execute({
    symbols: ['getUserId', 'getUserIds', 'listUserProfile', 'listUserProfiles'],
    path: root,
  }, mockExec(root))
  assert.deepEqual(
    Object.fromEntries(value.symbols.map(symbol => [symbol.name, symbol.matchedName])),
    {
      getUserId: 'get_user_id',
      getUserIds: 'get_user_ids',
      listUserProfile: 'list_user_profile',
      listUserProfiles: 'list_user_profiles',
    },
  )
  for (const symbol of value.symbols) {
    assert.equal(symbol.matchedOn, 'subtoken-normalized', symbol.name)
  }
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('subtoken resolution invents no symbol that is not in the index', async () => {
  const root = fixtureTree({ 'lib.rs': 'pub fn get_user_id() {}\n' })
  const { tool } = await loadTool(MODULE, {})
  // Same tokens but with a plural token is a DIFFERENT identifier, and a
  // genuinely unknown name stays absent — the tier widens spelling, not names.
  const value = await tool.execute({ symbols: ['get_user_ids', 'userprofilex'], path: root }, mockExec(root))
  assert.deepEqual(value.symbols.map(symbol => symbol.status), ['absent', 'absent'])
  assert.deepEqual(value.symbols.map(symbol => symbol.nearMiss.length > 0), [true, false])
  rmSync(root, { recursive: true, force: true })
})

evictIndexes()
test('a subtoken hit resolves definitions without inflating the impl target set', async () => {
  // The `expect` gate compares against `implTargets`, so a looser tier feeding
  // the impl sets could turn "does X implement Y" into a YES with no evidence.
  // Subtoken resolution therefore resolves DEFINITIONS ONLY: the same symbol
  // reached by a different spelling reports the definitions and no impls. That
  // under-report is the safe direction and is disclosed by `matchedOn`.
  const root = fixtureTree({
    'lib.rs': [
      'pub trait HttpFetcher {}',
      'impl HttpFetcher for UserProfile {}',
    ].join('\n'),
  })
  const { tool } = await loadTool(MODULE, {})
  const exact = await tool.execute({ symbols: ['HttpFetcher'], path: root }, mockExec(root))
  assert.equal(exact.symbols[0].implsTotal, 1)

  const normalized = await tool.execute({ symbols: ['http_fetcher'], path: root }, mockExec(root))
  assert.equal(normalized.symbols[0].matchedName, 'HttpFetcher')
  assert.equal(normalized.symbols[0].matchedOn, 'subtoken-normalized')
  assert.equal(normalized.symbols[0].status, 'defined')
  assert.equal(normalized.symbols[0].definitions.length, 1)
  assert.equal(normalized.symbols[0].implsTotal, 0)
  assert.equal(normalized.symbols[0].implTargetsTotal, 0)
  rmSync(root, { recursive: true, force: true })
})
