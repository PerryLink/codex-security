import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import {
  createDeepScanArtifacts,
  ensureDeepScanDirectories
} from "./artifacts.js";
import { validateDiscoveryArtifacts, validateReducerArtifacts, type DeepReductionInput } from "./artifact-validation.js";
import {
  scanDraftInputSchema,
  type ScanDraftInput
} from "../artifact-scan-draft.js";
import type { DeepScanArtifacts } from "./artifacts.js";
import { DeepScanWorkerRunner } from "./worker-runner.js";
import type { AcceptedDiscovery } from "./worker-runner.js";
import {
  boundedDeepScanErrorPair,
  boundedDeepScanErrorMessage,
  isStaleCoordinatorGenerationError
} from "./errors.js";
import type {
  CodexWorkerExecutor,
  DeepScanClock,
  DeepScanLogger,
  DeepScanReplaceableFailureKind,
  DeepScanRunState,
  DeepScanStore,
  DeepScanTerminalReason,
  PersistedDeepScanWorker
} from "./types.js";

const RETRY_DELAYS_MS = [60_000, 180_000, 540_000] as const;
const COORDINATOR_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_HOURS = 96;

interface ScanLoopResult {
  reason: DeepScanTerminalReason;
  result?: DeepReductionInput;
  accepted: AcceptedDiscovery[];
}

type CoordinatorPhase = "setup" | "discovery" | "terminal";

export interface CoordinatorOptions {
  run: DeepScanRunState;
  store: DeepScanStore;
  executor: CodexWorkerExecutor;
  pluginRoot: string;
  clock?: DeepScanClock;
  random?: () => number;
  log?: DeepScanLogger;
  retryDelaysMs?: readonly number[];
  discoveryTimeoutMs?: number;
  handoffClaimToken?: string;
  threadId?: string;
  heartbeatIntervalMs?: number;
  observeReplacement?: (run: DeepScanRunState) => Promise<DeepScanRunState>;
  onComplete?: (draft: ScanDraftInput, signal: AbortSignal) => Promise<void>;
  onStopped?: (run: DeepScanRunState) => Promise<void>;
}

export { DeepScanNonRetryableError } from "./errors.js";

/** Repeats independent Standard scans, merges each batch, and closes the parent scan. */
export class DeepScanCoordinator {
  private readonly abortController = new AbortController();
  private readonly discoveryAbortController = new AbortController();
  private readonly publicationAbortController = new AbortController();
  private readonly clock: DeepScanClock;
  private readonly log: DeepScanLogger;
  private readonly artifacts: DeepScanArtifacts;
  private readonly workers: DeepScanWorkerRunner;
  private readonly discoveryWorkers: DeepScanWorkerRunner;
  private readonly terminalPromise: Promise<DeepScanRunState>;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
  private discoveryTimeout: ReturnType<typeof setTimeout> | undefined;
  private ownershipCheck: Promise<boolean> | undefined;
  private resolveTerminal!: (state: DeepScanRunState) => void;
  private rejectTerminal!: (error: unknown) => void;
  private resolveCancellationReady!: () => void;
  private readonly cancellationReady = new Promise<void>((resolvePromise) => {
    this.resolveCancellationReady = resolvePromise;
  });
  private cancellationPersistence?: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  private started = false;
  private terminal = false;
  private canceled = false;
  private externallyFailed = false;
  private phase: CoordinatorPhase = "setup";
  private discoveryDeadlineReached = false;
  private readonly deadlineInterruptedPasses: Set<string>;
  private state: DeepScanRunState;

