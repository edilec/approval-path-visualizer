import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutGraph, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, graphWith, step, workspace } from './support.mjs'

/**
 * Ordering, pinned by the order that comes out.
 *
 * Scanning this package's own source for `.localeCompare(` would not be a
 * determinism test: `Intl.Collator`, or `a['locale' + 'Compare'](b)`, produces
 * identical collation drift with different source text, so the scan passes
 * while the emitted order quietly becomes dependent on the ICU data of
 * whichever machine ran the tool.
 *
 * So every case below chooses ids whose order genuinely differs between UTF-16
 * code units and collation, pushes them through the real report and the real
 * diagram, and asserts the exact order that comes out. `Zeta` before `alpha`
 * is the workhorse: `Z` is U+005A and `a` is U+0061, so code units put `Zeta`
 * first while every collation puts it last. `a-b` before `a_b` is the other
 * one: U+002D is below U+005F, and collation reverses the pair.
 *
 * There is one case per site that orders anything reaching the output, because
 * a helper pinned in isolation pins the helper and not its callers: every call
 * site can be swapped on its own. The two sites no fixture can distinguish are
 * named where they are: `location.file`, which is one value in any run, and
 * the rule-id comparator, whose alphabet -- lower-case letters, digits and the
 * hyphen -- puts code units and collation in agreement on all 1681 ordered
 * pairs of the forty-one documented ids.
 */

const CODE_UNIT_ORDER = Object.freeze(['README', 'Zeta', 'a-b', 'a_b', 'ab', 'alpha', 'assets'])
const COLLATED_ORDER = Object.freeze(['a_b', 'a-b', 'ab', 'alpha', 'assets', 'README', 'Zeta'])

test('the fixtures really do order differently under collation', () => {
  // The premise every case below rests on, checked against this host's own ICU
  // data rather than asserted from memory. If the two agreed, the cases would
  // prove nothing at all.
  const collated = [...CODE_UNIT_ORDER].sort((left, right) => left.localeCompare(right))
  assert.deepEqual(collated, [...COLLATED_ORDER])
  assert.notDeepEqual(collated, [...CODE_UNIT_ORDER])
})

async function reportFor(graph) {
  return workspace(async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }), { graph })
}

test('findings are ordered by pointer, by code unit', async () => {
  // Seven steps no path reaches, so the only thing separating the findings is
  // the node id inside the pointer.
  const { report } = await reportFor(graphWith(CODE_UNIT_ORDER.map((id) => step({ id }))))
  assert.deepEqual(
    report.findings.map((item) => item.location.pointer),
    CODE_UNIT_ORDER.map((id) => `/nodes/${id}`),
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId), CODE_UNIT_ORDER.map(() => 'node-unreachable'))
})

test('two findings on one pointer are ordered by rule id, not by the order they were found', async () => {
  // Both carry the same file and the same pointer, and the dead end is
  // recorded after the missing timeout, so insertion order would put it last.
  const value = graphWith([{ id: 'hold', kind: 'approval', label: 'Hold' }])
  value.nodes[0].edges.push({ to: 'hold', condition: 'held' })
  const { report } = await reportFor(value)
  assert.deepEqual(
    report.findings.filter((item) => item.location.pointer === '/nodes/hold').map((item) => item.ruleId),
    ['outcome-unreachable', 'path-dead-end'],
  )
})

test('the steps in one diagram row are drawn in code-unit order', async () => {
  // Every one of them is one edge from the start, so they share a layer and
  // only the id decides the order they are drawn in.
  const value = graphWith(CODE_UNIT_ORDER.map((id) => step({ id, label: id })))
  for (const id of CODE_UNIT_ORDER) value.nodes[0].edges.push({ to: id, condition: `route to ${id}` })

  const { graph, analysis, diagram } = await reportFor(value)
  const layout = layoutGraph(graph, analysis, [{ text: 'x', role: 'title' }])
  const row = layout.rows.find((item) => item.boxes.some((box) => box.node.id === 'Zeta'))
  assert.notEqual(row, undefined)
  // The outcome shares the row, since the start step also edges straight to
  // it; every other box in the row is one of the fixtures.
  assert.deepEqual(
    row.boxes.map((box) => box.node.id).filter((id) => id !== 'approved'),
    [...CODE_UNIT_ORDER],
  )

  // And in the drawn document, left to right by x co-ordinate.
  const drawn = [...diagram.matchAll(/<text class="node-title" x="(\d+)"[^>]*>([^<]+)</g)]
    .map((match) => ({ x: Number(match[1]), text: match[2] }))
    .filter((item) => CODE_UNIT_ORDER.includes(item.text))
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text)
  assert.deepEqual(drawn, [...CODE_UNIT_ORDER])
})

test('the steps no path reaches are drawn in code-unit order too', async () => {
  const { graph, analysis } = await reportFor(graphWith(CODE_UNIT_ORDER.map((id) => step({ id }))))
  const layout = layoutGraph(graph, analysis, [{ text: 'x', role: 'title' }])
  const band = layout.rows.find((row) => row.banner !== null)
  assert.notEqual(band, undefined)
  assert.deepEqual(band.boxes.map((box) => box.node.id), [...CODE_UNIT_ORDER])
})

