/**
 * Rendering a compiled approval graph as a standalone SVG or HTML document.
 *
 * Every string that reaches this module came out of a file this tool did not
 * write -- step labels, approver names, branch conditions, exception reasons,
 * the graph's own name -- and all of them end up inside generated markup. That
 * makes escaping the security property of this tool, not a presentation
 * detail, so there is exactly one way for an untrusted value to enter the
 * output: `markupText`, which strips the control and bidirectional classes and
 * then escapes `&`, `<`, `>`, `"` and `'`. A label spelling `<script>`, an
 * attribute break, a comment opener or `]]>` comes out as text saying so.
 *
 * The layout is arithmetic on integers: a breadth-first layer index, a
 * character count, a fixed box width. No font is measured, no clock is read
 * and no map is iterated in insertion order, so the same graph renders to the
 * same bytes on every machine.
 */

import { byCodeUnit, markupText, wrapText } from './text.mjs'
import { outgoingLinks } from './graph.mjs'

export const RENDER_FORMATS = Object.freeze(['html', 'svg'])

const BOX_WIDTH = 240
const BOX_CHARS = 32
const LINE_HEIGHT = 15
const BOX_PAD_Y = 13
const GAP_X = 36
const LAYER_GAP = 86
const MARGIN = 28
const MIN_WIDTH = 680
const HEADER_LINE = 20
const LEGEND_HEIGHT = 58
const LABEL_CHAR_WIDTH = 7
const BACK_EDGE_BULGE = 96
const LABEL_LINE = 12

/** One text line inside a node box, with the class that styles it. */
function boxLines(node, flags) {
  const lines = wrapText(node.label, BOX_CHARS).map((text) => ({ text, role: 'title' }))
  if (lines.length === 0) lines.push({ text: node.id, role: 'title' })

  if (node.kind === 'approval') {
    const approvers = node.approvers.length === 0
      ? ['approvers: none named']
      : wrapText(`approvers: ${node.approvers.join(', ')}`, BOX_CHARS)
    for (const text of approvers) lines.push({ text, role: 'meta' })
  }
  if (node.outcome !== null) lines.push({ text: `outcome: ${node.outcome}`, role: 'meta' })
  if (node.timeout !== null) {
    const after = node.timeout.after === null ? 'unreadable duration' : node.timeout.after
    for (const text of wrapText(`timeout ${after} to ${node.timeout.to}`, BOX_CHARS)) {
      lines.push({ text, role: 'meta' })
    }
  }
  for (const flag of flags) lines.push({ text: flag, role: 'flag' })
  return lines
}

/** What this run concluded about one node, said on the node itself. */
function nodeFlags(node, analysis) {
  const flags = []
  if (!analysis.decided) return flags
  if (!analysis.layers.has(node.id)) flags.push('! no path reaches this step')
  if (analysis.onCycle.has(node.id)) flags.push('! on an approval cycle')
  if (node.kind === 'approval' && analysis.layers.has(node.id) && !analysis.reachesOutcome.has(node.id)) {
    flags.push('! no outcome reachable')
  }
  return flags
}

/**
 * Place every node in a layer, and every layer in a row.
 *
 * Reachable nodes take the length of the shortest path that reaches them;
 * nodes no path reaches are gathered into one final band so that a reader sees
 * them apart from the flow rather than hidden inside it. Within a band the
 * order is by code unit, never by the order the nodes were declared or the
 * order a map happened to return.
 */
