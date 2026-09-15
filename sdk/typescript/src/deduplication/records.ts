import { isDeepStrictEqual } from "node:util";
import {
  CodexSecurityError,
  type DeduplicationReviewStage,
} from "../errors.js";
import type { CodexReview } from "./codex-review.js";
import {
  FindingDeduplicator,
  deduplicationConcurrency,
  type DeduplicationResult,
  type DeduplicationPairConstraint,
} from "./deduplication.js";
import {
  EvidenceDeduplicationReviewer,
  requireEvidenceRecord,
  type EvidenceRecord,
} from "./record-evidence.js";
import {
  DEFAULT_RESULT_TOOL_NAMESPACE,
  reviewSubmissionInstructionsFor,
  reviewErrorInstructions,
  recordSourceReviewInstructions,
} from "./deduplication-prompts.js";

/** SDK-authored assignment; the host supplies execution, tools and persistence. */
export interface DeduplicationReviewRequest {
  findingIds: readonly string[];
  stage: DeduplicationReviewStage;
  model: string;
  effort: string;
  prompt: string;
  schema: unknown;
  resultToolNamespace: string;
  instructions: { submission: string; source: string; error: string };
}
export interface DeduplicationReviewRunner {
  run(
    request: DeduplicationReviewRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
/** Caller-admitted constraints for the supplied current records. */
export type PriorDeduplicationDecision = DeduplicationPairConstraint;
export interface DeduplicateRecordsOptions {
  observations: readonly EvidenceRecord[];
  candidates: readonly EvidenceRecord[];
  candidateRelationships: readonly {
    observationId: string;
    candidateIds: readonly string[];
  }[];
  reviewRunner: DeduplicationReviewRunner;
  priorDecisions?: readonly PriorDeduplicationDecision[];
  resultToolNamespace?: string;
  concurrency?: number;
  signal?: AbortSignal;
}
export type DeduplicateRecordsResult = DeduplicationResult;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Deduplicate preloaded records using the same engine as saved-scan deduplication. */
export async function deduplicateRecords(
  options: DeduplicateRecordsOptions,
): Promise<DeduplicateRecordsResult> {
  options.signal?.throwIfAborted();
  const concurrency = deduplicationConcurrency(options.concurrency);
  const resultToolNamespace =
    options.resultToolNamespace ?? DEFAULT_RESULT_TOOL_NAMESPACE;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(resultToolNamespace))
    throw new CodexSecurityError(
      "The result tool namespace must be a single identifier.",
    );
  const records = new Map<string, EvidenceRecord>();
  function register(input: EvidenceRecord): EvidenceRecord {
    requireEvidenceRecord(input);
    const finding = freeze(structuredClone(input));
    const existing = records.get(finding.findingId);
    if (existing && !isDeepStrictEqual(existing, finding))
      throw new CodexSecurityError(
        "Conflicting finding content for one deduplication identity.",
      );
    if (!existing) records.set(finding.findingId, finding);
    return existing ?? finding;
  }
  const observations = new Set(
    options.observations.map(register).map(({ findingId }) => findingId),
  );
  const candidates = new Map(
    options.candidates
      .map(register)
      .map((finding) => [finding.findingId, finding]),
  );
  const neighborhoods = new Map<string, EvidenceRecord[]>();
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
    neighbors.delete(records.get(observationId)!);
    neighborhoods.set(observationId, [...neighbors]);
  }
  if (neighborhoods.size !== observations.size)
    throw new CodexSecurityError(
      "Candidate relationships must name each observation once.",
    );
  const priorDecisions = freeze(
    (options.priorDecisions ?? []).map(({ findingIds, decision }) => {
      if (
        findingIds.length !== 2 ||
        !["SAME", "DISTINCT"].includes(decision) ||
        findingIds.some((id) => !records.has(id))
      )
        throw new CodexSecurityError(
          "Prior decisions require two current records and a SAME or DISTINCT decision.",
        );
      return { findingIds: [...findingIds] as [string, string], decision };
    }),
  );
  const reviewRunner = options.reviewRunner;
  const signal = options.signal;
  const runner = {
    async run<T>(review: CodexReview<T>): Promise<T> {
      signal?.throwIfAborted();
      if (!review.findingIds)
        throw new CodexSecurityError(
          "Record review is missing its SDK assignment.",
        );
      const request = freeze({
        findingIds: [...review.findingIds],
        stage: review.stage,
        model: review.model,
        effort: review.effort,
        prompt: review.prompt,
        schema: structuredClone(review.schema),
        resultToolNamespace,
        instructions: {
          submission: reviewSubmissionInstructionsFor(resultToolNamespace),
          source: recordSourceReviewInstructions,
          error: reviewErrorInstructions,
        },
      });
      const result = await reviewRunner.run(request, signal);
      signal?.throwIfAborted();
      return review.validate(result);
    },
  };
  const core = new FindingDeduplicator(
    {
      async potentialDuplicates(id) {
        return {
          finding: records.get(id)!,
          potentialDuplicates: neighborhoods.get(id)!,
        };
      },
    },
    new EvidenceDeduplicationReviewer(runner, resultToolNamespace),
    signal,
    concurrency,
  );
  const priorIds = new Set(
    priorDecisions.flatMap((prior) => [...prior.findingIds]),
  );
  const { uniqueFindingIds, duplicateGroups, deduplicationStatus } =
    await core.runDetailed(
      [...observations],
      priorDecisions,
      false,
      [...records.values()].filter((finding) =>
        priorIds.has(finding.findingId),
      ),
    );
  return { uniqueFindingIds, duplicateGroups, deduplicationStatus };
}
