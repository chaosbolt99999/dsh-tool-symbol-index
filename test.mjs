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
  assert.match(entry.verdict, /4 impl\(s\) of this trait/)
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
  assert.match(text, /implements this trait \(30\)/)
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