export function layoutGraph(graph, analysis, headerLines) {
  const bands = new Map()
  let maxLayer = -1
  for (const node of graph.nodes) {
    const layer = analysis.decided ? analysis.layers.get(node.id) : 0
    if (layer !== undefined && layer > maxLayer) maxLayer = layer
  }
  const orphanLayer = maxLayer + 1

  for (const node of graph.nodes) {
    const layer = analysis.decided ? (analysis.layers.get(node.id) ?? orphanLayer) : 0
    if (!bands.has(layer)) bands.set(layer, [])
    bands.get(layer).push(node)
  }

  const layerIndexes = [...bands.keys()].sort((left, right) => left - right)
  const rows = []
  let width = MIN_WIDTH
  for (const layer of layerIndexes) {
    const nodes = bands.get(layer).slice().sort((left, right) => byCodeUnit(left.id, right.id))
    const boxes = nodes.map((node) => {
      const lines = boxLines(node, nodeFlags(node, analysis))
      return { node, lines, height: BOX_PAD_Y * 2 + lines.length * LINE_HEIGHT }
    })
    const rowWidth = boxes.length * BOX_WIDTH + (boxes.length - 1) * GAP_X
    width = Math.max(width, rowWidth + MARGIN * 2)
    rows.push({ layer, boxes, rowWidth, height: Math.max(...boxes.map((box) => box.height)) })
  }

  const headerHeight = MARGIN + headerLines.length * HEADER_LINE + 12
  const placed = new Map()
  let top = headerHeight
  for (const row of rows) {
    const isOrphanBand = analysis.decided && row.layer === orphanLayer && orphanLayer > 0
    row.top = top
    row.banner = isOrphanBand ? 'not reachable from the start step' : null
    if (isOrphanBand) row.top += 22
    const left = Math.round((width - row.rowWidth) / 2)
    for (const [position, box] of row.boxes.entries()) {
      box.x = left + position * (BOX_WIDTH + GAP_X)
      box.y = row.top
      placed.set(box.node.id, box)
    }
    top = row.top + row.height + LAYER_GAP
  }

  const height = (rows.length === 0 ? headerHeight : top - LAYER_GAP + MARGIN) + LEGEND_HEIGHT
  return { rows, placed, width, height, headerHeight }
}

const LINK_CLASS = Object.freeze({ edge: 'link-edge', timeout: 'link-timeout', exception: 'link-exception' })
const LINK_MARKER = Object.freeze({ edge: 'apv-arrow', timeout: 'apv-arrow-timeout', exception: 'apv-arrow-exception' })

function linkPath(from, to) {
  const x1 = from.x + BOX_WIDTH / 2
  const y1 = from.y + from.height
  const x2 = to.x + BOX_WIDTH / 2
  const y2 = to.y
  if (y2 > y1) {
    return { d: `M ${x1} ${y1} L ${x2} ${y2}`, labelX: Math.round((x1 + x2) / 2), labelY: Math.round((y1 + y2) / 2) }
  }
  // A link that does not go downwards is a return path: bulge it out to the
  // right so it is visible as one instead of vanishing behind the boxes.
  const bulge = Math.max(x1, x2) + BACK_EDGE_BULGE
  return {
    d: `M ${x1} ${y1} C ${bulge} ${y1 + 24}, ${bulge} ${y2 - 24}, ${x2} ${y2}`,
    labelX: Math.round(bulge - 10),
    labelY: Math.round((y1 + y2) / 2),
  }
}

/**
 * The condition, timeout or reason written on an arrow.
 *
 * Wrapped rather than cut: the value is already bounded by `maxLabelLength`,
 * and a condition shown as its first thirty characters reads like the whole
 * condition to anyone looking at the picture.
 */
function edgeLabel(text, x, y) {
  const lines = wrapText(text, BOX_CHARS)
  if (lines.length === 0) return ''
  const width = Math.max(24, Math.max(...lines.map((line) => line.length)) * LABEL_CHAR_WIDTH)
  const top = y - 11 - (lines.length - 1) * LABEL_LINE
  const parts = [
    `    <rect class="link-label-box" x="${Math.round(x - width / 2)}" y="${top}" ` +
    `width="${width}" height="${16 + (lines.length - 1) * LABEL_LINE}" rx="3" />`,
  ]
  for (const [index, line] of lines.entries()) {
    parts.push(
      `    <text class="link-label" x="${x}" y="${y - (lines.length - 1 - index) * LABEL_LINE}" ` +
      `text-anchor="middle">${markupText(line)}</text>`,
    )
  }
  return parts.join('\n')
}

const STYLE = [
  '    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
  '    .canvas { fill: #fbfbfa; }',
  '    .title { font-size: 15px; fill: #1b1b1a; }',
  '    .subtitle { font-size: 11px; fill: #55554f; }',
  '    .alert { font-size: 11px; fill: #8a2f1d; }',
  '    .band { font-size: 11px; fill: #8a2f1d; }',
  '    .box { fill: #ffffff; stroke: #9a9a92; stroke-width: 1; }',
  '    .box-outcome { fill: #f2f7f2; stroke: #4f7a4f; }',
  '    .box-flagged { fill: #fdf3f1; stroke: #8a2f1d; stroke-dasharray: 5 3; }',
  '    .box-start { stroke: #1b4f8a; stroke-width: 2; }',
  '    .node-title { font-size: 12px; fill: #1b1b1a; }',
  '    .node-meta { font-size: 10px; fill: #55554f; }',
  '    .node-flag { font-size: 10px; fill: #8a2f1d; }',
  '    .link-edge { fill: none; stroke: #4a4a45; stroke-width: 1.5; }',
  '    .link-timeout { fill: none; stroke: #7a5c1b; stroke-width: 1.5; stroke-dasharray: 2 3; }',
  '    .link-exception { fill: none; stroke: #8a2f1d; stroke-width: 1.5; stroke-dasharray: 7 4; }',
  '    .link-label { font-size: 10px; fill: #3b3b37; }',
  '    .link-label-box { fill: #fbfbfa; stroke: #d8d8d2; }',
  '    .legend { font-size: 10px; fill: #55554f; }',
].join('\n')

