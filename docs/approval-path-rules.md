# Approval path rules, limits and output

This document is the contract. `src/index.mjs` holds one frozen `ruleId -> severity` table and
`test/severity-table.test.mjs` asserts that table against the catalog below in **both** directions,
so a rule cannot be added, renamed or re-graded on one side alone.

Those are two declarations, and one edit can move both. Every rule in the catalog is therefore
pinned a second time by what a run of it does, in `test/severity-pins.test.mjs`: that file imports
no table, reads no catalog and holds no map of expected values, so an edit here and in the table
cannot reach it.

## The graph

One JSON file describes one approval path. Every key is closed: an unknown key is a finding, not
something quietly ignored, because a misspelled `edges` silently removes a path and turns a real
failure into a green run.

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

| Field | Where | Meaning |
| --- | --- | --- |
| `schemaVersion` | graph | `"1"`. Anything else stops the run rather than being read anyway. |
| `name` | graph | Title for the diagram. Optional; the file name is used instead. |
| `start` | graph | Id of the step a request enters. Required for any path verdict. |
| `nodes` | graph | The steps and outcomes. |
| `id` | node | Identifier. Trimmed, non-empty, at most 120 characters, no control characters. |
| `kind` | node | `approval` or `outcome`. |
| `label` | node | Display text. Optional; the id is drawn instead. |
| `approvers` | approval | Who may decide. At least one. |
| `edges` | approval | `{ "to": id, "condition": text }`. `condition` is optional on a single edge. |
| `timeout` | approval | `{ "after": ISO-8601 duration, "to": id }`. |
| `exceptions` | approval | `{ "to": id, "reason": text }` — the ways a request leaves without a decision. |
| `outcome` | outcome | `approved`, `rejected` or `withdrawn`. |

`after` accepts days, hours and minutes: `P2D`, `PT36H`, `P1DT2H30M`. Weeks, months and years are
refused rather than approximated — `P1M` is a month to ISO-8601 and a minute to half the people who
write it, and a timeout nobody reads the same way twice is worse than no timeout.

## Rule catalog

`fail` in the last column means the rule decides a verdict: the graph was read and did not pass.
`incomplete` means the run did not obtain the evidence, so it claims neither a pass nor a failure.

| ruleId | severity | leaves the run | Meaning |
| --- | --- | --- | --- |
| `approval-cycle` | error | fail | A request that enters this loop can be sent round it forever. |
| `approvers-duplicate` | warning | fail | One approver is named twice on a step. |
| `approvers-missing` | error | fail | An approval step nobody can approve. |
| `approvers-unexpected` | error | fail | An outcome node names approvers; it decides nothing. |
| `condition-duplicate` | warning | fail | Two edges leaving one step share a condition and lead elsewhere. |
| `condition-missing` | warning | fail | A branching step has an edge with no condition. |
| `edge-duplicate` | warning | fail | The same edge is declared twice on one step. |
| `edge-target-missing` | error | fail | An edge names a node nothing declares. |
| `exception-reason-missing` | warning | fail | An exception exit does not say when it is taken. |
| `exception-target-missing` | error | fail | An exception exit names a node nothing declares. |
| `graph-invalid` | error | incomplete | The file is not a graph this tool can read. |
| `graph-key-unknown` | error | fail | A top-level key outside the vocabulary. |
| `graph-name-missing` | info | fail | The graph has no name; the file name titles the diagram. |
| `graph-not-json` | error | incomplete | The file did not parse as JSON. |
| `graph-not-utf8` | error | incomplete | The file is not valid UTF-8. |
| `graph-too-large` | error | incomplete | The file is above `maxGraphBytes` and was not parsed. |
| `graph-unreadable` | error | incomplete | The file could not be opened, or is not a regular file. |
| `label-control-characters` | warning | fail | A displayed value carried control or bidi characters, which were removed. |
| `label-missing` | warning | fail | A node has no label; the diagram shows its id. |
| `label-too-long` | error | fail | A displayed value is above `maxLabelLength`. |
| `no-nodes-declared` | warning | incomplete | No approval step was read, so nothing was checked. |
| `node-id-duplicate` | error | fail | Two nodes claim one id; the later one was discarded. |
| `node-invalid` | error | incomplete | A node could not be read and was not entered into the graph. |
| `node-key-unknown` | error | fail | A node, edge, timeout or exception key outside the vocabulary. |
| `node-unreachable` | error | fail | No path from the start step reaches this node. |
| `outcome-missing` | error | fail | The graph declares no outcome node at all. |
| `outcome-not-terminal` | error | fail | An outcome node carries edges, a timeout or an exception exit. |
| `outcome-unexpected` | error | fail | An approval step declares an outcome. |
| `outcome-unreachable` | error | fail | No outcome is reachable from this approval step. |
| `outcome-value-unknown` | error | fail | An outcome outside `approved`, `rejected`, `withdrawn`. |
| `path-dead-end` | error | fail | An approval step a request can never leave. |
| `path-too-deep` | error | incomplete | A path longer than `maxDepth` was not followed. |
| `start-missing` | error | incomplete | The graph names no start step, so no path could be traced. |
| `start-unknown` | error | incomplete | The start names a node nothing declares. |
| `timeout-duration-invalid` | error | fail | A timeout duration outside the documented subset. |
| `timeout-missing` | warning | fail | An approval step that can wait indefinitely. |
| `timeout-target-missing` | error | fail | A timeout names a node nothing declares. |
| `too-many-approvers` | error | incomplete | A step is above `maxApprovers`; the rest were not read. |
| `too-many-edges` | error | incomplete | A step is above `maxEdgesPerNode`; the rest were not read. |
| `too-many-nodes` | error | incomplete | The graph is above `maxNodes`; the rest were not read. |
| `traversal-budget-exceeded` | error | incomplete | The path walk passed `maxTraversalSteps` and stopped. |

