import { randomUUID } from "node:crypto";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as timers from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ScanOptions } from "../src/api.js";
import { estimateScanCost } from "../src/cost.js";
import type { JsonObject as WorkbenchJsonObject } from "../src/config.js";
import {
  runDeepScans,
  DEEP_SCAN_CHECKPOINT,
  type DeepScanCheckpoint,
  type DeepScanComposition,
} from "../src/deep-scan.js";
import { ScanResult } from "../src/result.js";
import { ScanTransportClosedError } from "../src/scan-execution.js";
import {
  scanFindingIdentity,
  type JsonObject,
  type SemanticScan,
} from "../src/scan-semantics.js";
import type {
  ScanManifest,
  FindingsDocument,
  CoverageDocument,
} from "../src/models.js";

const pluginRoot = fileURLToPath(
  new URL("../../../plugins/codex-security/", import.meta.url),
);
const example = join(pluginRoot, "examples/completed-scan");
const roots: string[] = [];
let exampleManifest: ScanManifest;
let exampleFindings: FindingsDocument;
let exampleCoverage: CoverageDocument;
let retryDelay:
  ReturnType<typeof spyOn<typeof timers, "setTimeout">> | undefined;

beforeAll(async () => {
  [exampleManifest, exampleFindings, exampleCoverage] = await Promise.all(
    ["scan-manifest.json", "findings.json", "coverage.json"].map(async (file) =>
      JSON.parse(await readFile(join(example, file), "utf8")),
    ),
  );
});

