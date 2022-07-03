import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_LIMITS,
  analyseGraph,
  canonicalCycle,
  compileGraph,
  visualizeApprovalPath,
} from '../src/index.mjs'
import { GRAPH, graphWith, step, workspace } from './support.mjs'

/**
 * The two verdicts this tool exists for -- an approval step no path reaches,
 * and an approval cycle -- driven through the real compile and the real
 * analysis, and through the real entry point where the status matters.
 */

function analyse(value, limits = DEFAULT_LIMITS) {
  const { graph, problems } = compileGraph(value, limits)
  assert.notEqual(graph, null)
  const analysis = analyseGraph(graph, limits)
  return { graph, analysis, problems, findings: [...problems, ...analysis.problems] }
}

function rules(findings) {
  return findings.map((item) => item.ruleId).sort()
}

function find(findings, ruleId) {
  return findings.filter((item) => item.ruleId === ruleId)
}

/** Add nodes and route the start step to each of them, so only the change under test is new. */
function reachable(nodes, overrides = {}) {
  const value = graphWith(nodes, overrides)
  const intake = value.nodes.find((node) => node.id === 'intake')
  for (const node of nodes) intake.edges.push({ to: node.id, condition: `route to ${node.id}` })
  return value
}

async function reportFor(graph) {
  return workspace(async ({ root }) => {
    const { report } = await visualizeApprovalPath({ root, graph: 'approval.json' })
    return report
  }, { graph })
}

test('an approver no path reaches is diagnosed, and the finding names the approvers', async () => {
  const value = graphWith([step({
    id: 'security-review',
    label: 'Security review',
    approvers: ['security-officer', 'data-protection-officer'],
  })])

  const { analysis, findings } = analyse(value)
  assert.deepEqual(rules(findings), ['node-unreachable'])
  assert.equal(analysis.layers.has('security-review'), false)
  assert.match(
    find(findings, 'node-unreachable')[0].message,
    /Its approvers \(security-officer, data-protection-officer\) are never asked\./,
  )

  const report = await reportFor(value)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.unreachable, 1)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['node-unreachable'])
  assert.equal(report.findings[0].location.pointer, '/nodes/security-review')
})

test('an approval cycle is diagnosed, once, in canonical order', async () => {
  const value = reachable([
    step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }),
    step({
      id: 'compliance',
      edges: [
        { to: 'legal', condition: 'needs another legal read' },
        { to: 'approved', condition: 'clear' },
      ],
    }),
  ])

  const { analysis, findings } = analyse(value)
  assert.deepEqual(rules(findings), ['approval-cycle'])
  assert.equal(analysis.cycles.length, 1)
  assert.deepEqual(analysis.cycles[0], ['compliance', 'legal'])
  assert.equal(find(findings, 'approval-cycle')[0].evidence, 'compliance -> legal -> compliance')

  const report = await reportFor(value)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.cycles, 1)
})

test('a cycle closed by a timeout or by an exception exit is still a cycle', () => {
  const viaTimeout = reachable([
    step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }),
    step({ id: 'compliance', timeout: { after: 'P2D', to: 'legal' }, edges: [{ to: 'approved', condition: 'clear' }] }),
  ])
  assert.deepEqual(rules(analyse(viaTimeout).findings), ['approval-cycle'])

  const viaException = reachable([
    step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }),
    step({
      id: 'compliance',
      edges: [{ to: 'approved', condition: 'clear' }],
      exceptions: [{ to: 'legal', reason: 'legal reopened the question' }],
    }),
  ])
  assert.deepEqual(rules(analyse(viaException).findings), ['approval-cycle'])
})

test('a step that sends a request back to itself is a cycle of one', () => {
  const value = reachable([
    step({
      id: 'rework',
      edges: [{ to: 'rework', condition: 'more information needed' }, { to: 'approved', condition: 'complete' }],
    }),
  ])
  const { analysis } = analyse(value)
  assert.deepEqual(analysis.cycles, [['rework']])
})

test('canonicalCycle rotates the same loop to the same reading', () => {
  assert.deepEqual(canonicalCycle(['legal', 'compliance', 'risk']), ['compliance', 'risk', 'legal'])
  assert.deepEqual(canonicalCycle(['compliance', 'risk', 'legal']), ['compliance', 'risk', 'legal'])
  assert.deepEqual(canonicalCycle(['only']), ['only'])
})

test('a step reachable only through a timeout or an exception exit is reachable', () => {
  const value = graphWith([
    step({ id: 'escalation', edges: [{ to: 'approved', condition: 'duty manager decides' }] }),
    step({ id: 'withdrawal-desk', edges: [{ to: 'approved', condition: 'nothing to do' }] }),
  ])
  const intake = value.nodes.find((node) => node.id === 'intake')
  intake.timeout = { after: 'P1D', to: 'escalation' }
  intake.exceptions = [{ to: 'withdrawal-desk', reason: 'requester withdrew' }]

  const { analysis, findings } = analyse(value)
  assert.deepEqual(rules(findings), [])
  assert.deepEqual([...analysis.layers.keys()].sort(), ['approved', 'escalation', 'intake', 'withdrawal-desk'])
})

