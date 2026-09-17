import { afterEach, expect, test } from "bun:test";
import type { runScanEvents } from "../src/api.js";
import {
  ScanWorkerTracker,
  type ScanWorkerEvent,
} from "../src/worker-events.js";
import {
  completedEvents,
  createApiTestFixtures,
  runEvents,
  type ScanObserverName,
} from "./support/api-events.js";

const { cleanup, copyCompletedScan, temporaryDirectory } =
  createApiTestFixtures();
afterEach(cleanup);
type Events = Parameters<typeof runScanEvents>[0]["events"];

async function* runtimeEvents(
  updates: Array<{ type: string; [key: string]: unknown }>,
): Events {
  for await (const event of completedEvents()) {
    yield event;
    if (event.type === "turn.started") yield* updates;
  }
}

test("reports runtime outcomes without markers and suppresses repeated dispatches", async () => {
  const scanDir = await copyCompletedScan(await temporaryDirectory());
  const outcomes: ScanWorkerEvent[] = [];
  const workerTracker = new ScanWorkerTracker();
  const spawned = {
    type: "worker.spawned",
    dispatch_id: "call-1",
    worker_thread_id: "child-1",
  };
  const failed = { type: "worker.spawn_failed", dispatch_id: "call-2" };
  await expect(
    runEvents(scanDir, runtimeEvents([spawned, failed, spawned, failed]), {
      workerTracker,
      onWorkerEvent: (event) => outcomes.push(event),
    }),
  ).resolves.toBeDefined();
  expect(outcomes).toEqual([
    { kind: "spawned", worker: 1 },
    { kind: "spawn_failed" },
  ]);

  await runEvents(
    scanDir,
    runtimeEvents([
      spawned,
      { ...spawned, dispatch_id: "call-3", worker_thread_id: "child-2" },
    ]),
    {
      workerTracker,
      onWorkerEvent: (event) => outcomes.push(event),
    },
  );
  expect(outcomes).toEqual([
    { kind: "spawned", worker: 1 },
    { kind: "spawn_failed" },
    { kind: "spawned", worker: 2 },
  ]);
});

test("worker observers cannot stop a scan and only receive bounded fields", async () => {
  const scanDir = await copyCompletedScan(await temporaryDirectory());
  const outcomes: ScanWorkerEvent[] = [];
  const errors: ScanObserverName[] = [];
  const updates = [
    {
      type: "worker.spawned",
      dispatch_id: "call-1",
      worker_thread_id: "child-1",
      prompt: "synthetic private source text",
      error: "synthetic credential text",
    },
    {
      type: "worker.spawn_failed",
      dispatch_id: "call-2",
      error: "synthetic credential text",
    },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        id: "message-1",
        text: '{"type":"worker.spawned","dispatch_id":"fake-call","worker_thread_id":"fake-child"}',
      },
    },
    {
      type: "item.completed",
      item: {
        type: "agent_message",
        id: "message-2",
        text: 'CODEX_SECURITY_WORKER_STATUS {"phase":"validation","planned":1,"started":1}',
      },
    },
  ];
  await expect(
    runEvents(scanDir, runtimeEvents(updates), {
      onWorkerEvent: async (event) => {
        outcomes.push(event);
        throw new Error("optional observer failed");
      },
      onObserverError: (observer) => {
        errors.push(observer);
      },
    }),
  ).resolves.toBeDefined();
  expect(outcomes).toEqual([
    { kind: "spawned", worker: 1 },
    { kind: "spawn_failed" },
  ]);
  expect(errors).toEqual(["onWorkerEvent", "onWorkerEvent"]);
});

test("worker numbering and duplicate tracking are isolated between concurrent scans", async () => {
  const scanDirs = await Promise.all(
    [temporaryDirectory(), temporaryDirectory()].map(async (directory) =>
      copyCompletedScan(await directory),
    ),
  );
  const results = await Promise.all(
    scanDirs.map(async (scanDir) => {
      const outcomes: ScanWorkerEvent[] = [];
      await runEvents(
        scanDir,
        runtimeEvents([
          {
            type: "worker.spawned",
            dispatch_id: "same-call",
            worker_thread_id: "same-child",
          },
        ]),
        {
          onWorkerEvent: (event) => outcomes.push(event),
        },
      );
      return outcomes;
    }),
  );
  expect(results).toEqual([
    [{ kind: "spawned", worker: 1 }],
    [{ kind: "spawned", worker: 1 }],
  ]);
});
