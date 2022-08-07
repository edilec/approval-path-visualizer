import assert from 'node:assert/strict'
import test from 'node:test'

import { cli, workspace } from './support.mjs'

/**
 * One test per rule that can grade a run, pinned by what the run DOES.
 *
 * This file shares no severity with anything. It imports no table, reads no
 * catalog, and holds no map of expected values: every expectation below is a
 * literal written out at the assertion. That is the whole design. The severity
 * table, the documented catalog and a parameterised expectation in a test are
 * three declarations that can be edited together in one commit, and a fourth
 * declaration that drives the real binary and then compares against
 * `CASES[i].severity` is a fourth mirror, not a guard: the same edit moves it
 * too. Forty of fifty-two error rules were downgraded that way elsewhere in
 * this catalog with every test still green.
 *
 * So nothing here says `assert.equal(finding.severity, expected.severity)`.
 * Each case states what a run of that graph must do:
 *
 * - for a rule that decides against the graph, `status`, the exit code and the
 *   counted errors -- a downgrade drops the error count, and one exit code
 *   cannot be edited into agreement with a table;
 * - for a rule that leaves the run `incomplete`, where the exit code is 2
 *   whatever the severity, the counted errors and the severity word the human
 *   report prints on that rule's own line.
 *
 * Only the imports above are shared, and they are plumbing: a temporary root
 * and a child process. Every graph is built where it is used.
 */

/** A structurally valid graph that passes with no finding at all. */
function clean() {
  return {
    schemaVersion: '1',
    name: 'test approval',
    start: 'intake',
    nodes: [
      {
        id: 'intake',
        kind: 'approval',
        label: 'Intake',
        approvers: ['ops-desk'],
        timeout: { after: 'P1D', to: 'approved' },
        edges: [{ to: 'approved', condition: 'within policy' }],
      },
      { id: 'approved', kind: 'outcome', label: 'Approved', outcome: 'approved' },
    ],
  }
}

/** A valid approval step; anything can be overridden or deleted by the caller. */
function step(overrides = {}) {
  return {
    id: 'review',
    kind: 'approval',
    label: 'Review',
    approvers: ['reviewer'],
    timeout: { after: 'P1D', to: 'approved' },
    edges: [{ to: 'approved', condition: 'approved by reviewer' }],
    ...overrides,
  }
}

/**
 * Run one graph through the real binary twice: once for the machine-readable
 * report, once for the printed one, so both the counted severity and the word
 * a human reads can be asserted.
 */
async function run(graph, { flags = [], read = 'approval.json' } = {}) {
  return workspace(async ({ root }) => {
    const json = await cli(['--root', root, '--graph', read, '--json', ...flags])
    const printed = await cli(['--root', root, '--graph', read, ...flags])
    return {
      code: json.code,
      report: JSON.parse(json.stdout),
      printed: printed.stdout,
    }
  }, { graph })
}

/** The one printed line a rule produced, so the word in front of it can be read. */
function lineFor(result, ruleId) {
  const lines = result.printed.trimEnd().split('\n').filter((text) => text.includes(` ${ruleId} `))
  assert.equal(lines.length, 1, `${ruleId}: expected exactly one printed line, got ${lines.length}`)
  return lines[0]
}

// ---------------------------------------------------------------------------
// Rules that decide against the graph. The run fails and the binary exits 1.
// ---------------------------------------------------------------------------

test('approval-cycle fails the run', async () => {
  const graph = clean()
  graph.nodes[0].edges.push({ to: 'legal', condition: 'legal involved' })
  graph.nodes.push(step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }))
  graph.nodes.push(step({
    id: 'compliance',
    edges: [{ to: 'legal', condition: 'another read' }, { to: 'approved', condition: 'clear' }],
  }))

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'approval-cycle').startsWith('ERROR'), true)
})

test('approvers-missing fails the run', async () => {
  const graph = clean()
  graph.nodes[0].approvers = []

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'approvers-missing').startsWith('ERROR'), true)
})

test('approvers-unexpected fails the run', async () => {
  const graph = clean()
  graph.nodes[1].approvers = ['someone']

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'approvers-unexpected').startsWith('ERROR'), true)
})

test('edge-target-missing fails the run', async () => {
  const graph = clean()
  graph.nodes[0].edges.push({ to: 'ghost', condition: 'elsewhere' })

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'edge-target-missing').startsWith('ERROR'), true)
})

