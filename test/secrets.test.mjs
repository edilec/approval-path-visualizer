import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { args, cli, workspace } from './support.mjs'

/**
 * A parse failure must not reproduce the file it failed on.
 *
 * V8 reports a `JSON.parse` failure two ways. One names a position and says
 * nothing about the content. The other quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` -- the
 * whole document when it is short, a ten-character prefix when it is not. A
 * graph file short enough to be only a credential is therefore published in
 * full by its own error message, on exactly the path a malformed or untrusted
 * file takes.
 *
 * Sanitising does not fix this and never did: `excerpt` strips control
 * characters and cuts from the end, and the quoted input sits at the front of
 * the message. The canary below is AWS's published documentation placeholder,
 * not a key.
 */

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/** Every prefix of the canary down to eight characters, longest first. */
function prefixes(value) {
  const found = []
  for (let length = value.length; length >= 8; length -= 1) found.push(value.slice(0, length))
  return found
}

function assertNoCanary(result, label) {
  for (const prefix of prefixes(CANARY)) {
    assert.equal(result.stdout.includes(prefix), false, `${label}: stdout carries ${prefix}`)
    assert.equal(result.stderr.includes(prefix), false, `${label}: stderr carries ${prefix}`)
  }
}

test('a graph that is only a credential is not echoed by the failure that read it', async () => {
  await workspace(async ({ root }) => {
    const json = await cli(args(root))
    assert.equal(json.code, 2)
    assertNoCanary(json, 'json report')

    const human = await cli(['--root', root, '--graph', 'approval.json'])
    assert.equal(human.code, 2)
    assertNoCanary(human, 'human report')

    const finding = JSON.parse(json.stdout).findings.find((item) => item.ruleId === 'graph-not-json')
    assert.equal(finding.evidence, "unexpected token 'A' at the start of the document")
  }, { graph: CANARY })
})

test('a longer graph is not echoed by its ten-character prefix either', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(args(root))
    assert.equal(result.code, 2)
    assertNoCanary(result, 'long document')
  }, { graph: `${CANARY} and a great deal of trailing content nobody should ever read back` })
})

test('the position, line and column survive, because a parse error that says nothing is a defect', async () => {
  await workspace(async ({ root }) => {
    const result = await cli(args(root))
    const finding = JSON.parse(result.stdout).findings.find((item) => item.ruleId === 'graph-not-json')
    assert.match(finding.evidence, /at position \d+ \(line \d+ column \d+\)/)
    assert.equal(finding.evidence.includes('hunter2'), false)
  }, { graph: '{"schemaVersion": "1", "password": "hunter2-correct-horse" "start": "intake"}' })
})

test('parseFailureDetail keeps the position and drops the quoted input', () => {
  const cases = [
    ['AKIAIOSFODNN7EXAMPLE', "unexpected token 'A' at the start of the document"],
    ['password=hunter2-correct-horse', "unexpected token 'p' at the start of the document"],
    ['', 'Unexpected end of JSON input'],
    ['{"a": 1', "Expected ',' or '}' after property value in JSON at position 7 (line 1 column 8)"],
  ]
  for (const [document, expected] of cases) {
    let detail
    try {
      JSON.parse(document)
      assert.fail(`${document} parsed`)
    } catch (error) {
      detail = parseFailureDetail(error)
    }
    assert.equal(detail, expected, JSON.stringify(document))
  }

  // A message this tool has never seen still yields something printable, and
  // an error without a message does not throw on its way into a finding.
  assert.equal(parseFailureDetail(new Error('something new from a future V8')), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(undefined), 'the document could not be parsed as JSON')
})
