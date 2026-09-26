import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { RULE_SEVERITY, createFinding } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * The severity table as a source of truth, checked against the documented
 * catalog in both directions and against the rules the source can actually
 * emit.
 *
 * This file is a set of declarations agreeing with each other, which is
 * exactly the guard that failed elsewhere in this catalog: a coordinated edit
 * to the table and the catalog passes every assertion here. It is kept because
 * it catches the ordinary mistakes -- a rule added to the code and nowhere
 * else, a rule documented and never emitted, a typo in an id -- and the
 * severities that can decide a verdict are pinned by behaviour instead, in
 * `test/severity-behaviour.test.mjs`, which reads nothing from this file.
 */

const SEVERITIES = ['error', 'info', 'warning']

async function documentedRules() {
  const text = await readFile(join(projectDirectory, 'docs/approval-path-rules.md'), 'utf8')
  const rows = new Map()
  for (const match of text.matchAll(/^\| `([a-z][a-z0-9-]*)` \| (error|warning|info) \| (fail|incomplete) \|/gm)) {
    rows.set(match[1], { severity: match[2], leaves: match[3] })
  }
  return rows
}

test('every rule in the table is documented, with the same severity', async () => {
  const documented = await documentedRules()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(documented.has(ruleId), `${ruleId} is not in docs/approval-path-rules.md`)
    assert.equal(documented.get(ruleId).severity, severity, `${ruleId} is documented at a different severity`)
  }
})

test('every documented rule is in the table', async () => {
  const documented = await documentedRules()
  assert.ok(documented.size > 30, 'the catalog table was not parsed')
  for (const ruleId of documented.keys()) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is documented but not in RULE_SEVERITY`)
  }
})

test('the rules the source emits and the rules the table grades are the same set', async () => {
  // A rule constructed in the source and missing from the table throws at run
  // time, which is the right behaviour but a poor way to find out; a rule in
  // the table that nothing emits is a documented check nobody performs.
  const emitted = new Set([
    // Built from an expression rather than a literal key, so named here.
    'edge-target-missing', 'exception-target-missing', 'timeout-target-missing',
  ])
  for (const path of ['src/index.mjs', 'src/graph.mjs']) {
    const text = await readFile(join(projectDirectory, path), 'utf8')
    for (const match of text.matchAll(/ruleId: '([a-z][a-z0-9-]*)'/g)) emitted.add(match[1])
    for (const match of text.matchAll(/unknownKeys\(problems, '([a-z][a-z0-9-]*)'/g)) emitted.add(match[1])
  }
  assert.ok(emitted.size > 30, 'the source scan found almost nothing, so it is not checking anything')

  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but has no severity`)
  }
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(emitted.has(ruleId), `${ruleId} is graded but nothing emits it`)
  }
})

test('every severity is one of the three the contract allows', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(SEVERITIES.includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('the table is frozen and its ids are stable kebab-case', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.match(ruleId, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
  }
})

test('a finding whose rule is not in the table throws instead of being emitted', () => {
  assert.throws(
    () => createFinding({ ruleId: 'invented-rule', message: 'x', file: 'f', pointer: '/' }),
    /is not in RULE_SEVERITY/,
  )
  const finding = createFinding({ ruleId: 'node-unreachable', message: 'x', file: 'f.json', pointer: '/nodes/a' })
  assert.deepEqual(finding, {
    ruleId: 'node-unreachable',
    severity: 'error',
    message: 'x',
    location: { file: 'f.json', pointer: '/nodes/a' },
  })
})
