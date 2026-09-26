/**
 * Compiling an approval graph from data, and analysing the paths through it.
 *
 * Nothing here reads the filesystem, the network, the locale or the clock, and
 * nothing here writes: the graph definition is opened read-only by the caller
 * and this module turns the decoded value into a description, or says exactly
 * why it could not. The two questions the tool exists to answer -- is there an
 * approval step no path reaches, and does the graph loop -- are decided here,
 * and both are withheld rather than guessed whenever the traversal could not
 * complete.
 */

import {
  byCodeUnit,
  excerpt,
  hasControlCharacters,
  isIdentifier,
  isPlainObject,
  parseDuration,
} from './text.mjs'

export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze(['1'])
export const NODE_KINDS = Object.freeze(['approval', 'outcome'])
export const OUTCOME_VALUES = Object.freeze(['approved', 'rejected', 'withdrawn'])

export const GRAPH_KEYS = Object.freeze(['name', 'nodes', 'schemaVersion', 'start'])
export const NODE_KEYS = Object.freeze([
  'approvers', 'edges', 'exceptions', 'id', 'kind', 'label', 'outcome', 'timeout',
])
export const EDGE_KEYS = Object.freeze(['condition', 'to'])
export const EXCEPTION_KEYS = Object.freeze(['reason', 'to'])
export const TIMEOUT_KEYS = Object.freeze(['after', 'to'])

/** Where a label's control characters were found, for one shared rule. */
const LABEL_SITES = Object.freeze({
  label: 'label',
  approver: 'approver name',
  condition: 'condition',
  reason: 'exception reason',
  outcome: 'outcome',
  name: 'graph name',
})

function collector() {
  return []
}

function add(problems, problem) {
  problems.push({ evidence: undefined, suggestion: undefined, incomplete: false, ...problem })
}

/**
 * Report and strip what an untrusted display string may not carry, and bound
 * its length.
 *
 * Every label, approver name, condition, exception reason and graph name goes
 * through here on its way to a finding or a diagram. The length bound is the
 * one that keeps a box a sane size, and going over it is a finding naming the
 * limit -- the diagram then shows the value cut short and marked with an
 * ellipsis, so a reader sees that something was cut rather than reading a
 * shortened condition as the whole condition.
 */
function displayText(problems, pointer, site, value, limits) {
  if (hasControlCharacters(value)) {
    add(problems, {
      ruleId: 'label-control-characters',
      pointer,
      message: `The ${LABEL_SITES[site]} carries control or bidirectional formatting characters; they were removed before it was rendered.`,
      evidence: excerpt(value, 60),
      suggestion: 'Remove the control characters from the source graph; a diagram cannot show what they would do.',
    })
  }
  if (value.length > limits.maxLabelLength) {
    add(problems, {
      ruleId: 'label-too-long',
      pointer,
      message: `The ${LABEL_SITES[site]} is ${value.length} characters, above the maxLabelLength limit of ${limits.maxLabelLength}; the diagram shows it cut short and marked with an ellipsis.`,
      evidence: excerpt(value, 60),
      suggestion: 'Shorten it, or raise --max-label-length.',
    })
  }
  return excerpt(value, limits.maxLabelLength)
}

/**
 * The value a judgement compares, as distinct from the value a diagram shows.
 *
 * `displayText` bounds what is drawn, and that bound is a display decision.
 * Two conditions that first differ in their 130th character are two different
 * conditions whatever `maxLabelLength` happens to be, and an outcome spelling
 * `approved` is inside the vocabulary even when the diagram has room for five
 * characters of it. Cutting first and judging afterwards makes the verdict a
 * function of a drawing option, which produced findings that were simply
 * false: a clean graph "failed" at `--max-label-length 5` with its outcomes
 * outside the vocabulary and its conditions duplicated.
 *
 * The sanitising pass still runs -- a value that prints differently from the
 * value that was compared is one nobody can audit -- and nothing is cut. This
 * value is compared and never emitted; what a finding quotes is still the
 * bounded display text.
 */
function comparableText(value) {
  return excerpt(value, Number.MAX_SAFE_INTEGER)
}

