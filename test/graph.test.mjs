import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, compileGraph, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, graphWith, step, workspace } from './support.mjs'

/** Compile a value directly, with the shipped default limits. */
function compile(value) {
  return compileGraph(value, DEFAULT_LIMITS)
}

function ruleIds(problems) {
  return problems.map((item) => item.ruleId).sort()
}

/** Drive a graph through the real entry point and return its report. */
async function reportFor(graph) {
  return workspace(async ({ root }) => {
    const { report } = await visualizeApprovalPath({ root, graph: 'approval.json' })
    return report
  }, { graph })
}

test('the clean fixture compiles with no problem at all', () => {
  const { graph, problems } = compile(structuredClone(GRAPH))
  assert.deepEqual(problems, [])
  assert.equal(graph.start, 'intake')
  assert.deepEqual(graph.nodes.map((node) => node.id), ['approved', 'intake'])
})

test('a graph that is not an object, or declares no nodes, compiles to nothing', () => {
  for (const value of [null, [], 'graph', 7]) {
    const { graph, problems } = compile(value)
    assert.equal(graph, null)
    assert.deepEqual(ruleIds(problems), ['graph-invalid'])
    assert.equal(problems[0].incomplete, true)
  }
  const missingNodes = compile({ schemaVersion: '1', start: 'intake', name: 'x' })
  assert.equal(missingNodes.graph, null)
  assert.deepEqual(ruleIds(missingNodes.problems), ['graph-invalid'])
})

test('an unsupported schemaVersion stops the compile rather than being read anyway', () => {
  for (const version of [undefined, '2', 1, null]) {
    const { graph, problems } = compile({ ...structuredClone(GRAPH), schemaVersion: version })
    assert.equal(graph, null)
    assert.deepEqual(ruleIds(problems), ['graph-invalid'])
  }
})

test('an unknown key is refused at every level, never ignored', () => {
  const value = structuredClone(GRAPH)
  value.owner = 'someone'
  value.nodes[0].reviewers = ['x']
  value.nodes[0].edges[0].unless = 'x'
  value.nodes[0].timeout.escalate = true
  const { problems } = compile(value)
  assert.deepEqual(ruleIds(problems), ['graph-key-unknown', 'node-key-unknown', 'node-key-unknown', 'node-key-unknown'])
  assert.deepEqual(
    problems.map((item) => item.pointer).sort(),
    ['/nodes/intake/edges/0/unless', '/nodes/intake/reviewers', '/nodes/intake/timeout/escalate', '/owner'],
  )
})

test('a node with a structural defect is dropped whole, and dropping it makes the run incomplete', async () => {
  const cases = [
    ['not an object', 'ruin'],
    ['no id', { kind: 'approval', label: 'x' }],
    ['padded id', { ...step(), id: ' review ' }],
    ['unknown kind', { ...step(), kind: 'gateway' }],
    ['label not a string', { ...step(), label: 7 }],
    ['approvers not an array', { ...step(), approvers: 'reviewer' }],
    ['an empty approver', { ...step(), approvers: [''] }],
    ['edges not an array', { ...step(), edges: 'approved' }],
    ['an edge without a target', { ...step(), edges: [{ condition: 'x' }] }],
    ['a non-string condition', { ...step(), edges: [{ to: 'approved', condition: 5 }] }],
    ['a timeout that is not an object', { ...step(), timeout: 'P1D' }],
    ['a timeout without a target', { ...step(), timeout: { after: 'P1D' } }],
    ['exceptions that are not an array', { ...step(), exceptions: {} }],
    ['an exception without a target', { ...step(), exceptions: [{ reason: 'x' }] }],
    ['an outcome node with no outcome', { id: 'done', kind: 'outcome', label: 'Done' }],
  ]

  for (const [label, node] of cases) {
    const { graph, problems } = compile(graphWith([node]))
    assert.ok(problems.some((item) => item.ruleId === 'node-invalid' && item.incomplete === true), label)
    assert.deepEqual(graph.nodes.map((item) => item.id), ['approved', 'intake'], label)

    // And through the real entry point: a dropped node is never a pass.
    const report = await reportFor(graphWith([node]))
    assert.equal(report.status, 'incomplete', label)
  }
})

test('a repeated node id keeps the first declaration and reports the second', () => {
  const { graph, problems } = compile(graphWith([step({ id: 'intake', label: 'Second intake' })]))
  assert.deepEqual(ruleIds(problems), ['node-id-duplicate'])
  assert.equal(problems[0].incomplete, false)
  assert.equal(graph.byId.get('intake').label, 'Intake')
})

