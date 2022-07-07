import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, analyseGraph, compileGraph, renderDiagram, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, elementNames, graphWith, step, tagsBalance, workspace } from './support.mjs'

const SVG_ELEMENTS = ['defs', 'desc', 'g', 'marker', 'path', 'rect', 'style', 'svg', 'text', 'title']

/** Render a value the way the CLI does, but without touching a disk. */
function render(value, { format = 'svg', title = 'approval.json' } = {}) {
  const { graph, problems } = compileGraph(value, DEFAULT_LIMITS)
  const analysis = analyseGraph(graph, DEFAULT_LIMITS)
  const findings = [...problems, ...analysis.problems]
  const errors = findings.filter((item) => item.ruleId.startsWith('node-unreachable')).length
  const report = {
    status: findings.some((item) => item.incomplete) ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: {
      checked: graph.nodes.length,
      errors,
      warnings: 0,
      approvalSteps: graph.nodes.filter((node) => node.kind === 'approval').length,
      outcomes: graph.nodes.filter((node) => node.kind === 'outcome').length,
      edges: 0,
      timeouts: 0,
      exceptionExits: 0,
    },
    findings: [],
  }
  return { diagram: renderDiagram({ graph, analysis, report, format, title }), graph, analysis }
}

test('the diagram is a well-formed SVG built from a fixed set of elements', () => {
  const { diagram } = render(structuredClone(GRAPH))
  assert.ok(diagram.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'))
  assert.ok(diagram.trimEnd().endsWith('</svg>'))
  assert.deepEqual(elementNames(diagram), SVG_ELEMENTS)
  assert.equal(tagsBalance(diagram), true)
  assert.ok(diagram.includes('<title id="apv-title">test approval</title>'))
})

test('the same graph renders to the same bytes, every time', async () => {
  const first = render(structuredClone(GRAPH)).diagram
  const second = render(structuredClone(GRAPH)).diagram
  assert.equal(first, second)

  // And through the real entry point, from bytes on disk.
  const [runA, runB] = await workspace(async ({ root }) => Promise.all([
    visualizeApprovalPath({ root, graph: 'approval.json' }),
    visualizeApprovalPath({ root, graph: 'approval.json' }),
  ]))
  assert.equal(runA.diagram, runB.diagram)
  assert.equal(JSON.stringify(runA.report), JSON.stringify(runB.report))
})

test('every step, approver, condition, timeout and exception exit is drawn', () => {
  const value = graphWith([], {})
  value.nodes[0].exceptions = [{ to: 'approved', reason: 'requester withdrew' }]
  const { diagram } = render(value)
  assert.ok(diagram.includes('>Intake<'))
  assert.ok(diagram.includes('>approvers: ops-desk<'))
  assert.ok(diagram.includes('>timeout P1D to approved<'))
  assert.ok(diagram.includes('>outcome: approved<'))
  assert.ok(diagram.includes('>within policy<'))
  assert.ok(diagram.includes('>requester withdrew<'))
  assert.equal((diagram.match(/class="link-timeout"/g) ?? []).length, 1)
  assert.equal((diagram.match(/class="link-exception"/g) ?? []).length, 1)
})

test('a step no path reaches is drawn apart, and says so on the step', () => {
  const { diagram } = render(graphWith([step({ id: 'stranded', label: 'Stranded step' })]))
  assert.ok(diagram.includes('>not reachable from the start step<'))
  assert.ok(diagram.includes('>! no path reaches this step<'))
  assert.ok(diagram.includes('box-flagged'))
})

test('a step on a cycle is marked as one', () => {
  const value = graphWith([
    step({ id: 'legal', edges: [{ to: 'compliance', condition: 'needs compliance' }] }),
    step({ id: 'compliance', edges: [{ to: 'legal', condition: 'another read' }, { to: 'approved', condition: 'clear' }] }),
  ])
  value.nodes.find((node) => node.id === 'intake').edges.push({ to: 'legal', condition: 'legal involved' })
  const { diagram } = render(value)
  assert.equal((diagram.match(/! on an approval cycle/g) ?? []).length, 2)
})

test('a diagram drawn from incomplete evidence says so on its face', () => {
  const { graph, problems } = compileGraph(structuredClone(GRAPH), DEFAULT_LIMITS)
  const analysis = analyseGraph(graph, DEFAULT_LIMITS)
  const base = {
    summary: {
      checked: 2, errors: 0, warnings: 0, approvalSteps: 1, outcomes: 1,
      edges: 1, timeouts: 1, exceptionExits: 0,
    },
    findings: [],
  }
  assert.deepEqual(problems, [])

  const passing = renderDiagram({ graph, analysis, report: { ...base, status: 'pass' }, title: 'x' })
  assert.equal(passing.includes('evidence was incomplete'), false)
  assert.ok(passing.includes('status pass'))

  const incomplete = renderDiagram({ graph, analysis, report: { ...base, status: 'incomplete' }, title: 'x' })
  assert.ok(incomplete.includes('evidence was incomplete'))
  assert.ok(incomplete.includes('status incomplete'))
})

test('a diagram that traced no path does not pretend to have marked reachability', () => {
  const { diagram } = render({ ...structuredClone(GRAPH), start: 'nowhere' })
  assert.ok(diagram.includes('no path was traced, so unreachable steps and cycles are not marked'))
  assert.equal(diagram.includes('! no path reaches this step'), false)
})

test('the HTML format wraps the same SVG and lists the findings', async () => {
  const { report, diagram } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json', format: 'html' }),
    { graph: graphWith([step({ id: 'stranded' })]) },
  )
  assert.ok(diagram.startsWith('<!doctype html>'))
  assert.ok(diagram.includes('<svg xmlns="http://www.w3.org/2000/svg"'))
  assert.equal(tagsBalance(diagram), true)
  assert.equal(report.findings.length, 1)
  assert.ok(diagram.includes('<strong>node-unreachable</strong>'))
  assert.ok(diagram.includes('>error</span>'))
  assert.ok(diagram.includes('<h2>Findings (1)</h2>'))
})

test('an unknown render format is refused rather than guessed', () => {
  const { graph } = compileGraph(structuredClone(GRAPH), DEFAULT_LIMITS)
  const analysis = analyseGraph(graph, DEFAULT_LIMITS)
  assert.throws(
    () => renderDiagram({ graph, analysis, report: { status: 'pass', summary: {}, findings: [] }, format: 'pdf' }),
    /Unknown render format/,
  )
})