/**
 * Report every key outside the documented vocabulary.
 *
 * These rows are re-sorted by `(file, pointer, ruleId, message)` on their way
 * into the report, so a comparator here decides nothing about what is emitted.
 * There was one, and it read as a determinism guard while a full reversal of
 * it left every test in the suite green -- which is worse than no guard,
 * because a reader believes it. The order this tool emits is pinned where it
 * is decided, in `test/ordering.test.mjs`.
 */
function unknownKeys(problems, ruleId, value, allowed, pointerPrefix, what) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    add(problems, {
      ruleId,
      pointer: `${pointerPrefix}/${excerpt(key, 60)}`,
      message: `${what} key "${excerpt(key, 60)}" is not part of the documented vocabulary and was not read.`,
      suggestion: `Remove the key, or correct it to one of: ${allowed.join(', ')}.`,
    })
  }
}

/**
 * Compile one node. A node with a structural defect is DROPPED rather than
 * half-read, and dropping it makes the run incomplete: what reaches that step,
 * and what it leads to, is then unknown, and unknown is never a pass.
 */
function compileNode(problems, raw, index, limits) {
  const at = `/nodes/${index}`
  if (!isPlainObject(raw)) {
    add(problems, {
      ruleId: 'node-invalid',
      pointer: at,
      message: 'Node is not an object, so no approval step could be read from it.',
      incomplete: true,
    })
    return null
  }

  const rawId = raw.id
  if (!isIdentifier(rawId)) {
    add(problems, {
      ruleId: 'node-invalid',
      pointer: `${at}/id`,
      message: typeof rawId === 'string'
        ? 'Node id is empty, padded, too long, or carries control characters, so the node was not entered into the graph.'
        : 'Node declares no string id, so nothing can refer to it and it was not entered into the graph.',
      evidence: typeof rawId === 'string' ? excerpt(rawId, 60) : undefined,
      incomplete: true,
    })
    return null
  }

  const id = rawId
  const pointer = `/nodes/${id}`
  const drop = (message, field) => {
    add(problems, {
      ruleId: 'node-invalid',
      pointer: field === undefined ? pointer : `${pointer}/${field}`,
      message,
      incomplete: true,
    })
    return null
  }

  unknownKeys(problems, 'node-key-unknown', raw, NODE_KEYS, pointer, 'Node')

  if (!NODE_KINDS.includes(raw.kind)) {
    return drop(
      `Node kind must be one of ${NODE_KINDS.join(', ')}; the node was not entered into the graph.`,
      'kind',
    )
  }
  const kind = raw.kind

  let label = id
  if (raw.label === undefined) {
    add(problems, {
      ruleId: 'label-missing',
      pointer: `${pointer}/label`,
      message: 'Node declares no label, so the diagram shows its id instead.',
      suggestion: 'Add a label that says what this step decides.',
    })
  } else if (typeof raw.label !== 'string') {
    return drop('Node label must be a string.', 'label')
  } else if (raw.label.length > limits.maxLabelLength) {
    add(problems, {
      ruleId: 'label-too-long',
      pointer: `${pointer}/label`,
      message: `Node label is ${raw.label.length} characters, above the maxLabelLength limit of ${limits.maxLabelLength}; the id was rendered instead of a shortened label.`,
      evidence: excerpt(raw.label, 60),
      suggestion: 'Shorten the label, or raise --max-label-length.',
    })
  } else {
    label = displayText(problems, `${pointer}/label`, 'label', raw.label, limits) || id
  }

  const approvers = []
  if (raw.approvers !== undefined) {
    if (!Array.isArray(raw.approvers)) return drop('Node approvers must be an array of names.', 'approvers')
    if (kind !== 'approval') {
      add(problems, {
        ruleId: 'approvers-unexpected',
        pointer: `${pointer}/approvers`,
        message: `A node of kind "${kind}" is where a request ends, not a decision, so it cannot name approvers.`,
        suggestion: 'Move the approvers to the approval step that leads here.',
      })
    }
    if (raw.approvers.length > limits.maxApprovers) {
      add(problems, {
        ruleId: 'too-many-approvers',
        pointer: `${pointer}/approvers`,
        message: `Node names ${raw.approvers.length} approvers, above the maxApprovers limit of ${limits.maxApprovers}; the remainder were not read.`,
        suggestion: 'Raise --max-approvers, or name an approver group instead of every person.',
        incomplete: true,
      })
    }
    const seen = new Set()
    for (const [position, entry] of raw.approvers.slice(0, limits.maxApprovers).entries()) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return drop('Every approver must be a non-empty string.', `approvers/${position}`)
      }
      const name = displayText(problems, `${pointer}/approvers/${position}`, 'approver', entry, limits)
      const key = comparableText(entry)
      if (seen.has(key)) {
        add(problems, {
          ruleId: 'approvers-duplicate',
          pointer: `${pointer}/approvers/${position}`,
          message: `Approver "${name}" is named twice on this step; the second entry adds no one.`,
          suggestion: 'Remove the repeated name.',
        })
        continue
      }
      seen.add(key)
      approvers.push(name)
    }
  }
  if (kind === 'approval' && approvers.length === 0) {
    add(problems, {
      ruleId: 'approvers-missing',
      pointer: `${pointer}/approvers`,
      message: 'Approval step names no approvers, so nobody can move a request past it.',
      suggestion: 'Name at least one approver, or make this an outcome node.',
    })
  }

  const edges = []
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) return drop('Node edges must be an array.', 'edges')
    if (raw.edges.length > limits.maxEdgesPerNode) {
      add(problems, {
        ruleId: 'too-many-edges',
        pointer: `${pointer}/edges`,
        message: `Node declares ${raw.edges.length} outgoing edges, above the maxEdgesPerNode limit of ${limits.maxEdgesPerNode}; the remainder were not read, so where they lead is unknown.`,
        suggestion: 'Raise --max-edges-per-node, or split the step.',
        incomplete: true,
      })
    }
    for (const [position, entry] of raw.edges.slice(0, limits.maxEdgesPerNode).entries()) {
      const edgeAt = `edges/${position}`
      if (!isPlainObject(entry)) return drop('Every edge must be an object with a "to" target.', edgeAt)
      unknownKeys(problems, 'node-key-unknown', entry, EDGE_KEYS, `${pointer}/${edgeAt}`, 'Edge')
      if (!isIdentifier(entry.to)) return drop('Every edge must name a valid target node id in "to".', `${edgeAt}/to`)
      let condition = null
      let conditionKey = null
      if (entry.condition !== undefined) {
        if (typeof entry.condition !== 'string') return drop('An edge condition must be a string.', `${edgeAt}/condition`)
        condition = displayText(problems, `${pointer}/${edgeAt}/condition`, 'condition', entry.condition, limits)
        conditionKey = comparableText(entry.condition)
        if (conditionKey === '') {
          condition = null
          conditionKey = null
        }
      }
      edges.push({ to: entry.to, condition, conditionKey })
    }
  }

  let timeout = null
  if (raw.timeout !== undefined) {
    if (!isPlainObject(raw.timeout)) return drop('A node timeout must be an object with "after" and "to".', 'timeout')
    unknownKeys(problems, 'node-key-unknown', raw.timeout, TIMEOUT_KEYS, `${pointer}/timeout`, 'Timeout')
    if (!isIdentifier(raw.timeout.to)) return drop('A timeout must name a valid target node id in "to".', 'timeout/to')
    const duration = parseDuration(raw.timeout.after)
    if (!duration.ok) {
      add(problems, {
        ruleId: 'timeout-duration-invalid',
        pointer: `${pointer}/timeout/after`,
        message: 'Timeout duration is not an ISO-8601 duration of days, hours and minutes, so how long this step may wait is not stated.',
        evidence: typeof raw.timeout.after === 'string' ? excerpt(raw.timeout.after, 40) : undefined,
        suggestion: 'Write the wait as P2D, PT4H or PT90M. Weeks, months and years are refused because they are read two ways.',
      })
    }
    timeout = {
      to: raw.timeout.to,
      after: duration.ok ? duration.canonical : null,
      totalMinutes: duration.ok ? duration.totalMinutes : null,
    }
  }

  const exceptions = []
  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) return drop('Node exceptions must be an array.', 'exceptions')
    if (raw.exceptions.length > limits.maxEdgesPerNode) {
      add(problems, {
        ruleId: 'too-many-edges',
        pointer: `${pointer}/exceptions`,
        message: `Node declares ${raw.exceptions.length} exception exits, above the maxEdgesPerNode limit of ${limits.maxEdgesPerNode}; the remainder were not read, so where they lead is unknown.`,
        suggestion: 'Raise --max-edges-per-node, or group the exits.',
        incomplete: true,
      })
    }
    for (const [position, entry] of raw.exceptions.slice(0, limits.maxEdgesPerNode).entries()) {
      const exitAt = `exceptions/${position}`
      if (!isPlainObject(entry)) return drop('Every exception exit must be an object with a "to" target.', exitAt)
      unknownKeys(problems, 'node-key-unknown', entry, EXCEPTION_KEYS, `${pointer}/${exitAt}`, 'Exception')
      if (!isIdentifier(entry.to)) return drop('Every exception exit must name a valid target node id in "to".', `${exitAt}/to`)
      let reason = null
      if (entry.reason !== undefined) {
        if (typeof entry.reason !== 'string') return drop('An exception reason must be a string.', `${exitAt}/reason`)
        reason = displayText(problems, `${pointer}/${exitAt}/reason`, 'reason', entry.reason, limits)
        if (reason === '') reason = null
      }
      if (reason === null) {
        add(problems, {
          ruleId: 'exception-reason-missing',
          pointer: `${pointer}/${exitAt}`,
          message: `Exception exit to "${excerpt(entry.to, 60)}" states no reason, so the diagram cannot say when it is taken.`,
          suggestion: 'Add a reason such as "requester withdrew" or "budget exhausted".',
        })
      }
      exceptions.push({ to: entry.to, reason })
    }
  }

  let outcome = null
  if (kind === 'outcome') {
    if (raw.outcome === undefined) {
      return drop(`An outcome node must declare an outcome of ${OUTCOME_VALUES.join(', ')}.`, 'outcome')
    }
    if (typeof raw.outcome !== 'string') return drop('An outcome must be a string.', 'outcome')
    outcome = displayText(problems, `${pointer}/outcome`, 'outcome', raw.outcome, limits)
    if (!OUTCOME_VALUES.includes(comparableText(raw.outcome))) {
      add(problems, {
        ruleId: 'outcome-value-unknown',
        pointer: `${pointer}/outcome`,
        message: `Outcome "${outcome}" is outside the vocabulary ${OUTCOME_VALUES.join(', ')}.`,
        evidence: outcome,
      })
    }
    if (edges.length > 0 || timeout !== null || exceptions.length > 0) {
      add(problems, {
        ruleId: 'outcome-not-terminal',
        pointer,
        message: 'An outcome node ends the path, so it cannot carry edges, a timeout or an exception exit.',
        suggestion: 'Move the continuation to the approval step that leads here.',
      })
    }
  } else if (raw.outcome !== undefined) {
    add(problems, {
      ruleId: 'outcome-unexpected',
      pointer: `${pointer}/outcome`,
      message: 'An approval step decides who approves, not how the request ends; only an outcome node declares an outcome.',
    })
  }

  return { id, kind, label, approvers, edges, timeout, exceptions, outcome }
}

