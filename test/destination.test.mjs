/**
 * The output destination, one test per hole and one per allowed shape.
 *
 * Three of these were measured destroying real files through the real CLI
 * before the guard went in: a 14-byte file outside the root became an
 * 11117-byte SVG, a file reached through a symlinked parent went the same way,
 * and a link whose target did not exist yet created the diagram outside the
 * tree entirely. Every one of those runs exited 0 and printed
 * "diagram written".
 *
 * The allowed cases are not decoration. A guard that refuses everything passes
 * every data-loss test while making the tool useless, so the shapes that must
 * still work are pinned in the same file as the shapes that must not.
 */
import assert from 'node:assert/strict'
import { link, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { args, cli, outArgs, workspace } from './support.mjs'

const PRECIOUS = 'a file this tool was never asked to touch\n'

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

// ---------------------------------------------------------------------------
// Hole 1: a symbolic link at the destination.
// ---------------------------------------------------------------------------

test('a symlink at --out is refused, and the file it points at survives', async () => {
  await workspace(async ({ root, outside }) => {
    const precious = join(outside, 'precious.svg')
    await writeFile(precious, PRECIOUS, 'utf8')
    const destination = join(outside, 'diagram.svg')
    await symlink(precious, destination)

    const result = await cli(args(root, outArgs(destination)))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
    assert.match(result.stderr, /symbolic link/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

test('a symlink at --out whose target does not exist yet creates nothing', async () => {
  // `realpath` fails on a dangling link, so a tool that resolves the
  // destination concludes "nothing is there" and writes -- which follows the
  // link and creates the file outside the tree the caller named.
  await workspace(async ({ root, outside }) => {
    const wouldBeCreated = join(outside, 'elsewhere', 'created.svg')
    await mkdir(join(outside, 'elsewhere'), { recursive: true })
    const destination = join(outside, 'diagram.svg')
    await symlink(wouldBeCreated, destination)

    const result = await cli(args(root, outArgs(destination)))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /symbolic link/)
    assert.equal(await exists(wouldBeCreated), false, 'the diagram was created outside the root')
  })
})

// ---------------------------------------------------------------------------
// Hole 2: a symlinked parent directory.
// ---------------------------------------------------------------------------

test('a symlinked parent directory cannot carry the diagram out of --out-root', async () => {
  await workspace(async ({ root, outside }) => {
    const elsewhere = join(outside, 'elsewhere')
    const permitted = join(outside, 'permitted')
    await mkdir(elsewhere, { recursive: true })
    await mkdir(permitted, { recursive: true })
    const precious = join(elsewhere, 'precious.svg')
    await writeFile(precious, PRECIOUS, 'utf8')
    // Lexically `permitted/link/precious.svg` is inside --out-root. It is not.
    await symlink(elsewhere, join(permitted, 'link'))

    const result = await cli(args(root, [
      '--out', join(permitted, 'link', 'precious.svg'),
      '--out-root', permitted,
    ]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /outside the permitted root/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

test('a lexical ".." segment cannot carry the diagram out of --out-root', async () => {
  await workspace(async ({ root, outside }) => {
    const permitted = join(outside, 'permitted')
    await mkdir(permitted, { recursive: true })
    const precious = join(outside, 'precious.svg')
    await writeFile(precious, PRECIOUS, 'utf8')

    const result = await cli(args(root, [
      '--out', join(permitted, '..', 'precious.svg'),
      '--out-root', permitted,
    ]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /outside the permitted root/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

// ---------------------------------------------------------------------------
// Hole 3: a hard link to the input.
// ---------------------------------------------------------------------------

test('a hard link to the graph file is refused, and the graph survives', async () => {
  // A hard link has no target to resolve and shares no path with the graph, so
  // `realpath` and string comparison both call it a different file. Only
  // device plus inode sees that it is the same file.
  await workspace(async ({ root, outside, graphPath }) => {
    const before = await readFile(graphPath)
    const destination = join(outside, 'diagram.svg')
    await link(graphPath, destination)

    const result = await cli(args(root, outArgs(destination)))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /same file as an input/)
    assert.deepEqual(await readFile(graphPath), before)
  })
})

// ---------------------------------------------------------------------------
// Shapes that cannot be written at all, and the input root.
// ---------------------------------------------------------------------------

test('a destination that is a directory is refused', async () => {
  await workspace(async ({ root, outside }) => {
    const folder = join(outside, 'folder')
    await mkdir(folder, { recursive: true })

    const result = await cli(args(root, ['--out', folder, '--out-root', outside]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /not a regular file/)
  })
})

test('a destination whose directory does not exist is refused rather than created', async () => {
  await workspace(async ({ root, outside }) => {
    const result = await cli(args(root, [
      '--out', join(outside, 'absent', 'diagram.svg'),
      '--out-root', outside,
    ]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /directory that does not exist/)
    assert.equal(await exists(join(outside, 'absent')), false)
  })
})

test('a destination inside --root is refused even when --out-root permits it', async () => {
  // The input root wins: the diagram is derived from the graph, and writing it
  // back into the tree the graph lives in is how a read-only tool ends up
  // modifying its own input on the next run.
  await workspace(async ({ root }) => {
    const result = await cli(args(root, ['--out', join(root, 'diagram.svg'), '--out-root', root]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /must be written elsewhere/)
    assert.equal(await exists(join(root, 'diagram.svg')), false)
  })
})

// ---------------------------------------------------------------------------
// The allowed cases. A guard that refuses these is a guard that broke the tool.
// ---------------------------------------------------------------------------

test('an ordinary destination inside --out-root is written', async () => {
  await workspace(async ({ root, out }) => {
    const result = await cli(args(root, outArgs(out)))

    assert.equal(result.code, 0)
    assert.match(result.stderr, /diagram written:/)
    assert.ok((await readFile(out, 'utf8')).startsWith('<svg xmlns='))
  })
})

test('a destination in a subdirectory of --out-root is written', async () => {
  await workspace(async ({ root, outside }) => {
    await mkdir(join(outside, 'nested'), { recursive: true })
    const destination = join(outside, 'nested', 'diagram.svg')

    const result = await cli(args(root, ['--out', destination, '--out-root', outside]))

    assert.equal(result.code, 0)
    assert.ok((await readFile(destination, 'utf8')).startsWith('<svg xmlns='))
  })
})

test('an existing ordinary file inside --out-root is replaced', async () => {
  await workspace(async ({ root, out }) => {
    await writeFile(out, 'a stale diagram from the last run\n', 'utf8')

    const result = await cli(args(root, outArgs(out)))

    assert.equal(result.code, 0)
    assert.ok((await readFile(out, 'utf8')).startsWith('<svg xmlns='))
  })
})

test('an --out-root reached through a symlinked ancestor still accepts its own files', async () => {
  // The mirror image of hole 2, and the reason the comparison is real path
  // against real path in both directions. On macOS the system temporary
  // directory is itself reached through a symlink, so a guard that compares a
  // resolved destination with an unresolved root refuses every legitimate
  // destination on the machine it is running on.
  await workspace(async ({ root, outside }) => {
    const real = join(outside, 'real')
    await mkdir(real, { recursive: true })
    const alias = join(outside, 'alias')
    await symlink(real, alias)

    const result = await cli(args(root, ['--out', join(alias, 'diagram.svg'), '--out-root', alias]))

    assert.equal(result.code, 0)
    assert.ok((await readFile(join(real, 'diagram.svg'), 'utf8')).startsWith('<svg xmlns='))
  })
})

test('--out-root defaults to the working directory, and a destination outside it is refused', async () => {
  await workspace(async ({ root, out }) => {
    const result = await cli(args(root, ['--out', out]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /outside the permitted root/)
    assert.equal(await exists(out), false)
  })
})

test('--out-root without --out is a usage error', async () => {
  await workspace(async ({ root, outside }) => {
    const result = await cli(args(root, ['--out-root', outside]))

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /no meaning without --out/)
  })
})
