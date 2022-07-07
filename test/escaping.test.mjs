import assert from 'node:assert/strict'
import test from 'node:test'

import { visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, attributeNames, elementNames, graphWith, step, tagsBalance, workspace } from './support.mjs'

/** Everything between `<` and `>`: element names and attributes, no text content. */
function insideTags(markup) {
  return (markup.match(/<[A-Za-z][^<>]*>/g) ?? []).join(' ')
}

/**
 * Escaping is the security property of this tool, so it is tested by what the
 * rendered document IS, not by what the escape function returns.
 *
 * Every label, approver name, branch condition, exception reason, outcome and
 * node id below comes out of a file the tool did not write and goes into
 * generated markup. Each payload is pushed through the real entry point -- a
 * real file on disk, read, compiled, analysed and rendered -- and the
 * assertion is that the document's element and attribute vocabulary is exactly
 * the vocabulary of the same diagram drawn from harmless text. A payload that
 * created an element or an attribute would change one of those sets; a payload
 * that broke out of a `<text>` element would unbalance the tags.
 *
 * The payloads are then asserted to be PRESENT as text, because silently
 * dropping a hostile label would pass every assertion above while hiding the
 * step from the person reading the diagram.
 */

const PAYLOADS = Object.freeze([
  ['script element', '<script>alert(9)</script>'],
  ['break out of a text element', '</text><script>alert(9)</script><text x="1" y="1">'],
  ['attribute break, double quote', '" onload="alert(9)'],
  ['attribute break, single quote', "' onload='alert(9)"],
  ['comment opener', '<!-- swallowed --> alert(9)'],
  ['comment closer', '--> alert(9) <!--'],
  ['CDATA terminator', ']]><script>alert(9)</script>'],
  ['nested svg with a handler', '<svg onload="alert(9)"><circle r="9" /></svg>'],
  ['foreign object and iframe', '<foreignObject><iframe src="javascript:alert(9)"></iframe></foreignObject>'],
  ['style takeover', '</style><style>rect { display: none } alert(9)</style>'],
  ['an entity that must stay literal', '&lt;script&gt;alert(9)&lt;/script&gt;'],
  ['an ampersand run', '&&amp;&#x3c;script&#x3e;alert(9)'],
])

/**
 * Where an untrusted string can arrive. Each builder returns a graph carrying
 * the payload at exactly one site, so a site nobody escaped cannot hide behind
 * a site somebody did.
 */
const SITES = Object.freeze([
  ['a step label', (payload) => graphWith([], {
    nodes: [{ ...step({ id: 'intake', label: payload }) }, ...structuredClone(GRAPH.nodes).slice(1)],
  })],
  ['an approver name', (payload) => graphWith([], {
    nodes: [{ ...step({ id: 'intake', approvers: [payload] }) }, ...structuredClone(GRAPH.nodes).slice(1)],
  })],
  ['a branch condition', (payload) => graphWith([], {
    nodes: [
      { ...step({ id: 'intake', edges: [{ to: 'approved', condition: payload }] }) },
      ...structuredClone(GRAPH.nodes).slice(1),
    ],
  })],
  ['an exception reason', (payload) => graphWith([], {
    nodes: [
      { ...step({ id: 'intake', exceptions: [{ to: 'approved', reason: payload }] }) },
      ...structuredClone(GRAPH.nodes).slice(1),
    ],
  })],
  ['the graph name', (payload) => graphWith([], { name: payload })],
  // A node id is an identifier, and an identifier is exactly where another
  // tool in this catalog left its untrusted value unescaped: it reaches the
  // diagram as a box caption, as the target named on a timeout arrow and in
  // the finding that says no path reaches it.
  ['a node id', (payload) => graphWith([{ id: payload, kind: 'approval', approvers: ['someone'] }])],
  ['an outcome value', (payload) => graphWith([
    { id: 'other', kind: 'outcome', label: 'Other', outcome: payload },
  ])],
])

async function diagramFor(graph, format) {
  return workspace(
    async ({ root }) => (await visualizeApprovalPath({ root, graph: 'approval.json', format })).diagram,
    { graph },
  )
}

