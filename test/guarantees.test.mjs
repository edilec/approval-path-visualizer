import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, graphWith, outArgs, projectDirectory, step, workspace } from './support.mjs'

/**
 * One test per guarantee the README and the docs make.
 *
 * Each of these is written so that it fails when the line enforcing it is
 * removed. That is the whole point: the recurring finding across this catalog
 * is not that the code was wrong, it is that nothing defended it.
 */

test('the graph file is never written to, with or without a diagram destination', async () => {
  await workspace(async ({ root, out, graphPath }) => {
    const before = await readFile(graphPath)
    const beforeStat = await stat(graphPath)

    await visualizeApprovalPath({ root, graph: 'approval.json' })
    await visualizeApprovalPath({ root, graph: 'approval.json', format: 'html' })
    const viaCli = await cli(args(root, outArgs(out)))
    assert.equal(viaCli.code, 0)

    assert.deepEqual(await readFile(graphPath), before)
    assert.equal((await stat(graphPath)).mtimeMs, beforeStat.mtimeMs)
    // And nothing else appeared beside it.
    assert.deepEqual(await readdir(root), ['approval.json'])
  })
})

test('a run that read no step is incomplete, and pass with checked 0 is not reachable', async () => {
  // `no-nodes-declared` is a warning, so the incomplete flag is the only thing
  // between this run and a green one. Delete that flag and this assertion sees
  // "pass" instead.
  const empty = { schemaVersion: '1', name: 'empty', start: 'intake', nodes: [] }
  const { report, diagram } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
    { graph: empty },
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['no-nodes-declared'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.equal(diagram, null)

  const viaCli = await workspace(async ({ root }) => cli(args(root)), { graph: empty })
  assert.equal(viaCli.code, 2)
})

/**
 * Every input whose run must come back `incomplete`.
 *
 * Asserting the status is what fails when an `incomplete = true` is removed:
 * the run would report `fail` (or, for the warning-only cases, `pass`) and the
 * exit code would change with it.
 */
const INCOMPLETE_INPUTS = Object.freeze([
  ['a file that is not there', null, 'absent.json'],
  ['undecodable bytes', Buffer.from([0x7b, 0xff, 0x7d]), 'approval.json'],
  ['broken JSON', '{ "schemaVersion": ', 'approval.json'],
  ['a graph that is not an object', '"a string"', 'approval.json'],
  ['an unsupported schema version', JSON.stringify({ schemaVersion: '2', nodes: [] }), 'approval.json'],
  ['no nodes array', JSON.stringify({ schemaVersion: '1', start: 'x' }), 'approval.json'],
  ['no step at all', JSON.stringify({ schemaVersion: '1', start: 'x', nodes: [] }), 'approval.json'],
  ['a node that could not be read', JSON.stringify(graphWith([{ id: 'broken', kind: 'gateway' }])), 'approval.json'],
  ['no start step', JSON.stringify({ ...GRAPH, start: undefined }), 'approval.json'],
  ['a start nothing declares', JSON.stringify({ ...GRAPH, start: 'nowhere' }), 'approval.json'],
  ['a start that is not an id at all', JSON.stringify({ ...GRAPH, start: 123 }), 'approval.json'],
  ['a start id no node could carry', JSON.stringify({ ...GRAPH, start: ' padded ' }), 'approval.json'],
])

test('every input the tool could not fully read comes back incomplete, and exits 2', async () => {
  for (const [label, bytes, name] of INCOMPLETE_INPUTS) {
    const { report, viaCli } = await workspace(async ({ root }) => ({
      report: (await visualizeApprovalPath({ root, graph: name })).report,
      viaCli: await cli(['--root', root, '--graph', name, '--json']),
    }), { graph: bytes })

    assert.equal(report.status, 'incomplete', label)
    assert.ok(report.findings.length > 0, `${label}: incomplete with nothing said about it`)
    assert.equal(viaCli.code, 2, `${label}: the CLI did not exit 2`)
    assert.equal(JSON.parse(viaCli.stdout).status, 'incomplete', label)
  }
})

test('the same inputs are not incomplete when they are readable', async () => {
  // Without this, the assertions above would still pass if every run were
  // incomplete, which is the other way to be green on no evidence.
  const { report } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
    { graph: structuredClone(GRAPH) },
  )
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(report.findings, [])
})

test('a run that could not compile a graph draws nothing and says so', async () => {
  await workspace(async ({ root, out }) => {
    const result = await cli(args(root, outArgs(out)))
    assert.equal(result.code, 2)
    assert.match(result.stderr, /no diagram was written/)
    await assert.rejects(() => readFile(out), { code: 'ENOENT' })
  }, { graph: '{ broken' })
})