const MARKERS = [
  '    <marker id="apv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
  '      <path d="M 0 0 L 10 5 L 0 10 z" fill="#4a4a45" />',
  '    </marker>',
  '    <marker id="apv-arrow-timeout" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
  '      <path d="M 0 0 L 10 5 L 0 10 z" fill="#7a5c1b" />',
  '    </marker>',
  '    <marker id="apv-arrow-exception" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">',
  '      <path d="M 0 0 L 10 5 L 0 10 z" fill="#8a2f1d" />',
  '    </marker>',
].join('\n')

const LEGEND = Object.freeze([
  'solid arrow: conditional edge',
  'dotted arrow: timeout',
  'dashed arrow: exception exit',
  'dashed red box: a finding names this step',
])

/**
 * The lines printed across the top of the diagram.
 *
 * A diagram is passed around long after the report that produced it, so it
 * states its own verdict on its face. A run that could not obtain its evidence
 * says so here rather than looking like a complete picture of an approval
 * path that was never fully read.
 */
export function headerLines(graph, analysis, report, title) {
  const lines = [{ text: graph.name === '' ? title : graph.name, role: 'title' }]
  const counts = report.summary
  lines.push({
    text: `${counts.approvalSteps} approval step(s), ${counts.outcomes} outcome(s), ` +
      `${counts.edges} edge(s), ${counts.timeouts} timeout(s), ${counts.exceptionExits} exception exit(s)`,
    role: 'subtitle',
  })
  lines.push({
    text: `status ${report.status}: ${counts.errors} error(s), ${counts.warnings} warning(s)`,
    role: report.status === 'pass' ? 'subtitle' : 'alert',
  })
  if (report.status === 'incomplete') {
    lines.push({
      text: 'evidence was incomplete: this diagram may be missing steps or links, and no reachability verdict is claimed',
      role: 'alert',
    })
  }
  if (!analysis.decided) {
    lines.push({ text: 'no path was traced, so unreachable steps and cycles are not marked', role: 'alert' })
  }
  return lines
}

/**
 * Render the diagram.
 *
 * `format` is `svg` for a standalone image or `html` for a page that embeds
 * the same image above the findings. Both go through the same escaping; the
 * HTML page adds no untrusted value the SVG does not already carry.
 */
export function renderDiagram({ graph, analysis, report, format = 'svg', title = 'approval path' }) {
  if (!RENDER_FORMATS.includes(format)) throw new TypeError(`Unknown render format "${format}"`)
  const header = headerLines(graph, analysis, report, title)
  const layout = layoutGraph(graph, analysis, header)
  const svg = renderSvg(graph, analysis, report, header, layout)
  return format === 'svg' ? svg : renderHtml(graph, report, header, svg)
}