/**
 * Compile a decoded graph definition.
 *
 * Returns `{ graph, problems }`. `graph` is `null` only when nothing at all
 * could be read; a graph whose start step is unknown still compiles, because a
 * reader is better served by a diagram of the steps that were declared than by
 * nothing -- but its `start` is `null`, and every path verdict is withheld.
 */
export function compileGraph(value, limits) {
  const problems = collector()

  if (!isPlainObject(value)) {
    add(problems, {
      ruleId: 'graph-invalid',
      pointer: '/',
      message: 'Graph definition must be a JSON object.',
      incomplete: true,
    })
    return { graph: null, problems }
  }

  unknownKeys(problems, 'graph-key-unknown', value, GRAPH_KEYS, '', 'Graph')

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    add(problems, {
      ruleId: 'graph-invalid',
      pointer: '/schemaVersion',
      message: `Graph declares schemaVersion "${excerpt(String(value.schemaVersion), 20)}"; this tool reads ${SUPPORTED_SCHEMA_VERSIONS.map((item) => `"${item}"`).join(', ')}.`,
      incomplete: true,
    })
    return { graph: null, problems }
  }

  let name = ''
  if (value.name === undefined || value.name === '') {
    add(problems, {
      ruleId: 'graph-name-missing',
      pointer: '/name',
      message: 'Graph declares no name, so the diagram is titled by its file name instead.',
    })
  } else if (typeof value.name !== 'string') {
    add(problems, {
      ruleId: 'graph-invalid',
      pointer: '/name',
      message: 'Graph name must be a string.',
      incomplete: true,
    })
    return { graph: null, problems }
  } else {
    name = displayText(problems, '/name', 'name', value.name, limits)
  }

  if (!Array.isArray(value.nodes)) {
    add(problems, {
      ruleId: 'graph-invalid',
      pointer: '/nodes',
      message: 'Graph declares no nodes array, so there are no approval steps to draw.',
      incomplete: true,
    })
    return { graph: null, problems }
  }

  if (value.nodes.length > limits.maxNodes) {
    add(problems, {
      ruleId: 'too-many-nodes',
      pointer: '/nodes',
      message: `Graph declares ${value.nodes.length} nodes, above the maxNodes limit of ${limits.maxNodes}; the remainder were not read.`,
      suggestion: 'Raise --max-nodes, or split the approval path into separate graphs.',
      incomplete: true,
    })
  }

  const nodes = []
  const byId = new Map()
  const dropped = new Set()

  for (const [index, raw] of value.nodes.slice(0, limits.maxNodes).entries()) {
    const before = problems.length
    const node = compileNode(problems, raw, index, limits)
    if (node === null) {
      if (isPlainObject(raw) && isIdentifier(raw.id)) dropped.add(raw.id)
      continue
    }
    if (byId.has(node.id)) {
      // The second declaration is discarded whole, and so are the problems it
      // raised: reporting them against an id that names the first node would
      // put a finding on a step the reader can see is fine.
      problems.length = before
      add(problems, {
        ruleId: 'node-id-duplicate',
        pointer: `/nodes/${node.id}`,
        message: `Node id "${node.id}" is declared more than once; the later declaration was discarded because an edge naming it would be ambiguous.`,
        suggestion: 'Give one of the two steps a distinct id.',
      })
      continue
    }
    byId.set(node.id, node)
    nodes.push(node)
  }

  /**
   * The start step is only judged once at least one step has been read.
   *
   * A graph that declared no usable node has nothing for a start to name, and
   * reporting the start as unknown as well would bury the finding that
   * matters -- that this run read no approval step at all -- under a second
   * one that is merely its consequence.
   */
  let start = null
  if (nodes.length === 0) {
    start = null
  } else if (value.start === undefined) {
    add(problems, {
      ruleId: 'start-missing',
      pointer: '/start',
      message: 'Graph names no start step, so no path could be traced and nothing can be said about what is reachable.',
      suggestion: 'Set "start" to the id of the first approval step.',
      incomplete: true,
    })
  } else if (!isIdentifier(value.start)) {
    add(problems, {
      ruleId: 'start-unknown',
      pointer: '/start',
      message: 'Graph start is not a valid node id, so no path could be traced.',
      evidence: typeof value.start === 'string' ? excerpt(value.start, 60) : undefined,
      incomplete: true,
    })
  } else if (!byId.has(value.start)) {
    add(problems, {
      ruleId: 'start-unknown',
      pointer: '/start',
      message: `Graph starts at "${value.start}", which no node declares, so no path could be traced.`,
      evidence: excerpt(value.start, 60),
      suggestion: 'Correct the start id, or declare the step it names.',
      incomplete: true,
    })
  } else {
    start = value.start
  }

  nodes.sort((left, right) => byCodeUnit(left.id, right.id))
  return { graph: { name, start, nodes, byId, dropped }, problems }
}