A rule may appear on a run whose status is `incomplete` for another reason; the column says what
that rule **on its own** leaves behind.

## Withheld verdicts

`node-unreachable`, `approval-cycle` and `outcome-unreachable` are only reported when the traversal
that decides them ran to completion. If the start step is unknown, or `maxDepth` or
`maxTraversalSteps` stopped the walk, all three are withheld and the run is `incomplete`.

A step the walk never visited is not evidence that no path reaches it. Reporting it as one would be
a fabricated finding — the same defect as a pass on no evidence, pointing the other way.

`maxDepth` counts the links a path follows, and a path of exactly that length is walked in full: the
bound is only reached when there is still something unvisited beyond it.

Cycle detection is back-edge detection, not an enumeration of every elementary cycle. Every cyclic
region produces at least one reported cycle, and every node in a reported cycle is marked, but a
region with several overlapping loops can be described by fewer cycles than it strictly contains.
One loop per region is what a reader needs in order to act; claiming to have listed them all would
be claiming more than the walk knows.

## Limits

| Limit | Default | Flag | Exceeding it |
| --- | ---: | --- | --- |
| `maxGraphBytes` | 1048576 | `--max-graph-bytes` | `graph-too-large`, file not parsed |
| `maxNodes` | 500 | `--max-nodes` | `too-many-nodes`, the rest not read |
| `maxEdgesPerNode` | 32 | `--max-edges-per-node` | `too-many-edges`, the rest not read |
| `maxApprovers` | 16 | `--max-approvers` | `too-many-approvers`, the rest not read |
| `maxLabelLength` | 120 | `--max-label-length` | `label-too-long`, value cut and marked |
| `maxDepth` | 64 | `--max-depth` | `path-too-deep`, verdicts withheld |
| `maxTraversalSteps` | 200000 | `--max-traversal-steps` | `traversal-budget-exceeded`, verdicts withheld |

`maxTraversalSteps` is a work budget rather than a wall-clock timeout, deliberately. A timeout makes
the result depend on how busy the machine was, and a tool that says `fail` on a fast host and
`incomplete` on a slow one is not reproducible. Counting the links the walk follows bounds the same
runaway and decides the same way every time.

No limit is exceeded silently. Every one of them is a finding naming the limit, and every one of
them makes the run `incomplete` rather than producing a quietly shorter answer.

