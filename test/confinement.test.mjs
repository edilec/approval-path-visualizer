import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, resolveDiagramDestination, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, workspace } from './support.mjs'

/**
 * Confinement, decided on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. And the mistake in the other direction is a bug too --
 * a real root compared against an unresolved candidate refuses perfectly
 * legitimate files, which on macOS is every file under the temporary
 * directory, because that directory is itself a symbolic link.
 */

test('isInside compares whole path segments, not string prefixes', () => {
  assert.equal(isInside('/a/root', '/a/root'), true)
  assert.equal(isInside('/a/root', '/a/root/child/graph.json'), true)
  assert.equal(isInside('/a/root', '/a/rootless/graph.json'), false)
  assert.equal(isInside('/a/root', '/a/other'), false)
})

test('a symlink inside the root that resolves outside it is refused unread', async () => {
  await workspace(async ({ root, outside }) => {
    const secret = join(outside, 'elsewhere.json')
    await writeFile(secret, JSON.stringify({ schemaVersion: '1', name: 'not yours', start: 'x', nodes: [] }), 'utf8')
    await symlink(secret, join(root, 'linked.json'))

    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: 'linked.json' }),
      /resolves outside the input root/,
    )

    // Through the CLI: a configuration refusal leaves stdout empty, and the
    // content of the file outside the root never appears anywhere.
    const result = await cli(['--root', root, '--graph', 'linked.json', '--json'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('not yours'), false)
  })
})

test('a traversal and an absolute graph path are both refused', async () => {
  await workspace(async ({ root, outside }) => {
    await writeFile(join(outside, 'elsewhere.json'), '{}', 'utf8')
    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: '../elsewhere.json' }),
      /resolves outside the input root/,
    )
    await assert.rejects(
      () => visualizeApprovalPath({ root, graph: join(outside, 'elsewhere.json') }),
      /must be relative to --root/,
    )
  })
})

test('a root reached through a symbolic link still reads its own files', async () => {
  // The false-refusal direction. Both sides go through realpath, so a linked
  // root resolves to the same real directory its files do.
  await workspace(async ({ root, outside }) => {
    const linkedRoot = join(outside, 'linked-root')
    await symlink(root, linkedRoot)
    const { report } = await visualizeApprovalPath({ root: linkedRoot, graph: 'approval.json' })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 2)
  })
})

test('a graph in a subdirectory of the root is read, and reported under its relative name', async () => {
  await workspace(async ({ root }) => {
    await mkdir(join(root, 'paths'), { recursive: true })
    await writeFile(join(root, 'paths', 'purchase.json'), JSON.stringify(GRAPH), 'utf8')
    const { report, file } = await visualizeApprovalPath({ root, graph: 'paths/purchase.json' })
    assert.equal(file, 'paths/purchase.json')
    assert.equal(report.status, 'pass')
  })
})

test('a diagram destination inside the input root is refused', async () => {
  await workspace(async ({ root }) => {
    await assert.rejects(
      () => resolveDiagramDestination(root, join(root, 'diagram.svg')),
      /must be written elsewhere/,
    )
    await assert.rejects(
      () => resolveDiagramDestination(root, join(root, 'nested', 'deep', 'diagram.svg')),
      /must be written elsewhere/,
    )
    const result = await cli(args(root, ['--out', join(root, 'diagram.svg')]))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--out is not usable/)
  })
})

test('a destination whose parent is a symlink into the root is refused too', async () => {
  await workspace(async ({ root, outside }) => {
    const trapdoor = join(outside, 'trapdoor')
    await symlink(root, trapdoor)
    await assert.rejects(
      () => resolveDiagramDestination(root, join(trapdoor, 'diagram.svg')),
      /must be written elsewhere/,
    )
  })
})

test('a destination outside the root is written, and the graph file is not touched', async () => {
  await workspace(async ({ root, out, graphPath }) => {
    const before = await readFile(graphPath)
    const result = await cli(args(root, ['--out', out]))
    assert.equal(result.code, 0)
    const after = await readFile(graphPath)
    assert.deepEqual(after, before)
    const diagram = await readFile(out, 'utf8')
    assert.ok(diagram.startsWith('<svg xmlns='))
    assert.match(result.stderr, /diagram written:/)
  })
})

test('a destination that is a directory is refused rather than written into', async () => {
  await workspace(async ({ root, outside }) => {
    await assert.rejects(() => resolveDiagramDestination(root, outside), /is a directory, not a file/)
  })
})

test('a named graph that is not there is missing evidence, not a configuration error', async () => {
  await workspace(async ({ root }) => {
    const { report, diagram } = await visualizeApprovalPath({ root, graph: 'absent.json' })
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['graph-unreadable'])
    assert.equal(report.findings[0].location.file, 'absent.json')
    assert.equal(report.status, 'incomplete')
    assert.equal(diagram, null)

    // stdout carries the report, because the run had a subject and failed to
    // obtain evidence about it -- which is what incomplete exists to say.
    const result = await cli(['--root', root, '--graph', 'absent.json', '--json'])
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  })
})

test('a dangling symbolic link is reported as unreadable, not followed', async () => {
  await workspace(async ({ root }) => {
    await symlink(join(root, 'never-existed.json'), join(root, 'dangling.json'))
    const { report } = await visualizeApprovalPath({ root, graph: 'dangling.json' })
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['graph-unreadable'])
    assert.equal(report.status, 'incomplete')
  })
})

test('a graph path that is a directory is reported rather than read', async () => {
  await workspace(async ({ root }) => {
    await mkdir(join(root, 'paths'), { recursive: true })
    const { report } = await visualizeApprovalPath({ root, graph: 'paths' })
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['graph-unreadable'])
    assert.equal(report.status, 'incomplete')
  })
})

test('an input root that is not a directory, or is not there, is a configuration error', async () => {
  await workspace(async ({ root, graphPath }) => {
    await assert.rejects(() => visualizeApprovalPath({ root: graphPath, graph: 'x.json' }), /must be a directory/)
    await assert.rejects(
      () => visualizeApprovalPath({ root: join(root, 'nowhere'), graph: 'x.json' }),
      /Input root could not be read/,
    )
  })
})
