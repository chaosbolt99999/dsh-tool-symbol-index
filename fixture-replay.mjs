/**
 * The decisive test: replay the incident's question against the real vendored
 * checkout and assert the exact ground truth, in ONE call.
 *
 * Ground truth (verified independently with grep before this test was written):
 *   pub trait VisualContext: AppContext   crates/gpui/src/gpui.rs:260
 *   impl VisualContext for AsyncWindowContext      crates/gpui/src/app/async_context.rs:488
 *   impl VisualContext for BenchWindowContext<'_, '_> crates/gpui/src/app/bench_context.rs:1267
 *   impl VisualContext for VisualTestContext       crates/gpui/src/app/test_context.rs:1129
 *   no impl for Context.
 *
 * Compare with the incident: 41 identical bash calls and ~278 steps failed to
 * establish this.
 */
import { loadTool, mockExec } from './harness.mjs'

const MODULE = new URL('./lib/index.js', import.meta.url).pathname
const FIXTURE = '/home/chaosbolt/.cargo/git/checkouts/zed-a70e2ad075855582/87a1ea3'

const { tool } = await loadTool(MODULE, {})

console.log('=== call 1: cold index, three symbols in one call ===')
const coldStart = Date.now()
const cold = await tool.execute(
  { symbols: ['VisualContext', 'AppContext'], path: FIXTURE, expect: 'Context' },
  mockExec(FIXTURE),
)
const coldWall = Date.now() - coldStart
const coldText = tool.output.render({}, cold)[0].text
console.log(coldText)
console.log('')
console.log('--- measurements (cold) ---')
console.log('index build ms (plugin):', cold.index.builtMs)
console.log('wall ms incl. render     :', coldWall)
console.log('files indexed            :', cold.index.files)
console.log('definitions / impls      :', cold.index.definitions, '/', cold.index.impls)
console.log('skipped                  :', cold.index.skipped, 'truncated:', cold.index.truncated)
console.log('rendered chars           :', coldText.length)

console.log('')
console.log('=== call 2: warm index, one symbol (the 41-step question) ===')
const warmStart = Date.now()
const warm = await tool.execute({ symbols: ['Context'], path: FIXTURE }, mockExec(FIXTURE))
const warmWall = Date.now() - warmStart
const warmText = tool.output.render({}, warm)[0].text
console.log(warmText)
console.log('warm wall ms:', warmWall, '· reused index:', warm.index.reused)

// ── assertions ──────────────────────────────────────────────────────────────
const failures = []
const visual = cold.symbols.find(s => s.name === 'VisualContext')
const appContext = cold.symbols.find(s => s.name === 'AppContext')

const definition = visual.definitions.find(d => d.path.endsWith('crates/gpui/src/gpui.rs'))
if (definition === undefined) failures.push('VisualContext definition not found in gpui.rs')
else {
  if (definition.line !== 260) failures.push(`VisualContext definition line ${definition.line} !== 260`)
  if (definition.kind !== 'trait') failures.push(`VisualContext kind ${definition.kind} !== trait`)
  if (!definition.text.includes('pub trait VisualContext: AppContext')) {
    failures.push(`VisualContext signature text unexpected: ${definition.text}`)
  }
}
const forTypes = visual.impls.map(i => i.forType).sort()
const expectedForTypes = ['AsyncWindowContext', "BenchWindowContext<'_, '_>", 'VisualTestContext'].sort()
if (JSON.stringify(forTypes) !== JSON.stringify(expectedForTypes)) {
  failures.push(`impl forTypes ${JSON.stringify(forTypes)} !== ${JSON.stringify(expectedForTypes)}`)
}
const expectedImplLines = {
  AsyncWindowContext: 488,
  "BenchWindowContext<'_, '_>": 1267,
  VisualTestContext: 1129,
}
for (const impl of visual.impls) {
  const expected = expectedImplLines[impl.forType]
  if (expected === undefined) continue
  if (impl.line !== expected) failures.push(`impl ${impl.forType} line ${impl.line} !== ${expected}`)
}
if (!visual.verdict.includes('expect Context: NO')) {
  failures.push('verdict does not state the explicit expect answer (Context): ' + visual.verdict)
}
if (!visual.verdict.includes('3 impl site(s) across 3 unique target type(s)')) {
  failures.push('verdict does not report exactly three VisualContext impls: ' + visual.verdict)
}
if (!visual.verdict.includes('NOT an impl target')) {
  failures.push('expect clause is not explicit about absence: ' + visual.verdict)
}
if (appContext.status !== 'defined') failures.push('AppContext should be DEFINED, got ' + appContext.status)
if (cold.index.files !== 2013) failures.push(`files indexed ${cold.index.files} !== 2013 (1956 .rs + 57 .py/.js)`)
if (coldText.length > 14000) failures.push(`rendered ${coldText.length} chars exceeds maxOutputChars`)
if (warm.index.reused !== true) failures.push('warm call did not reuse the index')
if (warm.index.id !== cold.index.id) failures.push('warm call rebuilt the index')