for (const format of ['svg', 'html']) {
  test(`no payload can add an element or an attribute to the ${format} document`, async () => {
    const baseline = await diagramFor(graphWith([{
      id: 'harmless', kind: 'approval', label: 'Harmless', approvers: ['someone'],
    }]), format)
    const baselineElements = elementNames(baseline)
    const baselineAttributes = attributeNames(baseline)
    assert.ok(baselineElements.length > 4)
    assert.ok(baselineAttributes.length > 4)
    assert.equal(baselineAttributes.some((name) => name.startsWith('on')), false)

    for (const [siteName, build] of SITES) {
      for (const [payloadName, payload] of PAYLOADS) {
        const where = `${payloadName} through ${siteName} (${format})`
        const diagram = await diagramFor(build(payload), format)

        // Subset, not equality: the danger is a payload ADDING an element or
        // an attribute. A fixture with fewer findings than the baseline
        // legitimately renders fewer kinds of element.
        for (const name of elementNames(diagram)) assert.ok(baselineElements.includes(name), `${where}: <${name}>`)
        for (const name of attributeNames(diagram)) assert.ok(baselineAttributes.includes(name), `${where}: ${name}=`)
        assert.equal(tagsBalance(diagram), true, where)

        // The shapes named in this tool's brief, asserted literally. The
        // handler and the scheme are checked inside tags only: as escaped TEXT
        // the words are inert and must survive, which is the point.
        assert.equal(diagram.includes('<script'), false, where)
        assert.equal(diagram.includes('<!--'), false, where)
        assert.equal(diagram.includes(']]>'), false, where)
        assert.equal(insideTags(diagram).includes('onload'), false, where)
        assert.equal(insideTags(diagram).includes('javascript:'), false, where)

        // Rendered as text rather than dropped: the payload's own marker
        // survives, and the characters it would have used are escaped.
        assert.ok(diagram.includes('alert(9)'), `${where}: the label was not rendered at all`)
        if (payload.includes('<')) assert.ok(diagram.includes('&lt;'), where)
        if (payload.includes('&')) assert.ok(diagram.includes('&amp;'), where)
      }
    }
  })
}

test('an already-escaped entity is escaped again, not handed on to be decoded', async () => {
  const diagram = await diagramFor(graphWith([], {
    nodes: [
      { ...step({ id: 'intake', label: '&lt;script&gt;alert(9)&lt;/script&gt;' }) },
      ...structuredClone(GRAPH.nodes).slice(1),
    ],
  }), 'svg')
  assert.ok(diagram.includes('&amp;lt;script&amp;gt;'))
  assert.equal(diagram.includes('&lt;script&gt;'), false)
})

test('a payload in a node id is escaped in the diagram and readable in the report', async () => {
  const payload = '<script>alert(9)</script>'
  const { report, diagram } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
    { graph: graphWith([{ id: payload, kind: 'approval', approvers: ['someone'] }]) },
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), [
    'label-missing', 'node-unreachable', 'path-dead-end', 'timeout-missing',
  ])
  // The report is JSON, not markup: the id is carried through verbatim so a
  // reader can find the node, and it is the DIAGRAM that must escape it.
  const unreachable = report.findings.find((item) => item.ruleId === 'node-unreachable')
  assert.equal(unreachable.location.pointer, `/nodes/${payload}`)
  assert.ok(diagram.includes('&lt;script&gt;'))
  assert.equal(diagram.includes('<script'), false)
})

test('a timeout target drawn onto a step is escaped too', async () => {
  const payload = '"><script>alert(9)</script>'
  const diagram = await diagramFor(graphWith([], {
    nodes: [
      { ...step({ id: 'intake', timeout: { after: 'P1D', to: payload } }) },
      ...structuredClone(GRAPH.nodes).slice(1),
    ],
  }), 'svg')
  assert.ok(diagram.includes('timeout P1D to'))
  assert.equal(diagram.includes('<script'), false)
  assert.equal(tagsBalance(diagram), true)
})
