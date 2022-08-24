#!/usr/bin/env node

import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  excerpt,
  formatReport,
  resolveDiagramDestination,
  resolveGraphPath,
  visualizeApprovalPath,
  writeDiagram,
} from '../src/index.mjs'

const HELP = `approval-path-visualizer

Read an approval graph -- steps, approvers, branch conditions, timeouts and
exception exits -- diagnose the paths through it, and render a standalone SVG
or HTML diagram. Nothing is fetched, and the graph file is never written to.

Usage:
  approval-path-visualizer --root DIR --graph FILE [--out FILE] [--format svg|html] [--json] [limits]

Options:
  --root DIR                Directory holding the approval graph (required)
  --graph FILE              Graph file, relative to --root (required)
  --out FILE                Write the diagram here; must be outside --root
  --out-root DIR            Tree --out must resolve inside (default: the
                            working directory)
  --format svg|html         Diagram format (default svg)
  --json                    Emit the machine-readable report on stdout
  --max-graph-bytes N       Maximum graph file size (default 1048576)
  --max-nodes N             Maximum nodes read from the graph (default 500)
  --max-edges-per-node N    Maximum edges or exception exits per node (default 32)
  --max-approvers N         Maximum approvers per step (default 16)
  --max-label-length N      Maximum label length (default 120)
  --max-depth N             Maximum path length followed from the start (default 64)
  --max-traversal-steps N   Maximum links followed while tracing paths (default 200000)
  -h, --help                Show this help

Every option is accepted once: a repeated flag is a configuration error, not a
silent last-wins.

The graph is read, never written. The diagram is a derived artifact, and four
shapes of destination are refused before anything is opened: a symbolic link at
--out (following it writes wherever the link points, which is not the path you
named), a symlinked directory on the way there, a path resolving outside
--out-root, and a hard link to the graph file. A destination inside --root is
refused whatever --out-root says.

An approval step no path reaches, and an approval cycle, are both errors. A run
that read no step is "incomplete", never a pass, and a run whose path traversal
hit a documented limit withholds both verdicts rather than guessing them from a
partial walk.

Exit codes:
  0  every step is reachable, every path ends at an outcome
  1  the graph was read and failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-graph-bytes', 'maxGraphBytes'],
  ['--max-nodes', 'maxNodes'],
  ['--max-edges-per-node', 'maxEdgesPerNode'],
  ['--max-approvers', 'maxApprovers'],
  ['--max-label-length', 'maxLabelLength'],
  ['--max-depth', 'maxDepth'],
  ['--max-traversal-steps', 'maxTraversalSteps'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { root: null, graph: null, out: null, outRoot: null, format: null, json: false, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--max-nodes 500 --max-nodes 1` runs a limit nobody asked for and
   * `--graph a.json --graph b.json` draws a file nobody named. That is the
   * same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') {
      once('--json')
      options.json = true
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--graph') {
      once('--graph')
      options.graph = takeValue('--graph')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (argument === '--out-root') {
      once('--out-root')
      options.outRoot = takeValue('--out-root')
    } else if (argument === '--format') {
      once('--format')
      options.format = takeValue('--format')
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else {
      // The unknown option is echoed back, so it is untrusted like any other
      // value this tool prints: an argument carrying a NEL or a bidi override
      // must not forge a line on its way to stderr. Every message thrown here
      // goes through one sanitising pass in `main`, which is the only place a
      // diagnostic reaches the stream.
      throw new Error(`Unknown option "${argument}"`)
    }
  }

  if (options.root === null) throw new Error('--root is required')
  if (options.graph === null) throw new Error('--graph is required')
  if (options.outRoot !== null && options.out === null) {
    throw new Error('--out-root has no meaning without --out')
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${excerpt(error.message, 200)}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  // Configuration is settled before anything is read, so an unusable root or a
  // destination inside the input tree fails with no report rather than half a
  // run and a diagram nobody asked for.
  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    process.stderr.write(`--root could not be read: ${error.code ?? excerpt(error.message, 200)}\n`)
    return 2
  }

  // Which file the graph will be read from, so the destination check below can
  // refuse a hard link pointing at it: two names for one inode resolve to two
  // different paths, and writing the diagram to the second truncates the first.
  // A graph path that cannot be resolved at all is left alone here -- the run
  // itself reports it, in the ordinary way, on stdout.
  let graphReal = null
  try {
    graphReal = await resolveGraphPath(rootReal, options.graph)
  } catch {
    graphReal = null
  }

  let destination = null
  if (options.out !== null) {
    try {
      destination = await resolveDiagramDestination(rootReal, options.out, graphReal, {
        root: options.outRoot ?? process.cwd(),
      })
    } catch (error) {
      process.stderr.write(`--out is not usable: ${excerpt(error.message, 200)}\n`)
      return 2
    }
  }

  let result
  try {
    result = await visualizeApprovalPath({
      root: options.root,
      graph: options.graph,
      limits: options.limits,
      ...(options.format === null ? {} : { format: options.format }),
    })
  } catch (error) {
    process.stderr.write(`${excerpt(error.message, 200)}\n`)
    return 2
  }

  const { report, diagram, graph, file } = result

  let written = null
  if (destination !== null) {
    if (diagram === null) {
      process.stderr.write(
        'no diagram was written: the graph could not be read far enough to draw anything.\n',
      )
    } else {
      try {
        await writeDiagram(destination, diagram)
        written = options.out
        process.stderr.write(`diagram written: ${excerpt(options.out, 200)} (${diagram.length} bytes)\n`)
      } catch (error) {
        process.stderr.write(`diagram could not be written: ${error.code ?? excerpt(error.message, 200)}\n`)
        return 2
      }
    }
  }

  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatReport(report, { file, name: graph === null ? '' : graph.name, diagram: written }))

  if (report.status === 'incomplete') {
    process.stderr.write(
      'incomplete: evidence was missing, undecodable or bounded out, so no verdict is claimed.\n',
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
