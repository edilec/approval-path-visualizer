/**
 * approval-path-visualizer
 *
 * Reads one approval graph -- steps, approvers, branch conditions, timeouts
 * and exception exits -- checks the paths through it, and renders a standalone
 * SVG or HTML diagram of what it found.
 *
 * Three properties are structural rather than incidental:
 *
 * 1. **The input is opened read-only.** The diagram is a derived artifact
 *    written to a destination that is refused if it resolves inside the input
 *    root -- or if it is the graph file itself under a second name, which a
 *    hard link is and no path comparison can see -- so a run can never
 *    overwrite the graph it was asked to draw, and there is no auto-fix of any
 *    kind.
 * 2. **Every untrusted string is sanitised and escaped before it enters the
 *    output.** Labels, approver names, conditions, reasons and ids all come
 *    from a file this tool did not write and all end up inside markup. A label
 *    spelling `<script>` renders as the text `<script>`.
 * 3. **A verdict is withheld rather than guessed.** "No path reaches this
 *    step" is a serious accusation; it is only made when the traversal that
 *    decides it ran to completion. A bounded-out walk is `incomplete`, which
 *    is not a pass and not a failure but a statement that the tool did not
 *    find out.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { analyseGraph, compileGraph, outgoingLinks } from './graph.mjs'
import { RENDER_FORMATS, renderDiagram } from './render.mjs'
import { byCodeUnit, decodeUtf8, excerpt, isPlainObject, parseFailureDetail } from './text.mjs'
import { DestinationError, assertWritableDestination } from './write-guard.mjs'

export { DestinationError, assertWritableDestination } from './write-guard.mjs'

export const TOOL_ID = 'approval-path-visualizer'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * An approval graph is ordinary untrusted input: it can be a generated 50 MB
 * file, a thousand steps deep, or a small graph whose edges are arranged to
 * make a path walk quadratic. Every limit below is explicit, overridable from
 * the CLI, and reported by name when it is hit. Exceeding one produces a
 * finding and an `incomplete` report -- never a quietly shorter diagram, and
 * never a pass.
 *
 * `maxTraversalSteps` is a work budget rather than a wall-clock timeout on
 * purpose. A timeout makes the result depend on how busy the machine was, and
 * a report that says "fail" on a fast host and "incomplete" on a slow one is
 * not reproducible. Counting the links the walk follows bounds exactly the
 * same runaway and decides the same way every time.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxGraphBytes: 1048576,
  maxNodes: 500,
  maxEdgesPerNode: 32,
  maxApprovers: 16,
  maxLabelLength: 120,
  maxDepth: 64,
  maxTraversalSteps: 200000,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Spread across three dozen construction sites as a literal it drifts
 * silently, and flipping one rule down to a warning turns a refusal into a
 * green build with every test still passing. Every finding takes its severity
 * from here, an unknown rule id throws, and `docs/approval-path-rules.md` is
 * asserted against this table in both directions.
 *
 * That is the source of truth, and it is not the guard: agreeing declarations
 * can be edited together, and a test that drives the real binary and then
 * compares against a severity in a map the same edit touches is a fourth
 * declaration, not a guard. So every rule here is pinned again in
 * `test/severity-pins.test.mjs`, which imports no table, reads no catalog and
 * holds no map: one case per rule, every expectation a literal at its
 * assertion -- status, exit code and counted errors for a rule that decides a
 * verdict, and the counted errors plus the severity word the human report
 * prints for one that leaves the run `incomplete`, where the exit code is 2
 * whichever way the rule is graded.
 */