test('a duplicate node raises no finding of its own, since it was never read', () => {
  // The second declaration carries its own defects -- no approvers, no
  // timeout -- and none of them may be reported against the id of the first.
  const { problems } = compile(graphWith([{ id: 'intake', kind: 'approval', label: 'Second' }]))
  assert.deepEqual(ruleIds(problems), ['node-id-duplicate'])
})

test('a missing or unknown start compiles the steps but traces no path', () => {
  const missing = compile({ ...structuredClone(GRAPH), start: undefined })
  assert.equal(missing.graph.start, null)
  assert.deepEqual(ruleIds(missing.problems), ['start-missing'])
  assert.equal(missing.problems[0].incomplete, true)

  const unknown = compile({ ...structuredClone(GRAPH), start: 'nowhere' })
  assert.equal(unknown.graph.start, null)
  assert.deepEqual(ruleIds(unknown.problems), ['start-unknown'])
  assert.equal(unknown.problems[0].incomplete, true)

  const invalid = compile({ ...structuredClone(GRAPH), start: '  ' })
  assert.deepEqual(ruleIds(invalid.problems), ['start-unknown'])
})

test('approver rules read the list without rewriting it', () => {
  const { graph, problems } = compile(graphWith([
    step({ id: 'a', approvers: ['one', 'one', 'two'] }),
    step({ id: 'b', approvers: [] }),
  ]))
  assert.deepEqual(ruleIds(problems), ['approvers-duplicate', 'approvers-missing'])
  assert.deepEqual(graph.byId.get('a').approvers, ['one', 'two'])
  assert.deepEqual(graph.byId.get('b').approvers, [])
})

test('a timeout duration outside the documented subset is reported, and the step is kept', () => {
  const { graph, problems } = compile(graphWith([
    step({ id: 'slow', timeout: { after: 'P1W', to: 'approved' } }),
  ]))
  assert.deepEqual(ruleIds(problems), ['timeout-duration-invalid'])
  assert.equal(problems[0].incomplete, false)
  assert.equal(graph.byId.get('slow').timeout.after, null)
  assert.equal(graph.byId.get('slow').timeout.to, 'approved')
})

test('an outcome node ends the path and names one outcome from the vocabulary', () => {
  const { problems } = compile(graphWith([
    { id: 'maybe', kind: 'outcome', label: 'Maybe', outcome: 'pending' },
    {
      id: 'onwards',
      kind: 'outcome',
      label: 'Onwards',
      outcome: 'approved',
      approvers: ['someone'],
      edges: [{ to: 'approved' }],
    },
  ]))
  assert.deepEqual(ruleIds(problems), ['approvers-unexpected', 'outcome-not-terminal', 'outcome-value-unknown'])
})

test('an approval step that declares an outcome is reported without being rewritten', () => {
  const { graph, problems } = compile(graphWith([step({ id: 'odd', outcome: 'approved' })]))
  assert.deepEqual(ruleIds(problems), ['outcome-unexpected'])
  assert.equal(graph.byId.get('odd').outcome, null)
})

test('a label longer than the limit is reported, and the id is drawn instead', () => {
  const label = 'x'.repeat(DEFAULT_LIMITS.maxLabelLength + 1)
  const { graph, problems } = compile(graphWith([step({ id: 'wordy', label })]))
  assert.deepEqual(ruleIds(problems), ['label-too-long'])
  assert.equal(graph.byId.get('wordy').label, 'wordy')
  assert.equal(problems[0].incomplete, false)
})

test('a missing label falls back to the id and says so', () => {
  const { graph, problems } = compile(graphWith([step({ id: 'plain', label: undefined })]))
  assert.deepEqual(ruleIds(problems), ['label-missing'])
  assert.equal(graph.byId.get('plain').label, 'plain')
})

test('a graph with no name is titled by its file instead', () => {
  const { graph, problems } = compile({ ...structuredClone(GRAPH), name: undefined })
  assert.deepEqual(ruleIds(problems), ['graph-name-missing'])
  assert.equal(graph.name, '')

  const empty = compile({ ...structuredClone(GRAPH), name: '' })
  assert.deepEqual(ruleIds(empty.problems), ['graph-name-missing'])
  assert.equal(empty.graph.name, '')
})

test('a graph name that is not a string stops the compile', () => {
  for (const name of [7, [], { text: 'x' }, null]) {
    const { graph, problems } = compile({ ...structuredClone(GRAPH), name })
    assert.equal(graph, null, String(name))
    assert.deepEqual(ruleIds(problems), ['graph-invalid'], String(name))
    assert.equal(problems[0].incomplete, true, String(name))
  }
})