  constructor(private readonly options: CoordinatorOptions) {
    this.state = cloneState(options.run);
    this.deadlineInterruptedPasses = new Set((this.state.persistedWorkers ?? [])
      .filter((worker) => worker.kind === "discovery" && worker.status === "canceled"
        && worker.error === "deep_scan_discovery_deadline_reached")
      .map((worker) => worker.artifactDir));
    this.clock = options.clock ?? systemClock;
    this.log = options.log ?? (() => undefined);
    this.artifacts = createDeepScanArtifacts(this.state.scanDir);
    const workerOptions = {
      run: this.state,
      store: options.store,
      executor: options.executor,
      artifacts: this.artifacts,
      pluginRoot: options.pluginRoot,
      clock: this.clock,
      random: options.random ?? Math.random,
      log: this.log,
      retryDelaysMs: options.retryDelaysMs ?? RETRY_DELAYS_MS
    } satisfies Omit<ConstructorParameters<typeof DeepScanWorkerRunner>[0], "signal">;
    this.workers = new DeepScanWorkerRunner({
      ...workerOptions,
      signal: this.abortController.signal
    });
    this.discoveryWorkers = new DeepScanWorkerRunner({
      ...workerOptions,
      signal: this.discoveryAbortController.signal
    });
    this.abortController.signal.addEventListener(
      "abort",
      () => {
        this.discoveryAbortController.abort(this.abortController.signal.reason);
      },
      { once: true }
    );
    this.terminalPromise = new Promise((resolvePromise, rejectPromise) => {
      this.resolveTerminal = resolvePromise;
      this.rejectTerminal = rejectPromise;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.log({ event: "coordinator_started", scanId: this.state.scanId });
    this.scheduleDiscoveryDeadline();
    this.scheduleHeartbeat();
    void this.run().catch((error: unknown) => {
      this.log({
        event: "coordinator_unhandled_error",
        scanId: this.state.scanId,
        reason: errorKind(error)
      });
      this.failLocally(error);
    });
  }

  snapshot(): DeepScanRunState {
    return cloneState(this.state);
  }

  settled(): Promise<DeepScanRunState> {
    return this.terminalPromise.then(cloneState);
  }

  async wait(signal: AbortSignal | undefined): Promise<DeepScanRunState>;
  async wait(
    signal: AbortSignal | undefined,
    timeoutMs: number
  ): Promise<DeepScanRunState | undefined>;
  async wait(
    signal: AbortSignal | undefined,
    timeoutMs?: number
  ): Promise<DeepScanRunState | undefined> {
    if (this.terminal) return await this.settled();
    if (signal?.aborted) throw abortError(signal.reason);
    return await new Promise<DeepScanRunState | undefined>((resolvePromise, rejectPromise) => {
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              cleanup();
              resolvePromise(undefined);
            }, timeoutMs);
      const onAbort = (): void => {
        cleanup();
        rejectPromise(abortError(signal?.reason));
      };
      const cleanup = (): void => {
        if (timeout !== undefined) clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.terminalPromise.then(
        (state) => {
          cleanup();
          resolvePromise(cloneState(state));
        },
        (error: unknown) => {
          cleanup();
          rejectPromise(error);
        }
      );
    });
  }

  cancel(reason: string): void {
    if (this.canceled || this.terminal) return;
    this.canceled = true;
    this.state = { ...this.state, status: "canceled" };
    this.log({ event: "coordinator_cancel_requested", scanId: this.state.scanId, reason });
    this.abortController.abort(reason);
    this.publicationAbortController.abort(reason);
    // The cancel operation returns promptly. Terminal waiters remain attached
    // until worker cleanup and stopped-result publication settle.
  }

  async cancelAfterPersistence(
    reason: string,
    persistCancellation: () => Promise<void>
  ): Promise<DeepScanRunState> {
    if (this.terminal) return await this.settled();
    if (!this.cancellationPersistence) {
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      this.cancellationPersistence = { promise, resolve, reject };
    }
    this.cancel(reason);
    await this.cancellationReady;
    try {
      await persistCancellation();
      this.cancellationPersistence.resolve();
    } catch (error) {
      this.cancellationPersistence.reject(error);
      throw error;
    }
    return await this.settled();
  }

  failExternallyPersisted(reason: string): void {
    if (this.externallyFailed || this.terminal) return;
    this.externallyFailed = true;
    this.state = { ...this.state, status: "failed", error: reason };
    this.log({ event: "coordinator_external_failure", scanId: this.state.scanId, reason });
    this.abortController.abort(reason);
    this.publicationAbortController.abort(reason);
    // The caller already persisted this failure. Keep that stable state while
    // run() waits for workers instead of rewriting it as cancellation.
  }

  private async run(): Promise<void> {
    try {
      await ensureDeepScanDirectories(this.artifacts);
      if (this.canceled || this.externallyFailed) return;

      this.phase = "discovery";
      const loopResult = await this.runScans();
      if (this.canceled || this.externallyFailed) return;
      this.phase = "terminal";
      const draft = loopResult.result
        ? {
            ...structuredClone(loopResult.result),
            coverage: combinePassCoverage(loopResult.accepted, this.state.scanDir)
          }
        : scanDraftInputSchema.parse({
            scanId: this.state.scanId,
            findings: [],
            coverage: {
              completeness: "partial",
              surfaces: [],
              explicitExclusions: [],
              deferred: [
                {
                  reason:
                    "The configured discovery time limit elapsed before any source review completed."
                }
              ]
            }
          });
      if (this.deadlineInterruptedPasses.size > 0) {
        draft.coverage.completeness = "partial";
        draft.coverage.deferred = [
          ...(draft.coverage.deferred as unknown[]),
          ...[...this.deadlineInterruptedPasses].map((directory) => ({
            reason: "The discovery time limit interrupted a Standard scan. " +
              "Its unfinished work was not merged; any saved checkpoints remain under " +
              `${relative(this.state.scanDir, directory).split(sep).join("/")}.`
          }))
        ];
      }
      if (draft.scanId !== this.state.scanId) {
        throw new Error("Deep Scan aggregate does not match its authoritative scan identity.");
      }
      await this.options.onComplete?.(draft, this.publicationAbortController.signal);
      if (this.canceled || this.externallyFailed) return;
      this.state = await this.finishWithReplay(loopResult);
      if (this.canceled || this.externallyFailed) return;
      this.log({
        event: "coordinator_terminal",
        scanId: this.state.scanId,
        reason: loopResult.reason
      });
      this.finishLocally(this.state);
    } catch (error) {
      if (this.canceled || this.externallyFailed) {
        return;
      }
      if (
        await this.stopAfterOwnershipChange(
          this.options.threadId,
          isStaleCoordinatorGenerationError(error)
        )
      ) {
        return;
      }
      const message = errorMessage(error);
      const persistedMessage = boundedDeepScanErrorMessage(error);
      if (this.phase === "setup") {
        this.log({ event: "setup_failed", scanId: this.state.scanId, reason: errorKind(error) });
      }
      this.abortController.abort(message);
      try {
        this.state = await this.options.store.fail(this.state.scanId, persistedMessage, "failed");
      } catch (persistError) {
        this.state = { ...this.state, status: "failed", error: persistedMessage };
        this.log({
          event: "coordinator_failure_persistence_error",
          scanId: this.state.scanId,
          reason: errorKind(persistError)
        });
      }
      this.log({
        event: "coordinator_failed",
        scanId: this.state.scanId,
        reason: errorKind(error)
      });
    } finally {
      // The scan batch and reducer have settled before stopped-result publication.
      this.resolveCancellationReady();
      await this.cancellationPersistence?.promise;
      if (this.options.onStopped && this.options.threadId) {
        let current: DeepScanRunState | undefined;
        try {
          current = await this.options.store.get(this.state.scanId, this.options.threadId);
        } catch (error) {
          this.log({
            event: "coordinator_terminal_state_read_failed",
            scanId: this.state.scanId,
            reason: errorKind(error)
          });
        }
        if (
          current &&
          (current.status === "failed" || current.status === "canceled") &&
          current.coordinatorGeneration === this.options.run.coordinatorGeneration
        ) {
          try {
            await this.options.onStopped(current);
          } catch (error) {
            const publicationFailure = boundedDeepScanErrorMessage(
              `Saved result publication failed: ${boundedDeepScanErrorMessage(error)}`
            );
            const originalFailure = current.error?.trim();
            const diagnostic = originalFailure
              ? boundedDeepScanErrorPair(
                  publicationFailure,
                  "\nOriginal Deep Scan failure:\n",
                  originalFailure
                )
              : publicationFailure;
            const localState = {
              ...this.state,
              error: diagnostic
            };
            try {
              this.state = await this.options.store.recordStoppedPublicationFailure(
                this.state.scanId,
                publicationFailure,
                current.coordinatorGeneration
              );
            } catch (persistError) {
              this.state = localState;
              this.log({
                event: "coordinator_result_preservation_failure_persistence_error",
                scanId: this.state.scanId,
                reason: errorKind(persistError)
              });
            }
            this.log({
              event: "coordinator_result_preservation_failed",
              scanId: this.state.scanId,
              reason: errorKind(error)
            });
          }
        }
      }
      if (this.canceled || this.externallyFailed) {
        this.log({ event: "coordinator_cleanup_settled", scanId: this.state.scanId });
      }
      if (this.canceled) this.state = { ...this.state, status: "canceled" };
      this.finishLocally(this.state);
    }
  }

  private finishLocally(state: DeepScanRunState): void {
    if (this.terminal) return;
    this.terminal = true;
    if (this.heartbeatTimeout !== undefined) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
    if (this.discoveryTimeout !== undefined) {
      clearTimeout(this.discoveryTimeout);
      this.discoveryTimeout = undefined;
    }
    this.resolveTerminal(cloneState(state));
  }

  private failLocally(error: unknown): void {
    if (this.terminal) return;
    this.terminal = true;
    if (this.heartbeatTimeout !== undefined) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
    if (this.discoveryTimeout !== undefined) {
      clearTimeout(this.discoveryTimeout);
      this.discoveryTimeout = undefined;
    }
    this.rejectTerminal(error);
  }

  private scheduleDiscoveryDeadline(): void {
    const now = this.clock.now();
    const createdAt = this.state.createdAt === undefined ? now : Date.parse(this.state.createdAt);
    const startedAt = Number.isFinite(createdAt) ? createdAt : now;
    const discoveryTimeoutMs =
      this.options.discoveryTimeoutMs ??
      (this.state.config.maxTimeHours ?? DEFAULT_DISCOVERY_TIMEOUT_HOURS) * 60 * 60 * 1_000;
    const remainingMs = startedAt + discoveryTimeoutMs - now;
    if (remainingMs <= 0) {
      this.stopDiscoveryAtDeadline();
      return;
    }
    this.discoveryTimeout = setTimeout(() => {
      this.discoveryTimeout = undefined;
      this.stopDiscoveryAtDeadline();
    }, remainingMs);
    this.discoveryTimeout.unref?.();
  }

  private stopDiscoveryAtDeadline(): void {
    if (this.terminal || this.discoveryDeadlineReached) return;
    this.discoveryDeadlineReached = true;
    this.log({ event: "discovery_deadline_reached", scanId: this.state.scanId });
    this.discoveryAbortController.abort("deep_scan_discovery_deadline_reached");
  }

  private scheduleHeartbeat(): void {
    if (this.terminal || !this.options.threadId || !this.state.coordinatorGeneration) {
      return;
    }
    this.heartbeatTimeout = setTimeout(() => {
      void this.renewHeartbeat();
    }, this.options.heartbeatIntervalMs ?? COORDINATOR_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimeout.unref?.();
  }

  private async renewHeartbeat(): Promise<void> {
    const threadId = this.options.threadId;
    if (this.terminal || !threadId) return;
    try {
      const renewed = await this.options.store.heartbeatCoordinator({
        scanId: this.state.scanId,
        threadId,
        handoffClaimToken: this.options.handoffClaimToken
      });
      this.state = {
        ...this.state,
        updatedAt: renewed.updatedAt
      };
    } catch (error) {
      this.log({
        event: "coordinator_heartbeat_failed",
        scanId: this.state.scanId,
        reason: errorKind(error)
      });
    }
    this.scheduleHeartbeat();
    if (this.terminal || this.ownershipCheck) return;
    const ownershipCheck = this.stopAfterOwnershipChange(threadId, false);
    this.ownershipCheck = ownershipCheck;
    try {
      await ownershipCheck;
    } finally {
      if (this.ownershipCheck === ownershipCheck) this.ownershipCheck = undefined;
    }
  }

  private async stopAfterOwnershipChange(
    threadId: string | undefined,
    leaseLossConfirmed: boolean
  ): Promise<boolean> {
    if (this.externallyFailed || this.terminal || !threadId) return this.externallyFailed;
    let current: DeepScanRunState;
    try {
      current = await this.options.store.get(this.state.scanId, threadId);
    } catch (readError) {
      this.log({
        event: "coordinator_ownership_read_failed",
        scanId: this.state.scanId,
        reason: errorKind(readError)
      });
      if (!leaseLossConfirmed) return false;
      current = this.state;
    }
    const replacementConfirmed =
      leaseLossConfirmed ||
      (current.status === "running" &&
        current.coordinatorGeneration !== undefined &&
        this.state.coordinatorGeneration !== undefined &&
        current.coordinatorGeneration > this.state.coordinatorGeneration);
    if (current.status === "running" && !replacementConfirmed) return false;

    this.externallyFailed = true;
    this.abortController.abort("deep_scan_coordinator_lease_lost");
    this.publicationAbortController.abort("deep_scan_coordinator_lease_lost");
    if (replacementConfirmed && this.options.observeReplacement) {
      try {
        this.state = await this.options.observeReplacement(current);
      } catch (observeError) {
        this.log({
          event: "coordinator_replacement_observation_failed",
          scanId: this.state.scanId,
          reason: errorKind(observeError)
        });
        this.state = {
          ...current,
          status: "failed",
          error: `Deep Scan replacement observation failed: ${errorMessage(observeError)}`
        };
      }
    } else {
      this.state = current;
    }
    this.finishLocally(this.state);
    return true;
  }

  private async runScans(): Promise<ScanLoopResult> {
    const config = this.state.config;
    const accepted = await this.recoverAcceptedDiscoveries();
    const mergedIds = new Set(
      (this.state.persistedWorkers ?? [])
        .filter((worker) => worker.kind === "discovery" && worker.mergeState === "merged")
        .map((worker) => worker.id)
    );
    let pending = accepted.filter((worker) => !mergedIds.has(worker.id));
    let { resultPath, result } = await this.recoverCompletedReducers(accepted);
    let workerSequence = Math.max(
      this.state.dispatchedCount,
      ...(this.state.persistedWorkers ?? [])
        .filter((worker) => worker.kind === "discovery")
        .map((worker) => workerLabelSequence(worker, "discovery"))
    );
    let reducerSequence = Math.max(
      0,
      ...(this.state.persistedWorkers ?? [])
        .filter((worker) => worker.kind === "dedup")
        .map((worker) => workerLabelSequence(worker, "dedup"))
    );
    const errorLimit = config.stopAfterConsecutiveErrors;
    let reducerFailures = persistedReducerFailureStreak(this.state.persistedWorkers ?? []);
    let lastFailure = latestPersistedReplaceableFailure(this.state.persistedWorkers ?? []);
    if (this.state.consecutiveErrors >= errorLimit) {
      throw discoveryErrorLimitError(
        this.state.consecutiveErrors,
        errorLimit,
        lastFailure?.kind ?? "transient_error",
        lastFailure?.message ?? "persisted failure evidence is unavailable"
      );
    }
    if (reducerFailures >= errorLimit) {
      const failure = [...(this.state.persistedWorkers ?? [])]
        .reverse()
        .find((worker) => worker.kind === "dedup" && worker.status === "failed");
      throw reducerErrorLimitError(
        reducerFailures,
        errorLimit,
        failure?.error ?? "persisted reducer failure evidence is unavailable"
      );
    }
    await this.options.store.updateProgress({
      scanId: this.state.scanId,
      phase: "discovery",
      handoffClaimToken: this.options.handoffClaimToken
    });
    this.logProgress(accepted.length);

    for (;;) {
      if (this.abortController.signal.aborted) throw abortError(this.abortController.signal.reason);
      // Saved results are merged before another independent batch is launched.
      if (pending.length > 0) {
        const outcome = await this.workers.runReducer({
          id: randomUUID(),
          label: `dedup-${String(++reducerSequence).padStart(4, "0")}`,
          consumed: pending.sort(compareCompletionSequence),
          previousReducerResultPath: resultPath
        });
        if ("status" in outcome) {
          reducerFailures += 1;
          this.log({
            event: "dedup_worker_replaced",
            scanId: this.state.scanId,
            workerId: outcome.id,
            reason: errorKind(outcome.error),
            count: reducerFailures
          });
          if (reducerFailures >= errorLimit) {
            throw reducerErrorLimitError(
              reducerFailures,
              errorLimit,
              outcome.error.message,
              outcome.error
            );
          }
          continue;
        }
        reducerFailures = 0;
        this.state = outcome.run;
        resultPath = outcome.resultPath;
        result = outcome.result;
        pending = [];
      }
      if (this.abortController.signal.aborted) throw abortError(this.abortController.signal.reason);
      if (
        !this.discoveryDeadlineReached &&
        result &&
        this.state.noNewStreak >= config.stopAfterNoNew
      ) {
        return { reason: "saturated", result, accepted };
      }
      if (this.discoveryDeadlineReached || this.state.dispatchedCount >= config.maxDiscoveryRuns) {
        if (!result && lastFailure) {
          throw new Error(
            "Deep Scan reached its configured discovery limit without accepting a " +
              `complete discovery; last failure (${lastFailure.kind}): ${lastFailure.message}`
          );
        }
        if (!result && !this.discoveryDeadlineReached) {
          throw new Error("Deep Scan ended without a successfully reduced Standard scan.");
        }
        return { reason: "capped", result, accepted };
      }

      const count = Math.min(config.workers, config.maxDiscoveryRuns - this.state.dispatchedCount);
      const batch = Array.from({ length: count }, async () => {
        const workerId = randomUUID();
        const label = `discovery-${String(++workerSequence).padStart(4, "0")}`;
        this.state = { ...this.state, dispatchedCount: this.state.dispatchedCount + 1 };
        try {
          const outcome = await this.discoveryWorkers.runDiscoveryWorker(workerId, label);
          if (outcome.status === "succeeded") {
            accepted.push(outcome.worker);
            pending.push(outcome.worker);
            this.state = { ...this.state, consecutiveErrors: 0 };
            this.logProgress(accepted.length);
          } else if (outcome.status === "failed") {
            if (!outcome.replaceableFailureKind) throw outcome.error;
            lastFailure = { kind: outcome.replaceableFailureKind, message: outcome.error.message };
            const consecutiveErrors = outcome.consecutiveErrors ?? this.state.consecutiveErrors + 1;
            this.state = { ...this.state, consecutiveErrors };
            this.log({
              event: "discovery_worker_replaced",
              scanId: this.state.scanId,
              workerId,
              reason: outcome.replaceableFailureKind,
              count: consecutiveErrors
            });
            if (consecutiveErrors >= errorLimit) {
              throw discoveryErrorLimitError(
                consecutiveErrors,
                errorLimit,
                outcome.replaceableFailureKind,
                outcome.error.message,
                outcome.error
              );
            }
          } else if (this.discoveryDeadlineReached) {
            this.deadlineInterruptedPasses.add(join(this.artifacts.workersRoot, label, "output"));
          } else if (!this.discoveryAbortController.signal.aborted) {
            throw new Error(`Discovery worker ${workerId} was canceled unexpectedly.`);
          }
        } catch (error) {
          this.abortController.abort(errorMessage(error));
          throw error;
        }
      });
      // Each pass saves its result as it finishes; neither failures nor a fast
      // pass may leave another writer running when merging or publishing starts.
      const outcomes = await Promise.allSettled(batch);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") throw outcome.reason;
      }
    }
  }

  private async recoverAcceptedDiscoveries(): Promise<AcceptedDiscovery[]> {
    const recovered: AcceptedDiscovery[] = [];
    for (const worker of this.state.persistedWorkers ?? []) {
      if (worker.kind !== "discovery" || worker.status !== "succeeded") continue;
      if (!worker.resultManifestPath || !worker.completionSequence) {
        throw new Error(`Accepted discovery ${worker.id} has incomplete persisted evidence.`);
      }
      const result = await validateDiscoveryArtifacts(
        this.artifacts,
        worker.resultManifestPath,
        this.state.scanId
      );
      recovered.push({
        id: worker.id,
        resultPath: worker.resultManifestPath,
        completionSequence: worker.completionSequence,
        coverage: result.coverage
      });
    }
    return recovered.sort(compareCompletionSequence);
  }

  private async recoverCompletedReducers(
    discoveries: AcceptedDiscovery[]
  ): Promise<{ resultPath?: string; result?: DeepReductionInput }> {
    const discoveryIds = new Set(discoveries.map((worker) => worker.id));
    const inputs = this.state.persistedDedupInputs ?? [];
    const completed = (this.state.persistedWorkers ?? [])
      .filter((worker) => worker.kind === "dedup" && worker.status === "succeeded")
      .sort(
        (left, right) =>
          workerLabelSequence(left, "dedup") - workerLabelSequence(right, "dedup") ||
          left.id.localeCompare(right.id)
      );
    let resultPath: string | undefined;
    let result: DeepReductionInput | undefined;
    for (const worker of completed) {
      if (!worker.resultManifestPath) {
        throw new Error(`Completed reducer ${worker.id} has no persisted result manifest.`);
      }
      const consumed = inputs.filter((input) => input.dedupWorkerId === worker.id);
      if (
        consumed.length === 0 ||
        consumed.some((input) => !discoveryIds.has(input.discoveryWorkerId))
      ) {
        throw new Error(`Completed reducer ${worker.id} has incomplete persisted inputs.`);
      }
      const validated = await validateReducerArtifacts(
        {
          artifacts: this.artifacts,
          artifactDir: worker.artifactDir,
          resultPath: worker.resultManifestPath,
          reducerId: worker.id,
          previousReducerResultPath: resultPath
        },
        this.state.scanId
      );
      result = validated.result;
      resultPath = worker.resultManifestPath;
    }
    return { resultPath, result };
  }

  private logProgress(count: number): void {
    this.log({
      event: "progress_updated",
      scanId: this.state.scanId,
      count,
      completed: count
    });
  }

  /**
   * A workbench process can commit SQLite and still lose its stdout response.
   * Replay the exact idempotent finish once before treating the run as failed;
   * otherwise we could overwrite a successful terminal state after durable success.
   */
  private async finishWithReplay(result: ScanLoopResult): Promise<DeepScanRunState> {
    const input = {
      scanId: this.state.scanId,
      reason: result.reason,
      manifestPath: join(this.state.scanDir, "scan-manifest.json"),
      omittedWorkerIds: []
    };
    try {
      return await this.options.store.finish(input);
    } catch (firstError) {
      this.log({
        event: "coordinator_finish_replay",
        scanId: this.state.scanId,
        reason: errorKind(firstError)
      });
      try {
        return await this.options.store.finish(input);
      } catch (replayError) {
        throw new Error(
          `Deep Scan terminal persistence replay failed: ${errorMessage(replayError)}`,
          { cause: firstError }
        );
      }
    }
  }
}

const systemClock: DeepScanClock = {
  now: () => Date.now(),
  sleep: async (delayMs, signal) => {
    if (signal.aborted) throw abortError(signal.reason);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolvePromise();
      }, delayMs);
      const onAbort = (): void => {
        cleanup();
        rejectPromise(abortError(signal.reason));
      };
      const cleanup = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
};

