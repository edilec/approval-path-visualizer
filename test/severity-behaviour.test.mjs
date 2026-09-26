import assert from 'node:assert/strict'
import test from 'node:test'

import { GRAPH, args, cli, graphWith, step, workspace } from './support.mjs'

/**
 * Severity, pinned by what a run DOES rather than by what a table says.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog and against the rules the source emits. Those are declarations, and
 * a coordinated edit to all of them agrees with itself and passes: elsewhere
 * in this catalog forty of fifty-two error rules were downgraded that way with
 * the whole suite green.
 *
 * Nothing in this file imports RULE_SEVERITY, reads the catalog or names a
 * severity for a rule. Every case drives a real graph through the real binary
 * and asserts the observable outcome: which rules the run reported, the status,
 * and the exit code. A downgrade changes those, and an exit code cannot be
 * edited into agreement.
 *
 * The rules that leave the run `incomplete` cannot be pinned this way -- the
 * exit code is 2 whatever their severity -- so they are pinned in the second
 * half by their counted severity and the severity word the human report
 * prints, both asserted as literals that share no map with anything else.
 */

async function run(graph, { human = false } = {}) {
  return workspace(async ({ root }) => {
    const json = await cli(args(root))
    return {
      json,
      human: human ? await cli(['--root', root, '--graph', 'approval.json']) : null,
      report: json.stdout === '' ? null : JSON.parse(json.stdout),
    }
  }, { graph })
}

/** Each entry: the rules the run must report, and the graph that provokes exactly those. */
const FAILING = Object.freeze([
  [['node-unreachable'], () => graphWith([step({ id: 'stranded' })])],
  [['approval-cycle'], () => {
    const value = graphWith([
      step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }),
      step({ id: 'compliance', edges: [{ to: 'legal', condition: 'another read' }, { to: 'approved', condition: 'clear' }] }),
    ])
    value.nodes[0].edges.push({ to: 'legal', condition: 'legal involved' })
    return value
  }],
  [['edge-target-missing'], () => withIntakeEdge({ to: 'ghost', condition: 'elsewhere' })],
  [['timeout-target-missing'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].timeout = { after: 'P1D', to: 'ghost' }
    return value
  }],
  [['exception-target-missing', 'exception-reason-missing'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].exceptions = [{ to: 'ghost' }]
    return value
  }],
  [['approvers-missing'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].approvers = []
    return value
  }],
  [['approvers-unexpected'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[1].approvers = ['someone']
    return value
  }],
  [['outcome-unexpected'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].outcome = 'approved'
    return value
  }],
  [['outcome-value-unknown'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[1].outcome = 'pending'
    return value
  }],
  [['outcome-not-terminal'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[1].edges = [{ to: 'archived', condition: 'filed' }]
    value.nodes.push({ id: 'archived', kind: 'outcome', label: 'Archived', outcome: 'approved' })
    return value
  }],
  [['outcome-missing', 'outcome-unreachable', 'path-dead-end', 'timeout-missing'], () => ({
    schemaVersion: '1',
    name: 'endless',
    start: 'intake',
    nodes: [step({ id: 'intake', timeout: undefined, edges: [] })],
  })],
  [['path-dead-end', 'outcome-unreachable', 'timeout-missing'], () => withIntakeEdge(
    { to: 'hold', condition: 'held' },
    [{ id: 'hold', kind: 'approval', label: 'Hold', approvers: ['nobody'] }],
  )],
  [['node-id-duplicate'], () => {
    const value = structuredClone(GRAPH)
    value.nodes.push({ ...structuredClone(GRAPH.nodes[0]), label: 'Intake again' })
    return value
  }],
  [['node-key-unknown'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].reviewers = ['someone']
    return value
  }],
  [['graph-key-unknown'], () => ({ ...structuredClone(GRAPH), owner: 'someone' })],
  [['label-too-long'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].label = 'x'.repeat(200)
    return value
  }],
  [['timeout-duration-invalid'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].timeout = { after: 'P1W', to: 'approved' }
    return value
  }],
])

function withIntakeEdge(edge, extraNodes = []) {
  const value = graphWith(extraNodes)
  value.nodes[0].edges.push(edge)
  return value
}

