/**
 * Decoding, ordering, sanitising and markup escaping.
 *
 * Nothing in this module touches the filesystem, the network, the locale or
 * the clock. Every value it handles arrived in a file this tool did not write,
 * so every value it returns is data on its way into a report or a diagram --
 * never something allowed to shape a line of output or an element of markup.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` and `Intl.Collator` both depend on ICU data that differs
 * between Node builds and between hosts, and both treat punctuation as
 * ignorable: under collation `step-a` and `step_a` swap places depending on
 * where the tool runs, and `Zeta` moves from first to last. A diagram whose
 * step order depends on the machine that drew it is not reproducible, so every
 * order this tool emits comes from here.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * The characters no untrusted value may carry into output, in four classes.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A line feed forges a line in
 *   the human report; ESC starts a terminal escape sequence; NUL truncates a
 *   value in anything that reaches it through C.
 * - **C1** (U+0080-U+009F). Easy to forget after C0, and two of them do the
 *   same damage unaided: U+0085 NEL is a line break to a great many consumers,
 *   and U+009B is the 8-bit CSI, a terminal control introducer that needs no
 *   ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029), line breaks to
 *   JavaScript and to many text consumers.
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so an approver named in a diagram can be displayed as somebody
 *   else. Ordinary right-to-left text -- Arabic, Hebrew -- needs none of these:
 *   the letters carry their own direction, so refusing the overrides refuses
 *   nothing legitimate.
 *
 * Escaping markup does not cover any of this: `&lt;` is not what stops U+202E,
 * and a `<text>` element happily carries a NEL into whatever reads the file.
 * Both passes run, on every untrusted string, every time.
 *
 * Tab, line feed and carriage return are left out of `CONTROL` on purpose:
 * `excerpt` collapses them with the surrounding whitespace into one space,
 * which is the same removal by a shorter route. `STRICT` is the same set with
 * those three put back, for values that get no whitespace collapse.
 */
const CONTROL_SOURCE = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' +
  '\\u007F-\\u009F\\u2028\\u2029\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069'
const STRICT_SOURCE = '\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029' +
  '\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069'

const CONTROL_GLOBAL = new RegExp(`[${CONTROL_SOURCE}]`, 'g')
const CONTROL_TEST = new RegExp(`[${CONTROL_SOURCE}]`)
const STRICT_TEST = new RegExp(`[${STRICT_SOURCE}]`)

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 120

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, label, approver, condition and message that reaches
 * a finding or a diagram goes through this, not only an `evidence` field. A
 * tool in this catalog sanitised its excerpts and left its identifiers raw, so
 * a node id holding a line feed printed two lines into the human report and
 * invented a finding nobody emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL_GLOBAL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/** True when a value carries a character `excerpt` would strip outright. */
export function hasControlCharacters(value) {
  return typeof value === 'string' && CONTROL_TEST.test(value)
}

/**
 * Identifiers are this tool's vocabulary: node ids, and the edge, timeout and
 * exception targets that name them. They are compared, used as map keys and
 * printed. A control character in one is refused at the door rather than
 * cleaned up afterwards, because a value that prints differently from the
 * value that was compared is a value nobody can audit.
 */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.trim() !== value) return false
  return !STRICT_TEST.test(value)
}

/**
 * Escape a string for use as XML/HTML text or as an attribute value.
 *
 * This is the security property of the whole tool: every label, approver,
 * condition, reason and id in the input is untrusted, and all of them end up
 * inside generated markup. All five characters are escaped -- including both
 * quote styles, so the same function is safe in an attribute -- and `>` is
 * escaped as well as `<`, which is what stops a label ending `]]>` from
 * closing a CDATA section in a consuming document, and what stops `-->` from
 * ending a comment.
 *
 * `&` is replaced first. Doing it last would re-escape the ampersands the
 * other replacements just introduced and turn `<` into `&amp;lt;`.
 */
export function escapeMarkup(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Sanitise then escape, in that order.
 *
 * Order matters: escaping first would leave a U+202E sitting between two
 * escaped entities, and stripping afterwards would have to walk the entity
 * text. Every interpolation in `src/render.mjs` goes through this one function
 * so that no future element can be added with only half the treatment.
 */
export function markupText(value, limit = EXCERPT_LIMIT) {
  return escapeMarkup(excerpt(value, limit))
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote. Every file this tool opens goes through here -- there is only one, and
 * it is both the data and the configuration, which is exactly the path another
 * tool hardened on one side and left lossy on the other.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const DURATION = /^P(?:(\d{1,4})D)?(?:T(?:(\d{1,4})H)?(?:(\d{1,4})M)?)?$/

/**
 * Parse the ISO-8601 duration subset a timeout may use: days, hours, minutes.
 *
 * Weeks, months and years are refused rather than approximated. "P1M" is a
 * month in ISO-8601 and a minute to half the people who write it, and a
 * timeout nobody can read the same way twice is worse than no timeout. The
 * canonical form is rebuilt and the total in minutes is returned, so two
 * spellings of the same wait compare equal without consulting a clock.
 */
export function parseDuration(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' }
  const parts = DURATION.exec(value)
  if (parts === null) return { ok: false, reason: 'not-iso-duration' }
  const days = Number(parts[1] ?? 0)
  const hours = Number(parts[2] ?? 0)
  const minutes = Number(parts[3] ?? 0)
  if (days === 0 && hours === 0 && minutes === 0) return { ok: false, reason: 'empty-duration' }
  const time = `${hours === 0 ? '' : `${hours}H`}${minutes === 0 ? '' : `${minutes}M`}`
  const canonical = `P${days === 0 ? '' : `${days}D`}${time === '' ? '' : `T${time}`}`
  return { ok: true, canonical, totalMinutes: days * 1440 + hours * 60 + minutes }
}

/**
 * Break a string into display lines of at most `width` characters.
 *
 * Pure, deterministic and independent of any font metric: the diagram uses a
 * fixed-advance layout, so counting characters is what decides the box height.
 * A word longer than the whole line is hard-split rather than allowed to run
 * out of the box, and there is no line cap: nothing is dropped here, because a
 * label that silently loses its tail misrepresents the step it names. What
 * bounds the height is `maxLabelLength`, enforced with a finding of its own
 * before any value reaches this function.
 */
export function wrapText(value, width) {
  const flattened = excerpt(value, Number.MAX_SAFE_INTEGER)
  if (flattened === '') return []
  const lines = []
  let current = ''

  const push = () => {
    if (current !== '') lines.push(current)
    current = ''
  }

  for (const word of flattened.split(' ')) {
    let rest = word
    while (rest.length > width) {
      push()
      lines.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (rest === '') continue
    if (current === '') current = rest
    else if (current.length + 1 + rest.length <= width) current = `${current} ${rest}`
    else {
      push()
      current = rest
    }
  }
  push()
  return lines
}
