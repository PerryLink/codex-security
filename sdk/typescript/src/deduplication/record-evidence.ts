import { z } from "zod";
import type { CodexReviewRunner } from "./codex-review.js";
import {
  DEFAULT_RESULT_TOOL_NAMESPACE,
  evidencePairReviewPrompt,
  evidenceScreeningPrompt,
} from "./deduplication-prompts.js";
import {
  screeningToolSchema,
  validateScreening,
  type DeduplicationReviewer,
  type ScreeningResult,
} from "./deduplication-reviewer.js";

const severity = z.strictObject({
  level: z.enum(["critical", "high", "medium", "low", "informational"]),
});
const identity = z.string().min(1);
const substantive = z.string().refine((value) => value.trim().length > 0);
const evidenceRecordSchema = z.strictObject({
  findingId: identity,
  severity,
  evidence: z.record(z.string(), z.json()),
  provenance: z.record(z.string(), z.json()),
});

/** Original producer evidence is preserved without filling missing Finding fields. */
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;

/** A generated summary accompanies immutable originals; it does not replace them. */
const mergedEvidenceSchema = z.strictObject({
  findingId: identity,
  severity,
  summary: substantive,
  originalFindingIds: z.tuple([identity, identity]),
});
export type MergedEvidenceSummary = z.infer<typeof mergedEvidenceSchema>;

const evidenceReviewSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("SAME"),
    rationale: substantive,
    canonicalFindingId: identity,
    mergedFinding: mergedEvidenceSchema,
  }),
  z.strictObject({
    decision: z.literal("DISTINCT"),
    rationale: substantive,
    canonicalFindingId: z.null().optional(),
    mergedFinding: z.null().optional(),
  }),
]);
export type EvidenceDuplicateDecision = z.infer<typeof evidenceReviewSchema>;

/** @internal */
export function requireEvidenceRecord(
  value: unknown,
): asserts value is EvidenceRecord {
  evidenceRecordSchema.parse(value);
}

/** @internal */
export function validateEvidenceReview(
  value: unknown,
  findings: readonly EvidenceRecord[],
): EvidenceDuplicateDecision {
  const result = evidenceReviewSchema.parse(value);
  if (result.decision === "DISTINCT") return result;
  const original = findings.find(
    (finding) => finding.findingId === result.canonicalFindingId,
  );
  const merged = result.mergedFinding;
  if (
    !original ||
    merged.findingId !== original.findingId ||
    merged.severity.level !== original.severity.level
  )
    throw new Error(
      "Merged evidence must preserve an assigned canonical identity and its observed severity.",
    );
  const ids = new Set(merged.originalFindingIds);
  if (
    findings.length !== 2 ||
    ids.size !== 2 ||
    findings.some((finding) => !ids.has(finding.findingId))
  )
    throw new Error(
      "Merged evidence must reference exactly both assigned originals once each.",
    );
  return result;
}

/** @internal */
export class EvidenceDeduplicationReviewer implements DeduplicationReviewer<EvidenceRecord> {
  constructor(
    private readonly runner: Pick<CodexReviewRunner, "run">,
    private readonly resultToolNamespace = DEFAULT_RESULT_TOOL_NAMESPACE,
  ) {}

  async screen(findings: readonly EvidenceRecord[]): Promise<ScreeningResult> {
    return await this.runner.run({
      findingIds: findings.map((finding) => finding.findingId),
      stage: "screening",
      model: "gpt-5.6-luna",
      effort: "xhigh",
      prompt: evidenceScreeningPrompt(findings, this.resultToolNamespace),
      schema: screeningToolSchema(findings.length - 1),
      validate: (value) => validateScreening(value, findings),
    });
  }

  async reviewPair(
    findings: readonly EvidenceRecord[],
  ): Promise<EvidenceDuplicateDecision> {
    return await this.runner.run({
      findingIds: findings.map((finding) => finding.findingId),
      stage: "pair-review",
      model: "gpt-5.6-sol",
      effort: "high",
      prompt: evidencePairReviewPrompt(findings, this.resultToolNamespace),
      schema: {
        type: "object",
        ...z.toJSONSchema(evidenceReviewSchema, { target: "openapi-3.0" }),
      },
      validate: (value) => validateEvidenceReview(value, findings),
    });
  }
}