test('exception-target-missing fails the run, and exception-reason-missing does not', async () => {
  const graph = clean()
  graph.nodes[0].exceptions = [{ to: 'ghost' }]

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(lineFor(result, 'exception-target-missing').startsWith('ERROR'), true)
  assert.equal(lineFor(result, 'exception-reason-missing').startsWith('WARNING'), true)
})

test('graph-key-unknown fails the run', async () => {
  const graph = clean()
  graph.owner = 'someone'

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'graph-key-unknown').startsWith('ERROR'), true)
})

test('label-too-long fails the run', async () => {
  const graph = clean()
  graph.nodes[0].label = 'x'.repeat(200)

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'label-too-long').startsWith('ERROR'), true)
})

test('node-id-duplicate fails the run', async () => {
  const graph = clean()
  graph.nodes.push({ ...clean().nodes[0], label: 'Intake again' })

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'node-id-duplicate').startsWith('ERROR'), true)
})

test('node-key-unknown fails the run', async () => {
  const graph = clean()
  graph.nodes[0].reviewers = ['someone']

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'node-key-unknown').startsWith('ERROR'), true)
})

test('node-unreachable fails the run', async () => {
  const graph = clean()
  graph.nodes.push(step({ id: 'stranded' }))

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'node-unreachable').startsWith('ERROR'), true)
})

test('outcome-missing fails the run', async () => {
  // One approval step, no outcome node anywhere, and no way out of it: three
  // errors -- no outcome declared, no outcome reachable, and a dead end -- and
  // the one warning that this step can wait for ever.
  const result = await run({
    schemaVersion: '1',
    name: 'endless',
    start: 'intake',
    nodes: [step({ id: 'intake', timeout: undefined, edges: [] })],
  })
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 3)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(lineFor(result, 'outcome-missing').startsWith('ERROR'), true)
})

test('outcome-not-terminal fails the run', async () => {
  const graph = clean()
  graph.nodes[1].edges = [{ to: 'archived', condition: 'filed' }]
  graph.nodes.push({ id: 'archived', kind: 'outcome', label: 'Archived', outcome: 'approved' })

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'outcome-not-terminal').startsWith('ERROR'), true)
})

test('outcome-unexpected fails the run', async () => {
  const graph = clean()
  graph.nodes[0].outcome = 'approved'

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'outcome-unexpected').startsWith('ERROR'), true)
})

test('outcome-unreachable and path-dead-end both fail the run', async () => {
  // A step a request can reach, cannot leave, and from which no outcome is
  // reachable. Two errors, one warning: downgrading either one drops the error
  // count to 1 and changes the word printed on its line, and neither of those
  // is something a coordinated edit to the table and the catalog can move.
  const graph = clean()
  graph.nodes[0].edges.push({ to: 'hold', condition: 'held' })
  graph.nodes.push({ id: 'hold', kind: 'approval', label: 'Hold', approvers: ['nobody'] })

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 2)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(lineFor(result, 'outcome-unreachable').startsWith('ERROR'), true)
  assert.equal(lineFor(result, 'path-dead-end').startsWith('ERROR'), true)
  assert.equal(lineFor(result, 'timeout-missing').startsWith('WARNING'), true)
})

test('outcome-value-unknown fails the run', async () => {
  const graph = clean()
  graph.nodes[1].outcome = 'pending'

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'outcome-value-unknown').startsWith('ERROR'), true)
})

test('timeout-duration-invalid fails the run', async () => {
  const graph = clean()
  graph.nodes[0].timeout = { after: 'P1W', to: 'approved' }

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'timeout-duration-invalid').startsWith('ERROR'), true)
})

test('timeout-target-missing fails the run', async () => {
  const graph = clean()
  graph.nodes[0].timeout = { after: 'P1D', to: 'ghost' }

  const result = await run(graph)
  assert.equal(result.report.status, 'fail')
  assert.equal(result.code, 1)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(lineFor(result, 'timeout-target-missing').startsWith('ERROR'), true)
})

// ---------------------------------------------------------------------------
// Rules that leave the run incomplete. The exit code is 2 either way, so what
// is asserted is the counted severity and the word printed on the rule's line.
// ---------------------------------------------------------------------------

test('graph-invalid is counted and printed as an error', async () => {
  const result = await run({ schemaVersion: '9', nodes: [] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'graph-invalid').startsWith('ERROR'), true)
})

