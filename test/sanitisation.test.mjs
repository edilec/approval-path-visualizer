import assert from 'node:assert/strict'
import test from 'node:test'

import { excerpt, formatReport, isIdentifier, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, graphWith, step, workspace } from './support.mjs'

/**
 * Every class of character that must not travel inside a value this tool
 * prints or draws, tested class by class and through the real report and the
 * real diagram.
 *
 * A class list that stops at C0 and the two Unicode line separators leaves the
 * C1 range through, and two of those do the same damage unaided: U+0085 NEL is
 * a line break to a great many consumers, and U+009B is the 8-bit CSI, a
 * terminal control introducer that needs no ESC in front of it. The bidi
 * overrides are worse in a different way -- they forge no line, but U+202E
 * makes an approver print as somebody other than the approver that was read.
 *
 * Escaping does not cover any of this. `&lt;` is not what stops U+202E, and a
 * `<text>` element carries a NEL into whatever reads the file quite happily.
 */

const CLASSES = Object.freeze([
  ['C0 NUL', 0x00],
  ['C0 BEL', 0x07],
  ['C0 line feed', 0x0a],
  ['C0 ESC', 0x1b],
  ['DEL', 0x7f],
  ['C1 padding', 0x80],
  ['C1 NEL', 0x85],
  ['C1 CSI', 0x9b],
  ['C1 APC', 0x9f],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['left-to-right mark', 0x200e],
  ['right-to-left mark', 0x200f],
  ['left-to-right embedding', 0x202a],
  ['right-to-left override', 0x202e],
  ['left-to-right isolate', 0x2066],
  ['pop directional isolate', 0x2069],
])

function carrying(code) {
  return `finance${String.fromCharCode(code)}review`
}

test('excerpt removes every class, and keeps ordinary text of any script', () => {
  for (const [label, code] of CLASSES) {
    assert.equal(excerpt(carrying(code)), 'finance review', label)
    assert.equal(excerpt(carrying(code)).includes(String.fromCharCode(code)), false, label)
  }
  // Nothing legitimate is lost: right-to-left letters carry their own
  // direction and need no override, and a combining mark is not a control.
  for (const kept of ['\u0645\u0648\u0627\u0641\u0642\u0629-2', 'na\u00efve-step', 'e\u0301tape']) {
    assert.equal(excerpt(kept), kept)
  }
})

test('isIdentifier refuses every class at the door', () => {
  for (const [label, code] of CLASSES) {
    assert.equal(isIdentifier(carrying(code)), false, label)
  }
  for (const kept of ['\u0645\u0648\u0627\u0641\u0642\u0629-2', 'na\u00efve-step', 'finance-review']) {
    assert.equal(isIdentifier(kept), true, kept)
  }
})

/** The untrusted sites a character can arrive through, one graph each. */
const SITES = Object.freeze([
  ['a label', (value) => graphWith([step({ id: 'extra', label: value })])],
  ['an approver name', (value) => graphWith([step({ id: 'extra', approvers: [value] })])],
  ['a condition', (value) => graphWith([step({ id: 'extra', edges: [{ to: 'approved', condition: value }] })])],
  ['an exception reason', (value) => graphWith([
    step({ id: 'extra', exceptions: [{ to: 'approved', reason: value }] }),
  ])],
  ['an outcome value', (value) => graphWith([{ id: 'extra', kind: 'outcome', label: 'Extra', outcome: value }])],
  ['the graph name', (value) => graphWith([], { name: value })],
  // The identifier path. A tool in this catalog sanitised its evidence field
  // carefully and let a page id carrying a line feed forge whole lines.
  ['a node id', (value) => graphWith([step({ id: value })])],
  ['an edge target', (value) => graphWith([step({ id: 'extra', edges: [{ to: value }] })])],
])

/** Every string anywhere in a value, so the check misses no field. */
function allStrings(value, found = []) {
  if (typeof value === 'string') found.push(value)
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found)
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, found)
  return found
}

test('no class survives into the report, the human lines or the diagram', async () => {
  for (const [siteName, build] of SITES) {
    for (const [className, code] of CLASSES) {
      const where = `${className} through ${siteName}`
      const character = String.fromCharCode(code)
      const { report, diagram, graph, file } = await workspace(
        async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
        { graph: build(carrying(code)) },
      )

      // Every string in the report, not just an evidence field: ids, pointers,
      // paths, messages and suggestions are all values this tool prints.
      for (const text of allStrings(report)) {
        assert.equal(text.includes(character), false, `${where}: in the report`)
      }

      // The human lines are checked line by line, which is exactly what a
      // forged line feed attacks: the report has its two summary lines plus
      // one line per finding, and no more.
      const printed = formatReport(report, { file, name: graph === null ? '' : graph.name })
      const lines = printed.trimEnd().split('\n')
      for (const line of lines) assert.equal(line.includes(character), false, `${where}: in the human lines`)
      assert.equal(lines.length, 2 + report.findings.length, `${where}: the printed report grew a line`)

      if (diagram === null) continue
      for (const line of diagram.split('\n')) {
        assert.equal(line.includes(character), false, `${where}: in the diagram`)
      }
      // And no drawn text was split across two lines of the document, which is
      // the same forgery one level down.
      assert.equal(/<text[^<>]*>[^<]*\n/.test(diagram), false, `${where}: a drawn value broke its line`)
    }
  }
})

test('a label carrying a control character is reported, not silently cleaned', async () => {
  const { report } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
    { graph: graphWith([], { name: `approvals${String.fromCharCode(0x202e)}path` }) },
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['label-control-characters'])
  assert.equal(report.findings[0].location.pointer, '/name')
  assert.equal(report.findings[0].evidence, 'approvals path')
  // The value was cleaned and the run says so; cleaning in silence is what
  // leaves a reader comparing a printed name against a stored one that differ.
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.warnings, 1)
})

test('the CLI keeps every class out of stdout and stderr', async () => {
  for (const [className, code] of CLASSES) {
    const character = String.fromCharCode(code)
    const result = await workspace(
      async ({ root }) => cli(args(root)),
      { graph: graphWith([step({ id: carrying(code) })]) },
    )
    for (const line of result.stdout.split('\n')) {
      assert.equal(line.includes(character), false, `${className}: stdout`)
    }
    for (const line of result.stderr.split('\n')) {
      assert.equal(line.includes(character), false, `${className}: stderr`)
    }
    JSON.parse(result.stdout)
  }
})

test('an unknown option carrying a class is sanitised on its way to stderr', async () => {
  // NUL is the one class that cannot be tested here: an argument containing it
  // is refused by the operating system before this tool is started.
  for (const [className, code] of CLASSES.filter(([, code]) => code !== 0)) {
    const character = String.fromCharCode(code)
    const result = await workspace(
      async ({ root }) => cli(args(root, [`--forge${character}option`])),
      { graph: structuredClone(GRAPH) },
    )
    assert.equal(result.code, 2, className)
    assert.equal(result.stdout, '', className)
    for (const line of result.stderr.split('\n')) {
      assert.equal(line.includes(character), false, `${className}: stderr`)
    }
    assert.ok(result.stderr.startsWith('Unknown option "--forge option"'), className)
  }
})

test('a graph file name carrying a class is sanitised in the location it reports', async () => {
  // The file name reaches every finding's location; it is untrusted for the
  // same reason every other value here is.
  const name = `graph${String.fromCharCode(0x85)}.json`
  const result = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: name }),
    { graph: structuredClone(GRAPH), file: name },
  )
  assert.equal(result.report.findings.length, 0)
  assert.equal(result.file.includes('\u0085'), false)
  assert.equal(result.file, 'graph .json')
})