/** Every link leaving a node, in the order the diagram draws them. */
export function outgoingLinks(node) {
  const links = node.edges.map((edge, position) => ({
    kind: 'edge', to: edge.to, label: edge.condition, pointer: `edges/${position}`,
  }))
  if (node.timeout !== null) {
    links.push({
      kind: 'timeout',
      to: node.timeout.to,
      label: node.timeout.after === null ? 'timeout' : `timeout ${node.timeout.after}`,
      pointer: 'timeout',
    })
  }
  for (const [position, exit] of node.exceptions.entries()) {
    links.push({ kind: 'exception', to: exit.to, label: exit.reason, pointer: `exceptions/${position}` })
  }
  return links
}

function spend(budget, amount = 1) {
  budget.used += amount
  if (budget.used > budget.limit) budget.exceeded = true
  return !budget.exceeded
}

/**
 * Canonical rotation of a cycle: the smallest id by code unit comes first, so
 * the same loop found from two different entry points is reported once.
 */
export function canonicalCycle(cycle) {
  let best = 0
  for (let index = 1; index < cycle.length; index += 1) {
    if (byCodeUnit(cycle[index], cycle[best]) < 0) best = index
  }
  return [...cycle.slice(best), ...cycle.slice(0, best)]
}

/**
 * Every cycle a depth-first search meets, found iteratively.
 *
 * Iterative rather than recursive because the bound that stops this walk must
 * be the graph's documented one, not the interpreter's stack: a 500-node chain
 * has to be answered by a limit the report can name, not by an overflow no
 * report could describe.
 *
 * This is back-edge detection, not an enumeration of every elementary cycle.
 * Every cyclic region produces at least one reported cycle, and every node in
 * a reported cycle is marked -- but a region with many overlapping loops can
 * be described by fewer cycles than it strictly contains. Reporting one loop
 * per region is what a reader needs to act; claiming to have listed them all
 * would be claiming more than this walk knows.
 */
