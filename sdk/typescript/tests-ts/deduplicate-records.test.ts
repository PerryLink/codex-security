import { expect, test } from "bun:test";
import {
  deduplicateRecords,
  type DeduplicateRecordsOptions,
  type DeduplicationReviewRequest,
} from "../src/index.js";
import {
  assigned,
  record,
  submission,
} from "./record-deduplication-fixtures.js";

function options(findings = [record(1), record(2)]): DeduplicateRecordsOptions {
  return {
    observations: findings,
    candidates: findings,
    candidateRelationships: findings.map((anchor) => ({
      observationId: anchor.findingId,
      candidateIds: findings
        .filter((candidate) => candidate.findingId !== anchor.findingId)
        .map((candidate) => candidate.findingId),
    })),
    reviewRunner: { run: async (request) => submission(request) },
    concurrency: 1,
  };
}
test("preloaded records use screening and independent pair review and return only groups", async () => {
  const input = options();
  const requests: DeduplicationReviewRequest[] = [];
  input.reviewRunner.run = async (request) => {
    requests.push(request);
    return submission(request);
  };
  expect(await deduplicateRecords(input)).toEqual({
    uniqueFindingIds: [input.observations[0]!.findingId],
    duplicateGroups: [input.observations.map((f) => f.findingId)],
    deduplicationStatus: "completed",
  });
  expect(
    requests.map(({ stage, model, effort }) => [stage, model, effort]),
  ).toEqual([
    ["screening", "gpt-5.6-luna", "xhigh"],
    ["screening", "gpt-5.6-luna", "xhigh"],
    ["pair-review", "gpt-5.6-sol", "high"],
  ]);
  expect(assigned(requests[2]!)[0]).toEqual(input.observations[1]!);
  expect(Object.keys(requests[0]!).sort()).toEqual(
    [
      "findingIds",
      "stage",
      "model",
      "effort",
      "prompt",
      "schema",
      "resultToolNamespace",
      "instructions",
    ].sort(),
  );
});
test("snapshots complete inputs before callbacks and ignores self or repeated nominations", async () => {
  const input = options(),
    expected = await deduplicateRecords(input);
  input.candidateRelationships = input.candidateRelationships.map(
    ({ observationId, candidateIds }) => ({
      observationId,
      candidateIds: [observationId, ...candidateIds, ...candidateIds],
    }),
  );
  let first = true;
  input.reviewRunner.run = async (request) => {
    if (first) {
      first = false;
      input.candidates[0]!.evidence = { changed: true };
      input.candidateRelationships = [];
      input.candidates = [];
    }
    return submission(request);
  };
  expect(await deduplicateRecords(input)).toEqual(expected);
});
test("empty and isolated observations do not review unrelated candidates", async () => {
  for (const records of [[], [record(1)]]) {
    const input = options(records);
    input.candidates = [...records, record(3)];
    input.reviewRunner.run = async () => {
      throw new Error("Unexpected review");
    };
    expect((await deduplicateRecords(input)).uniqueFindingIds).toEqual(
      records.map((r) => r.findingId),
    );
  }
});
test("fresh and host-replayed responses receive the same SDK semantic validation", async () => {
  const input = options(),
    cache = new Map<string, unknown>();
  let executions = 0;
  input.reviewRunner.run = async (request) => {
    const key = JSON.stringify(request);
    if (cache.has(key)) return cache.get(key);
    executions++;
    const result = submission(request);
    cache.set(key, result);
    return result;
  };
  const first = await deduplicateRecords(input);
  const count = executions;
  expect(await deduplicateRecords(input)).toEqual(first);
  expect(executions).toBe(count);
  const pair = [...cache.keys()].find(
    (key) => JSON.parse(key).stage === "pair-review",
  )!;
  cache.set(pair, {
    ...(cache.get(pair) as object),
    canonicalFindingId: "foreign",
  });
  await expect(deduplicateRecords(input)).rejects.toThrow("canonical identity");
  expect(executions).toBe(count);
});
test("a screening veto prevents pair review even if the other screening says SAME", async () => {
  const input = options();
  input.reviewRunner.run = async (request) => {
    expect(request.stage).toBe("screening");
    return submission(
      request,
      request.findingIds[0] === input.observations[0]!.findingId,
    );
  };
  expect((await deduplicateRecords(input)).duplicateGroups).toEqual([]);
});
test("un-nominated prior DISTINCT constrains a new positive bridge without added reviews", async () => {
  const [a, b, c] = [record(1), record(2), record(3)];
  const input = options([a!, b!, c!]);
  input.candidateRelationships = [
    { observationId: a!.findingId, candidateIds: [b!.findingId, c!.findingId] },
    { observationId: b!.findingId, candidateIds: [] },
    { observationId: c!.findingId, candidateIds: [] },
  ];
  input.priorDecisions = [
    { findingIds: [b!.findingId, c!.findingId], decision: "DISTINCT" },
  ];
  const reviews: DeduplicationReviewRequest[] = [];
  input.reviewRunner.run = async (request) => {
    reviews.push(request);
    return submission(request);
  };
  const result = await deduplicateRecords(input);
  expect(reviews.filter((r) => r.stage === "pair-review")).toHaveLength(2);
  expect(result.duplicateGroups).toEqual([[a!.findingId, b!.findingId]]);
  expect(result.uniqueFindingIds).toEqual([a!.findingId, c!.findingId]);
  // The host retains both positive edges, including the one excluded by subgrouping.
  expect(
    reviews.filter((r) => r.stage === "pair-review").map((r) => r.findingIds),
  ).toEqual([
    [a!.findingId, b!.findingId],
    [a!.findingId, c!.findingId],
  ]);
});
test.each(["SAME", "DISTINCT"] as const)(
  "prior %s can refer to preloaded endpoints absent from nominations",
  async (decision) => {
    const input = options([record(1)]);
    const candidate = record(2),
      unrelated = record(3);
    input.candidates = [candidate, unrelated];
    input.priorDecisions = [
      {
        findingIds: [input.observations[0]!.findingId, candidate.findingId],
        decision,
      },
    ];
    input.reviewRunner.run = async () => {
      throw new Error("Unexpected review");
    };
    const result = await deduplicateRecords(input);
    expect(result.duplicateGroups).toEqual(
      decision === "SAME"
        ? [[input.observations[0]!.findingId, candidate.findingId]]
        : [],
    );
    expect(result.uniqueFindingIds).not.toContain(unrelated.findingId);
  },
);
test.each([
  { candidates: [] },
  { candidateRelationships: [] },
  { candidateRelationships: [{ observationId: "foreign", candidateIds: [] }] },
  { candidates: [{ ...record(1), evidence: { changed: true } }] },
  {
    priorDecisions: [
      { findingIds: [record(1).findingId, "foreign"], decision: "SAME" },
    ],
  },
  {
    priorDecisions: [
      {
        findingIds: [record(1).findingId, record(1).findingId],
        decision: "SAME",
      },
    ],
  },
  {
    priorDecisions: [
      {
        findingIds: [record(1).findingId, record(2).findingId],
        decision: "SAME",
      },
      {
        findingIds: [record(2).findingId, record(1).findingId],
        decision: "DISTINCT",
      },
    ],
  },
])(
  "rejects invalid graph or conflicting prior before review: %j",
  async (change) => {
    const input = { ...options(), ...change } as DeduplicateRecordsOptions;
    let calls = 0;
    input.reviewRunner.run = async () => {
      calls++;
      throw new Error("Unexpected callback");
    };
    await expect(deduplicateRecords(input)).rejects.toThrow();
    expect(calls).toBe(0);
  },
);
test.each([
  {},
  { decisions: {} },
  { decisions: { "pair-1": { decision: "SAME", rationale: " " } } },
])("invalid or incomplete results fail without groups: %j", async (result) => {
  const input = options();
  input.reviewRunner.run = async () => result;
  await expect(deduplicateRecords(input)).rejects.toThrow();
});
test("namespace consistently identifies result tools without source registration", async () => {
  const input = options();
  input.resultToolNamespace = "mcp__synthetic_result";
  input.reviewRunner.run = async (request) => {
    expect(request.resultToolNamespace).toBe(input.resultToolNamespace!);
    expect(request.prompt).not.toContain("review_validator.");
    expect(request.instructions.submission).toContain(
      "mcp__synthetic_result.submit_decisions",
    );
    expect(request.instructions.submission).toContain(
      "mcp__synthetic_result.submit_error",
    );
    expect(request.instructions.source).toContain("supplied by the host");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.findingIds)).toBe(true);
    return submission(request);
  };
  await deduplicateRecords(input);
  input.resultToolNamespace = "a.b";
  await expect(deduplicateRecords(input)).rejects.toThrow("single identifier");
});
test("host persistence failure blocks completion and caller can retry from saved replies", async () => {
  const input = options(),
    saved = new Map<string, unknown>();
  let fail = true,
    calls = 0;
  input.reviewRunner.run = async (request) => {
    calls++;
    const key = JSON.stringify(request);
    const result = saved.get(key) ?? submission(request);
    saved.set(key, result);
    if (fail) {
      fail = false;
      throw new Error("Lost durable acknowledgement");
    }
    return result;
  };
  await expect(deduplicateRecords(input)).rejects.toThrow(
    "Lost durable acknowledgement",
  );
  expect((await deduplicateRecords(input)).deduplicationStatus).toBe(
    "completed",
  );
  expect(saved.size).toBe(3);
  expect(calls).toBe(4);
});
test("cancellation drains an active host callback before rejecting without scheduling pair review", async () => {
  const controller = new AbortController(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const input = options();
  input.signal = controller.signal;
  let settled = false,
    calls = 0;
  input.reviewRunner.run = async (request) => {
    calls++;
    entered.resolve();
    await release.promise;
    return submission(request);
  };
  const pending = deduplicateRecords(input).finally(() => {
    settled = true;
  });
  await entered.promise;
  controller.abort("cancelled");
  await Promise.resolve();
  expect(settled).toBe(false);
  release.resolve();
  await expect(pending).rejects.toBe("cancelled");
  expect(calls).toBe(1);
});
