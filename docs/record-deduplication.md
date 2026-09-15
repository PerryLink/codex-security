# Record deduplication integrations

`deduplicateRecords` accepts a complete batch of SDK `Finding` records and
candidate relationships, with host-owned model execution, source access and checkpoint storage.
It uses the same screening, independent pair review and contradiction-aware
grouping as scan deduplication. It does not load scan artifacts, start a model
process or publish duplicate groups.

## Call the SDK

```typescript
import { deduplicateRecords } from "@openai/codex-security";

const result = await deduplicateRecords({
  observations,
  candidates,
  candidateRelationships,
  reviewRunner,
  sourceManifest,
  sourceTools,
  verifySource,
  checkpointStore,
  scopeKey: "synthetic-repository-v1",
  concurrency: 1,
});
```

## Finding identities and candidates

Supply `observations`, `candidates`, and one `candidateRelationships` entry per
observation, including empty neighborhoods. Candidate IDs resolve only against
`candidates`; supplying a record does not nominate it for every observation.
The SDK validates and snapshots the complete batch before any host callback.
Missing neighborhoods, dangling references, and conflicting record content fail the call.
Finding IDs must satisfy the SDK schema (`csf_` followed by
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
Source tools may share the result namespace, but cannot replace
`submit_decisions` or `submit_error` in either the configured namespace or
`review_validator`. Duplicate source namespace/name pairs are rejected.
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
constraints fail the call. Prior endpoints are retained from the preloaded
records for grouping even when they are no longer nominated; this does not add
model comparisons or include unrelated candidates. A prior DISTINCT remains a grouping constraint even
if current nearest-neighbor retrieval did not nominate that pair.

For this record-level API, `deduplicationStatus: "completed"` means review and
grouping completed, including configured checkpoint writes. The host owns any
subsequent publication, stable canonical identities or workflow transitions.

## Headless CLI protocol

Use `codex-security dedupe --records` to call the same SDK algorithm from another
language or process. Without `--records`, `dedupe` keeps its saved-scan behavior.
Use the exact `--records` flag; value forms such as `--records=true` are rejected.
Record mode accepts no other execution flags: inputs and settings arrive in the
`run` message. `codex-security dedupe --help` describes both modes. Record mode
does not prompt, load local scan state, start a model runtime or publish results.

The transport is bidirectional JSON-RPC 2.0, one UTF-8 JSON object per line on
stdin/stdout. Stdout contains only protocol messages; protocol execution does not
write diagnostics to stderr.
There are no JSON-RPC batch messages. A process serves one `run` request and exits
when its run succeeds, fails or is canceled. Keep stdin open and service callbacks
until the final run response; piping only a run request and closing stdin cancels
unfinished work.

Send a `run` request with these parameters. `protocolVersion` must be `1`;
`checkpoints` defaults to `false` and enables host checkpoint callbacks when true.

| Field                    | Contract                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `protocolVersion`        | Required protocol version `1`.                                                                                |
| `recordFormat`           | Optional `finding-v1` (default) or `evidence-v1`; selects the schema for every observation and candidate.     |
| `checkpoints`            | Optional boolean enabling the host checkpoint store; defaults to `false`.                                     |
| `observations`           | Required observation records in the selected format; the SDK validates each record.                           |
| `candidates`             | Required candidate records in the selected format, fetched and authorized before invoking the CLI.            |
| `candidateRelationships` | Required `{observationId, candidateIds}` entries, exactly one per observation, including empty neighborhoods. |
| `scopeKey`               | Required nonempty corpus scope.                                                                               |
| `sourceManifest`         | Required JSON object describing host-approved source.                                                         |
| `sourceTools`            | Optional SDK source tool descriptors; defaults to an empty array.                                             |
| `settingsDigest`         | Optional host execution-settings binding.                                                                     |
| `resultToolNamespace`    | Optional result tool namespace; defaults to `review_validator`.                                               |
| `priorDecisions`         | Optional earlier bound pair decisions; defaults to an empty array.                                            |
| `concurrency`            | Optional positive integer; defaults to the SDK default of 8.                                                  |

A minimal empty-corpus run is:

```json
{
  "jsonrpc": "2.0",
  "id": "run",
  "method": "run",
  "params": {
    "protocolVersion": 1,
    "observations": [],
    "candidates": [],
    "candidateRelationships": [],
    "scopeKey": "synthetic-scope",
    "sourceManifest": { "revision": "synthetic-revision" }
  }
}
```

The host fetches and authorizes the complete batch before invoking the CLI.
The SDK uses the same batch inputs and validation for direct calls. The CLI
never requests candidates from the host or an HTTP endpoint.

The CLI sends callback requests with contiguous increasing IDs `sdk:1`, `sdk:2`,
and so on, in emission order within each process. Requests can overlap;
the host must correlate responses by ID, not arrival order. Host and CLI request
IDs are independent. Use string IDs or integer IDs for host requests. The callback
methods are:

| Method           | Parameters               | Success `result`                                                   |
| ---------------- | ------------------------ | ------------------------------------------------------------------ |
| `review.run`     | `{request}`              | Raw model submission, validated by the SDK.                        |
| `source.verify`  | `{manifest}`             | `null`, after verifying the exact source binding.                  |
| `checkpoint.get` | `{key}`                  | Previously saved raw review result, or `null` if absent.           |
| `checkpoint.put` | `{key, binding, result}` | `null`, only after durable storage acknowledges this exact result. |

For example, reply to a successful source verification with:

```json
{ "jsonrpc": "2.0", "id": "sdk:1", "result": null }
```

On failure, return an error instead of a substitute verdict:

```json
{
  "jsonrpc": "2.0",
  "id": "sdk:1",
  "error": { "code": -32001, "message": "Synthetic source is unavailable." }
}
```

The host registers and executes the request's source and result tools, enforces
access to the approved repositories, and owns model execution and durable state.
Before a run is accepted, a rejected request receives an error with its own ID;
unidentifiable input uses `null`. Once accepted, the run ID identifies its terminal
response. Use the structured stdout error and process exit status. Static command-usage
errors may still use stderr.

The CLI does not execute source tool descriptors itself. Credentials belong in
the host's execution environment, not protocol arguments or source descriptors.
Unknown parameters, malformed or duplicate replies, and replies to unknown IDs
fail the attempt. Prior constraints can be passed as the three-field SDK input or as full earlier
pair outcomes; only `findingIds`, `decision` and `bindingDigest` are reused.
An SDK failure is returned on the run request as an error, not
as a DISTINCT result. Completion returns the existing SDK result unchanged.
Exit status is 0 for success, 2 for failure, and 130 for cancellation.

To cancel, send this notification (no `id` or `params`):

```json
{ "jsonrpc": "2.0", "method": "cancel" }
```

Cancellation returns run error code `-32800`; it and EOF reject all outstanding
callback promises. SIGINT/SIGTERM also cancel the attempt. The host must stop its
own outstanding operations: terminating this CLI cannot terminate a model or
storage operation running in the host. A durable checkpoint write may have
committed even when its acknowledgement is lost; reuse the host store on retry.

## Linking pair decisions to durable reviews

Each review request and checkpoint binding includes `findingIds`, derived by the
SDK from the assigned Findings in prompt order. For screening, the first ID is
the anchor and the remaining IDs are its candidate slots in order. Pair review
assigns the two IDs in order. Hosts do not need to parse prompts to identify the
records a checkpoint explains.

Each returned pair outcome has `checkpointKeys`: the sorted keys of acknowledged
screening and pair-review checkpoints concerning that pair. Cached reviews
produce the same associations without calling `review.run` again. With no
checkpoint store this array is empty. Prior-only outcomes also have an empty
array; retain the earlier decision's provenance in the host's durable record.
A screening checkpoint can explain multiple anchor-candidate pairs.

## Imported evidence without a complete Finding

Use `recordFormat: "evidence-v1"` when original records do not contain every
required SDK Finding field. The same option works with `deduplicateRecords`
(`DeduplicateEvidenceRecordsOptions`) and the single CLI `run` request, which
uses protocol version 1. Older executables reject the unsupported run field;
there is no automatic downgrade or inference from missing fields.

Each observation and candidate has exactly this envelope:

```json
{
  "findingId": "synthetic-import-1",
  "severity": { "level": "high" },
  "evidence": {
    "description": "Original report text, including all original fields",
    "relevant_lines": null,
    "custom": { "labels": ["original"] }
  },
  "provenance": {
    "repository": "synthetic-repository",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

`findingId` is a nonempty host-bound comparison identity; the scan-specific
`csf_` format is not required. `severity.level` is the original observed severity
(`critical`, `high`, `medium`, `low` or `informational`), used by the existing
group representative ordering. Missing or unsupported severity must be resolved
by the host rather than replaced with an invented default.

`evidence` and `provenance` accept complete JSON objects. Preserve every original
field and absent versus null values. Do not manufacture confidence, remediation,
locations, fingerprints or scan identity. The envelope's provenance describes
the host-known origin; the separate source manifest and verification callback
still establish current source access. Source references grant no authority.

A mixed-producer batch uses envelopes for every observation and candidate.
Include an existing complete SDK Finding unchanged inside its envelope's
`evidence`. Canonical candidates must retain their contributing original
evidence and provenance, not only a mutable generated summary. An envelope is
one assigned record even if its evidence contains multiple contributing sources.
Raw Finding/envelope mixtures and conflicting evidence for one identity fail.
The host still supplies the full explicit candidate graph before execution.

Screening and independent pair review use the existing models and grouping
algorithm. DISTINCT keeps its existing result shape. An evidence-mode SAME
review instead supplies this strict generated summary:

```json
{
  "decision": "SAME",
  "rationale": "One inspected correction closes both complete reported paths.",
  "canonicalFindingId": "synthetic-import-1",
  "mergedFinding": {
    "findingId": "synthetic-import-1",
    "severity": { "level": "high" },
    "summary": "An inclusive summary of the shared issue, correction and uncertainty.",
    "originalFindingIds": ["synthetic-import-1", "synthetic-import-2"]
  }
}
```

The SDK validates the selected assigned identity, unchanged selected severity,
nonempty summary and exactly both original IDs once each. Other merged fields,
including confidence, status or assignment, are rejected. Cached and fresh
reviews use the same validation. The pair-selected identity does not override
the existing final grouping representative selection.

**The summary accompanies the immutable originals; it never replaces them.**
The host must retain the frozen originals and their provenance when publishing,
and preserve every member's evidence for larger groups. Original IDs refer to
the two assigned envelopes, not arbitrary IDs nested inside their evidence.
Publication must not treat this summary as a complete SDK Finding or change
validation, remediation or assignment state based on it.

Both formats freeze and hash complete records. Evidence mode's versioned
context binds the envelope, provenance, source, tools and settings to reviews
and prior decisions. Resume a failed attempt with the exact frozen format and
inputs, including after a durable checkpoint write loses its acknowledgement.
Current source verification still precedes checkpoint reuse.

Omitting `recordFormat`, or explicitly selecting `finding-v1`, preserves the
existing complete-Finding validation, prompts, result schema and version 3
context. It still rejects incomplete Findings. This extension does not change
saved-scan deduplication or `--findings-url`, including URL path prefixes.