// ── v2: the A/B's measured defect, against the same tree and the same oracle ──
// `grep -rnE --include='*.rs' 'impl[^;{]*\bFocusable\b\s+for\b'` returns 190 rows
// and 186 distinct targets on this checkout. v1 reported 189 and dropped
// `FocusOnlyModal` (crates/terminal_view/src/terminal_panel.rs:2494, a
// qualified-path impl inside a test module). Asserted here so it cannot regress.
console.log('')
console.log('=== v2 regression: the A/B impl-enumeration gap ===')
const gap = await tool.execute({ symbols: ['Focusable', 'FocusOnlyModal'], path: FIXTURE }, mockExec(FIXTURE))
const focusable = gap.symbols.find(s => s.name === 'Focusable')
const focusOnly = gap.symbols.find(s => s.name === 'FocusOnlyModal')
console.log('Focusable   impls:', focusable.implsTotal, '· distinct targets:', focusable.implTargetsTotal)
console.log('FocusOnlyModal implements:', focusOnly.implsForTotal, '->', focusOnly.implForTargets.join(', '))
console.log('macro impl templates disclosed:', gap.index.templates, '·', gap.index.templateSamples[0])
if (focusable.implsTotal !== 190) {
  failures.push(`Focusable impl rows ${focusable.implsTotal} !== 190 (grep oracle)`)
}
if (focusable.implTargetsTotal !== 186) {
  failures.push(`Focusable distinct targets ${focusable.implTargetsTotal} !== 186 (grep oracle)`)
}
if (!focusable.implTargets.includes('FocusOnlyModal')) {
  failures.push('Focusable impl targets omit FocusOnlyModal — the qualified-path impl is dropped again')
}
if (focusOnly.implsForTotal !== 4) {
  failures.push(`FocusOnlyModal implements ${focusOnly.implsForTotal} traits; grep 'for FocusOnlyModal' says 4`)
}
if (!focusOnly.implForTargets.includes('gpui::Focusable')) {
  failures.push('FocusOnlyModal does not list gpui::Focusable among what it implements')
}
// The `quote!` templates in crates/gpui_macros must be DISCLOSED, not attributed:
// folding one in adds the bogus target `#type_name #type_generics #where_clause`.
if (gap.index.templates < 1) {
  failures.push('no macro impl template was detected; the quote! bodies should have been skipped')
}
if (focusable.implTargets.some(target => target.includes('#'))) {
  failures.push('a macro metavariable leaked into the impl target set')
}

console.log('')
console.log('=== assertions ===')
if (failures.length === 0) {
  console.log('ALL GROUND-TRUTH ASSERTIONS PASSED')
} else {
  for (const failure of failures) console.log('FAIL:', failure)
  process.exitCode = 1
}
