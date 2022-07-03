import assert from 'node:assert/strict'
import test from 'node:test'

import {
  byCodeUnit,
  decodeUtf8,
  escapeMarkup,
  excerpt,
  hasControlCharacters,
  isIdentifier,
  markupText,
  parseDuration,
  wrapText,
} from '../src/text.mjs'

test('byCodeUnit orders by code unit, where collation would not', () => {
  const sorted = ['alpha', 'Zeta', 'a_b', 'ab'].sort(byCodeUnit)
  assert.deepEqual(sorted, ['Zeta', 'a_b', 'ab', 'alpha'])
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('excerpt flattens, bounds and reports its truncation', () => {
  assert.equal(excerpt('  two   words \n here '), 'two words here')
  assert.equal(excerpt('abcdefghij', 4), 'abcd...')
  assert.equal(excerpt('abcd', 4), 'abcd')
  assert.equal(excerpt(42), '42')
})

test('hasControlCharacters sees what excerpt removes, and nothing else', () => {
  assert.equal(hasControlCharacters('plain text'), false)
  assert.equal(hasControlCharacters('a line\nbreak'), false)
  assert.equal(hasControlCharacters('bell'), true)
  assert.equal(hasControlCharacters('nel'), true)
  assert.equal(hasControlCharacters('override‮'), true)
})

test('isIdentifier refuses empty, padded, over-long and control-bearing values', () => {
  assert.equal(isIdentifier('finance-review'), true)
  assert.equal(isIdentifier('مقال-2'), true)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' padded'), false)
  assert.equal(isIdentifier('x'.repeat(121)), false)
  assert.equal(isIdentifier(42), false)
  assert.equal(isIdentifier('two\nlines'), false)
})

test('decodeUtf8 refuses undecodable bytes and never guesses from the text', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('ok', 'utf8')), { ok: true, text: 'ok' })
  assert.equal(decodeUtf8(Buffer.from([0xff, 0xfe, 0x41])).ok, false)
  // A file that legitimately holds U+FFFD decodes; inferring "not UTF-8" from
  // the decoded text is the confusion that let an unread input report a pass.
  assert.equal(decodeUtf8(Buffer.from('�', 'utf8')).ok, true)
})

test('escapeMarkup escapes all five characters, ampersand first', () => {
  assert.equal(escapeMarkup('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  // An already-escaped entity stays literal instead of being decoded by a
  // consumer into the character it names.
  assert.equal(escapeMarkup('&lt;script&gt;'), '&amp;lt;script&amp;gt;')
  assert.equal(escapeMarkup(']]>'), ']]&gt;')
  assert.equal(escapeMarkup('<!--'), '&lt;!--')
})

test('markupText sanitises before it escapes', () => {
  const hostile = '<script>‮alert(1)</script>'
  const rendered = markupText(hostile)
  assert.equal(rendered.includes('‮'), false)
  assert.equal(rendered.includes('<'), false)
  assert.equal(rendered, '&lt;script&gt; alert(1)&lt;/script&gt;')
})

test('parseDuration reads days, hours and minutes, and refuses the ambiguous ones', () => {
  assert.deepEqual(parseDuration('P2D'), { ok: true, canonical: 'P2D', totalMinutes: 2880 })
  assert.deepEqual(parseDuration('PT36H'), { ok: true, canonical: 'PT36H', totalMinutes: 2160 })
  assert.deepEqual(parseDuration('P1DT2H30M'), { ok: true, canonical: 'P1DT2H30M', totalMinutes: 1590 })
  for (const refused of ['P1W', 'P1M', 'P1Y', 'P', 'PT', '2 days', '', 'P0D', 3, null]) {
    assert.equal(parseDuration(refused).ok, false, String(refused))
  }
})

test('wrapText wraps on words, hard-splits a long word and drops nothing', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four'])
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('   ', 8), [])
  // No line cap: every character of the input comes back out, because the
  // bound that keeps a box a sane size is maxLabelLength, which is enforced
  // with a finding rather than by quietly cutting the text here.
  const long = wrapText('a b c d e f g h i j k l', 3)
  assert.equal(long.join(' ').replace(/\s+/g, ' '), 'a b c d e f g h i j k l')
})