export function findCycles(graph, budget) {
  const cycles = new Map()
  const onCycle = new Set()
  const state = new Map()
  const stack = []

  for (const root of graph.nodes.map((node) => node.id)) {
    if (state.get(root) === 'done') continue
    const frames = [{ id: root, links: null, index: 0 }]

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]
      if (frame.links === null) {
        state.set(frame.id, 'open')
        stack.push(frame.id)
        frame.links = outgoingLinks(graph.byId.get(frame.id))
          .filter((link) => graph.byId.has(link.to))
          .map((link) => link.to)
      }
      if (frame.index >= frame.links.length) {
        state.set(frame.id, 'done')
        stack.pop()
        frames.pop()
        continue
      }
      const next = frame.links[frame.index]
      frame.index += 1
      if (!spend(budget)) return { cycles: [], onCycle: new Set(), complete: false }

      if (state.get(next) === 'open') {
        const cycle = canonicalCycle(stack.slice(stack.lastIndexOf(next)))
        const key = JSON.stringify(cycle)
        if (!cycles.has(key)) cycles.set(key, cycle)
        for (const id of cycle) onCycle.add(id)
        continue
      }
      if (state.get(next) === 'done') continue
      frames.push({ id: next, links: null, index: 0 })
    }
  }

  const ordered = [...cycles.keys()].sort(byCodeUnit).map((key) => cycles.get(key))
  return { cycles: ordered, onCycle, complete: true }
}

