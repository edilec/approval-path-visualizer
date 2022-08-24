import assert from 'node:assert/strict'
import { chmod, link, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, isSameFile, resolveDiagramDestination, visualizeApprovalPath } from '../src/index.mjs'
import { GRAPH, args, cli, outArgs, workspace } from './support.mjs'

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
    await mkdir(join(root, 'nested', 'deep'), { recursive: true })
    await assert.rejects(
      () => resolveDiagramDestination(root, join(root, 'nested', 'deep', 'diagram.svg')),
      /must be written elsewhere/,
    )
    const result = await cli(args(root, ['--out', join(root, 'diagram.svg'), '--out-root', root]))
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
    const result = await cli(args(root, outArgs(out)))
    assert.equal(result.code, 0)
    const after = await readFile(graphPath)
    assert.deepEqual(after, before)
    const diagram = await readFile(out, 'utf8')
    assert.ok(diagram.startsWith('<svg xmlns='))
    assert.match(result.stderr, /diagram written:/)
  })
})

test('isSameFile decides by device and inode, which is the only thing a hard link shares', async () => {
  await workspace(async ({ outside, graphPath }) => {
    const second = join(outside, 'second-name.json')
    await link(graphPath, second)
    const separate = join(outside, 'separate.json')
    await writeFile(separate, await readFile(graphPath))

    // The two names resolve to two different real paths -- a hard link has no
    // target for realpath to follow -- and are nonetheless one file.
    assert.notEqual(await realpath(second), await realpath(graphPath))
    assert.equal(await isSameFile(second, graphPath), true)

    // Byte-identical content is not identity, and an absent path is not a match.
    assert.equal(await isSameFile(separate, graphPath), false)
    assert.equal(await isSameFile(join(outside, 'never-existed'), graphPath), false)
    assert.equal(await isSameFile(graphPath, join(outside, 'never-existed')), false)
  })
})

test('a destination that is the graph file under another name is refused, and the graph survives', async () => {
  // The data-loss case containment cannot see: a hard link to the input, made
  // anywhere outside the root, is its own real path, so every path comparison
  // says "different file" while writeFile to it truncates the graph.
  await workspace(async ({ root, outside, graphPath }) => {
    const before = await readFile(graphPath)
    const decoy = join(outside, 'diagram.svg')
    await link(graphPath, decoy)

    await assert.rejects(
      () => resolveDiagramDestination(root, decoy, graphPath),
      /same file as an input/,
    )

    const result = await cli(args(root, outArgs(decoy)))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--out is not usable/)
    assert.deepEqual(await readFile(graphPath), before)
    // And the link, which is the same file, is still the graph too.
    assert.deepEqual(await readFile(decoy), before)
  })
})

test('a destination that is a directory is refused rather than written into', async () => {
  await workspace(async ({ root, outside }) => {
    await assert.rejects(() => resolveDiagramDestination(root, outside), /not a regular file/)
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

test('a destination with no usable path at all is refused', async () => {
  await workspace(async ({ root, outside }) => {
    for (const destination of ['', '   ', 7, null]) {
      await assert.rejects(
        () => resolveDiagramDestination(root, destination),
        /Diagram destination must be a non-empty path/,
        String(destination),
      )
    }
    // A destination whose directory is not there is refused rather than
    // created. The point of the check is that the diagram lands where the path
    // reads, and a path with no directory yet does not read as anywhere.
    const deep = join(outside, ...Array.from({ length: 70 }, (_, index) => `d${index}`), 'diagram.svg')
    await assert.rejects(() => resolveDiagramDestination(root, deep), /directory that does not exist/)
  })
})

test('a graph file that cannot be opened is reported, not assumed empty', async () => {
  await workspace(async ({ root, graphPath }) => {
    await chmod(graphPath, 0o000)
    try {
      await readFile(graphPath)
      return // running as a user the mode does not restrain; nothing to test
    } catch {
      // expected: the file is now unreadable
    }
    const { report } = await visualizeApprovalPath({ root, graph: 'approval.json' })
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['graph-unreadable'])
    assert.equal(report.status, 'incomplete')
    await chmod(graphPath, 0o644)
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