afterEach(async () => {
  retryDelay?.mockRestore();
  retryDelay = undefined;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function result(
  scanId: string,
  scanDir: string,
  identity?: string,
): ScanResult {
  const manifest = structuredClone(exampleManifest);
  manifest.scan.id = scanId;
  const findings = structuredClone(exampleFindings);
  findings.scanId = scanId;
  if (identity === undefined) findings.findings = [];
  else findings.findings[0]!.identity = { anchor: identity };
  const coverage = structuredClone(exampleCoverage);
  coverage.scanId = scanId;
  coverage.surfaces = [];
  return new ScanResult({
    manifest,
    findings,
    coverage,
    scanDir,
    threadId: `thread-${scanId}`,
    turnResult: {},
  });
}

interface SavedRecord {
  scanId: string;
  scanDir: string;
  parentScanId: string;
  targetPath: string;
  progress: { status: string };
}

async function harness(
  settings: Partial<DeepScanComposition["settings"]> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "deep-scan-composition-"));
  roots.push(root);
  const scanDir = join(root, "parent");
  const repository = join(root, "repository");
  await mkdir(scanDir, { mode: 0o700 });
  await mkdir(repository);
  const controller = new AbortController();
  const scanId = randomUUID();
  const records = new Map<string, SavedRecord>();
  const calls: ScanOptions[] = [];
  const published: SemanticScan[] = [];
  const checkpoints: DeepScanCheckpoint[] = [];
  const mergeInputs: number[] = [];
  let closed = 0;
  let active = 0;
  let maximumActive = 0;
  let run = async (options: ScanOptions): Promise<ScanResult> =>
    result(options.resumeScanId ?? randomUUID(), options.outputDir!);
  const input: DeepScanComposition = {
    scanId,
    scanDir,
    repository,
    pluginRoot,
    startedAt: new Date().toISOString(),
    settings: {
      workers: 1,
      subagents: 3,
      stopAfterNoNew: 4,
      stopAfterConsecutiveErrors: 3,
      maxDiscoveryRuns: 8,
      maxTimeHours: 1,
      ...settings,
    },
    scanOptions: {},
    signal: controller.signal,
    createClient: () => ({
      async run(_repository, options = {}) {
        calls.push(options);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const id = options.resumeScanId ?? randomUUID();
        records.set(id, {
          scanId: id,
          scanDir: options.outputDir!,
          parentScanId: scanId,
          targetPath: repository,
          progress: { status: "running" },
        });
        await mkdir(options.outputDir!, { recursive: true, mode: 0o700 });
        await options.onRegisteredScan?.({
          scanId: id,
          scanDir: options.outputDir!,
        });
        try {
          const completed = await run({ ...options, resumeScanId: id });
          records.get(id)!.progress.status = "complete";
          return completed;
        } finally {
          active -= 1;
        }
      },
      async close() {
        closed += 1;
      },
    }),
    async workbench(args, contents) {
      if (args[0] === "save-scan-artifact") {
        const state = JSON.parse(contents!) as DeepScanCheckpoint;
        checkpoints.push(state);
        const path = join(scanDir, DEEP_SCAN_CHECKPOINT);
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents!);
        await rename(temporary, path);
        return {};
      }
      if (args[0] === "list-scans")
        return {
          scans: [...records.values()],
        } as unknown as WorkbenchJsonObject;
      if (args[0] === "get-scan")
        return { scan: { progress: { status: "running" } } };
      if (args[0] === "fail-scan") {
        records.get(args[2]!)!.progress.status = "failed";
        return {};
      }
      throw new Error(`Unexpected workbench operation ${args[0]}`);
    },
    async merge(prompt) {
      const payload = JSON.parse(prompt.slice(prompt.indexOf('{"scans":'))) as {
        scans: SemanticScan[];
        previous: SemanticScan | null;
      };
      mergeInputs.push(payload.scans.length);
      const findings = structuredClone(payload.previous?.findings ?? []);
      for (const source of payload.scans.flatMap((scan) => scan.findings)) {
        const existing = findings.find(
          (finding) =>
            scanFindingIdentity(finding) === scanFindingIdentity(source),
        );
        if (!existing) findings.push(source);
        else
          (existing["provenance"] as JsonObject)["sourceFindingIds"] = [
            ...((existing["provenance"] as JsonObject)[
              "sourceFindingIds"
            ] as string[]),
            ...((source["provenance"] as JsonObject)[
              "sourceFindingIds"
            ] as string[]),
          ];
      }
      return { scanId, findings };
    },
    writer: {
      async restore(path, contents) {
        await mkdir(dirname(join(scanDir, path)), { recursive: true });
        await writeFile(join(scanDir, path), contents);
      },
    },
    async publish(draft) {
      published.push(structuredClone(draft));
    },
    onCost() {},
  };
  return {
    input,
    records,
    calls,
    published,
    checkpoints,
    mergeInputs,
    controller,
    setRun(value: typeof run) {
      run = value;
    },
    metrics: () => ({ closed, maximumActive }),
    checkpoint: async () =>
      JSON.parse(
        await readFile(join(scanDir, DEEP_SCAN_CHECKPOINT), "utf8"),
      ) as DeepScanCheckpoint,
    async seed(state: DeepScanCheckpoint) {
      const path = join(scanDir, DEEP_SCAN_CHECKPOINT);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(state));
    },
  };
}