export const RULE_SEVERITY = Object.freeze({
  'approval-cycle': 'error',
  'approvers-duplicate': 'warning',
  'approvers-missing': 'error',
  'approvers-unexpected': 'error',
  'condition-duplicate': 'warning',
  'condition-missing': 'warning',
  'edge-duplicate': 'warning',
  'edge-target-missing': 'error',
  'exception-reason-missing': 'warning',
  'exception-target-missing': 'error',
  'graph-invalid': 'error',
  'graph-key-unknown': 'error',
  'graph-name-missing': 'info',
  'graph-not-json': 'error',
  'graph-not-utf8': 'error',
  'graph-too-large': 'error',
  'graph-unreadable': 'error',
  'label-control-characters': 'warning',
  'label-missing': 'warning',
  'label-too-long': 'error',
  'no-nodes-declared': 'warning',
  'node-id-duplicate': 'error',
  'node-invalid': 'error',
  'node-key-unknown': 'error',
  'node-unreachable': 'error',
  'outcome-missing': 'error',
  'outcome-not-terminal': 'error',
  'outcome-unexpected': 'error',
  'outcome-unreachable': 'error',
  'outcome-value-unknown': 'error',
  'path-dead-end': 'error',
  'path-too-deep': 'error',
  'start-missing': 'error',
  'start-unknown': 'error',
  'timeout-duration-invalid': 'error',
  'timeout-missing': 'warning',
  'timeout-target-missing': 'error',
  'too-many-approvers': 'error',
  'too-many-edges': 'error',
  'too-many-nodes': 'error',
  'traversal-budget-exceeded': 'error',
})

const ALLOWED_OPTIONS = Object.freeze(['format', 'graph', 'limits', 'root'])
const ANCESTOR_PROBE_LIMIT = 64

/**
 * Containment, checked on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Both sides have been through `realpath` before they
 * reach this function -- comparing a real root against an unresolved candidate
 * refuses legitimate files, which is a bug in the other direction.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Resolve a path that need not exist yet, by realpath-ing its nearest existing
 * ancestor and appending the rest. That still defeats a symlinked parent
 * directory, which is how a "separate destination" quietly becomes a file
 * written back into the input tree.
 */
async function resolveThroughAncestors(absolute) {
  const tail = []
  let probe = absolute
  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    try {
      const real = await realpath(probe)
      return tail.length === 0 ? real : join(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`Path could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError('Path has no existing ancestor directory')
      tail.unshift(basename(probe))
      probe = parent
    }
  }
  throw new TypeError('Path is nested too deeply to resolve')
}

/** Resolve the graph file inside the input root. Outside the root is a refusal, not a finding. */
export async function resolveGraphPath(rootReal, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new TypeError('A graph path relative to the root is required')
  }
  if (isAbsolute(relativePath)) {
    throw new TypeError('The graph path must be relative to --root, not absolute')
  }
  const resolved = await resolveThroughAncestors(resolve(rootReal, relativePath))
  if (!isInside(rootReal, resolved)) {
    throw new TypeError('The graph path resolves outside the input root and was refused; nothing was read from it')
  }
  return resolved
}

/**
 * Two names for one file.
 *
 * `realpath` resolves symbolic links, but a hard link has no target to resolve:
 * two names for one inode are two different real paths, so a path comparison
 * says they are different files while a write to either one destroys the other.
 * File identity is the `(device, inode)` pair, and nothing else is. Hard links
 * are ordinary in build trees -- `cp -l`, package stores, backup snapshots --
 * so this is not an exotic case to be waved away.
 */
export async function isSameFile(left, right) {
  let first
  let second
  try {
    first = await stat(left)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw new TypeError(`Path could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  try {
    second = await stat(right)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false
    throw new TypeError(`Path could not be inspected: ${error.code ?? 'unknown error'}`)
  }
  return first.dev === second.dev && first.ino === second.ino
}

/**
 * Resolve the diagram destination and refuse everything that would put it
 * somewhere other than the file the caller named.
 *
 * The diagram is derived from the graph; writing it back into the tree the
 * graph lives in is how a "read-only" tool ends up modifying its own input on
 * the next run. Containment was never the whole of it, and the version of this
 * function that only resolved and compared was measured destroying files:
 *
 * - `--out` pointing at a SYMBOLIC LINK: `resolveThroughAncestors` resolved the
 *   link on its first `realpath` call and handed back the target, so the write
 *   went wherever the link pointed. A 14-byte file outside the root became an
 *   11117-byte SVG while the run exited 0 and printed "diagram written". A link
 *   whose target did not exist yet created the file out there instead.
 * - `--out` under a SYMLINKED PARENT: lexically inside the tree the caller
 *   named, actually outside it, and nothing compared the resolved parent with a
 *   permitted root because there was no permitted root.
 * - `--out` as a HARD LINK to the graph: this one was already refused, and it
 *   stays refused, now by identity inside the shared guard rather than here.
 *
 * `assertWritableDestination` answers all three. Two things are layered on top
 * of it, because the guard cannot know them: the input root, which the diagram
 * must stay out of whatever `--out-root` permits, and the graph file, which is
 * passed as an input so device and inode can see a second name for it.
 */
export async function resolveDiagramDestination(rootReal, destination, graphReal = null, options = {}) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Diagram destination must be a non-empty path')
  }
  const { root = null } = options

  let resolved
  try {
    resolved = await assertWritableDestination(destination, {
      inputs: graphReal === null ? [] : [graphReal],
      root,
      label: '--out',
      rootLabel: '--out-root',
    })
  } catch (error) {
    if (!(error instanceof DestinationError)) throw error
    throw new TypeError(error.message)
  }

  // The destination itself is not a link -- the guard just refused that shape
  // -- so resolving its parent is the whole of the resolution. Containment is
  // then real path against real path in both directions: comparing a resolved
  // destination with an unresolved root refuses every legitimate destination on
  // a host where the input tree sits under a symlinked ancestor.
  const parentReal = await realpath(dirname(resolved))
  if (isInside(rootReal, join(parentReal, basename(resolved)))) {
    throw new TypeError(
      'Diagram destination is inside the input root; the diagram is a derived artifact and must be written elsewhere',
    )
  }
  return resolved
}