function combinePassCoverage(
  passes: AcceptedDiscovery[],
  scanDir: string
): ScanDraftInput["coverage"] {
  const coverage: ScanDraftInput["coverage"] = {
    completeness: passes.some((pass) => pass.coverage.completeness === "partial")
      ? "partial"
      : passes.some((pass) => pass.coverage.completeness === "unknown")
        ? "unknown"
        : "complete"
  };
  for (const field of ["surfaces", "explicitExclusions", "deferred", "openQuestions"] as const) {
    const entries = passes.flatMap((pass) => {
      const root = relative(scanDir, dirname(pass.resultPath)).split(sep).join("/");
      return ((pass.coverage[field] as unknown[] | undefined) ?? []).map((value) => {
        if (typeof value !== "object" || value === null) return value;
        const entry = structuredClone(value) as Record<string, unknown>;
        // Independent reviews may choose the same local identifiers.
        if (typeof entry.id === "string") entry.id = `${pass.id}/${entry.id}`;
        if (typeof entry.candidateId === "string") {
          entry.sourceCandidateId = entry.candidateId;
          entry.candidateId = `${pass.id}:${createHash("sha256").update(entry.candidateId).digest("hex")}`;
        }
        if (Array.isArray(entry.surfaceIds))
          entry.surfaceIds = entry.surfaceIds.map((id) => `${pass.id}/${id}`);
        if (Array.isArray(entry.receiptRefs))
          entry.receiptRefs = entry.receiptRefs.map((ref) => `${root}/${ref}`);
        return entry;
      });
    });
    coverage[field] = [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()];
  }
  return coverage;
}

