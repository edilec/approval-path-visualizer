# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- an explicit approval graph — steps, approvers, branch conditions, timeouts and
  exception exits — compiled from data, with every unknown key at every level
  refused rather than ignored, and every structurally defective node dropped
  whole rather than half-read;
- the two verdicts the tool exists for: an approval step no path from the start
  reaches (`node-unreachable`, whose message names the approvers who are never
  asked) and an approval cycle (`approval-cycle`, canonically rotated so one
  loop is reported once however it is entered), both decided over edges,
  timeouts and exception exits alike;
- the verdicts that follow from the same walk: an approval step from which no
  outcome is reachable, a step a request can never leave, a graph with no
  outcome node at all, and an edge, timeout or exception exit that names a step
  nothing declares;
- **withheld verdicts.** `node-unreachable`, `approval-cycle` and
  `outcome-unreachable` are reported only when the traversal that decides them
  ran to completion. An unknown start step, the depth bound or the work budget
  stopping the walk withholds all three and makes the run `incomplete`: a step
  the walk never visited is not evidence that nothing reaches it, and reporting
  it as one would be a fabricated finding in a report whose only value is that
  it can be trusted;
- a standalone SVG or HTML diagram of the compiled graph, laid out by integer
  arithmetic — a shortest-path layer index, a character count, a fixed box
  width — so no font is measured and the same graph renders to the same bytes
  everywhere. Steps no path reaches are drawn in a band of their own, steps on
  a cycle are marked, and each box is one `aria-label`-ed group;
- escaping as the security property, not a presentation detail: `&`, `<`, `>`,
  `"` and `'` on every interpolation, so a label naming a script element, an
  attribute break, a comment opener or `]]>` renders as the text of one;
- sanitisation of every untrusted string that reaches output — identifiers,
  pointers, paths and messages as well as `evidence`, and a CLI diagnostic on
  its way to stderr — covering C0 and DEL, the whole C1 range (U+0085 NEL
  forges a line of its own, U+009B is the 8-bit CSI), U+2028 and U+2029, and
  the bidi and isolate controls U+200E, U+200F, U+202A–U+202E and U+2066–U+2069,
  which are also refused inside an identifier. Ordinary right-to-left letters
  are untouched: they carry their own direction and need no override;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })`, so
  whether a file is decodable is the decoder's decision and never an inference
  drawn from the decoded text;
- real-path confinement on both sides: the graph file is refused if it resolves
  outside the input root, and the diagram destination is refused if it resolves
  inside it — checked against the nearest existing ancestor, so a symlinked
  parent cannot put a derived artifact back among the inputs, and resolved on
  both sides, so a root reached through a symbolic link still reads its own
  files;
- explicit file-byte, node, edge, approver, label-length, path-depth and
  traversal-work limits, each reported by name when hit and each making the run
  `incomplete` instead of truncating. `maxTraversalSteps` is a work budget
  rather than a wall-clock timeout, deliberately: a timeout makes the result
  depend on how busy the machine was, and a tool that says `fail` on a fast host
  and `incomplete` on a slow one is not reproducible;
- nothing cut in silence anywhere. A value above `maxLabelLength` is reported
  *and* shown cut with an ellipsis; the renderer wraps rather than truncates, so
  a long condition is never displayed as though it were the whole condition;
- an ISO-8601 duration subset for timeouts — days, hours and minutes. Weeks,
  months and years are refused rather than approximated: `P1M` is a month to
  the standard and a minute to half the people who write it, and a timeout
  nobody reads the same way twice is worse than no timeout;
- a CLI with `--help`, `--json`, `--out`, `--format` and the limit flags, the
  report on stdout, diagnostics on stderr, and exit codes 0 / 1 / 2 — with an
  empty stdout for a configuration error and an `incomplete` report for
  evidence that could not be obtained, and with a repeated value-carrying flag
  refused instead of silently overwriting the earlier value;
- runnable clean and deliberately broken example graphs; the broken one carries
  an unreachable security review, a cycle between legal and compliance, a
  timeout and an exception exit that lead nowhere, a step a request can never
  leave, and labels spelling a script element, a comment opener and `]]>`, so
  the escaping is demonstrated by the example itself;
- the graph schema, the rule catalog, the limits, the ordering rule, the exit
  codes and the list of things this tool cannot conclude in
  `docs/approval-path-rules.md`.

### Guaranteed

- No code path in this package writes to the graph it was asked to draw. The
  input is byte-identical, to the millisecond, after any run, and the diagram is
  written only to a destination outside the input root.
- A run that read no approval step is `incomplete` and exits 2. `pass` with
  `checked: 0` is not reachable.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, and the table is asserted against the documented
  catalog in both directions and against the rules the source emits. Those are
  three declarations, and a coordinated edit to all three agrees with itself, so
  every rule whose severity can decide a verdict is pinned again by behaviour: a
  real graph through the real binary, asserting the rules reported, the status
  and the exit code, with nothing in that file reading the table.
- No wall clock, locale, `localeCompare`, collator, random source, network
  access or filesystem enumeration order affects the output. Every order the
  report and the diagram expose is pinned by asserting the emitted order for ids
  that sort differently under collation than by code unit, so substituting a
  collator — under any spelling a source scan would miss — fails a test rather
  than silently making the output depend on the host's ICU data.
- Every guarantee above was checked by deleting the line that enforces it,
  watching the suite go red, and restoring it.

No release has been published.
