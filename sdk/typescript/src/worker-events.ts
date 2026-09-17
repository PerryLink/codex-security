/** A runtime spawn outcome from the scan's main agent. No model text is included. */
export type ScanWorkerEvent =
  { kind: "spawned"; worker: number } | { kind: "spawn_failed" };

/** Shares scan-local worker numbers with activity and session observers. */
export class ScanWorkerTracker {
  readonly #workers = new Map<string, number>();
  readonly #dispatches = new Set<string>();

  public workerNumber(threadId: string): number {
    let worker = this.#workers.get(threadId);
    if (worker === undefined) {
      worker = this.#workers.size + 1;
      this.#workers.set(threadId, worker);
    }
    return worker;
  }

  public eventFromRuntime(
    event: Readonly<Record<string, unknown>>,
  ): ScanWorkerEvent | null {
    const type = event["type"];
    const dispatchId = event["dispatch_id"];
    if (
      (type !== "worker.spawned" && type !== "worker.spawn_failed") ||
      typeof dispatchId !== "string" ||
      this.#dispatches.has(dispatchId)
    )
      return null;
    let outcome: ScanWorkerEvent;
    if (type === "worker.spawned") {
      const threadId = event["worker_thread_id"];
      if (typeof threadId !== "string") return null;
      outcome = { kind: "spawned", worker: this.workerNumber(threadId) };
    } else {
      outcome = { kind: "spawn_failed" };
    }
    this.#dispatches.add(dispatchId);
    return outcome;
  }
}