function compareCompletionSequence(left: AcceptedDiscovery, right: AcceptedDiscovery): number {
  return left.completionSequence - right.completionSequence || left.id.localeCompare(right.id);
}

function workerLabelSequence(worker: PersistedDeepScanWorker, kind: "discovery" | "dedup"): number {
  const match = worker.promptPath.match(new RegExp(`${kind}-(\\d+)`));
  return match ? Number(match[1]) : 0;
}

function cloneState(state: DeepScanRunState): DeepScanRunState {
  return { ...state, config: { ...state.config } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function latestPersistedReplaceableFailure(
  workers: PersistedDeepScanWorker[]
): { kind: DeepScanReplaceableFailureKind; message: string } | undefined {
  for (const worker of [...workers].reverse()) {
    const failure = persistedReplaceableFailure(worker);
    if (failure) return failure;
  }
  return undefined;
}

function persistedReducerFailureStreak(workers: PersistedDeepScanWorker[]): number {
  let consecutiveFailures = 0;
  for (const worker of workers) {
    if (worker.kind !== "dedup") continue;
    if (worker.status === "succeeded") consecutiveFailures = 0;
    else if (worker.status === "failed") consecutiveFailures += 1;
  }
  return consecutiveFailures;
}

function persistedReplaceableFailure(
  worker: PersistedDeepScanWorker
): { kind: DeepScanReplaceableFailureKind; message: string } | undefined {
  if (worker.kind !== "discovery" || worker.status !== "canceled" || !worker.error) return undefined;
  const kinds: DeepScanReplaceableFailureKind[] = [
    "policy_refusal",
    "transient_error",
    "invalid_discovery_artifacts"
  ];
  for (const kind of kinds) {
    const prefix = `${kind}:`;
    if (worker.error.startsWith(prefix)) {
      return { kind, message: worker.error.slice(prefix.length).trim() };
    }
  }
  return undefined;
}

function discoveryErrorLimitError(
  count: number,
  limit: number,
  kind: DeepScanReplaceableFailureKind,
  message: string,
  cause?: Error
): Error {
  const detail = `Deep Scan stopped after ${count} consecutive unsuccessful discovery workers `
    + `(limit: ${limit}); last failure (${kind}): ${message}`;
  return cause ? new Error(detail, { cause }) : new Error(detail);
}

function reducerErrorLimitError(
  count: number,
  limit: number,
  message: string,
  cause?: Error
): Error {
  const detail = `Deep Scan stopped after ${count} consecutive unsuccessful reducer workers `
    + `(limit: ${limit}); last failure: ${message}`;
  return cause ? new Error(detail, { cause }) : new Error(detail);
}

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code ? `${error.name}:${code}` : error.name;
}

function abortError(reason?: unknown): Error {
  const error = new Error("Deep Scan worker was aborted.", { cause: reason });
  error.name = "AbortError";
  return error;
}