/**
 * Breadth-first layering from the start step.
 *
 * The layer of a node is the length of the shortest path that reaches it, so
 * the diagram reads top to bottom in the order a request actually travels. A
 * path longer than `maxDepth` is not followed: the bound is reported by name
 * and every reachability verdict is withheld, because a partial traversal
 * cannot tell an unreachable step from an unvisited one.
 */
export function layerFromStart(graph, limits, budget) {
  const layers = new Map()
  if (graph.start === null) return { layers, complete: false, tooDeep: false }
  layers.set(graph.start, 0)
  const queue = [graph.start]
  let head = 0
  let tooDeep = false

  while (head < queue.length) {
    const id = queue[head]
    head += 1
    const depth = layers.get(id)
    for (const link of outgoingLinks(graph.byId.get(id))) {
      if (!spend(budget)) return { layers, complete: false, tooDeep }
      if (!graph.byId.has(link.to) || layers.has(link.to)) continue
      // The bound is only reached when there is something left to reach: a
      // step at exactly maxDepth whose every target is already laid out has
      // been fully explored, and calling that run incomplete would withhold a
      // verdict the walk did in fact obtain.
      if (depth >= limits.maxDepth) {
        tooDeep = true
        continue
      }
      layers.set(link.to, depth + 1)
      queue.push(link.to)
    }
  }
  return { layers, complete: !tooDeep, tooDeep }
}