test('unknown keys are reported in code-unit order', async () => {
  const value = structuredClone(GRAPH)
  for (const key of CODE_UNIT_ORDER) value[key] = 1
  const { report } = await reportFor(value)
  assert.deepEqual(
    report.findings.filter((item) => item.ruleId === 'graph-key-unknown').map((item) => item.location.pointer),
    CODE_UNIT_ORDER.map((key) => `/${key}`),
  )
})

test('cycles are reported in code-unit order, each rotated to its smallest id', async () => {
  // Two separate loops, declared with the later-sorting one first.
  const value = graphWith([
    step({ id: 'Zeta', edges: [{ to: 'alpha', condition: 'onwards' }] }),
    step({ id: 'alpha', edges: [{ to: 'Zeta', condition: 'back' }, { to: 'approved', condition: 'done' }] }),
    step({ id: 'ab', edges: [{ to: 'a_b', condition: 'onwards' }] }),
    step({ id: 'a_b', edges: [{ to: 'ab', condition: 'back' }, { to: 'approved', condition: 'done' }] }),
  ])
  for (const id of ['Zeta', 'ab']) value.nodes[0].edges.push({ to: id, condition: `route to ${id}` })

  const { report, analysis } = await reportFor(value)
  assert.deepEqual(analysis.cycles, [['Zeta', 'alpha'], ['a_b', 'ab']])
  assert.deepEqual(
    report.findings.filter((item) => item.ruleId === 'approval-cycle').map((item) => item.evidence),
    ['Zeta -> alpha -> Zeta', 'a_b -> ab -> a_b'],
  )
})

test('the loops a tangle reports are decided by the node order this tool fixes', async () => {
  // The compiled node order is the order the cycle search takes its depth-first
  // roots in, which decides WHICH loops of an overlapping region get reported.
  // These three ids are `Zeta, a_b, ab` by code unit and `a_b, ab, Zeta` under
  // collation, and the two orders report different sets: rooted at Zeta the
  // walk finds two loops, rooted at a_b it finds three, and
  // "Zeta -> ab -> Zeta" -- a loop nothing in the file traverses that way --
  // appears in the report. Both are honest back-edge searches. Only one of them
  // gives the same answer on every machine, and it is the one asserted here.
  const value = graphWith([
    step({ id: 'Zeta', edges: [{ to: 'a_b', condition: 'to a_b' }, { to: 'ab', condition: 'to ab' }] }),
    step({ id: 'a_b', edges: [{ to: 'ab', condition: 'onwards' }] }),
    step({ id: 'ab', edges: [{ to: 'Zeta', condition: 'back' }, { to: 'a_b', condition: 'back again' }] }),
  ])
  value.nodes[0].edges.push({ to: 'Zeta', condition: 'into the tangle' })

  const { report, graph } = await reportFor(value)
  assert.deepEqual(graph.nodes.map((node) => node.id), ['Zeta', 'a_b', 'ab', 'approved', 'intake'])
  assert.deepEqual(
    report.findings.filter((item) => item.ruleId === 'approval-cycle').map((item) => item.evidence),
    ['Zeta -> a_b -> ab -> Zeta', 'a_b -> ab -> a_b'],
  )
  assert.equal(report.summary.cycles, 2)
  assert.equal(report.summary.errors, 2)
})

test('two findings sharing a pointer and a rule are ordered by their message, by code unit', async () => {
  // The last comparator in the report sort, and the only fixture that reaches
  // it: two loops through one step, canonically rotated to the same first id,
  // so file, pointer and ruleId are all equal and the message alone decides.
  // `Zeta` before `alpha` is code units; every collation puts it the other way.
  const value = graphWith([
    step({
      id: 'A',
      edges: [
        { to: 'Zeta', condition: 'one way' },
        { to: 'alpha', condition: 'the other' },
        { to: 'approved', condition: 'done' },
      ],
    }),
    step({ id: 'Zeta', edges: [{ to: 'A', condition: 'back' }] }),
    step({ id: 'alpha', edges: [{ to: 'A', condition: 'back' }] }),
  ])
  value.nodes[0].edges.push({ to: 'A', condition: 'into the loops' })

  const { report } = await reportFor(value)
  assert.deepEqual(report.findings.map((item) => [item.location.pointer, item.ruleId]), [
    ['/nodes/A', 'approval-cycle'],
    ['/nodes/A', 'approval-cycle'],
  ])
  assert.deepEqual(report.findings.map((item) => item.message), [
    'Approval cycle: A -> Zeta -> A. A request that enters it can be sent round forever.',
    'Approval cycle: A -> alpha -> A. A request that enters it can be sent round forever.',
  ])

  // And the premise that makes the first comparator in that sort untestable:
  // one run reads one file, so every row carries the same `location.file` and
  // no pair of findings can disagree about it. It is kept because the sort key
  // is documented as four fields, not because a fixture could distinguish it.
  assert.deepEqual([...new Set(report.findings.map((item) => item.location.file))], ['approval.json'])
})

test('the approvers listed in a message keep the order the graph declared', async () => {
  // Not sorted: an escalation list is written in the order it is worked
  // through, and reordering it would misreport the path.
  const { report } = await reportFor(graphWith([step({ id: 'stranded', approvers: ['Zeta', 'alpha', 'ab'] })]))
  assert.match(report.findings[0].message, /\(Zeta, alpha, ab\)/)
})
