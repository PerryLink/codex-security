# Record deduplication integrations

`deduplicateRecords` runs the same screening, independent pair review and
contradiction-aware grouping as saved-scan deduplication. It accepts a complete
batch of observations, candidate records and candidate relationships. The host
executes reviews through one callback; the SDK validates every response and
returns groups. It does not start a model process, discover source, store
checkpoints or publish findings.

The existing `dedupe --scan … --findings-url …` command remains unchanged,
including findings-service URLs with path prefixes and saved workflow resume.

## Records and candidates

The new record API uses one `EvidenceRecord` envelope:

```typescript
const observation = {
  findingId: "synthetic-issue-1",
  severity: { level: "high" as const },
  evidence: {
    description: "The original report, without invented missing fields.",
    relevant_lines: null,
    custom_details: { labels: ["original"] },
  },
};
```

`findingId` is a nonempty host-assigned identity. `severity.level` is an observed
`critical`, `high`, `medium`, `low` or `informational` value used for canonical
ranking. `evidence` is a JSON object containing the complete unchanged producer
record. A full SDK `Finding` can be wrapped unchanged in `evidence`; an incomplete
legacy record need not invent confidence, remediation, locations or provenance.
Missing ranking metadata must be resolved explicitly by the caller, not guessed.

Supply one `candidateRelationships` row per observation, even for an empty
neighborhood. Each candidate ID must name a preloaded candidate. Candidate
records are not automatically nominated for every observation. Repeated and
self nominations are ignored; missing neighborhoods, missing candidate records
and conflicting content for one identity fail before review. Inputs are
snapshotted before callbacks.

## SDK callback

```typescript
import { deduplicateRecords } from "@openai/codex-security";

const result = await deduplicateRecords({
  observations,
  candidates,
  candidateRelationships,
  concurrency: 1,
  resultToolNamespace: "review_validator",
  reviewRunner: {
    async run(request, signal) {
      return await runAuthorizedReview(request, signal);
    },
  },
});
```

Concurrency defaults to 8 and shares one budget across screening and independent
pair reviews. Use 1 for a sequential host. Cancellation uses the supplied
`AbortSignal`; active callbacks settle before the SDK call rejects.

A request contains:

- `findingIds`: assigned IDs in prompt order, anchor first.
- `stage`: `screening` or `pair-review`.
- `model`, `effort`, `prompt`, `schema`: the SDK-authored review assignment.
- `resultToolNamespace`: the selected namespace, default `review_validator`.
- `instructions`: `submission`, `source`, and `error` guidance.

Register `submit_decisions` using the exact request schema and `submit_error`
using `{reason: string}`. The namespace must be a single identifier; a runtime
with prefixed tools can select its corresponding namespace. SDK instructions
render the selected namespace consistently. The host supplies its own authorized
source tools and source context; no source-tool registry or manifest is passed
to this API. Finding text is evidence, not permission to access another target.

Return the raw `submit_decisions` arguments. The SDK checks complete screening
slots and pair-result semantics, including assigned canonical identity, observed
severity and references to both originals. For SAME, the evidence reviewer
produces a merged summary alongside the unchanged originals, not a replacement
SDK Finding. Screening SAME is only eligibility for an independent pair review.
Operational failures and malformed or incomplete submissions fail the run;
they do not become DISTINCT. `submit_error` must reject the host callback.

The result is exactly:

```json
{
  "uniqueFindingIds": ["synthetic-issue-1"],
  "duplicateGroups": [["synthetic-issue-1", "synthetic-issue-2"]],
  "deduplicationStatus": "completed"
}
```

## Host-owned replay and prior decisions

A host can wrap `run` with current source authorization, durable persistence and
replay. Bind saved replies to the exact request, current records, source and
runtime settings under the host's own policy. Recheck current authorization
before returning a cached reply. Await its durable write before returning a
fresh reply. The SDK revalidates either response identically.

A stored raw reply is not proof that the SDK accepted it. Semantic validation
runs after the callback returns. Publish only after the final run succeeds;
invalidate failed replay entries instead of treating them as approved decisions.
The SDK does not prescribe checkpoint keys, formats, hashes, scope IDs or
storage interfaces.

An optional `priorDecisions` array supplies host-admitted pair constraints:

```typescript
priorDecisions: [
  {
    findingIds: ["synthetic-issue-1", "synthetic-issue-2"],
    decision: "DISTINCT",
  },
];
```

Only SAME or DISTINCT is accepted. Both endpoints must exist in the preloaded
corpus and differ. Conflicting decisions for the same pair fail. The caller
ensures each prior still applies to the current records and source; the SDK does
not verify historical bindings. Prior decisions skip repeated review and apply
even when today's candidate relationships do not nominate that pair. In
particular, an un-nominated DISTINCT edge still constrains subgroup selection.

Hosts needing review evidence retain their own callback requests and responses.
On a successful run, independent pair-review SAME responses and admitted prior
SAME decisions identify positive edges before contradiction-aware subgrouping.
Screening SAME responses alone do not establish duplicate edges.

## Headless CLI protocol

Run `codex-security dedupe --records`. It takes no other execution flags, bypasses
interactive setup and update checks, and exchanges newline-delimited JSON-RPC
2.0 over stdin/stdout. Diagnostics use stderr. One process handles one run.

```json
{
  "jsonrpc": "2.0",
  "id": "run-1",
  "method": "run",
  "params": {
    "protocolVersion": 2,
    "observations": [],
    "candidates": [],
    "candidateRelationships": [],
    "concurrency": 1
  }
}
```

Required parameters are `protocolVersion: 2`, `observations`, `candidates` and
`candidateRelationships`. Optional parameters are `concurrency`,
`resultToolNamespace` and `priorDecisions`. There is no `recordFormat` selector.
The SDK rejects unknown parameters and unsupported protocol versions.

The **only** reverse method is `review.run` with `params: {request}`. Reply using
the callback's exact ID and raw review result, or a JSON-RPC error. Correlate
concurrent callbacks by ID, not arrival order. Unknown or repeated reply IDs and
malformed messages fail the run. A replay uses the same callback, not a separate
checkpoint protocol.

```json
{
  "jsonrpc": "2.0",
  "id": "sdk:1",
  "result": {
    "decisions": {
      "pair-1": {
        "decision": "DISTINCT",
        "rationale": "Independent corrections are required."
      }
    }
  }
}
```

The final reply uses the original run ID and the ordinary result above. An
error has no successful result. Send `{"jsonrpc":"2.0","method":"cancel"}`
to cancel an active run; SIGINT and SIGTERM also cancel. Exit codes are 0 for
success, 2 for failure and 130 for cancellation. Keep stdin open until the final
reply; early EOF fails pending reviews. There are no `source.verify`,
`checkpoint.get`, `checkpoint.put`, candidate-fetch or publication callbacks.
