import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { GRAPH, args, cli, graphWith, outArgs, step, workspace } from './support.mjs'

/**
 * The command line surface: the two shapes of exit 2, the three exit codes,
 * the stream split, and a configuration error refused before anything is read.
 */

test('--help prints the usage on stdout and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await cli([flag])
    assert.equal(result.code, 0, flag)
    assert.match(result.stdout, /^approval-path-visualizer/)
    assert.match(result.stdout, /--root DIR/)
    assert.match(result.stdout, /--graph FILE/)
    assert.match(result.stdout, /--out FILE/)
    assert.match(result.stdout, /--format svg\|html/)
    assert.match(result.stdout, /--json/)
    assert.match(result.stdout, /Exit codes:/)
    assert.equal(result.stderr, '')
  }
})

test('every documented limit flag appears in the help', async () => {
  const { stdout } = await cli(['--help'])
  for (const flag of [
    '--max-graph-bytes', '--max-nodes', '--max-edges-per-node', '--max-approvers',
    '--max-label-length', '--max-depth', '--max-traversal-steps',
  ]) {
    assert.ok(stdout.includes(flag), `${flag} is not in the help`)
  }
})

test('a usage error leaves stdout empty and exits 2', async () => {
  const cases = [
    [[], '--root is required'],
    [['--root', '.'], '--graph is required'],
    [['--root'], '--root requires a value'],
    [['--root', '.', '--graph', 'a.json', '--nope'], 'Unknown option "--nope"'],
    [['--root', '.', '--graph', 'a.json', '--max-nodes', 'lots'], '--max-nodes requires a positive integer'],
    [['--root', '.', '--graph', 'a.json', '--max-nodes', '0'], '--max-nodes requires a positive integer'],
    [['--root', '.', '--graph', 'a.json', '--max-nodes'], '--max-nodes requires a value'],
  ]
  for (const [argv, message] of cases) {
    const result = await cli(argv)
    assert.equal(result.code, 2, argv.join(' '))
    assert.equal(result.stdout, '', argv.join(' '))
    assert.ok(result.stderr.startsWith(message), `${argv.join(' ')}: ${result.stderr.split('\n')[0]}`)
  }
})

test('a value-carrying flag given twice is refused, not silently last-wins', async () => {
  const base = [
    '--root', '.', '--graph', 'a.json', '--out', 'a.svg', '--format', 'svg', '--max-nodes', '5', '--json',
  ]
  for (const extra of [
    ['--root', '.'], ['--graph', 'b.json'], ['--out', 'b.svg'], ['--format', 'html'],
    ['--max-nodes', '2'], ['--json'],
  ]) {
    const result = await cli([...base, ...extra])
    assert.equal(result.code, 2, extra.join(' '))
    assert.equal(result.stdout, '', extra.join(' '))
    assert.match(result.stderr, /was given more than once/)
  }
})

test('an unknown format is a configuration error, with an empty stdout', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(['--root', root, '--graph', 'approval.json', '--format', 'png'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /Unknown format "png"/)
  })
})

test('a graph that passes exits 0, and the report is the only thing on stdout', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(args(root))
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    const report = JSON.parse(result.stdout)
    assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
    assert.equal(report.tool, 'approval-path-visualizer')
    assert.equal(report.schemaVersion, '1')
    assert.equal(report.status, 'pass')
  })
})

test('a graph that fails exits 1 and still reports', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(args(root))
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).status, 'fail')
  }, { graph: graphWith([step({ id: 'stranded' })]) })
})

test('evidence that could not be obtained exits 2 with a report on stdout', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(args(root))
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
    assert.match(result.stderr, /incomplete: evidence was missing/)
  }, { graph: 'not json at all' })
})

test('the human report prints the summary, the diagram path and one line per finding', async () => {
  await workspace(async ({ root, out }) => {
    const result = await cli(['--root', root, '--graph', 'approval.json', ...outArgs(out)])
    const lines = result.stdout.trimEnd().split('\n')
    assert.match(lines[0], /^test approval \(approval\.json\): 2 approval step\(s\), 1 outcome\(s\)/)
    assert.match(lines[1], /^paths: /)
    assert.equal(lines[2], `diagram: ${out}`)
    assert.equal(lines.length, 3 + 1)
    assert.match(lines[3], /^ERROR {3}approval\.json\/nodes\/stranded node-unreachable /)
  }, { graph: graphWith([step({ id: 'stranded' })]) })
})

test('--out writes the format that was asked for, and nothing when it is not given', async () => {
  await workspace(async ({ root, out, outside }) => {
    await cli(args(root, outArgs(out)))
    assert.ok((await readFile(out, 'utf8')).startsWith('<svg xmlns='))

    const htmlPath = join(outside, 'diagram.html')
    await cli(args(root, [...outArgs(htmlPath), '--format', 'html']))
    assert.ok((await readFile(htmlPath, 'utf8')).startsWith('<!doctype html>'))

    const withoutOut = await cli(args(root))
    assert.equal(withoutOut.code, 0)
    assert.equal(withoutOut.stderr, '')
  })
})

test('a graph read from a subdirectory is named by its relative path in the report', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(['--root', root, '--graph', 'paths/approval.json', '--json'])
    assert.equal(result.code, 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.findings[0].location.file, 'paths/approval.json')
  }, { graph: graphWith([step({ id: 'stranded' })]), file: 'paths/approval.json' })
})

test('the summary counts what the graph holds', async () => {
  await workspace(async ({ root }) => {
    const report = JSON.parse((await cli(args(root))).stdout)
    assert.deepEqual(report.summary, {
      checked: 3,
      errors: 0,
      warnings: 0,
      info: 0,
      approvalSteps: 2,
      outcomes: 1,
      approvers: 2,
      edges: 2,
      timeouts: 2,
      exceptionExits: 1,
      unreachable: 0,
      cycles: 0,
      traversalSteps: 20,
    })
  }, {
    graph: {
      ...structuredClone(GRAPH),
      nodes: [
        {
          ...structuredClone(GRAPH.nodes[0]),
          edges: [{ to: 'second', condition: 'onwards' }],
          exceptions: [{ to: 'approved', reason: 'requester withdrew' }],
        },
        step({ id: 'second', approvers: ['second-desk'] }),
        structuredClone(GRAPH.nodes[1]),
      ],
    },
  })
})