/** The set of nodes from which some outcome node is reachable, by reverse search. */
function nodesThatReachAnOutcome(graph, budget) {
  const incoming = new Map(graph.nodes.map((node) => [node.id, []]))
  for (const node of graph.nodes) {
    for (const link of outgoingLinks(node)) {
      if (!spend(budget)) return { set: new Set(), complete: false }
      if (incoming.has(link.to)) incoming.get(link.to).push(node.id)
    }
  }
  const reaching = new Set(graph.nodes.filter((node) => node.kind === 'outcome').map((node) => node.id))
  const queue = [...reaching]
  let head = 0
  while (head < queue.length) {
    const id = queue[head]
    head += 1
    for (const source of incoming.get(id)) {
      if (!spend(budget)) return { set: reaching, complete: false }
      if (reaching.has(source)) continue
      reaching.add(source)
      queue.push(source)
    }
  }
  return { set: reaching, complete: true }
}

/**
 * Analyse a compiled graph.
 *
 * The reachability and cycle verdicts are reported only when the traversal
 * that decides them ran to completion. A budget or depth bound that stopped it
 * makes the run incomplete and withholds both: a step the walk never got to is
 * not evidence that no path reaches it, and reporting it as one would be a
 * fabricated finding in a report whose whole purpose is to be trusted.
 */
