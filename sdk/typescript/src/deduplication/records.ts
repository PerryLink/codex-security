import type { JsonObject } from "../config.js";
import {
  CodexSecurityError,
  type DeduplicationReviewStage,
} from "../errors.js";
import type { Finding } from "../models.js";
import { workflowDigest } from "../finding-workflow.js";
import { VERSION } from "../version.js";
import type { CodexReview, CodexReviewRunner } from "./codex-review.js";
import type { DeduplicationIdentity } from "./record-types.js";
import {
  EvidenceDeduplicationReviewer,
  requireEvidenceRecord,
  type EvidenceRecord,
} from "./record-evidence.js";
import {
  FindingDeduplicator,
  deduplicationConcurrency,
  type DetailedDeduplicationResult,
  type DeduplicationPairOutcome,
} from "./deduplication.js";
import {
  CodexDeduplicationReviewer,
  requireFinding,
  type DeduplicationReviewer,
  pairKey,
} from "./deduplication-reviewer.js";
import {
  DEFAULT_RESULT_TOOL_NAMESPACE,
  reviewSubmissionInstructionsFor,
  reviewErrorInstructions,
  sourceReviewInstructions,
} from "./deduplication-prompts.js";
import {
  runCheckpointedReview,
  type DeduplicationCheckpointStore,
} from "./review-checkpoint.js";

export type { DeduplicationCheckpointStore } from "./review-checkpoint.js";

/** Source operations explicitly registered and executed by the injected host. */
export interface DeduplicationSourceTool {
  namespace: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
  /** Changes when implementation semantics or permissions change. */
  version: string;
}

/** Serializable model assignment; the SDK retains all result validation. */
export interface DeduplicationReviewRequest {
  /** Exact SDK assignment in prompt order; screening anchor is first. */
  findingIds: readonly string[];
  checkpointKey: string;
  /** Model-visible namespace for submit_decisions and submit_error. */
  resultToolNamespace: string;
  stage: DeduplicationReviewStage;
  model: string;
  effort: string;
  prompt: string;
  schema: unknown;
  instructions: {
    submission: string;
    source: string;
    error: string;
  };
  sourceManifest: JsonObject;
  sourceTools: readonly DeduplicationSourceTool[];
}