describe("ordinary scan composition", () => {
  test("runs fixed bounded batches and counts every successfully merged clean input", async () => {
    const h = await harness({ workers: 2, stopAfterNoNew: 4 });
    await runDeepScans(h.input);
    const state = await h.checkpoint();
    expect(h.calls).toHaveLength(4);
    expect(h.metrics()).toEqual({ closed: 4, maximumActive: 2 });
    expect(h.mergeInputs).toEqual([2, 2]);
    expect(state.noNewStreak).toBe(4);
    expect(state.terminalReason).toBe("saturated");
    expect(new Set(h.published.map((draft) => draft.scanId))).toEqual(
      new Set([h.input.scanId]),
    );
    expect(h.published.at(-1)).toEqual(state.aggregate!);
    expect(h.published.at(-1)!.findings).toEqual([]);
    expect(
      h.calls.every(
        (options) =>
          options.mode === "standard" &&
          options.parentScanId === h.input.scanId &&
          options.deepScanPass === true,
      ),
    ).toBe(true);
  });

  test("resets no-new streak on a novel stable identity", async () => {
    const h = await harness({ stopAfterNoNew: 2 });
    let pass = 0;
    h.setRun(async (options) =>
      result(
        options.resumeScanId!,
        options.outputDir!,
        ++pass >= 2 ? "supported-issue" : undefined,
      ),
    );
    await runDeepScans(h.input);
    const state = await h.checkpoint();
    expect(h.calls).toHaveLength(4);
    expect(state.noNewStreak).toBe(2);
    expect(state.terminalReason).toBe("saturated");
    expect(h.published.at(-1)!.findings).toHaveLength(1);
    expect(
      (h.published.at(-1)!.findings[0]!["provenance"] as JsonObject)[
        "sourceFindings"
      ],
    ).toHaveLength(3);
    const admissions = h.checkpoints.filter(
      (checkpoint, index, all) =>
        checkpoint.mergedScanIds.length >
        (all[index - 1]?.mergedScanIds.length ?? 0),
    );
    expect(admissions.map((checkpoint) => checkpoint.noNewStreak)).toEqual([
      1, 0, 1, 2,
    ]);
  });

  test.each([
    [0, 0],
    [0, 1],
    [0, 3],
    [2, 0],
    [2, 1],
    [3, 0],
  ])(
    "resumes a sealed child with %i saved and %i new merge failures",
    async (priorFailures, failures) => {
      const h = await harness({ stopAfterNoNew: 1, maxDiscoveryRuns: 1 });
      const childDirectory = "artifacts/deep-scan/passes/pass-1";
      const scanDir = join(h.input.scanDir, childDirectory);
      await mkdir(dirname(scanDir), { recursive: true, mode: 0o700 });
      await cp(example, scanDir, { recursive: true });
      if (process.platform !== "win32") await chmod(scanDir, 0o700);
      const scanId = exampleManifest.scan.id;
      h.records.set(scanId, {
        scanId,
        scanDir,
        parentScanId: h.input.scanId,
        targetPath: h.input.repository,
        progress: { status: "complete" },
      });
      const bytes = await readFile(join(scanDir, "findings.json"));
      await h.seed({
        version: 2,
        startedAt: h.input.startedAt,
        passes: [{ directory: childDirectory }],
        mergedScanIds: [],
        aggregate: null,
        noNewStreak: 0,
        consecutiveErrors: 2,
        ...(priorFailures === 0 ? {} : { mergeFailures: priorFailures }),
      });
      const merge = h.input.merge;
      let attempts = 0;
      h.input.merge = async (...args) => {
        if (++attempts <= failures) throw new Error("Merge failed.");
        return merge(...args);
      };
      if (priorFailures + failures >= 3) {
        await expect(runDeepScans(h.input)).rejects.toThrow(
          priorFailures === 3
            ? "consecutive merge error limit"
            : "Merge failed.",
        );
        expect(attempts).toBe(3 - priorFailures);
        expect(h.calls).toEqual([]);
        expect(await h.checkpoint()).toMatchObject({
          consecutiveErrors: 2,
          mergeFailures: 3,
          noNewStreak: 0,
          mergedScanIds: [],
          terminalReason: "failed",
        });
        expect(await readFile(join(scanDir, "findings.json"))).toEqual(bytes);
        return;
      }
      await runDeepScans(h.input);
      const state = await h.checkpoint();
      expect(h.calls).toEqual([]);
      expect(h.mergeInputs).toEqual([1]);
      expect(state.mergedScanIds).toEqual([scanId]);
      expect(state.consecutiveErrors).toBe(2);
      expect(state.mergeFailures).toBe(0);
      expect(attempts).toBe(failures + 1);
      expect(state.terminalReason).toBe("capped");
      expect(h.published.at(-1)!.findings).toHaveLength(1);
      expect(await readFile(join(scanDir, "findings.json"))).toEqual(bytes);
      await runDeepScans(h.input);
      expect(h.calls).toEqual([]);
      expect(h.mergeInputs).toEqual([1]);
      expect((await h.checkpoint()).mergedScanIds).toEqual([scanId]);
      expect((await h.checkpoint()).noNewStreak).toBe(state.noNewStreak);
      expect(await readFile(join(scanDir, "findings.json"))).toEqual(bytes);
    },
  );

  test("stops at the saved merge error limit before scheduling discovery", async () => {
    const h = await harness();
    await h.seed({
      version: 2,
      startedAt: h.input.startedAt,
      passes: [],
      mergedScanIds: [],
      aggregate: null,
      noNewStreak: 0,
      consecutiveErrors: 0,
      mergeFailures: 3,
    });
    await expect(runDeepScans(h.input)).rejects.toThrow(
      "consecutive merge error limit",
    );
    expect(h.calls).toEqual([]);
    expect(h.mergeInputs).toEqual([]);
    expect((await h.checkpoint()).mergeFailures).toBe(3);
  });

  test("continues the already reserved final pass before applying the run cap", async () => {
    const h = await harness({ maxDiscoveryRuns: 1 });
    const id = randomUUID();
    const directory = "artifacts/deep-scan/passes/pass-1";
    h.records.set(id, {
      scanId: id,
      scanDir: join(h.input.scanDir, directory),
      parentScanId: h.input.scanId,
      targetPath: h.input.repository,
      progress: { status: "running" },
    });
    await h.seed({
      version: 2,
      startedAt: h.input.startedAt,
      passes: [{ directory, scanId: id }],
      mergedScanIds: [],
      aggregate: null,
      noNewStreak: 0,
      consecutiveErrors: 0,
    });
    await runDeepScans(h.input);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.resumeScanId).toBe(id);
    expect((await h.checkpoint()).mergedScanIds).toEqual([id]);
    expect((await h.checkpoint()).terminalReason).toBe("capped");
  });

  test("continues saved legacy counters and coverage using only new ordinary scans", async () => {
    const h = await harness({ maxDiscoveryRuns: 3, stopAfterNoNew: 4 });
    const coverage = {
      completeness: "partial",
      surfaces: [],
      deferred: [
        { id: "legacy-unresolved", reason: "Saved unresolved validation." },
      ],
    };
    await h.seed({
      version: 2,
      startedAt: h.input.startedAt,
      passes: [],
      mergedScanIds: [],
      aggregate: { scanId: h.input.scanId, findings: [], coverage },
      legacy: { discoveryRuns: 2, coverage },
      noNewStreak: 3,
      consecutiveErrors: 0,
    });
    await runDeepScans(h.input);
    const state = await h.checkpoint();
    expect(h.calls).toHaveLength(1);
    expect(state.passes).toHaveLength(1);
    expect(state.noNewStreak).toBe(4);
    expect(state.terminalReason).toBe("saturated");
    expect(state.aggregate!.coverage["deferred"]).toEqual(coverage.deferred);
    expect(state.aggregate!.coverage["completeness"]).toBe("partial");

    const ready = await harness();
    await ready.seed({
      ...state,
      passes: [],
      mergedScanIds: [],
      aggregate: {
        ...state.aggregate!,
        scanId: ready.input.scanId,
      },
    });
    await runDeepScans(ready.input);
    expect(ready.calls).toEqual([]);
    expect(ready.mergeInputs).toEqual([]);
    expect(ready.published.at(-1)!.coverage["deferred"]).toEqual(
      coverage.deferred,
    );
  });

  test("recovers legacy paid usage once and requires it before spending under a saved limit", async () => {
    const h = await harness({ maxDiscoveryRuns: 1 });
    const coverage = { completeness: "partial", surfaces: [] };
    const state: DeepScanCheckpoint = {
      version: 2,
      startedAt: h.input.startedAt,
      passes: [],
      mergedScanIds: [],
      aggregate: { scanId: h.input.scanId, findings: [], coverage },
      legacy: {
        discoveryRuns: 1,
        coverage,
        originThreadId: "original-session",
      },
      noNewStreak: 0,
      consecutiveErrors: 0,
    };
    await h.seed(state);
    h.input.scanOptions.requireCost = true;
    h.input.historicalCost = async () => null;
    await expect(runDeepScans(h.input)).rejects.toThrow(
      "original Deep Scan session logs",
    );
    expect(h.calls).toEqual([]);
    const cost = estimateScanCost("gpt-6-astra", {
      input_tokens: 10000,
      output_tokens: 2000,
    })!;
    let recoveries = 0;
    h.input.historicalCost = async (threadId) => {
      expect(threadId).toBe("original-session");
      recoveries++;
      return cost;
    };
    const costs = new Map();
    h.input.onCost = (id, receipt) => {
      costs.set(id, receipt);
    };
    await runDeepScans(h.input);
    await runDeepScans(h.input);
    expect(recoveries).toBe(1);
    expect(costs.get("legacy")).toEqual(cost);
    expect((await h.checkpoint()).legacy!.cost).toEqual(cost);
    expect(h.calls).toEqual([]);
  });

  test("retries the same ordinary scan without counting another logical input", async () => {
    retryDelay = spyOn(timers, "setTimeout").mockImplementation(
      async <T>(_delay?: number, value?: T): Promise<T> => value as T,
    );
    const h = await harness({ stopAfterNoNew: 1 });
    let attempts = 0;
    h.setRun(async (options) => {
      if (++attempts === 1) throw new Error("Transient scan interruption");
      return result(options.resumeScanId!, options.outputDir!);
    });
    await runDeepScans(h.input);
    const state = await h.checkpoint();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]!.outputDir).toBe(h.calls[1]!.outputDir);
    expect(h.calls[1]!.resumeScanId).toBe(state.passes[0]!.scanId);
    expect(state.passes).toHaveLength(1);
    expect(state.noNewStreak).toBe(1);
    expect(state.mergedScanIds).toHaveLength(1);
    expect(h.mergeInputs).toEqual([1]);
  });

  test("failed scans do not count toward clean saturation", async () => {
    retryDelay = spyOn(timers, "setTimeout").mockImplementation(
      async <T>(_delay?: number, value?: T): Promise<T> => value as T,
    );
    const h = await harness({ stopAfterNoNew: 1, maxDiscoveryRuns: 1 });
    h.setRun(async () => {
      throw new Error("Discovery failed.");
    });
    await expect(runDeepScans(h.input)).rejects.toThrow(
      "every discovery run failed",
    );
    const state = await h.checkpoint();
    expect(h.calls).toHaveLength(4);
    expect(state.passes).toHaveLength(1);
    expect(state.mergedScanIds).toEqual([]);
    expect(state.noNewStreak).toBe(0);
    expect(state.terminalReason).toBe("failed");
    expect(state.consecutiveErrors).toBe(1);
    expect(h.mergeInputs).toEqual([]);
    expect(h.published).toEqual([]);
  });

  test("reports the original deadline when the final merge reaches saturation late", async () => {
    const h = await harness({ stopAfterNoNew: 1 });
    const merge = h.input.merge;
    const clock = spyOn(Date, "now");
    h.input.merge = async (...args) => {
      const merged = await merge(...args);
      clock.mockReturnValue(Date.parse(h.input.startedAt) + 3_600_001);
      return merged;
    };
    try {
      await runDeepScans(h.input);
      expect(await h.checkpoint()).toMatchObject({
        startedAt: h.input.startedAt,
        noNewStreak: 1,
        terminalReason: "capped",
      });
      expect(h.calls).toHaveLength(1);
      expect(h.mergeInputs).toEqual([1]);
      expect(h.published.at(-1)!.findings).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  test("cancellation preserves accepted progress and closes owned clients", async () => {
    const h = await harness({ stopAfterNoNew: 4 });
    let passes = 0;
    h.setRun(async (options) => {
      if (++passes === 2) {
        h.controller.abort(new Error("Canceled by the user."));
        throw h.controller.signal.reason;
      }
      return result(
        options.resumeScanId!,
        options.outputDir!,
        "supported-issue",
      );
    });
    await expect(runDeepScans(h.input)).rejects.toThrow("Canceled by the user");
    const state = await h.checkpoint();
    expect(state.terminalReason).toBe("canceled");
    expect(state.mergedScanIds).toHaveLength(1);
    expect(state.aggregate!.findings).toHaveLength(1);
    expect(
      (state.aggregate!.findings[0]!["provenance"] as JsonObject)[
        "sourceFindings"
      ],
    ).toHaveLength(1);
    expect(h.published.at(-1)).toEqual(state.aggregate!);
    expect(h.published.at(-1)!.coverage["completeness"]).toBe("partial");
    expect(h.published.at(-1)!.coverage["deferred"]).toHaveLength(1);
    expect(h.metrics().closed).toBe(2);
  });

  test.each(["transport interruption", "explicit cancellation"] as const)(
    "preserves saved discovery state across %s with the correct child lifecycle",
    async (stop) => {
      const h = await harness({ stopAfterNoNew: 3 });
      const now = Date.parse("2026-01-02T12:00:00Z");
      h.input.startedAt = new Date(now).toISOString();
      const startedAt = new Date(now - 1_800_000).toISOString();
      const scanId = randomUUID();
      const directory = "artifacts/deep-scan/passes/pass-1";
      const scanDir = join(h.input.scanDir, directory);
      const childCheckpoint = join(scanDir, "checkpoint.json");
      const childBytes = Buffer.from('{"completed":"inventory"}\n');
      await mkdir(scanDir, { recursive: true, mode: 0o700 });
      await writeFile(childCheckpoint, childBytes);
      h.records.set(scanId, {
        scanId,
        scanDir,
        parentScanId: h.input.scanId,
        targetPath: h.input.repository,
        progress: { status: "running" },
      });
      const coverage = { completeness: "partial", surfaces: [] };
      const checkpoint: DeepScanCheckpoint = {
        version: 2,
        startedAt,
        passes: [{ directory, scanId }],
        mergedScanIds: [],
        aggregate: { scanId: h.input.scanId, findings: [], coverage },
        legacy: { discoveryRuns: 2, coverage },
        noNewStreak: 2,
        consecutiveErrors: 1,
        mergeFailures: 1,
      };
      await h.seed(checkpoint);
      const checkpointPath = join(h.input.scanDir, DEEP_SCAN_CHECKPOINT);
      const checkpointBytes = await readFile(checkpointPath);
      const reason =
        stop === "transport interruption"
          ? new ScanTransportClosedError("Native transport disconnected.")
          : new Error("Canceled by the user.");
      h.setRun(async () => {
        h.controller.abort(reason);
        throw reason;
      });
      const clock = spyOn(Date, "now").mockReturnValue(now);
      try {
        await expect(runDeepScans(h.input)).rejects.toThrow(reason.message);
        expect(h.calls).toHaveLength(1);
        expect(h.calls[0]).toMatchObject({
          resumeScanId: scanId,
          outputDir: scanDir,
        });
        expect(h.metrics()).toEqual({ closed: 1, maximumActive: 1 });
        expect(await readFile(childCheckpoint)).toEqual(childBytes);
        expect(await h.checkpoint()).toMatchObject({
          startedAt,
          passes: checkpoint.passes,
          mergedScanIds: [],
          noNewStreak: 2,
          consecutiveErrors: 1,
          mergeFailures: 1,
        });
        if (stop === "explicit cancellation") {
          expect((await h.checkpoint()).terminalReason).toBe("canceled");
          expect(h.records.get(scanId)!.progress.status).toBe("failed");
          return;
        }

        expect(await readFile(checkpointPath)).toEqual(checkpointBytes);
        expect((await h.checkpoint()).terminalReason).toBeUndefined();
        expect(h.records.get(scanId)!.progress.status).toBe("running");
        expect(h.published).toEqual([]);
        h.input.signal = new AbortController().signal;
        h.setRun(async (options) => {
          clock.mockReturnValue(Date.parse(startedAt) + 3_600_001);
          return result(options.resumeScanId!, options.outputDir!);
        });
        await runDeepScans(h.input);
        expect(h.calls).toHaveLength(2);
        expect(h.calls[1]).toMatchObject({
          resumeScanId: scanId,
          outputDir: scanDir,
        });
        expect(h.records.size).toBe(1);
        expect(h.records.get(scanId)!.progress.status).toBe("complete");
        expect(await h.checkpoint()).toMatchObject({
          startedAt,
          passes: checkpoint.passes,
          mergedScanIds: [scanId],
          noNewStreak: 3,
          consecutiveErrors: 0,
          mergeFailures: 0,
          terminalReason: "capped",
        });
        expect(h.mergeInputs).toEqual([1]);
        expect(h.metrics()).toEqual({ closed: 2, maximumActive: 1 });
        expect(await readFile(childCheckpoint)).toEqual(childBytes);
      } finally {
        clock.mockRestore();
      }
    },
  );
});