`maxLabelLength` bounds what is **drawn** and decides nothing else. The vocabulary check on an
`outcome`, and the comparisons that decide whether two conditions, two edges or two approvers are
the same, all run on the whole sanitised value. A display bound that reaches a judgement invents
findings: cut to five characters, a clean graph reported every outcome as outside the vocabulary and
every pair of conditions sharing an opening as making the path ambiguous — both false, and both
about a graph the reader can see is fine.

## Escaping and sanitising

Every label, approver name, condition, exception reason, outcome, graph name and node id arrives in
a file this tool did not write, and all of them are drawn into generated markup. Two passes run on
each, in this order:

1. **Sanitise.** Remove C0 (U+0000–U+001F), DEL (U+007F), C1 (U+0080–U+009F), U+2028, U+2029 and
   the bidi and isolate controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069). This applies to
   every value that reaches output — ids, pointers, paths, messages and evidence, not only an
   excerpt field. Escaping does nothing about any of these: `&lt;` is not what stops U+202E, and a
   `<text>` element carries a NEL into whatever reads the file quite happily.
2. **Escape.** `&`, `<`, `>`, `"` and `'`, ampersand first. Both quote styles, so the same function
   is safe in an attribute; `>` as well as `<`, which is what stops a value ending `]]>` from
   closing a CDATA section in a consuming document and `-->` from ending a comment.

A control character in an **identifier** is refused outright rather than cleaned: a node id that
prints differently from the id that was compared is one nobody can audit.

## Ordering

Findings sort by `(location.file, location.pointer, ruleId, message)`, compared by UTF-16 code unit.
There is one input file, so `location.file` is constant in practice and `pointer` is what orders a
report.

Diagram rows are ordered by shortest-path layer, and within a layer by node id — again by code unit.
`localeCompare` and `Intl.Collator` are both refused: they depend on ICU data that differs between
Node builds, and they treat punctuation as ignorable, so `step-a` and `step_a` swap places depending
on where the tool ran. Running the tool twice over the same bytes produces byte-identical stdout and
a byte-identical diagram.

## The diagram destination

The diagram is derived from the graph, and writing it back into the tree the graph lives in is how a
read-only tool modifies its own input on the next run. `--out` is refused when:

- it resolves inside `--root`, including through a symbolically linked parent directory; or
- it is a directory; or
- it names the graph file itself under a second name.

That last one is not the same check as the first. `realpath` resolves a symbolic link, but a hard
link has no target: `cp -l`, a package store and a backup snapshot all produce two names for one
inode, and those two names resolve to two different real paths. A path comparison says "different
file" and the write truncates the graph. File identity is the `(device, inode)` pair, so that is
what is compared, before any byte is written.

## Output

stdout carries the report and nothing else; diagnostics go to stderr.

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every step is reachable and every path ends at an outcome | the report |
| `1` | the graph was read and failed the check | the report |
| `2` | invalid usage or configuration | **empty** |
| `2` | evidence missing, undecodable or bounded out | an `incomplete` report |

## What this tool cannot conclude

- **That the approval path is correct.** It reads a description of a path. Whether that description
  matches the system that actually routes requests is outside what any file can tell it.
- **That the approvers exist, hold the authority the step assumes, or are different people.** The
  names are text. Two names spelled differently may be one person; one name may be a group that is
  empty this week.
- **That a condition is satisfiable, exhaustive or mutually exclusive.** Conditions are drawn as
  text, never evaluated. `amount >= 10000` and `amount > 10000` leaving one step is a gap this tool
  cannot see; two conditions written identically is the most it can notice.
- **That a timeout is long enough, or that anything enforces it.** It checks the duration is
  readable and the target exists.
- **That a reachable path is one a real request can take.** Reachability here is graph reachability:
  it ignores conditions entirely, so a step reachable only when `amount < 0` counts as reachable.
- **That an unreachable step is dead.** It is unreachable *from the declared start*. A graph that is
  entered at several points is not the shape this tool reads.
- **Anything about a run whose status is `incomplete`.** That status means the tool did not find
  out, and it is never a pass.
- **That the rendered diagram is safe to paste into a page whose own markup it does not control.**
  The output is a standalone document, escaped as described above. Embedding it inside another
  document, or serving it as HTML from a host whose cookies matter, is a decision this tool cannot
  make for you.
