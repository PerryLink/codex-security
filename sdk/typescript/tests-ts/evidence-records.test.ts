import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  deduplicateRecords,
  type DeduplicateRecordsOptions,
  type DeduplicationReviewRequest,
  type EvidenceRecord,
  type Finding,
  type FindingsDocument,
} from "../src/index.js";
import {
  requireEvidenceRecord,
  validateEvidenceReview,
} from "../src/deduplication/record-evidence.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

const fixture: FindingsDocument = JSON.parse(
  await readFile(
    join(PLUGIN_ROOT, "examples/completed-scan/findings.json"),
    "utf8",
  ),
);
function finding(index: number): Finding {
  return {
    ...structuredClone(fixture.findings[0]!),
    findingId: `csf_${index.toString(16).padStart(24, "0")}`,
    severity: { level: index === 1 ? "high" : "medium" },
  };
}
function evidence(index: number): EvidenceRecord {
  return {
    findingId: finding(index).findingId,
    severity: finding(index).severity,
    evidence: {
      description: `Synthetic original ${index}`,
      relevant_lines: null,
      detail: { originalLabels: ["one", "two"], observed: true },
    },
  };
}
function originals(request: DeduplicationReviewRequest): EvidenceRecord[] {
  return JSON.parse(
    request.prompt.slice(request.prompt.lastIndexOf("\n\n") + 2),
  ).findings;
}
function same(records: readonly EvidenceRecord[]) {
  return {
    decision: "SAME" as const,
    rationale: "One shared security correction closes both paths.",
    canonicalFindingId: records[0]!.findingId,
    mergedFinding: {
      findingId: records[0]!.findingId,
      severity: records[0]!.severity,
      summary:
        "Both original paths share the same correction; missing source details remain uncertain.",
      originalFindingIds: [records[0]!.findingId, records[1]!.findingId] as [
        string,
        string,
      ],
    },
  };
}
function review(request: DeduplicationReviewRequest): unknown {
  const records = originals(request);
  return request.stage === "screening"
    ? {
        decisions: Object.fromEntries(
          records.slice(1).map((_, index) => [
            `pair-${index + 1}`,
            {
              decision: "SAME",
              rationale: "One correction may cover both paths.",
            },
          ]),
        ),
      }
    : same(records);
}
function options(
  records = [evidence(1), evidence(2)],
): DeduplicateRecordsOptions {
  return {
    observations: records,
    candidates: records,
    candidateRelationships: records.map((record) => ({
      observationId: record.findingId,
      candidateIds: records
        .filter((candidate) => candidate.findingId !== record.findingId)
        .map((candidate) => candidate.findingId),
    })),
    reviewRunner: { run: async (request) => review(request) },
    concurrency: 1,
  };
}
test("evidence mode preserves missing fields and complete mixed-producer originals", async () => {
  const imported = evidence(1);
  imported.findingId = "imported-issue";
  const complete = evidence(2);
  complete.evidence = JSON.parse(JSON.stringify(finding(2)));
  const input = options([imported, complete]);
  const before = structuredClone(input.observations);
  const requests: DeduplicationReviewRequest[] = [];
  input.reviewRunner.run = async (request) => {
    requests.push(request);
    return review(request);
  };
  const result = await deduplicateRecords(input);
  expect(result.duplicateGroups).toEqual([
    [imported.findingId, complete.findingId],
  ]);
  expect(input.observations).toEqual(before);
  for (const request of requests)
    for (const original of originals(request)) {
      expect(original).toEqual(
        before.find((record) => record.findingId === original.findingId)!,
      );
      if (original.findingId === imported.findingId) {
        expect(original.evidence).not.toHaveProperty("confidence");
        expect(original.evidence).not.toHaveProperty("remediation");
        expect(original.evidence).not.toHaveProperty("locations");
        expect(original.evidence["relevant_lines"]).toBeNull();
      }
    }
});

test.each([
  { severity: { level: "unknown" } },
  { evidence: { confidence: undefined } },
  { confidence: { level: "high" } },
])(
  "rejects invalid evidence envelopes without fabricating fields: %j",
  (change) => {
    expect(() =>
      requireEvidenceRecord({ ...evidence(1), ...change }),
    ).toThrow();
  },
);

test("evidence registration rejects one identity with conflicting original evidence", async () => {
  const input = options();
  input.candidates = [
    { ...input.observations[0]!, evidence: { revision: "different" } },
  ];
  await expect(deduplicateRecords(input)).rejects.toThrow(
    "Conflicting finding content",
  );
});

test.each([
  (value: ReturnType<typeof same>) => {
    value.canonicalFindingId = "unassigned";
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.findingId = "unassigned";
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.severity = { level: "low" };
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.originalFindingIds.pop();
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.originalFindingIds[1] =
      value.mergedFinding.originalFindingIds[0]!;
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.originalFindingIds[1] = "unassigned";
  },
  (value: ReturnType<typeof same>) => {
    value.mergedFinding.summary = " ";
  },
  (value: ReturnType<typeof same>) => {
    Object.assign(value.mergedFinding, { status: "validated" });
  },
  (value: ReturnType<typeof same>) => {
    Object.assign(value.mergedFinding, { confidence: "high" });
  },
])(
  "validates SAME identity, observed severity, complete originals and summary",
  (mutate) => {
    const records = [evidence(1), evidence(2)];
    const value = same(records);
    mutate(value);
    expect(() => validateEvidenceReview(value, records)).toThrow();
  },
);

test("accepts either original-ID order and retains selected observed severity", () => {
  const records = [evidence(1), evidence(2)];
  const value = same(records);
  value.mergedFinding.originalFindingIds.reverse();
  expect(validateEvidenceReview(value, records)).toEqual(value);
  expect(
    validateEvidenceReview(
      { decision: "DISTINCT", rationale: "Different corrections." },
      records,
    ).decision,
  ).toBe("DISTINCT");
});
