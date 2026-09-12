# Record deduplication integrations

`deduplicateRecords` accepts complete SDK `Finding` records and injected
candidate retrieval, model execution, source access and checkpoint storage.
It uses the same screening, independent pair review and contradiction-aware
grouping as scan deduplication. It does not load scan artifacts, start a model
process or publish duplicate groups.

## Call the SDK

```typescript
import {
  deduplicateRecords,
  type DeduplicateRecordsOptions,
  type Finding,
} from "@openai/codex-security";

async function reviewImportedFindings(
  observations: Finding[],
  host: Pick<
    DeduplicateRecordsOptions,
    | "candidateProvider"
    | "reviewRunner"
    | "sourceManifest"
    | "sourceTools"
    | "verifySource"
    | "checkpointStore"
  >,
) {
  return await deduplicateRecords({
    ...host,
    observations,
    scopeKey: "synthetic-repository-v1",
    concurrency: 1,
  });
}
```

## Finding identities and candidates

The candidate provider receives an immutable observation and returns complete
candidate Findings. Finding IDs must satisfy the SDK schema (`csf_` followed by
24 lowercase hexadecimal characters) and identify the same content throughout
the run. Integrations with another identifier format must retain their own
mapping; the SDK does not change original finding identities.

## Review runner and result tools

The host's `reviewRunner.run(request, signal)` receives the complete prompt,
model and effort, submission schema and instructions, immutable source manifest,
and explicitly configured source tools. The host registers those tools in the
runtime that performs the review and executes source operations under its own
authorization. Tool handlers and credentials stay with the host. It returns the
raw submission; the SDK validates both fresh submissions and checkpoint hits.
Set `resultToolNamespace` when the runtime exposes result tools under a different
namespace, such as `mcp__review_validator`. It defaults to `review_validator`;
`submit_decisions` and `submit_error` keep their fixed names. The SDK supplies the
resolved namespace in each request and renders its instructions accordingly,
without changing finding evidence. The host must register those exact tools.
Changing the namespace invalidates checkpoint and prior-pair bindings. The CLI
keeps its existing namespace and behavior.

Required source or execution failures must throw rather than invent a verdict.
SAME/DISTINCT compares corrections and is separate from vulnerability validation.

## Source access

`sourceManifest` describes the approved repositories and exact revisions.
`verifySource` must verify that binding is still available and valid, including
before a cached review is reused. `sourceTools` descriptors include a version
that changes when tool behavior or permissions change. The manifest and tool
configuration are frozen for the call; they do not authorize additional source.
The built-in CLI runner's source configuration remains unchanged.

## Durable checkpoints

An optional checkpoint store implements `getReview(key)` and
`saveReview(key, binding, result)`. Saving must atomically persist that exact
result before its promise resolves; a conflicting existing result must fail
instead of acknowledging a different verdict. Bindings include the SDK/review contract, complete prompt and result
schema, model settings, scope, source and tool versions. Pass `settingsDigest`
when host execution settings change. `checkpointKeys` contains only review keys
acknowledged by a configured store. Failed runs preserve completed checkpoints;
retry with the same inputs and store to resume them.

## Pair decisions and results

The result also includes validated `pairOutcomes` and `sameComponents` before
contradiction subgrouping. Each pair outcome records its screening, pair-review
or prior origin and an immutable-input `bindingDigest`. Previously persisted
outcomes can be supplied as `priorDecisions`; their records must be present in
the current corpus and their bindings must still match. Stale or conflicting
constraints fail the call. A prior DISTINCT remains a grouping constraint even
if current nearest-neighbor retrieval did not nominate that pair.

For this record-level API, `deduplicationStatus: "completed"` means review and
grouping completed, including configured checkpoint writes. The host owns any
subsequent publication, stable canonical identities or workflow transitions.