test('two runs over the same bytes produce byte-identical stdout and diagram', async () => {
  await workspace(async ({ root, out, outside }) => {
    const first = await cli(args(root, outArgs(out)))
    const second = await cli(args(root, outArgs(join(outside, 'again.svg'))))
    assert.equal(first.stdout, second.stdout)
    assert.deepEqual(await readFile(out), await readFile(join(outside, 'again.svg')))
  }, { graph: graphWith([step({ id: 'stranded' })]) })
})

test('an unknown option, limit or graph key is refused rather than ignored', async () => {
  await workspace(async ({ root }) => {
    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: 'approval.json', strict: true }),
      /Unknown option "strict"/,
    )
    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: 'approval.json', limits: { maxNode: 2 } }),
      /Unknown limit "maxNode"/,
    )
    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: 'approval.json', format: 'png' }),
      /Unknown format "png"/,
    )
    await assert.rejects(() => visualizeApprovalPath({ root }), /A graph path relative to the root is required/)
    await assert.rejects(() => visualizeApprovalPath({ graph: 'x' }), /An input root is required/)
    await assert.rejects(() => visualizeApprovalPath('root'), /Options must be an object/)
  })
})

test('a typo in a graph key cannot turn a real failure green', async () => {
  // `edges` misspelled removes a path; the run must not pass because of it.
  const value = structuredClone(GRAPH)
  value.nodes[0].edgess = value.nodes[0].edges
  delete value.nodes[0].edges
  const { report } = await workspace(
    async ({ root }) => visualizeApprovalPath({ root, graph: 'approval.json' }),
    { graph: value },
  )
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.some((item) => item.ruleId === 'node-key-unknown'))
})

test('the example graphs behave the way the README says they do', async () => {
  const clean = await cli(['--root', join(projectDirectory, 'examples/clean'), '--graph', 'approval.json', '--json'])
  assert.equal(clean.code, 0)
  const cleanReport = JSON.parse(clean.stdout)
  assert.equal(cleanReport.status, 'pass')
  assert.deepEqual(cleanReport.findings, [])

  const broken = await cli(['--root', join(projectDirectory, 'examples/broken'), '--graph', 'approval.json', '--json'])
  assert.equal(broken.code, 1)
  const brokenReport = JSON.parse(broken.stdout)
  assert.equal(brokenReport.status, 'fail')
  const reported = new Set(brokenReport.findings.map((item) => item.ruleId))
  for (const expected of ['node-unreachable', 'approval-cycle', 'path-dead-end', 'timeout-target-missing']) {
    assert.ok(reported.has(expected), `the broken example no longer demonstrates ${expected}`)
  }
})

test('the deliberately broken example renders its markup labels as text', async () => {
  const { diagram } = await visualizeApprovalPath({
    root: join(projectDirectory, 'examples/broken'),
    graph: 'approval.json',
  })
  assert.equal(diagram.includes('<script'), false)
  assert.equal(diagram.includes('<!--'), false)
  assert.equal(diagram.includes(']]>'), false)
  assert.ok(diagram.includes('&lt;script&gt;'))
  assert.ok(diagram.includes(']]&gt;'))
  assert.ok(diagram.includes('--&gt;&lt;!--'))
})

test('nothing under src reads a clock, a random source or the network', async () => {
  // Not the determinism test -- `test/ordering.test.mjs` pins the emitted order
  // and the byte-identical rerun above pins the rest. This is a net for the
  // obvious ways a later change would reintroduce non-determinism, and it is
  // worth exactly what a source scan is worth.
  const forbidden = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /\bfetch\(/, /localeCompare/, /Intl\./]
  for (const name of ['index.mjs', 'graph.mjs', 'render.mjs', 'text.mjs']) {
    const text = await readFile(join(projectDirectory, 'src', name), 'utf8')
    // Comments are stripped first: these modules explain at length why they do
    // not use a collator, and the explanation must not trip the scan.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    for (const pattern of forbidden) {
      assert.equal(pattern.test(code), false, `src/${name} matches ${pattern}`)
    }
  }
})

test('the diagram destination is refused before anything is read, not after', async () => {
  await workspace(async ({ root }) => {
    await writeFile(join(root, 'approval.json'), '{ broken', 'utf8')
    const result = await cli(args(root, ['--out', join(root, 'diagram.svg'), '--out-root', root]))
    // stdout is empty: a configuration error means the run never had a
    // subject, so there is nothing to report about.
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    await assert.rejects(() => readFile(join(root, 'diagram.svg')), { code: 'ENOENT' })
  })
})