export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * Build one finding, taking its severity from the single table.
 *
 * Exported so a test can prove the refusal below actually throws: a rule that
 * can be emitted without a table entry is a rule whose severity nobody pinned.
 * Every string here has already been through `excerpt`, and goes through it
 * again on the way out -- a message assembled from two sanitised halves is
 * still a message this tool must not be able to forge a line with.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/approval-path-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, 400),
    location: { file: excerpt(row.file, 200), pointer: excerpt(row.pointer, 200) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence, 160)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, 240)
  return finding
}

function countLinks(nodes, kind) {
  let total = 0
  for (const node of nodes) {
    for (const link of outgoingLinks(node)) if (link.kind === kind) total += 1
  }
  return total
}

function buildReport(rows, incomplete, graph, analysis) {
  rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message))

  const findings = rows.map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const nodes = graph === null ? [] : graph.nodes
  const status = incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: nodes.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      approvalSteps: nodes.filter((node) => node.kind === 'approval').length,
      outcomes: nodes.filter((node) => node.kind === 'outcome').length,
      approvers: new Set(nodes.flatMap((node) => node.approvers)).size,
      edges: countLinks(nodes, 'edge'),
      timeouts: countLinks(nodes, 'timeout'),
      exceptionExits: countLinks(nodes, 'exception'),
      unreachable: analysis === null || !analysis.decided
        ? 0
        : nodes.filter((node) => !analysis.layers.has(node.id)).length,
      cycles: analysis === null ? 0 : analysis.cycles.length,
      traversalSteps: analysis === null ? 0 : analysis.steps,
    },
    findings,
  }
}

/**
 * Read one approval graph, check it, and render the diagram.
 *
 * Nothing here reads the network, the clock, the locale or the environment, so
 * two runs over the same bytes produce byte-identical output -- report and
 * diagram alike. The returned `diagram` is a string the caller decides what to
 * do with; this function writes nothing.
 */