export function analyseGraph(graph, limits) {
  const problems = collector()
  const budget = { limit: limits.maxTraversalSteps, used: 0, exceeded: false }

  const { layers, complete: layeringComplete, tooDeep } = layerFromStart(graph, limits, budget)
  const cycleSearch = findCycles(graph, budget)
  const outcomeSearch = nodesThatReachAnOutcome(graph, budget)

  const structural = (node, pointer, extra) => add(problems, { pointer: `/nodes/${node.id}${pointer}`, ...extra })

  for (const node of graph.nodes) {
    const links = outgoingLinks(node)
    for (const link of links) {
      if (graph.byId.has(link.to) || graph.dropped.has(link.to)) continue
      const ruleId = link.kind === 'edge'
        ? 'edge-target-missing'
        : link.kind === 'timeout' ? 'timeout-target-missing' : 'exception-target-missing'
      structural(node, `/${link.pointer}`, {
        ruleId,
        message: `Target "${excerpt(link.to, 60)}" is not declared by any node, so this ${link.kind === 'edge' ? 'edge' : `${link.kind} exit`} leads nowhere.`,
        evidence: excerpt(link.to, 60),
        suggestion: 'Declare the step, or correct the target id.',
      })
    }

    if (node.kind !== 'approval') continue

    if (links.length === 0) {
      structural(node, '', {
        ruleId: 'path-dead-end',
        message: 'Approval step has no edge, timeout or exception exit, so a request that arrives here can never leave.',
        suggestion: 'Add an edge to the next step, or an exception exit.',
      })
    }
    if (node.timeout === null) {
      structural(node, '/timeout', {
        ruleId: 'timeout-missing',
        message: 'Approval step declares no timeout, so a request can wait here indefinitely with nothing to escalate it.',
        suggestion: 'Add a timeout naming how long the step may wait and where the request goes next.',
      })
    }

    const conditions = new Map()
    const targets = new Set()
    for (const [position, edge] of node.edges.entries()) {
      const pointer = `/edges/${position}`
      if (edge.condition === null && node.edges.length > 1) {
        structural(node, pointer, {
          ruleId: 'condition-missing',
          message: `Edge to "${excerpt(edge.to, 60)}" states no condition, but this step has ${node.edges.length} outgoing edges, so which one a request follows is not stated.`,
          suggestion: 'State the condition, or make this the only unconditional edge by removing the others.',
        })
      }
      const targetKey = JSON.stringify([edge.to, edge.conditionKey])
      if (targets.has(targetKey)) {
        structural(node, pointer, {
          ruleId: 'edge-duplicate',
          message: `Edge to "${excerpt(edge.to, 60)}" repeats an edge already declared on this step under the same condition.`,
          suggestion: 'Remove the repeated edge.',
        })
        continue
      }
      targets.add(targetKey)
      if (edge.conditionKey === null) continue
      if (conditions.has(edge.conditionKey)) {
        structural(node, pointer, {
          ruleId: 'condition-duplicate',
          message: `Condition "${edge.condition}" is declared on two edges leaving this step that lead to different nodes, so the path a request takes is ambiguous.`,
          evidence: edge.condition,
          suggestion: 'Make the conditions distinguish the two destinations.',
        })
        continue
      }
      conditions.set(edge.conditionKey, position)
    }
  }

  if (graph.nodes.every((node) => node.kind !== 'outcome')) {
    add(problems, {
      ruleId: 'outcome-missing',
      pointer: '/nodes',
      message: 'Graph declares no outcome node, so no request can ever reach a decision.',
      suggestion: `Add a node of kind "outcome" declaring one of ${OUTCOME_VALUES.join(', ')}.`,
    })
  }

  if (budget.exceeded) {
    add(problems, {
      ruleId: 'traversal-budget-exceeded',
      pointer: '/nodes',
      message: `Path traversal passed the maxTraversalSteps limit of ${limits.maxTraversalSteps} and stopped; reachability and cycle verdicts were withheld rather than guessed from a partial walk.`,
      suggestion: 'Raise --max-traversal-steps, or split the graph.',
      incomplete: true,
    })
  } else if (tooDeep) {
    add(problems, {
      ruleId: 'path-too-deep',
      pointer: '/nodes',
      message: `A path longer than the maxDepth limit of ${limits.maxDepth} was not followed; reachability and cycle verdicts were withheld rather than guessed from a partial walk.`,
      suggestion: 'Raise --max-depth, or shorten the approval path.',
      incomplete: true,
    })
  }

  const decided = !budget.exceeded && layeringComplete && cycleSearch.complete &&
    outcomeSearch.complete && graph.start !== null

  if (decided) {
    for (const node of graph.nodes) {
      if (layers.has(node.id)) continue
      const who = node.kind === 'approval' && node.approvers.length > 0
        ? ` Its approvers (${node.approvers.join(', ')}) are never asked.`
        : ''
      add(problems, {
        ruleId: 'node-unreachable',
        pointer: `/nodes/${node.id}`,
        message: `No path from the start step "${graph.start}" reaches this node.${who}`,
        suggestion: 'Add an edge that leads here, or remove the node.',
      })
    }
    for (const cycle of cycleSearch.cycles) {
      add(problems, {
        ruleId: 'approval-cycle',
        pointer: `/nodes/${cycle[0]}`,
        message: `Approval cycle: ${[...cycle, cycle[0]].join(' -> ')}. A request that enters it can be sent round forever.`,
        evidence: [...cycle, cycle[0]].join(' -> '),
        suggestion: 'Break the loop, or give one of its steps an exit that leads to an outcome.',
      })
    }
    for (const node of graph.nodes) {
      if (node.kind !== 'approval' || !layers.has(node.id)) continue
      if (outcomeSearch.set.has(node.id)) continue
      add(problems, {
        ruleId: 'outcome-unreachable',
        pointer: `/nodes/${node.id}`,
        message: 'No outcome node is reachable from this approval step, so a request that gets here is never decided.',
        suggestion: 'Route this step, directly or eventually, to an outcome node.',
      })
    }
  }

  return {
    problems,
    layers,
    decided,
    cycles: decided ? cycleSearch.cycles : [],
    onCycle: decided ? cycleSearch.onCycle : new Set(),
    reachesOutcome: decided ? outcomeSearch.set : new Set(),
    steps: budget.used,
  }
}
