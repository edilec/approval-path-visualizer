/**
 * Fixture builders shared by the suite.
 *
 * Every test that needs files gets its own temporary root, so no test can be
 * made to pass by another test's leftovers and the order they run in does not
 * matter. The graph is written as bytes, not handed over as an object, because
 * the paths being tested start at a file on disk.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      await mkdir(dirname(join(root, file)), { recursive: true })
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
 * `--out` together with the root it is permitted to resolve inside.
 *
 * `--out-root` defaults to the working directory, which for a spawned CLI is
 * the package, so a destination in a temporary directory needs the root
 * declared. Tests about rendering, determinism or the human summary say it
 * this way so that they are not quietly also testing destination policy;
 * `test/destination.test.mjs` is where that policy is pinned.
 */
export function outArgs(out) {
  return ['--out', out, '--out-root', dirname(out)]
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

/**
 * A tag whose attributes are all `name="value"` with no raw quote inside a
 * value -- which is exactly what an escaped document produces, and exactly
 * what a payload breaking out of an attribute would stop producing.
 */
const WELL_FORMED_TAG = /^<\/?[A-Za-z][\w:-]*(?:\s+[A-Za-z][\w:-]*="[^"]*")*\s*\/?>$/

/** Every attribute of every tag, as `[name, value]` pairs. */
export function attributes(markup) {
  const pairs = []
  for (const element of markup.matchAll(/<[A-Za-z][^<>]*>/g)) {
    for (const match of element[0].matchAll(/\s([A-Za-z][\w:-]*)="([^"]*)"/g)) {
      pairs.push([match[1].toLowerCase(), match[2]])
    }
  }
  return pairs
}

/** Every attribute name the rendered document contains, read from well-formed tags only. */
export function attributeNames(markup) {
  return [...new Set(attributes(markup).map(([name]) => name))].sort()
}

/**
 * True when every tag in the document is well formed.
 *
 * This is what catches an unescaped quote: a value that closes its own
 * attribute leaves a tag whose remainder is not a `name="value"` list, whether
 * or not the name it invented happens to be one the renderer also emits.
 */
export function tagsWellFormed(markup) {
  for (const element of markup.matchAll(/<\/?[A-Za-z][^<>]*>/g)) {
    if (!WELL_FORMED_TAG.test(element[0])) return false
  }
  return true
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
