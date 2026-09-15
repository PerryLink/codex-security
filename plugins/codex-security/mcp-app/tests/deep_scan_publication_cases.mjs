import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const bundle = await build({
  bundle: true,
  entryPoints: [new URL("../src/artifact-scan-draft.ts", import.meta.url).pathname],
  format: "esm",
  platform: "node",
  write: false,
});
const { parseScanDraft } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);

export async function testDeepScanPublication({
  fixtureRun, FakeStore, FakeExecutor, DeepScanCoordinator, deferred,
  immediateClock, eventually, standardScanDraft,
}) {
  async function testDeadlineRetainsUnfinishedPassForFollowUp(resume) {
    const fixture = await fixtureRun({ workers: 1, subagents: 0, stopAfterNoNew: 99, maxDiscoveryRuns: 8 });
    fixture.run.createdAt = new Date(immediateClock.now()).toISOString();
    const store = new FakeStore(fixture.run);
    const executor = new FakeExecutor({
      blockDiscoveryAfterCalls: 1, discoveryCandidateId: "candidate-1", dedupNewFindings: [1],
    });
    const completed = [];
    const options = {
      store, executor, pluginRoot: fixture.pluginRoot, clock: immediateClock, discoveryTimeoutMs: 500,
    };
    const coordinator = new DeepScanCoordinator({
      ...options, run: fixture.run,
      onComplete: async (draft) => {
        if (resume) coordinator.cancel("mcp_transport_closed");
        else completed.push(parseScanDraft(draft));
      },
    });
    coordinator.start();
    await eventually(() => executor.discoveryCalls === 2 && executor.runningDiscovery === 1);
    assert.equal(executor.dedupCalls, 1, "the first singleton is committed before the next scan begins");
    const unfinished = [...store.workers.values()].find((worker) => (
      worker.kind === "discovery" && worker.status === "running"
    ));
    const checkpoint = path.join(unfinished.artifactDir, "checkpoints", `${"a".repeat(64)}.json`);
    const raw = { ...standardScanDraft(fixture.run.scanId, "unfinished-candidate", "discovery-0002"), complete: false };
    await mkdir(path.dirname(checkpoint), { recursive: true });
    await writeFile(checkpoint, JSON.stringify(raw));
    let terminal = await coordinator.wait(undefined, 5_000);
    if (resume) {
      assert.equal(terminal?.status, "canceled");
      assert.equal(store.finishCalls.length, 0);
      const run = await store.get();
      const claim = store.dedupClaims[0];
      run.persistedDedupInputs = claim.workerIds.map((discoveryWorkerId, inputOrder) => ({
        dedupWorkerId: claim.id, discoveryWorkerId, inputOrder,
      }));
      const replacement = new DeepScanCoordinator({
        ...options, run,
        clock: { ...immediateClock, now: () => immediateClock.now() + options.discoveryTimeoutMs },
        onComplete: async (draft) => completed.push(parseScanDraft(draft)),
      });
      replacement.start();
      terminal = await replacement.wait(undefined, 5_000);
    }
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(terminal.terminalReason, "capped");
    assert.equal(terminal.dispatchedCount, 2);
    assert.equal(store.failCalls, 0);
    assert.equal(executor.discoveryCalls, 2);
    assert.equal(executor.runningDiscovery, 0);
    assert.equal(executor.dedupCalls, 1);
    assert.equal(store.dedupCommits.length, 1);
    assert.equal(store.run.noNewStreak, 0);
    assert.deepEqual(store.finishCalls[0].omittedWorkerIds, []);
    assert.equal(store.dedupClaims[0].workerIds.length, 1);
    assert.equal(store.workers.get(unfinished.id).error, "deep_scan_discovery_deadline_reached");
    assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), raw);
    assert.equal(completed.length, 1);
    assert.deepEqual(completed[0].findings.map((finding) => finding.provenance.candidateId), ["candidate-1"]);
    assert.equal(completed[0].coverage.completeness, "partial");
    assert.equal(completed[0].coverage.deferred.length, 1);
    assert.ok(completed[0].coverage.deferred[0].reason.includes(
      path.relative(fixture.run.scanDir, unfinished.artifactDir).split(path.sep).join("/"),
    ));
  }

  async function testDiscoveryDeadlineDrainsActiveReducerAndPreservesFindings() {
    const fixture = await fixtureRun({ workers: 2, subagents: 0, stopAfterNoNew: 99, maxDiscoveryRuns: 12 });
    const store = new FakeStore(fixture.run);
    const deadline = deferred();
    let published;
    const executor = new FakeExecutor({ blockDedup: true, discoveryCandidateId: "candidate-1" });
    const coordinator = new DeepScanCoordinator({
      run: fixture.run, store, executor, pluginRoot: fixture.pluginRoot,
      clock: immediateClock, discoveryTimeoutMs: 500,
      onComplete: async (draft) => { published = parseScanDraft(draft); },
      log: (event) => { if (event.event === "discovery_deadline_reached") deadline.resolve(); }
    });
    coordinator.start();
    const terminalPromise = coordinator.wait(undefined, 5_000);
    await executor.dedupStarted;
    await deadline.promise;
    assert.equal(executor.discoveryCalls, 2);
    assert.equal(executor.runningDiscovery, 0);
    assert.equal(executor.runningDedup, 1, "the deadline lets the active merge finish");
    assert.equal(executor.dedupSignal.aborted, false);
    assert.equal(store.finishCalls.length, 0);
    executor.releaseDedup();
    const terminal = await terminalPromise;
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(terminal.terminalReason, "capped");
    assert.equal(executor.discoveryCalls, 2);
    assert.equal(published.coverage.completeness, "complete");
    assert.deepEqual(published.coverage.deferred, []);
    assert.equal(store.failCalls, 0);
    assert.equal(store.dedupCommits.length, 1);
    assert.deepEqual(store.finishCalls[0].omittedWorkerIds, []);
    const manifest = JSON.parse(await readFile(terminal.manifestPath, "utf8"));
    assert.deepEqual(manifest.findings.map((finding) => finding.provenance.candidateId), ["candidate-1"]);
    assert.equal([...store.workers.values()].every((worker) => worker.status === "succeeded"), true);
  }

  async function testPublicationWaitsForAllAcceptedBatchResults() {
    const fixture = await fixtureRun({ workers: 3, subagents: 0, stopAfterNoNew: 2, maxDiscoveryRuns: 3 });
    const store = new FakeStore(fixture.run);
    const acceptance = deferred();
    const releaseAcceptance = deferred();
    const updateWorker = store.updateWorker.bind(store);
    store.updateWorker = async (update) => {
      const persisted = await updateWorker(update);
      if (update.kind === "discovery" && update.status === "succeeded"
        && path.basename(path.dirname(update.promptPath)) === "discovery-0003") {
        acceptance.resolve();
        await releaseAcceptance.promise;
      }
      return persisted;
    };
    const executor = new FakeExecutor({
      discoveryCandidates: { "discovery-0003": "accepted-batch-finding" },
    });
    const completed = [];
    const coordinator = new DeepScanCoordinator({
      run: fixture.run, store, executor, pluginRoot: fixture.pluginRoot,
      clock: immediateClock,
      onComplete: async (draft) => completed.push(structuredClone(draft)),
    });
    coordinator.start();
    await acceptance.promise;
    await eventually(() => [...store.workers.values()].filter((worker) => worker.status === "succeeded").length === 3);
    assert.equal(executor.runningDiscovery, 0);
    assert.equal(store.dedupClaims.length, 0, "merge must wait for each acceptance response");
    assert.equal(completed.length, 0);
    releaseAcceptance.resolve();
    const terminal = await coordinator.wait(undefined, 5_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(terminal.terminalReason, "capped");
    assert.equal(executor.discoveryCalls, 3);
    assert.equal(executor.dedupCalls, 1);
    assert.deepEqual(store.finishCalls[0].omittedWorkerIds, []);
    assert.equal(completed.length, 1);
    assert.equal(completed[0].coverage.completeness, "complete");
    assert.deepEqual(completed[0].findings.map((finding) => finding.provenance.candidateId), ["accepted-batch-finding"]);
  }

  async function testIndependentPassCoveragePreservesConflictingOutcomesAndEvidence() {
    const fixture = await fixtureRun({ workers: 3, subagents: 0, stopAfterNoNew: 2, maxDiscoveryRuns: 3 });
    const store = new FakeStore(fixture.run);
    const executor = new FakeExecutor();
    const run = executor.run.bind(executor);
    const sourceCoverage = new Map();
    executor.run = async (request) => {
      const outcome = await run(request);
      if (request.kind !== "discovery") return outcome;
      const resultPath = path.join(request.artifactContext.root, "result.json");
      const draft = JSON.parse(await readFile(resultPath, "utf8"));
      const label = path.basename(path.dirname(request.promptPath));
      const complete = label === "discovery-0001";
      draft.coverage = {
        completeness: complete ? "complete" : "partial",
        surfaces: [{
          id: "query-surface", label: "Reviewed query",
          disposition: complete ? "no_issue_found" : "needs_follow_up",
          notes: complete ? "Verified bound values." : `Unresolved proof from ${label}.`,
          receiptRefs: ["artifacts/receipt.json"],
        }],
        explicitExclusions: [{ pattern: "vendor/**", reason: "Third-party source is outside the selected review." }],
        deferred: complete ? [] : [{
          id: "pending-query", candidateId: label === "discovery-0003" ? "c".repeat(512) : "candidate-1",
          reason: "The candidate needs further source validation.",
          surfaceIds: ["query-surface"],
          candidate: { proof: `Independent evidence from ${label}.` },
        }],
        ...(complete ? {} : { openQuestions: [{ question: `Question from ${label}.` }] }),
      };
      sourceCoverage.set(label, structuredClone(draft.coverage));
      await mkdir(path.join(request.artifactContext.root, "artifacts"));
      await writeFile(path.join(request.artifactContext.root, "artifacts", "receipt.json"), label);
      await writeFile(resultPath, JSON.stringify(draft));
      return outcome;
    };
    const completed = [];
    const coordinator = new DeepScanCoordinator({
      run: fixture.run, store, executor, pluginRoot: fixture.pluginRoot,
      clock: immediateClock,
      onComplete: async (draft) => completed.push(parseScanDraft(draft)),
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 5_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(completed.length, 1);
    const coverage = completed[0].coverage;
    assert.equal(coverage.completeness, "partial");
    assert.deepEqual(coverage.surfaces.map((surface) => surface.disposition).sort(), [
      "needs_follow_up", "needs_follow_up", "no_issue_found",
    ]);
    assert.deepEqual(coverage.surfaces.map((surface) => surface.notes).sort(), [
      "Unresolved proof from discovery-0002.", "Unresolved proof from discovery-0003.", "Verified bound values.",
    ]);
    assert.deepEqual(coverage.deferred.map((item) => item.candidate.proof).sort(), [
      "Independent evidence from discovery-0002.", "Independent evidence from discovery-0003.",
    ]);
    assert.equal(coverage.explicitExclusions.some((item) => item.pattern === "vendor/**"), true);
    assert.deepEqual(coverage.openQuestions.map((item) => item.question).sort(), [
      "Question from discovery-0002.", "Question from discovery-0003.",
    ]);
    for (const item of coverage.deferred) {
      assert.equal(item.surfaceIds.every((id) => coverage.surfaces.some((surface) => surface.id === id)), true);
    }
    assert.equal(new Set(coverage.deferred.map((item) => item.candidateId)).size, 2);
    assert.deepEqual(coverage.deferred.map((item) => item.sourceCandidateId).sort(), ["c".repeat(512), "candidate-1"].sort());
    const receipts = await Promise.all(coverage.surfaces.flatMap((surface) => (
      surface.receiptRefs.map((ref) => readFile(path.join(fixture.run.scanDir, ref), "utf8"))
    )));
    assert.deepEqual(receipts.sort(), ["discovery-0001", "discovery-0002", "discovery-0003"]);
    for (const worker of store.workers.values()) {
      if (worker.kind !== "discovery") continue;
      const draft = JSON.parse(await readFile(worker.resultManifestPath, "utf8"));
      assert.deepEqual(draft.coverage, sourceCoverage.get(path.basename(path.dirname(worker.promptPath))));
    }
  }

  async function testSaturationRequiresNoWorkerCancellation() {
    const fixture = await fixtureRun({ workers: 2, subagents: 0, stopAfterNoNew: 2, maxDiscoveryRuns: 6 });
    const store = new FakeStore(fixture.run);
    const executor = new FakeExecutor();
    const updateWorker = store.updateWorker.bind(store);
    const cancellations = [];
    store.updateWorker = async (update) => {
      if (update.status === "canceled") cancellations.push(update.id);
      return updateWorker(update);
    };
    const completed = [];
    const coordinator = new DeepScanCoordinator({
      run: fixture.run, store, executor, pluginRoot: fixture.pluginRoot,
      clock: immediateClock,
      onComplete: async (draft) => completed.push(structuredClone(draft)),
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 5_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(terminal.terminalReason, "saturated");
    assert.deepEqual(cancellations, []);
    assert.equal(executor.discoveryCalls, 2);
    assert.equal(executor.dedupCalls, 1);
    assert.equal(store.failCalls, 0);
    assert.equal(store.finishCalls.length, 1);
    assert.equal(completed.length, 1);
    const acceptedReducer = [...store.workers.values()].find((worker) => worker.kind === "dedup" && worker.status === "succeeded");
    const { coverage, ...publishedReduction } = completed[0];
    assert.deepEqual(publishedReduction, JSON.parse(await readFile(acceptedReducer.resultManifestPath, "utf8")));
    assert.equal(coverage.completeness, "complete");
    assert.equal(coverage.surfaces.some((surface) => surface.label === "Fixture query"), true);
  }

  async function testPublicationUsesAcceptedReducerSnapshot() {
    const fixture = await fixtureRun({ workers: 1, subagents: 0, stopAfterNoNew: 1, maxDiscoveryRuns: 1 });
    const store = new FakeStore(fixture.run);
    const commitDedup = store.commitDedup.bind(store);
    store.commitDedup = async (commit) => {
      const accepted = await commitDedup(commit);
      await rm(commit.resultManifestPath);
      return accepted;
    };
    store.finish = async (input) => {
      store.finishCalls.push(input);
      Object.assign(store.run, { status: "succeeded", terminalReason: input.reason, manifestPath: input.manifestPath });
      return structuredClone(store.run);
    };
    const completed = [];
    const coordinator = new DeepScanCoordinator({
      run: fixture.run, store,
      executor: new FakeExecutor({ discoveryCandidateId: "accepted-finding" }),
      pluginRoot: fixture.pluginRoot, clock: immediateClock,
      onComplete: async (draft) => completed.push(structuredClone(draft)),
    });
    coordinator.start();
    const terminal = await coordinator.wait(undefined, 5_000);
    assert.equal(terminal?.status, "succeeded", terminal?.error);
    assert.equal(completed[0].findings[0].provenance.candidateId, "accepted-finding");
    assert.equal(completed[0].coverage.completeness, "complete");
  }

  await testDeadlineRetainsUnfinishedPassForFollowUp(false);
  await testDeadlineRetainsUnfinishedPassForFollowUp(true);
  await testDiscoveryDeadlineDrainsActiveReducerAndPreservesFindings();
  await testPublicationWaitsForAllAcceptedBatchResults();
  await testIndependentPassCoveragePreservesConflictingOutcomesAndEvidence();
  await testSaturationRequiresNoWorkerCancellation();
  await testPublicationUsesAcceptedReducerSnapshot();
}