function renderSvg(graph, analysis, report, header, layout) {
  const parts = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" ` +
    `width="${layout.width}" height="${layout.height}" role="img" aria-labelledby="apv-title apv-desc">`,
  )
  parts.push(`  <title id="apv-title">${markupText(header[0].text)}</title>`)
  parts.push(
    `  <desc id="apv-desc">Approval path diagram. ${markupText(header[1].text)}. ` +
    `Status ${markupText(report.status)}.</desc>`,
  )
  parts.push(`  <style>\n${STYLE}\n  </style>`)
  parts.push(`  <defs>\n${MARKERS}\n  </defs>`)
  parts.push(`  <rect class="canvas" x="0" y="0" width="${layout.width}" height="${layout.height}" />`)

  for (const [index, line] of header.entries()) {
    const cls = line.role === 'title' ? 'title' : line.role === 'alert' ? 'alert' : 'subtitle'
    parts.push(
      `  <text class="${cls}" x="${MARGIN}" y="${MARGIN + index * HEADER_LINE}">${markupText(line.text)}</text>`,
    )
  }

  parts.push('  <g class="links">')
  for (const node of graph.nodes) {
    const from = layout.placed.get(node.id)
    for (const link of outgoingLinks(node)) {
      const to = layout.placed.get(link.to)
      if (from === undefined || to === undefined) continue
      const path = linkPath(from, to)
      parts.push(
        `    <path class="${LINK_CLASS[link.kind]}" d="${path.d}" marker-end="url(#${LINK_MARKER[link.kind]})" />`,
      )
      if (link.label !== null && link.label !== undefined && link.label !== '') {
        parts.push(edgeLabel(link.label, path.labelX, path.labelY))
      }
    }
  }
  parts.push('  </g>')

  for (const row of layout.rows) {
    if (row.banner !== null) {
      parts.push(`  <text class="band" x="${MARGIN}" y="${row.top - 8}">${markupText(row.banner)}</text>`)
    }
    for (const box of row.boxes) {
      const flagged = box.lines.some((line) => line.role === 'flag')
      const classes = ['box']
      if (box.node.kind === 'outcome') classes.push('box-outcome')
      if (flagged) classes.push('box-flagged')
      if (box.node.id === graph.start) classes.push('box-start')
      // The whole box is one labelled group: a reader using a screen reader
      // gets the step as a sentence instead of a scattering of text nodes.
      // The label is untrusted text inside an ATTRIBUTE, which is why
      // `markupText` escapes both quote styles as well as the angle brackets.
      parts.push(
        `  <g class="node" aria-label="${markupText(box.lines.map((line) => line.text).join('; '), 400)}">`,
      )
      parts.push(
        `    <rect class="${classes.join(' ')}" x="${box.x}" y="${box.y}" ` +
        `width="${BOX_WIDTH}" height="${box.height}" rx="6" />`,
      )
      for (const [index, line] of box.lines.entries()) {
        const cls = line.role === 'title' ? 'node-title' : line.role === 'meta' ? 'node-meta' : 'node-flag'
        parts.push(
          `    <text class="${cls}" x="${box.x + 14}" y="${box.y + BOX_PAD_Y + 11 + index * LINE_HEIGHT}">` +
          `${markupText(line.text)}</text>`,
        )
      }
      parts.push('  </g>')
    }
  }

  const legendY = layout.height - LEGEND_HEIGHT + 20
  for (const [index, entry] of LEGEND.entries()) {
    parts.push(
      `  <text class="legend" x="${MARGIN + (index % 2) * 320}" y="${legendY + Math.floor(index / 2) * 16}">` +
      `${markupText(entry)}</text>`,
    )
  }
  parts.push('</svg>')
  return `${parts.join('\n')}\n`
}

function renderHtml(graph, report, header, svg) {
  const rows = report.findings.map((finding) => [
    '      <li>',
    `        <span class="severity severity-${markupText(finding.severity)}">${markupText(finding.severity)}</span>`,
    `        <code>${markupText(finding.location.pointer)}</code>`,
    `        <strong>${markupText(finding.ruleId)}</strong>`,
    `        ${markupText(finding.message)}`,
    '      </li>',
  ].join('\n'))

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${markupText(header[0].text)}</title>`,
    '<style>',
    '  body { margin: 0; padding: 24px; background: #f4f4f1; color: #1b1b1a;',
    '         font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
    '  main { max-width: 1100px; margin: 0 auto; }',
    '  svg { max-width: 100%; height: auto; background: #fbfbfa; border: 1px solid #d8d8d2; }',
    '  h1 { font-size: 18px; }',
    '  ul { list-style: none; padding: 0; }',
    '  li { border-top: 1px solid #d8d8d2; padding: 8px 0; font-size: 13px; }',
    '  .severity { display: inline-block; min-width: 72px; text-transform: uppercase; font-size: 11px; }',
    '  .severity-error { color: #8a2f1d; }',
    '  .severity-warning { color: #7a5c1b; }',
    '  .severity-info { color: #3b5c7a; }',
    '  code { color: #55554f; }',
    '</style>',
    '</head>',
    '<body>',
    '  <main>',
    `    <h1>${markupText(header[0].text)}</h1>`,
    `    <p>${markupText(header[1].text)}</p>`,
    `    <p>${markupText(header[2].text)}</p>`,
    svg.trimEnd(),
    `    <h2>Findings (${report.findings.length})</h2>`,
    '    <ul>',
    rows.length === 0 ? '      <li>No finding was reported.</li>' : rows.join('\n'),
    '    </ul>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