export async function visualizeApprovalPath(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('An input root is required')
  }
  const format = options.format ?? 'svg'
  if (!RENDER_FORMATS.includes(format)) {
    throw new TypeError(`Unknown format "${excerpt(String(format), 40)}"; expected one of ${RENDER_FORMATS.join(', ')}`)
  }
  const limits = validateLimits(options.limits ?? {})

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Input root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Input root must be a directory')

  const graphReal = await resolveGraphPath(rootReal, options.graph)
  const file = excerpt(String(options.graph).split(sep).join('/'), 200)

  const rows = []
  let incomplete = false
  const record = (row) => {
    rows.push({ file, ...row })
    if (row.incomplete === true) incomplete = true
  }

  /** Everything below reads; the only thing that ever leaves is a string. */
  const unreadable = (message, suggestion) => {
    record({ ruleId: 'graph-unreadable', pointer: '/', message, suggestion, incomplete: true })
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  let info
  try {
    info = await stat(graphReal)
  } catch (error) {
    return unreadable(
      `Graph file could not be read: ${error.code ?? 'unknown error'}.`,
      'Check the path given to --graph, relative to --root.',
    )
  }
  if (!info.isFile()) {
    return unreadable('Graph path is not a regular file, so nothing could be read from it.')
  }
  if (info.size > limits.maxGraphBytes) {
    record({
      ruleId: 'graph-too-large',
      pointer: '/',
      message: `Graph file is ${info.size} bytes, above the maxGraphBytes limit of ${limits.maxGraphBytes}; it was not parsed.`,
      suggestion: 'Raise --max-graph-bytes, or split the approval path into separate graphs.',
      incomplete: true,
    })
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  let bytes
  try {
    bytes = await readFile(graphReal)
  } catch (error) {
    return unreadable(`Graph file could not be read: ${error.code ?? 'unknown error'}.`)
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record({
      ruleId: 'graph-not-utf8',
      pointer: '/',
      message: 'Graph file is not valid UTF-8; it was not parsed and nothing was drawn from it.',
      suggestion: 'Re-encode the graph as UTF-8.',
      incomplete: true,
    })
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  let value
  try {
    value = JSON.parse(decoded.text)
  } catch (error) {
    record({
      ruleId: 'graph-not-json',
      pointer: '/',
      message: 'Graph file is not valid JSON; it was not parsed and nothing was drawn from it.',
      evidence: excerpt(parseFailureDetail(error), 120),
      incomplete: true,
    })
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  const compiled = compileGraph(value, limits)
  for (const problem of compiled.problems) record(problem)

  if (compiled.graph === null) {
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  /**
   * Green on no evidence is a defect, not a clean bill of health. A graph that
   * declared no usable step means the run obtained nothing to judge, so it is
   * reported and the run is incomplete -- it can never be a pass.
   */
  if (compiled.graph.nodes.length === 0) {
    record({
      ruleId: 'no-nodes-declared',
      pointer: '/nodes',
      message: 'No approval step was read from this graph, so this run checked nothing and drew nothing.',
      suggestion: 'Declare the approval steps in "nodes".',
      incomplete: true,
    })
    return { report: buildReport(rows, incomplete, null, null), diagram: null, graph: null, analysis: null, file }
  }

  const analysis = analyseGraph(compiled.graph, limits)
  for (const problem of analysis.problems) record(problem)

  const report = buildReport(rows, incomplete, compiled.graph, analysis)
  const diagram = renderDiagram({
    graph: compiled.graph,
    analysis,
    report,
    format,
    title: basename(file),
  })

  return { report, diagram, graph: compiled.graph, analysis, file }
}

/** Write the derived diagram to its own destination. The input is never touched. */
export async function writeDiagram(destination, diagram) {
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, diagram, 'utf8')
  return destination
}

const SEVERITY_WIDTH = 7

export function formatReport(report, { file, name = '', diagram = null } = {}) {
  const { summary } = report
  const subject = name === '' ? file : `${name} (${file})`
  const lines = [
    `${subject}: ${summary.approvalSteps} approval step(s), ${summary.outcomes} outcome(s), ` +
    `${summary.approvers} approver(s), status ${report.status}.`,
    `paths: ${summary.edges} edge(s), ${summary.timeouts} timeout(s), ` +
    `${summary.exceptionExits} exception exit(s), ${summary.unreachable} unreachable step(s), ` +
    `${summary.cycles} cycle(s).`,
  ]
  if (diagram !== null) lines.push(`diagram: ${excerpt(diagram, 200)}`)
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export {
  analyseGraph,
  canonicalCycle,
  compileGraph,
  findCycles,
  layerFromStart,
  outgoingLinks,
  EDGE_KEYS,
  EXCEPTION_KEYS,
  GRAPH_KEYS,
  NODE_KEYS,
  NODE_KINDS,
  OUTCOME_VALUES,
  SUPPORTED_SCHEMA_VERSIONS,
  TIMEOUT_KEYS,
} from './graph.mjs'
export { RENDER_FORMATS, headerLines, layoutGraph, renderDiagram } from './render.mjs'
export {
  byCodeUnit,
  decodeUtf8,
  escapeMarkup,
  excerpt,
  hasControlCharacters,
  isIdentifier,
  markupText,
  parseDuration,
  parseFailureDetail,
  wrapText,
} from './text.mjs'