export interface DeduplicationReviewRunner {
  /**
   * Register the request's result and source tools in the reviewing runtime.
   * Return the complete raw submission, or throw when required execution/source
   * access fails. A blocker must not be converted into a DISTINCT verdict.
   */
  run(
    request: DeduplicationReviewRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Reuse an earlier pair outcome only with its original immutable-input binding. */
export interface PriorDeduplicationDecision {
  findingIds: readonly [string, string];
  decision: "SAME" | "DISTINCT";
  bindingDigest: string;
}

interface RecordOptions<TRecord extends DeduplicationIdentity> {
  observations: readonly TRecord[];
  candidates: readonly TRecord[];
  candidateRelationships: readonly {
    observationId: string;
    candidateIds: readonly string[];
  }[];
  reviewRunner: DeduplicationReviewRunner;
  /** Host-established repository identities and exact revisions, without credentials. */
  sourceManifest: JsonObject;
  sourceTools?: readonly DeduplicationSourceTool[];
  /** Verify current source availability/binding, including before checkpoint reuse. */
  verifySource(manifest: JsonObject): Promise<void>;
  /** Isolate review checkpoints and prior decisions belonging to separate corpora. */
  scopeKey: string;
  settingsDigest?: string;
  /** Model-visible result-tool namespace; defaults to review_validator. */
  resultToolNamespace?: string;
  checkpointStore?: DeduplicationCheckpointStore;
  priorDecisions?: readonly PriorDeduplicationDecision[];
  /** Defaults to the existing SDK dedupe concurrency (8). */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface DeduplicateRecordsOptions extends RecordOptions<Finding> {
  recordFormat?: "finding-v1";
}

export interface DeduplicateEvidenceRecordsOptions extends RecordOptions<EvidenceRecord> {
  recordFormat: "evidence-v1";
}

export interface BoundDeduplicationPairOutcome extends DeduplicationPairOutcome {
  /** Acknowledged reviews explaining this pair; prior-only outcomes have none. */
  checkpointKeys: string[];
  bindingDigest: string;
}

export interface DeduplicateRecordsResult extends DetailedDeduplicationResult {
  pairOutcomes: BoundDeduplicationPairOutcome[];
  checkpointKeys: string[];
}

// Changes to record review semantics invalidate saved host review bindings.
const RECORD_REVIEW_CONTRACT_VERSION = 3;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Review normalized records with host-owned retrieval, source access and storage.
 * This never loads scan artifacts, spawns a model runtime, or publishes groups.
 */
export function deduplicateRecords(
  options: DeduplicateRecordsOptions,
): Promise<DeduplicateRecordsResult>;
export function deduplicateRecords(
  options: DeduplicateEvidenceRecordsOptions,
): Promise<DeduplicateRecordsResult>;
export async function deduplicateRecords(
  options: DeduplicateRecordsOptions | DeduplicateEvidenceRecordsOptions,
): Promise<DeduplicateRecordsResult> {
  if (options.recordFormat === "evidence-v1")
    return await runRecords(
      options,
      requireEvidenceRecord,
      (runner, namespace) =>
        new EvidenceDeduplicationReviewer(runner, namespace),
      { version: 4, recordFormat: "evidence-v1" },
    );
  if (
    options.recordFormat !== undefined &&
    options.recordFormat !== "finding-v1"
  )
    throw new CodexSecurityError("Unsupported deduplication record format.");
  return await runRecords(
    options,
    requireFinding,
    (runner, namespace) => new CodexDeduplicationReviewer(runner, namespace),
    { version: RECORD_REVIEW_CONTRACT_VERSION },
  );
}

async function runRecords<TRecord extends DeduplicationIdentity>(
  options: RecordOptions<TRecord>,
  requireRecord: (value: unknown) => asserts value is TRecord,
  reviewer: (
    runner: Pick<CodexReviewRunner, "run">,
    namespace: string,
  ) => DeduplicationReviewer<TRecord>,
  contract: { version: number; recordFormat?: "evidence-v1" },
): Promise<DeduplicateRecordsResult> {
  options.signal?.throwIfAborted();
  const concurrency = deduplicationConcurrency(options.concurrency);
  if (!options.scopeKey.trim())
    throw new CodexSecurityError(
      "A record deduplication scopeKey is required.",
    );

  const resultToolNamespace =
    options.resultToolNamespace ?? DEFAULT_RESULT_TOOL_NAMESPACE;
  if (
    typeof resultToolNamespace !== "string" ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(resultToolNamespace)
  )
    throw new CodexSecurityError(
      "The result tool namespace must be a single identifier.",
    );

  const sourceManifest = freeze(structuredClone(options.sourceManifest));
  const sourceTools = freeze(structuredClone(options.sourceTools ?? []));
  const toolNames = new Set<string>();
  for (const tool of sourceTools) {
    const key = JSON.stringify([tool.namespace, tool.name]);
    if (
      ((tool.namespace === DEFAULT_RESULT_TOOL_NAMESPACE ||
        tool.namespace === resultToolNamespace) &&
        (tool.name === "submit_decisions" || tool.name === "submit_error")) ||
      toolNames.has(key)
    )
      throw new CodexSecurityError(
        "Source tools must have distinct names and cannot replace reserved result tools.",
      );
    toolNames.add(key);
  }
  const priorDecisions = freeze(
    (options.priorDecisions ?? []).map(
      ({ findingIds, decision, bindingDigest }) => ({
        findingIds: structuredClone(findingIds),
        decision,
        bindingDigest,
      }),
    ),
  );
  const context = freeze({
    ...contract,
    sdkVersion: VERSION,
    scopeKey: options.scopeKey,
    settingsDigest: options.settingsDigest,
    resultToolNamespace,
    sourceManifest,
    sourceTools,
  });
  // A finding ID cannot silently acquire another record's evidence in the union
  // of neighborhoods. Snapshot the complete batch before any host callback.
  const records = new Map<string, { finding: TRecord; digest: string }>();
  function register(input: TRecord): TRecord {
    requireRecord(input);
    const finding = freeze(structuredClone(input));
    const digest = workflowDigest(finding);
    const existing = records.get(finding.findingId);
    if (existing && existing.digest !== digest)
      throw new CodexSecurityError(
        "Conflicting finding content for one deduplication identity.",
      );
    if (!existing) records.set(finding.findingId, { finding, digest });
    return existing?.finding ?? finding;
  }
  const observations = new Set(
    options.observations.map(register).map(({ findingId }) => findingId),
  );
  const candidates = new Map(
    options.candidates
      .map(register)
      .map((finding) => [finding.findingId, finding]),
  );
  const neighborhoods = new Map<string, TRecord[]>();
  for (const {
    observationId,
    candidateIds,
  } of options.candidateRelationships) {
    if (!observations.has(observationId) || neighborhoods.has(observationId))
      throw new CodexSecurityError(
        "Candidate relationships must name each observation once.",
      );
    const neighbors = new Set(
      candidateIds.map((id) => {
        const candidate = candidates.get(id);
        if (!candidate)
          throw new CodexSecurityError(
            "Candidate relationship names a missing candidate record.",
          );
        return candidate;
      }),
    );
    neighbors.delete(records.get(observationId)!.finding);
    neighborhoods.set(observationId, [...neighbors]);
  }
  if (neighborhoods.size !== observations.size)
    throw new CodexSecurityError(
      "Candidate relationships must name each observation once.",
    );
  const assertSourceUnchanged = async () => {
    options.signal?.throwIfAborted();
    await options.verifySource(sourceManifest);
    options.signal?.throwIfAborted();
  };
  await assertSourceUnchanged();

  function pairBinding(findingIds: readonly [string, string]): string {
    return workflowDigest({
      ...context,
      findings: [...findingIds].sort().map((id) => {
        const record = records.get(id);
        if (!record)
          throw new CodexSecurityError(
            "Prior decision refers to a finding outside the current corpus.",
          );
        return { id, digest: record.digest };
      }),
    });
  }
  const checkpointKeys = new Set<string>();
  const pairCheckpointKeys = new Map<string, Set<string>>();
  const runner = {
    async run<T>(review: CodexReview<T>): Promise<T> {
      await assertSourceUnchanged();
      if (!review.findingIds)
        throw new CodexSecurityError(
          "Record review is missing its SDK assignment.",
        );
      const request = {
        findingIds: [...review.findingIds],
        resultToolNamespace,
        stage: review.stage,
        model: review.model,
        effort: review.effort,
        prompt: review.prompt,
        schema: review.schema,
        instructions: {
          submission: reviewSubmissionInstructionsFor(resultToolNamespace),
          source: sourceReviewInstructions,
          error: reviewErrorInstructions,
        },
        sourceManifest,
        sourceTools,
      };
      const binding = freeze({ ...context, request, priorDecisions });
      const key = workflowDigest(binding);
      const result = await runCheckpointedReview({
        review,
        binding,
        store: options.checkpointStore,
        run: () =>
          options.reviewRunner.run(
            freeze({ ...request, checkpointKey: key }),
            options.signal,
          ),
        assertSourceUnchanged,
      });
      if (options.checkpointStore) {
        checkpointKeys.add(key);
        const [anchor, ...neighbors] = request.findingIds;
        for (const neighbor of neighbors) {
          const pair = pairKey([anchor!, neighbor]);
          const keys = pairCheckpointKeys.get(pair) ?? new Set<string>();
          keys.add(key);
          pairCheckpointKeys.set(pair, keys);
        }
      }
      return result;
    },
  };
  const core = new FindingDeduplicator(
    {
      async potentialDuplicates(id) {
        return {
          finding: records.get(id)!.finding,
          potentialDuplicates: neighborhoods.get(id)!,
        };
      },
    },
    reviewer(runner, resultToolNamespace),
    options.signal,
    concurrency,
  );
  for (const prior of priorDecisions) {
    if (
      prior.findingIds.length !== 2 ||
      !["SAME", "DISTINCT"].includes(prior.decision)
    )
      throw new CodexSecurityError(
        "Prior decisions require one assigned pair and a SAME or DISTINCT decision.",
      );
    if (prior.bindingDigest !== pairBinding(prior.findingIds))
      throw new CodexSecurityError(
        "Prior decision does not match the current record/source binding.",
      );
  }
  const priorIds = new Set(priorDecisions.flatMap((prior) => prior.findingIds));
  const priorFindings = [...records.values()]
    .filter(({ finding }) => priorIds.has(finding.findingId))
    .map(({ finding }) => finding);
  const result = await core.runDetailed(
    [...observations],
    priorDecisions,
    true,
    priorFindings,
  );
  await assertSourceUnchanged();
  return {
    ...result,
    pairOutcomes: result.pairOutcomes.map((outcome) => ({
      ...outcome,
      bindingDigest: pairBinding(outcome.findingIds),
      checkpointKeys:
        outcome.origin === "prior"
          ? []
          : [
              ...(pairCheckpointKeys.get(pairKey(outcome.findingIds)) ?? []),
            ].sort(),
    })),
    checkpointKeys: [...checkpointKeys].sort(),
  };
}