test('a step from which no outcome is reachable is diagnosed', () => {
  const value = reachable([
    step({ id: 'hold-a', edges: [{ to: 'hold-b', condition: 'still waiting' }], timeout: { after: 'P1D', to: 'hold-b' } }),
    step({ id: 'hold-b', edges: [{ to: 'hold-a', condition: 'still waiting' }], timeout: { after: 'P1D', to: 'hold-a' } }),
  ])
  const { findings } = analyse(value)
  assert.deepEqual(rules(findings), ['approval-cycle', 'outcome-unreachable', 'outcome-unreachable'])
  assert.deepEqual(find(findings, 'outcome-unreachable').map((item) => item.pointer), ['/nodes/hold-a', '/nodes/hold-b'])
})

test('a step a request can never leave is diagnosed as a dead end', () => {
  const value = reachable([{ id: 'hold', kind: 'approval', label: 'Hold', approvers: ['nobody-in-particular'] }])
  const { findings } = analyse(value)
  assert.deepEqual(rules(findings), ['outcome-unreachable', 'path-dead-end', 'timeout-missing'])
})

test('an edge, a timeout and an exception exit that lead nowhere are each diagnosed', () => {
  const value = reachable([step({
    id: 'branch',
    edges: [{ to: 'approved', condition: 'done' }, { to: 'ghost', condition: 'elsewhere' }],
    timeout: { after: 'P1D', to: 'phantom' },
    exceptions: [{ to: 'vanished', reason: 'requester withdrew' }],
  })])
  const { findings } = analyse(value)
  assert.deepEqual(rules(findings), ['edge-target-missing', 'exception-target-missing', 'timeout-target-missing'])
  assert.equal(find(findings, 'edge-target-missing')[0].evidence, 'ghost')
})

test('a target that names a node this run dropped is not also called missing', () => {
  // The dropped node already made the run incomplete and said why; accusing
  // every edge that names it of leading nowhere buries that in noise.
  const value = reachable([
    step({ id: 'branch', edges: [{ to: 'approved', condition: 'done' }, { to: 'broken', condition: 'elsewhere' }] }),
    { id: 'broken', kind: 'gateway', label: 'Broken' },
  ])
  const { findings } = analyse(value)
  assert.deepEqual(rules(findings), ['node-invalid'])
})

test('a branch whose conditions do not distinguish its edges is diagnosed', () => {
  const value = reachable([step({
    id: 'branch',
    edges: [
      { to: 'approved', condition: 'amount < 100' },
      { to: 'intake', condition: 'amount < 100' },
      { to: 'approved' },
      { to: 'approved' },
    ],
  })])
  const { findings } = analyse(value)
  assert.deepEqual(
    rules(findings),
    ['approval-cycle', 'condition-duplicate', 'condition-missing', 'condition-missing', 'edge-duplicate'],
  )
  assert.equal(find(findings, 'condition-duplicate')[0].pointer, '/nodes/branch/edges/1')
  assert.equal(find(findings, 'edge-duplicate')[0].pointer, '/nodes/branch/edges/3')
})

test('a graph with no outcome node at all is diagnosed', () => {
  const value = {
    schemaVersion: '1',
    name: 'endless',
    start: 'intake',
    nodes: [step({ id: 'intake', timeout: undefined, edges: [] })],
  }
  const { findings } = analyse(value)
  assert.deepEqual(rules(findings), ['outcome-missing', 'outcome-unreachable', 'path-dead-end', 'timeout-missing'])
})

test('a walk stopped by the work budget withholds both verdicts instead of guessing', async () => {
  const value = graphWith([step({ id: 'stranded' })])
  const limits = { ...DEFAULT_LIMITS, maxTraversalSteps: 1 }
  const { findings, analysis } = analyse(value, limits)

  assert.equal(analysis.decided, false)
  assert.deepEqual(rules(findings), ['traversal-budget-exceeded'])
  assert.equal(find(findings, 'traversal-budget-exceeded')[0].incomplete, true)

  // The same graph with the budget restored does accuse the stranded step, so
  // the case above is a withheld verdict rather than a graph with nothing wrong.
  assert.deepEqual(rules(analyse(value).findings), ['node-unreachable'])

  const report = await workspace(async ({ root }) => {
    const result = await visualizeApprovalPath({ root, graph: 'approval.json', limits: { maxTraversalSteps: 1 } })
    return result.report
  }, { graph: value })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.unreachable, 0)
  assert.equal(report.summary.cycles, 0)
})

test('a path longer than the depth bound withholds both verdicts', () => {
  const chain = []
  for (let index = 0; index < 8; index += 1) {
    chain.push(step({
      id: `s${index}`,
      timeout: undefined,
      edges: [{ to: index === 7 ? 'approved' : `s${index + 1}`, condition: 'onwards' }],
    }))
  }
  const value = { schemaVersion: '1', name: 'chain', start: 's0', nodes: [...chain, ...structuredClone(GRAPH.nodes)] }
  const { findings, analysis } = analyse(value, { ...DEFAULT_LIMITS, maxDepth: 3 })
  assert.equal(analysis.decided, false)
  assert.ok(rules(findings).includes('path-too-deep'))
  assert.equal(rules(findings).includes('node-unreachable'), false)
})

test('an unknown start withholds both verdicts rather than calling every step unreachable', () => {
  const { findings, analysis } = analyse({ ...structuredClone(GRAPH), start: 'nowhere' })
  assert.equal(analysis.decided, false)
  assert.deepEqual(rules(findings), ['start-unknown'])
})
