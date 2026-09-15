import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  deduplicateRecords,
  type DeduplicateEvidenceRecordsOptions,
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
    provenance: { repository: "synthetic", revision: "a".repeat(40) },
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
): DeduplicateEvidenceRecordsOptions {
  return {
    recordFormat: "evidence-v1",
    observations: records,
    candidateProvider: {
      potentialDuplicates: async (anchor) =>
        records.filter((record) => record.findingId !== anchor.findingId),
    },
    reviewRunner: { run: async (request) => review(request) },
    scopeKey: "synthetic-scope",
    sourceManifest: { repository: "synthetic", revision: "a".repeat(40) },
    verifySource: async () => {},
    concurrency: 1,
  };
}
function checkpoints() {
  const values = new Map<string, unknown>();
  const bindings = new Map<string, object>();
  return {
    values,
    bindings,
    getReview: async (key: string) => values.get(key) ?? null,
    saveReview: async (key: string, binding: object, result: unknown) => {
      values.set(key, structuredClone(result));
      bindings.set(key, structuredClone(binding));
    },
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

test("evidence registration rejects one identity with conflicting original provenance", async () => {
  const input = options();
  input.candidateProvider.potentialDuplicates = async (original) => [
    { ...original, provenance: { revision: "different" } },
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

test("evidence checkpoint recovery validates cached summaries and preserves own-pair keys", async () => {
  const store = checkpoints();
  const input = { ...options(), checkpointStore: store };
  const fresh = await deduplicateRecords(input);
  for (const binding of store.bindings.values())
    expect(binding).toMatchObject({ version: 4, recordFormat: "evidence-v1" });
  input.reviewRunner.run = async () => {
    throw new Error("Cached reviews should be reused");
  };
  expect(await deduplicateRecords(input)).toEqual(fresh);
  const pairKey = [...store.bindings].find(
    ([, binding]) =>
      (binding as { request: DeduplicationReviewRequest }).request.stage ===
      "pair-review",
  )![0];
  store.values.set(pairKey, {
    ...same([evidence(1), evidence(2)]),
    canonicalFindingId: "unassigned",
  });
  await expect(deduplicateRecords(input)).rejects.toThrow("canonical identity");
});

test("current source revocation blocks checkpoint reuse", async () => {
  const input = { ...options(), checkpointStore: checkpoints() };
  await deduplicateRecords(input);
  input.verifySource = async () => {
    throw new Error("Source permission revoked");
  };
  await expect(deduplicateRecords(input)).rejects.toThrow(
    "Source permission revoked",
  );
});

test.each(["evidence", "provenance", "source", "namespace", "settings"])(
  "changed %s invalidates evidence checkpoints and prior bindings",
  async (field) => {
    const input = { ...options(), checkpointStore: checkpoints() };
    const original = await deduplicateRecords(input);
    if (field === "evidence")
      input.observations[0]!.evidence = { updated: true };
    if (field === "provenance")
      input.observations[0]!.provenance = { revision: "b".repeat(40) };
    if (field === "source") input.sourceManifest = { revision: "b".repeat(40) };
    if (field === "namespace") input.resultToolNamespace = "synthetic_result";
    if (field === "settings") input.settingsDigest = "changed";
    const changed = await deduplicateRecords(input);
    expect(changed.checkpointKeys).not.toEqual(original.checkpointKeys);
    await expect(
      deduplicateRecords({ ...input, priorDecisions: original.pairOutcomes }),
    ).rejects.toThrow("current record/source binding");
  },
);

test("explicit finding-v1 preserves default prompts, schemas, checkpoint contexts and results", async () => {
  const records = [finding(1), finding(2)];
  const requests: DeduplicationReviewRequest[] = [];
  const input: DeduplicateRecordsOptions = {
    ...options(),
    recordFormat: "finding-v1",
    observations: records,
    candidateProvider: {
      potentialDuplicates: async (anchor) =>
        records.filter((record) => record.findingId !== anchor.findingId),
    },
    reviewRunner: {
      run: async (request) => {
        requests.push(request);
        return request.stage === "screening"
          ? review(request)
          : {
              ...same(originals(request)),
              mergedFinding: originals(request)[0],
            };
      },
    },
    checkpointStore: checkpoints(),
  };
  delete input.recordFormat;
  const implicit = await deduplicateRecords(input);
  const implicitRequests = structuredClone(requests);
  const implicitStore = input.checkpointStore as ReturnType<typeof checkpoints>;
  requests.length = 0;
  const explicitStore = checkpoints();
  const explicit = await deduplicateRecords({
    ...input,
    recordFormat: "finding-v1",
    checkpointStore: explicitStore,
  });
  expect(explicit).toEqual(implicit);
  expect(requests).toEqual(implicitRequests);
  expect(explicitStore.bindings).toEqual(implicitStore.bindings);
  for (const binding of explicitStore.bindings.values()) {
    expect(binding).toMatchObject({ version: 3 });
    expect(binding).not.toHaveProperty("recordFormat");
  }
  await expect(
    deduplicateRecords({ ...options(), priorDecisions: implicit.pairOutcomes }),
  ).rejects.toThrow("current record/source binding");
});

test("both formats use the same screening veto, pair orientation and contradiction grouping", async () => {
  const records = [finding(1), finding(2), finding(3)];
  const wrapped = records.map((record, index) => ({
    ...evidence(index + 1),
    evidence: JSON.parse(JSON.stringify(record)),
  }));
  const assignments: { finding: unknown[]; evidence: unknown[] } = {
    finding: [],
    evidence: [],
  };
  const runReview =
    (mode: "finding" | "evidence") =>
    async (request: DeduplicationReviewRequest) => {
      const assigned = originals(request);
      assignments[mode]!.push({
        stage: request.stage,
        ids: request.findingIds,
      });
      if (request.stage === "screening")
        return {
          decisions: Object.fromEntries(
            assigned.slice(1).map((candidate, index) => [
              `pair-${index + 1}`,
              {
                decision:
                  new Set([assigned[0]!.findingId, candidate.findingId]).has(
                    records[0]!.findingId,
                  ) &&
                  new Set([assigned[0]!.findingId, candidate.findingId]).has(
                    records[2]!.findingId,
                  )
                    ? "DISTINCT"
                    : "SAME",
                rationale: "Compare the exact shared correction.",
              },
            ]),
          ),
        };
      return mode === "evidence"
        ? same(assigned)
        : { ...same(assigned), mergedFinding: assigned[0] };
    };
  const full = await deduplicateRecords({
    ...options(),
    recordFormat: "finding-v1",
    observations: records,
    candidateProvider: {
      potentialDuplicates: async (anchor) =>
        records.filter((record) => record.findingId !== anchor.findingId),
    },
    reviewRunner: { run: runReview("finding") },
  });
  const adapted = await deduplicateRecords({
    ...options(wrapped),
    reviewRunner: { run: runReview("evidence") },
  });
  expect(assignments.evidence).toEqual(assignments.finding);
  const grouping = (result: typeof full) => ({
    uniqueFindingIds: result.uniqueFindingIds,
    duplicateGroups: result.duplicateGroups,
    sameComponents: result.sameComponents,
    pairs: result.pairOutcomes.map(
      ({ findingIds, decision, origin, screenings }) => ({
        findingIds,
        decision,
        origin,
        screenings,
      }),
    ),
  });
  expect(grouping(adapted)).toEqual(grouping(full));
  expect(
    adapted.pairOutcomes.filter((pair) => pair.origin === "pair-review"),
  ).toHaveLength(2);
  expect(adapted.sameComponents[0]).toHaveLength(3);
  expect(adapted.duplicateGroups[0]).toHaveLength(2);
});