test('every rule that decides against a graph fails the run and exits 1', async () => {
  for (const [expected, build] of FAILING) {
    const { json, report } = await run(build())
    assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [...expected].sort(), expected.join(' + '))
    assert.equal(report.status, 'fail', `${expected.join(' + ')} did not fail the run`)
    assert.equal(json.code, 1, `${expected.join(' + ')} did not exit 1`)
    assert.ok(report.summary.errors > 0, `${expected.join(' + ')}: a refusal with no error in the report`)
  }
})

/** Rules that must not fail a run: upgrading one turns a readable graph into a failed build. */
const PASSING = Object.freeze([
  [['timeout-missing'], () => {
    const value = structuredClone(GRAPH)
    delete value.nodes[0].timeout
    return value
  }],
  [['condition-missing'], () => withIntakeEdge({ to: 'approved' })],
  [['condition-duplicate'], () => withIntakeEdge(
    { to: 'second', condition: 'within policy' },
    [step({ id: 'second', edges: [{ to: 'approved', condition: 'onwards' }] })],
  )],
  [['edge-duplicate'], () => withIntakeEdge({ to: 'approved', condition: 'within policy' })],
  [['approvers-duplicate'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].approvers = ['ops-desk', 'ops-desk']
    return value
  }],
  [['exception-reason-missing'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].exceptions = [{ to: 'approved' }]
    return value
  }],
  [['label-missing'], () => {
    const value = structuredClone(GRAPH)
    delete value.nodes[0].label
    return value
  }],
  [['label-control-characters'], () => {
    const value = structuredClone(GRAPH)
    value.nodes[0].label = `Intake${String.fromCharCode(0x85)}review`
    return value
  }],
  [['graph-name-missing'], () => {
    const value = structuredClone(GRAPH)
    delete value.name
    return value
  }],
])

test('the rules that must not fail a run keep their runs green', async () => {
  for (const [expected, build] of PASSING) {
    const { json, report } = await run(build())
    assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [...expected].sort(), expected.join(' + '))
    assert.equal(report.status, 'pass', `${expected.join(' + ')} must not fail the run`)
    assert.equal(report.summary.errors, 0, expected.join(' + '))
    assert.equal(json.code, 0, `${expected.join(' + ')} did not exit 0`)
  }
})

/**
 * The rules that leave the run incomplete, pinned by their counted severity
 * and by the word the human report prints.
 *
 * The exit code is 2 for all of them whatever their severity, so there is no
 * observable verdict to assert. Every expectation below is a literal written
 * out here: no map, no import, no lookup.
 */
const INCOMPLETE = Object.freeze([
  ['graph-not-json', 'ERROR  ', { errors: 1, warnings: 0 }, () => '{ not json'],
  ['graph-not-utf8', 'ERROR  ', { errors: 1, warnings: 0 }, () => Buffer.from([0x7b, 0xff, 0x7d])],
  ['graph-invalid', 'ERROR  ', { errors: 1, warnings: 0 }, () => JSON.stringify({ schemaVersion: '9', nodes: [] })],
  ['no-nodes-declared', 'WARNING', { errors: 0, warnings: 1 }, () => JSON.stringify({
    schemaVersion: '1', name: 'empty', start: 'intake', nodes: [],
  })],
  ['node-invalid', 'ERROR  ', { errors: 1, warnings: 0 }, () => JSON.stringify(
    graphWith([{ id: 'broken', kind: 'gateway' }]),
  )],
])

test('a rule that leaves the run incomplete keeps its counted and printed severity', async () => {
  for (const [ruleId, printed, counts, build] of INCOMPLETE) {
    const { json, human, report } = await run(build(), { human: true })
    assert.deepEqual(report.findings.map((item) => item.ruleId), [ruleId], ruleId)
    assert.equal(report.status, 'incomplete', ruleId)
    assert.equal(json.code, 2, ruleId)
    assert.equal(report.summary.errors, counts.errors, `${ruleId}: errors`)
    assert.equal(report.summary.warnings, counts.warnings, `${ruleId}: warnings`)
    assert.ok(human.stdout.includes(`${printed} `), `${ruleId}: the human report did not print ${printed.trim()}`)
  }
})

test('an unknown start is incomplete, and the empty graph it leaves behind is not a pass', async () => {
  const { json, report } = await run({ ...structuredClone(GRAPH), start: 'nowhere' })
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['start-unknown'])
  assert.equal(report.status, 'incomplete')
  assert.equal(json.code, 2)
  assert.equal(report.summary.errors, 1)
})
