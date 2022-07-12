import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, validateLimits, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, graphWith, step, workspace } from './support.mjs'

/**
 * Every documented limit, enforced and tested.
 *
 * A limit that is accepted and never wired through is the defect this catalog
 * has already shipped once, so each case below sets the limit low, drives a
 * real graph through the real entry point, and asserts three things: the rule
 * that names the limit is reported, the run is `incomplete` rather than
 * quietly shorter, and the CLI exits 2. The `incomplete` assertion is also
 * what fails if the flag that sets it is removed -- the run would report
 * `fail`, and the exit code would be 1.
 */

async function runWith(graph, limits, extraArgs = []) {
  return workspace(async ({ root }) => {
    const result = await visualizeApprovalPath({ root, graph: 'approval.json', limits })
    const viaCli = await cli(args(root, extraArgs))
    return { ...result, viaCli }
  }, { graph })
}

const CASES = Object.freeze([
  {
    name: 'maxGraphBytes',
    ruleId: 'graph-too-large',
    limits: { maxGraphBytes: 20 },
    flag: ['--max-graph-bytes', '20'],
    graph: () => structuredClone(GRAPH),
  },
  {
    name: 'maxNodes',
    ruleId: 'too-many-nodes',
    limits: { maxNodes: 1 },
    flag: ['--max-nodes', '1'],
    graph: () => structuredClone(GRAPH),
  },
  {
    name: 'maxEdgesPerNode',
    ruleId: 'too-many-edges',
    limits: { maxEdgesPerNode: 1 },
    flag: ['--max-edges-per-node', '1'],
    graph: () => graphWith([step({
      id: 'branch',
      edges: [{ to: 'approved', condition: 'a' }, { to: 'intake', condition: 'b' }],
    })]),
  },
  {
    name: 'maxApprovers',
    ruleId: 'too-many-approvers',
    limits: { maxApprovers: 1 },
    flag: ['--max-approvers', '1'],
    graph: () => graphWith([step({ id: 'wide', approvers: ['one', 'two'] })]),
  },
  {
    name: 'maxDepth',
    ruleId: 'path-too-deep',
    limits: { maxDepth: 1 },
    flag: ['--max-depth', '1'],
    graph: () => graphWith([step({
      id: 'second',
      edges: [{ to: 'approved', condition: 'onwards' }],
    })], {
      nodes: [
        step({ id: 'intake', edges: [{ to: 'second', condition: 'onwards' }], timeout: { after: 'P1D', to: 'second' } }),
        step({ id: 'second', edges: [{ to: 'approved', condition: 'onwards' }] }),
        { id: 'approved', kind: 'outcome', label: 'Approved', outcome: 'approved' },
      ],
    }),
  },
  {
    name: 'maxTraversalSteps',
    ruleId: 'traversal-budget-exceeded',
    limits: { maxTraversalSteps: 1 },
    flag: ['--max-traversal-steps', '1'],
    graph: () => structuredClone(GRAPH),
  },
])

test('every documented limit is enforced, named, and makes the run incomplete', async () => {
  for (const item of CASES) {
    const { report, viaCli } = await runWith(item.graph(), item.limits, item.flag)
    assert.ok(
      report.findings.some((finding) => finding.ruleId === item.ruleId),
      `${item.name}: ${item.ruleId} was not reported`,
    )
    assert.ok(
      report.findings.find((finding) => finding.ruleId === item.ruleId).message.includes(item.name),
      `${item.name}: the finding does not name the limit`,
    )
    assert.equal(report.status, 'incomplete', item.name)
    assert.equal(viaCli.code, 2, `${item.name}: the CLI did not exit 2`)
    assert.equal(JSON.parse(viaCli.stdout).status, 'incomplete', item.name)
  }
})

test('the same graphs pass with the limits at their documented defaults', async () => {
  // Without this, every case above would also pass if the tool simply refused
  // everything: the limits have to be the thing that changed the answer.
  for (const item of CASES) {
    const { report } = await runWith(item.graph(), {})
    assert.notEqual(report.status, 'incomplete', item.name)
    assert.equal(
      report.findings.some((finding) => finding.ruleId === item.ruleId),
      false,
      `${item.name}: reported at the default limit`,
    )
  }
})

test('a label, an approver, a condition and a reason are each bounded by maxLabelLength', async () => {
  const long = 'x'.repeat(40)
  const cases = [
    ['/nodes/wordy/label', graphWith([step({ id: 'wordy', label: long })])],
    ['/nodes/wordy/approvers/0', graphWith([step({ id: 'wordy', approvers: [long] })])],
    ['/nodes/wordy/edges/0/condition', graphWith([step({ id: 'wordy', edges: [{ to: 'approved', condition: long }] })])],
    ['/nodes/wordy/exceptions/0/reason', graphWith([step({
      id: 'wordy', exceptions: [{ to: 'approved', reason: long }],
    })])],
    ['/name', graphWith([], { name: long })],
  ]

  for (const [pointer, graph] of cases) {
    const { report, diagram } = await runWith(graph, { maxLabelLength: 20 })
    const finding = report.findings.find((item) => item.ruleId === 'label-too-long')
    assert.notEqual(finding, undefined, pointer)
    assert.equal(finding.location.pointer, pointer)
    assert.ok(finding.message.includes('maxLabelLength'), pointer)
    // Cut visibly rather than quietly: whatever the diagram shows of an
    // over-long value, it shows that something was cut.
    if (pointer !== '/nodes/wordy/label') assert.ok(diagram.includes('...'), pointer)
  }
})

test('the limits a caller may set are exactly the documented ones', () => {
  assert.deepEqual(Object.keys(validateLimits({})), Object.keys(DEFAULT_LIMITS))
  assert.throws(() => validateLimits({ maxNode: 5 }), /Unknown limit "maxNode"/)
  assert.throws(() => validateLimits({ maxNodes: 0 }), /positive integer/)
  assert.throws(() => validateLimits({ maxNodes: 1.5 }), /positive integer/)
  assert.throws(() => validateLimits({ maxNodes: '5' }), /positive integer/)
  assert.throws(() => validateLimits([]), /Limits must be an object/)
  assert.equal(validateLimits({ maxNodes: 7 }).maxNodes, 7)
})

test('a bounded-out run still draws what it read, and the diagram says it is partial', async () => {
  const { report, diagram } = await runWith(structuredClone(GRAPH), { maxNodes: 1 })
  assert.equal(report.status, 'incomplete')
  assert.notEqual(diagram, null)
  assert.ok(diagram.includes('evidence was incomplete'))
})
