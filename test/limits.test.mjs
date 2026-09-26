import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, validateLimits, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, graphWith, projectDirectory, step, workspace } from './support.mjs'

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

test('nothing past a limit is read: the counts stop where the finding says they do', async () => {
  // Every one of these findings says "the remainder were not read". What makes
  // that sentence true is the slice that stops the read, and these are the
  // assertions that fail when one of them goes: the count moves while the
  // finding goes on claiming the same thing.

  const nodes = await runWith(graphWith([step({ id: 'extra' })]), { maxNodes: 2 })
  assert.equal(nodes.report.summary.checked, 2, 'a node past maxNodes was read')
  assert.ok(nodes.report.findings.some((item) => item.ruleId === 'too-many-nodes'))
  // And the step that was not read is not in the picture either.
  assert.equal(nodes.diagram.includes('extra'), false, 'a node past maxNodes was drawn')

  const approvers = await runWith(
    graphWith([step({ id: 'wide', approvers: ['one', 'two', 'three'] })]),
    { maxApprovers: 1 },
  )
  assert.equal(approvers.report.summary.approvers, 2, 'an approver past maxApprovers was read')
  assert.equal(
    approvers.report.findings.find((item) => item.ruleId === 'node-unreachable').message,
    'No path from the start step "intake" reaches this node. Its approvers (one) are never asked.',
  )

  const edges = await runWith(graphWith([step({
    id: 'branch',
    edges: [
      { to: 'approved', condition: 'a' },
      { to: 'intake', condition: 'b' },
      { to: 'branch', condition: 'c' },
    ],
  })]), { maxEdgesPerNode: 1 })
  assert.equal(edges.report.summary.edges, 2, 'an edge past maxEdgesPerNode was read')

  const exits = await runWith(graphWith([step({
    id: 'exits',
    exceptions: [
      { to: 'approved', reason: 'first' },
      { to: 'approved', reason: 'second' },
      { to: 'approved', reason: 'third' },
    ],
  })]), { maxEdgesPerNode: 1 })
  assert.equal(exits.report.summary.exceptionExits, 1, 'an exception exit past maxEdgesPerNode was read')
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

test('an exception-exit list past maxEdgesPerNode withholds the verdict too, not only an edge list', async () => {
  // One rule, raised from two places. The edge list is the one the cases above
  // exercise; the exception list is the other, and where its unread exits lead
  // is just as unknown -- so it withholds the verdict in the same way.
  const { report, viaCli } = await runWith(
    graphWith([step({
      id: 'exits',
      exceptions: [{ to: 'approved', reason: 'first' }, { to: 'approved', reason: 'second' }],
    })]),
    { maxEdgesPerNode: 1 },
    ['--max-edges-per-node', '1'],
  )
  const finding = report.findings.find((item) => item.ruleId === 'too-many-edges')
  assert.notEqual(finding, undefined, 'too-many-edges was not reported for an exception list')
  assert.equal(finding.location.pointer, '/nodes/exits/exceptions')
  assert.equal(report.status, 'incomplete')
  assert.equal(viaCli.code, 2)
  assert.equal(JSON.parse(viaCli.stdout).status, 'incomplete')
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

test('maxLabelLength bounds what is drawn and decides nothing', async () => {
  // A display bound that reaches a judgement fabricates findings. Cut to five
  // characters, every outcome in the clean example fell outside the vocabulary
  // ("Outcome \"appro...\" is outside the vocabulary approved, rejected,
  // withdrawn") and five pairs of plainly different conditions were reported as
  // making the path ambiguous. What the bound may say is that a value is too
  // long; what it may not do is change what the value means.
  const cut = await cli([
    '--root', join(projectDirectory, 'examples/clean'), '--graph', 'approval.json',
    '--json', '--max-label-length', '5',
  ])
  assert.deepEqual(
    [...new Set(JSON.parse(cut.stdout).findings.map((item) => item.ruleId))],
    ['label-too-long'],
  )

  // Two conditions sharing their first 120 characters, at the documented
  // default of 120. They are two conditions, whatever a diagram has room for.
  const shared = 'amount is above the approval threshold for this cost centre'.padEnd(120, '-')
  const twoTargets = graphWith([step({ id: 'second' })])
  twoTargets.nodes[0].edges = [
    { to: 'approved', condition: `${shared}route A` },
    { to: 'second', condition: `${shared}route B` },
  ]
  const branching = await runWith(twoTargets, {})
  assert.equal(
    branching.report.findings.some((item) => item.ruleId === 'condition-duplicate'),
    false,
    'two conditions that differ past the bound were called one',
  )

  // The same pair on two edges to one target, which is where the other
  // comparison lives: the same destination under two different conditions is
  // not the same edge declared twice.
  const oneTarget = graphWith([])
  oneTarget.nodes[0].edges = [
    { to: 'approved', condition: `${shared}route A` },
    { to: 'approved', condition: `${shared}route B` },
  ]
  const repeated = await runWith(oneTarget, {})
  assert.equal(
    repeated.report.findings.some((item) => item.ruleId === 'edge-duplicate'),
    false,
    'two edges that differ past the bound were called one',
  )

  // And two approvers whose names differ past the bound are two people: the
  // second is not dropped from the step as a repeat of the first.
  const wide = await runWith(
    graphWith([step({ id: 'wide', approvers: [`${shared}Ann`, `${shared}Bo`] })]),
    {},
  )
  assert.equal(
    wide.report.findings.some((item) => item.ruleId === 'approvers-duplicate'),
    false,
    'two approvers that differ past the bound were called one',
  )
  assert.equal(wide.graph.byId.get('wide').approvers.length, 2, 'an approver was dropped as a repeat')

  // The bound still reports every one of those values as too long, and the
  // shorter ones the same graphs carry are not reported at all.
  for (const result of [branching, repeated, wide]) {
    assert.equal(result.report.findings.filter((item) => item.ruleId === 'label-too-long').length, 2)
  }
})

test('maxDepth counts the links a path follows, and a path of exactly that length is fine', async () => {
  // The off-by-one matters: a graph whose longest path is exactly the bound
  // has been walked in full, and calling that run incomplete would withhold a
  // verdict the traversal did obtain. One link further is genuinely unwalked.
  const chain = (steps) => ({
    schemaVersion: '1',
    name: 'chain',
    start: 's0',
    nodes: [
      ...Array.from({ length: steps }, (unused, index) => step({
        id: `s${index}`,
        label: `Step ${index}`,
        timeout: undefined,
        edges: [{ to: index === steps - 1 ? 'approved' : `s${index + 1}`, condition: 'onwards' }],
      })),
      { id: 'approved', kind: 'outcome', label: 'Approved', outcome: 'approved' },
    ],
  })

  const exact = await runWith(chain(3), { maxDepth: 3 })
  assert.equal(exact.report.status, 'pass', 'a path of exactly maxDepth was called too deep')
  assert.equal(exact.analysis.decided, true)

  const over = await runWith(chain(3), { maxDepth: 2 })
  assert.equal(over.report.status, 'incomplete')
  assert.ok(over.report.findings.some((item) => item.ruleId === 'path-too-deep'))
  assert.equal(over.analysis.decided, false)
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