test('graph-not-json is counted and printed as an error', async () => {
  const result = await run('{ not json')
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'graph-not-json').startsWith('ERROR'), true)
})

test('graph-not-utf8 is counted and printed as an error', async () => {
  const result = await run(Buffer.from([0x7b, 0xff, 0x7d]))
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'graph-not-utf8').startsWith('ERROR'), true)
})

test('graph-too-large is counted and printed as an error', async () => {
  const result = await run(clean(), { flags: ['--max-graph-bytes', '20'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'graph-too-large').startsWith('ERROR'), true)
})

test('graph-unreadable is counted and printed as an error', async () => {
  const result = await run(clean(), { read: 'absent.json' })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'graph-unreadable').startsWith('ERROR'), true)
})

test('node-invalid is counted and printed as an error', async () => {
  const graph = clean()
  graph.nodes.push({ id: 'broken', kind: 'gateway' })

  const result = await run(graph)
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'node-invalid').startsWith('ERROR'), true)
})

test('path-too-deep is counted and printed as an error', async () => {
  const result = await run({
    schemaVersion: '1',
    name: 'chain',
    start: 's0',
    nodes: [
      step({ id: 's0', label: 'Step 0', timeout: { after: 'P1D', to: 's1' }, edges: [{ to: 's1', condition: 'onwards' }] }),
      step({ id: 's1', label: 'Step 1', edges: [{ to: 'approved', condition: 'onwards' }] }),
      { id: 'approved', kind: 'outcome', label: 'Approved', outcome: 'approved' },
    ],
  }, { flags: ['--max-depth', '1'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'path-too-deep').startsWith('ERROR'), true)
})

test('start-missing is counted and printed as an error', async () => {
  const graph = clean()
  delete graph.start

  const result = await run(graph)
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'start-missing').startsWith('ERROR'), true)
})

test('start-unknown is counted and printed as an error', async () => {
  const graph = clean()
  graph.start = 'nowhere'

  const result = await run(graph)
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'start-unknown').startsWith('ERROR'), true)
})

test('too-many-approvers is counted and printed as an error', async () => {
  const graph = clean()
  graph.nodes[0].approvers = ['one', 'two']

  const result = await run(graph, { flags: ['--max-approvers', '1'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'too-many-approvers').startsWith('ERROR'), true)
})

test('too-many-edges is counted and printed as an error', async () => {
  const graph = clean()
  graph.nodes[0].edges = [{ to: 'approved', condition: 'a' }, { to: 'approved', condition: 'b' }]

  const result = await run(graph, { flags: ['--max-edges-per-node', '1'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'too-many-edges').startsWith('ERROR'), true)
})

test('too-many-nodes is counted and printed as an error', async () => {
  // Two outcome nodes and a start on the first of them, so the node that is
  // not read takes nothing else down with it and this rule stands alone.
  const result = await run({
    schemaVersion: '1',
    name: 'two outcomes',
    start: 'approved',
    nodes: [
      { id: 'approved', kind: 'outcome', label: 'Approved', outcome: 'approved' },
      { id: 'spare', kind: 'outcome', label: 'Spare', outcome: 'rejected' },
    ],
  }, { flags: ['--max-nodes', '1'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'too-many-nodes').startsWith('ERROR'), true)
})

test('traversal-budget-exceeded is counted and printed as an error', async () => {
  const result = await run(clean(), { flags: ['--max-traversal-steps', '1'] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 1)
  assert.equal(result.report.summary.warnings, 0)
  assert.equal(lineFor(result, 'traversal-budget-exceeded').startsWith('ERROR'), true)
})

test('no-nodes-declared is counted and printed as a warning, and is still not a pass', async () => {
  // The other direction, and the one that matters most for this rule: upgrading
  // it would fail a run over an empty graph on a rule that is a statement about
  // evidence, and downgrading it to info would leave the empty graph carrying
  // nothing at all. The incomplete status is what keeps it off a pass.
  const result = await run({ schemaVersion: '1', name: 'empty', start: 'intake', nodes: [] })
  assert.equal(result.report.status, 'incomplete')
  assert.equal(result.code, 2)
  assert.equal(result.report.summary.errors, 0)
  assert.equal(result.report.summary.warnings, 1)
  assert.equal(result.report.summary.info, 0)
  assert.equal(lineFor(result, 'no-nodes-declared').startsWith('WARNING'), true)
})
