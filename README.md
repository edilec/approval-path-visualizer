# approval-path-visualizer

Read an approval path — steps, approvers, branch conditions, timeouts and exception exits — check
the paths through it, and draw a standalone **SVG** or **HTML** diagram of what it found.

- **Repository:** [edilec/approval-path-visualizer](https://github.com/edilec/approval-path-visualizer)
- **Area:** Automation & Workflows
- **License:** MIT
- Node ESM, `node >= 22`, **no dependencies** — runtime or development. Node built-ins only.

Two questions are hard to answer by reading an approval definition and easy to answer by walking it:

| Rule | What it means |
| --- | --- |
| `node-unreachable` | No path from the start step reaches this one. If it is an approval step, its approvers are never asked — the review everyone believes is happening is not. |
| `approval-cycle` | Two or more steps can send a request round to each other forever. Nobody is refusing it; it just never arrives. |

And one property matters more than either, because the tool writes markup: **every label, approver
name, condition and reason in the input is untrusted text**, and all of them end up inside a
generated document. A step labelled `<script>alert(1)</script>` renders as the words
`<script>alert(1)</script>`, drawn in a box, doing nothing.

## Install

```sh
npm install approval-path-visualizer
```

Or run it from a checkout with `node bin/approval-path-visualizer.mjs`.

## Use

```sh
approval-path-visualizer \
  --root examples/clean \
  --graph approval.json \
  --out build/approval-path.svg
```

```
capital purchase approval (approval.json): 5 approval step(s), 3 outcome(s), 6 approver(s), status pass.
paths: 11 edge(s), 5 timeout(s), 2 exception exit(s), 0 unreachable step(s), 0 cycle(s).
diagram: build/approval-path.svg
```

The deliberately broken example in `examples/broken` exits `1` and says why:

```
ERROR   approval.json/nodes/security-review node-unreachable No path from the start step "intake"
        reaches this node. Its approvers (security-officer, data-protection-officer) are never asked.
ERROR   approval.json/nodes/compliance-review approval-cycle Approval cycle: compliance-review ->
        legal-review -> compliance-review. A request that enters it can be sent round forever.
ERROR   approval.json/nodes/vendor-hold path-dead-end Approval step has no edge, timeout or exception
        exit, so a request that arrives here can never leave.
```

`--json` emits the machine-readable report on stdout, `--format html` writes a page with the diagram
above the findings, and `--help` prints the full flag list.

### As a library

```js
import { visualizeApprovalPath, writeDiagram } from 'approval-path-visualizer'

const { report, diagram, graph, analysis } = await visualizeApprovalPath({
  root: 'examples/clean',
  graph: 'approval.json',
  format: 'svg',
})
```

`visualizeApprovalPath` reads; it never writes. `diagram` is a string, and where it goes is the
caller's decision — `writeDiagram` is offered for convenience and refuses nothing on its own, which
is why the CLI resolves the destination with `resolveDiagramDestination(root, out, graphPath)`
first. Pass that third argument: it is what refuses a destination that is the graph file reached by
another name.

The pure pieces are exported too: `compileGraph`, `analyseGraph`, `renderDiagram`, `layoutGraph`,
`findCycles`, `layerFromStart`, `canonicalCycle`, `escapeMarkup`, `markupText`, `parseDuration`.

## The graph

One JSON file, every key closed. `docs/approval-path-rules.md` holds the full schema; the shape is:

```json
{
  "schemaVersion": "1",
  "name": "capital purchase approval",
  "start": "intake-review",
  "nodes": [
    {
      "id": "intake-review",
      "kind": "approval",
      "label": "Intake review",
      "approvers": ["requesting-team-lead"],
      "timeout": { "after": "P2D", "to": "escalate-to-operations" },
      "edges": [
        { "to": "finance-review", "condition": "amount >= 10000" },
        { "to": "approved", "condition": "amount < 10000" }
      ],
      "exceptions": [{ "to": "withdrawn", "reason": "requester withdrew the request" }]
    },
    { "id": "approved", "kind": "outcome", "label": "Approved", "outcome": "approved" }
  ]
}
```

An unknown key is a finding rather than something quietly ignored: a misspelled `edges` removes a
path, and a removed path is exactly the kind of real failure a typo must not be able to turn green.

## Escaping is the security property

Two passes run on every untrusted value, in this order, and there is one function that does both:

1. **Sanitise** — remove C0 (U+0000–U+001F), DEL, C1 (U+0080–U+009F), U+2028, U+2029 and the bidi
   and isolate controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069). U+0085 and U+009B forge
   lines in a report; U+202E reverses what is displayed after it. Escaping does nothing about any of
   them, and this applies to **every** value that reaches output — ids, pointers, paths, messages
   and evidence, not only an excerpt field.
2. **Escape** — `&`, `<`, `>`, `"` and `'`, ampersand first. Both quote styles, so the same function
   is safe inside an attribute; `>` as well as `<`, which is what stops a label ending `]]>` from
   closing a CDATA section in a consuming document and `-->` from ending a comment.

