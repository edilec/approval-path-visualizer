/**
 * Fixture builders shared by the suite.
 *
 * Every test that needs files gets its own temporary root, so no test can be
 * made to pass by another test's leftovers and the order they run in does not
 * matter. The graph is written as bytes, not handed over as an object, because
 * the paths being tested start at a file on disk.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/approval-path-visualizer.mjs')
export const GRAPH_FILE = 'approval.json'

/** A structurally valid graph that passes with no finding at all. */
export const GRAPH = Object.freeze({
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
})

/** A valid approval node; every field can be overridden or deleted by the caller. */
export function step(overrides = {}) {
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

/** The clean graph with extra nodes appended, and anything else replaced. */
export function graphWith(nodes = [], overrides = {}) {
  return {
    ...structuredClone(GRAPH),
    nodes: [...structuredClone(GRAPH.nodes), ...nodes],
    ...overrides,
  }
}

/**
 * Run `body` against a temporary root holding one graph file.
 *
 * `graph` may be an object (serialised as JSON), a string or a Buffer (written
 * verbatim, so undecodable bytes and broken JSON can be tested), or `null` to
 * write no file at all.
 */
export async function workspace(body, { graph = GRAPH, file = GRAPH_FILE } = {}) {
  const root = await mkdtemp(join(await realTempDirectory(), 'apv-'))
  const outside = await mkdtemp(join(await realTempDirectory(), 'apv-out-'))
  try {
    if (graph !== null) {
      const bytes = typeof graph === 'string' || Buffer.isBuffer(graph)
        ? graph
        : `${JSON.stringify(graph, null, 2)}\n`
      await writeFile(join(root, file), bytes)
    }
    return await body({ root, outside, out: join(outside, 'diagram.svg'), graphPath: join(root, file) })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

let cachedTemp = null

/**
 * The real temporary directory.
 *
 * On macOS `os.tmpdir()` is itself a symbolic link, so a test that compares a
 * realpath-resolved root against an unresolved fixture path fails for a reason
 * that has nothing to do with the tool. Resolving here keeps the confinement
 * tests testing confinement.
 */
export async function realTempDirectory() {
  if (cachedTemp === null) {
    const { realpath } = await import('node:fs/promises')
    cachedTemp = await realpath(tmpdir())
  }
  return cachedTemp
}

/** Run the real binary and return its exit code and both streams. */
export async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], options)
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

/** The standard argument list: read `file` from `root`, report as JSON. */
export function args(root, extra = []) {
  return ['--root', root, '--graph', GRAPH_FILE, '--json', ...extra]
}

/**
 * Every element name the rendered document contains.
 *
 * This is how the escaping tests state their assertion: a label that tried to
 * create an element would show up here as a name the renderer never emits.
 */
export function elementNames(markup) {
  const names = new Set()
  for (const match of markup.matchAll(/<\/?([A-Za-z][\w:-]*)/g)) names.add(match[1].toLowerCase())
  return [...names].sort()
}

/** Every attribute name the rendered document contains. */
export function attributeNames(markup) {
  const names = new Set()
  for (const element of markup.matchAll(/<[A-Za-z][^<>]*>/g)) {
    for (const match of element[0].matchAll(/[\s"']([A-Za-z][\w:-]*)\s*=/g)) names.add(match[1].toLowerCase())
  }
  return [...names].sort()
}

/**
 * A minimal well-formedness check: every element opened is closed, in order.
 *
 * Not a full XML parser, and not meant to be one. It exists so that a label
 * which broke out of a `<text>` element would be caught as an imbalance even
 * if the element name it invented happened to be one the renderer also emits.
 */
export function tagsBalance(markup) {
  const stack = []
  for (const match of markup.matchAll(/<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = match
    if (closing === '/') {
      if (stack.pop() !== name) return false
      continue
    }
    if (selfClosing !== '/') stack.push(name)
  }
  return stack.length === 0
}