A control character in an **identifier** is refused outright instead of cleaned: a node id that
prints differently from the id that was compared is one nobody can audit.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every step is reachable and every path ends at an outcome | the report |
| `1` | the graph was read and failed the check | the report |
| `2` | invalid usage or configuration | **empty** |
| `2` | evidence missing, undecodable or bounded out | an `incomplete` report |

A graph file that was named but is not there is missing evidence, not a configuration error: it is
reported as `graph-unreadable` in an `incomplete` report. stdout is empty only when the run never had
a subject at all — an unusable flag, an unreadable root, a path that resolves outside it.

stdout carries the report and nothing else; diagnostics go to stderr. A consumer that pipes stdout
must handle it being empty on exit 2 — emitting a fake report for a run that never started would be
worse.

## Guarantees

Each of these has a test that fails when the line enforcing it is removed. Each was also checked by
deleting that line, watching the suite go red, and putting it back.

- **A label naming an element renders as text.** Twelve payloads through seven arrival sites — a
  node identifier and an outcome value among them — in both formats, asserted against the document's
  element and attribute vocabulary rather than against what an escape function returns.
- **The input is never written to.** The graph file is byte-identical, to the millisecond, after any
  run; the diagram destination is refused if it resolves inside the input root, refused through a
  symlinked parent, and refused when it is the graph file itself under a second name. `realpath`
  resolves a symbolic link, but a hard link has no target — two names for one inode resolve to two
  different paths, so identity is decided on `(device, inode)` and never on the resolved path.
- **A verdict is withheld rather than guessed.** `node-unreachable`, `approval-cycle` and
  `outcome-unreachable` are reported only when the traversal that decides them ran to completion. A
  bounded-out or untraceable walk is `incomplete`, which is not a pass and not a failure.
- **`pass` with `checked: 0` is not reachable.** A graph that yielded no step is `incomplete`.
- **Every documented limit is enforced**, reported by name, and makes the run `incomplete` — never a
  quietly shorter diagram. Nothing is truncated in silence: a value above `maxLabelLength` is cut
  with an ellipsis *and* a finding, and the renderer wraps rather than cuts.
- **Every finding's severity comes from one frozen table**, asserted against the documented catalog
  in both directions — and, because three agreeing declarations can be edited together, every rule
  that can decide a verdict is pinned again by behaviour: a real graph through the real binary,
  asserting the exit code, in a file that imports no table.
- **No wall clock, locale, `localeCompare`, collator, random source, network access or filesystem
  enumeration order affects the output.** Every emitted order is pinned by asserting the order that
  comes out for ids that collate differently from their code-unit order, so substituting a collator
  fails a test rather than quietly making the output depend on the host's ICU data.
- **A diagram drawn from incomplete evidence says so on its face**, because a picture outlives the
  report that produced it.

## Limits and non-goals

This tool reads a description of an approval path. Here is what that cannot tell it:

- **Whether the description is true.** Whether the system that actually routes requests matches this
  file is outside anything a file can settle.
- **Whether the approvers exist, hold the authority the step assumes, or are different people.** The
  names are text. Two spellings may be one person; one name may be a group that is empty this week.
- **Whether a condition is satisfiable, exhaustive or mutually exclusive.** Conditions are drawn,
  never evaluated. `amount >= 10000` beside `amount > 10000` is a gap this tool cannot see; two
  conditions written identically is the most it can notice.
- **Whether a timeout is long enough, or whether anything enforces it.** It checks that the duration
  is readable and that its target exists.
- **Whether a reachable path is one a real request can take.** Reachability here is graph
  reachability and ignores conditions entirely, so a step reachable only when `amount < 0` counts as
  reachable.
- **How many loops a tangle contains.** Cycle detection reports at least one cycle through every
  cyclic region and marks every step on a reported one, but it does not enumerate every elementary
  cycle: a region with several overlapping loops may be described by fewer.
- **Whether an unreachable step is dead.** It is unreachable *from the declared start*. A process
  entered at several points is not the shape this tool reads.
- **Anything at all about a run whose status is `incomplete`.** That status means the tool did not
  find out.
- **Whether the diagram is safe inside a document whose markup it does not control.** The output is a
  standalone, escaped document. Embedding it in another page, or serving it as HTML from an origin
  whose cookies matter, is a decision this tool cannot make for you.

The layout is a plain layered one: shortest-path layers top to bottom, steps ordered by id within a
layer, straight arrows forward and a curve for anything that goes back. It is meant to be read and
diffed, not to be pretty; on a dense graph, arrows cross.

## Rules, limits and output

`docs/approval-path-rules.md` — the graph schema, all forty-one rules with their severities, every
limit and its flag, the ordering rule, the exit codes, and the list of things this tool cannot
conclude.

## Development

```sh
npm run check     # lint, test, run the example, and pack
```

`npm run lint` is `node --check` over every file, `npm test` is `node --test`, and
`npm run test:coverage` adds Node's own coverage. There is nothing to install.

## License

MIT. See [LICENSE](./LICENSE).
