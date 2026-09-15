import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import {
  deduplicateRecords,
  type DeduplicationReviewRequest,
} from "../src/deduplication/records.js";
import {
  runRecordDedupeCli,
  runRecordDedupeProtocol,
} from "../src/deduplication/records-cli.js";
import { record, submission } from "./record-deduplication-fixtures.js";

const first = record(1),
  second = record(2);
const params = {
  protocolVersion: 2,
  observations: [first],
  candidates: [second],
  candidateRelationships: [
    { observationId: first.findingId, candidateIds: [second.findingId] },
  ],
  concurrency: 2,
};
type Message = {
  jsonrpc: "2.0";
  id: string | number | null;
  method?: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};
function session() {
  const input = new PassThrough(),
    output = new PassThrough();
  const lines = createInterface({ input: output });
  const messages: Message[] = [],
    waiting: ((message: Message) => void)[] = [];
  lines.on("line", (line) => {
    const message: Message = JSON.parse(line),
      next = waiting.shift();
    if (next) next(message);
    else messages.push(message);
  });
  const done = runRecordDedupeProtocol(input, output);
  const send = (message: unknown) =>
    input.write(`${JSON.stringify(message)}\n`);
  const next = async (): Promise<Message> =>
    messages.shift() ?? (await new Promise((resolve) => waiting.push(resolve)));
  const reply = (message: Message, result: unknown) =>
    send({ jsonrpc: "2.0", id: message.id, result });
  const run = (options: unknown = params) =>
    send({ jsonrpc: "2.0", id: "run", method: "run", params: options });
  const close = () => {
    input.destroy();
    output.destroy();
    lines.close();
  };
  return {
    input,
    done,
    send,
    next,
    reply,
    run,
    [Symbol.dispose]: close,
  };
}
async function drive(
  options: Record<string, unknown> = params,
  review = submission,
) {
  using s = session();
  const methods: string[] = [];
  s.run(options);
  for (;;) {
    const message = await s.next();
    if (!message.method) return { message, exit: await s.done, methods };
    methods.push(message.method);
    expect(message.method).toBe("review.run");
    expect(Object.keys(message.params)).toEqual(["request"]);
    s.reply(
      message,
      review(message.params["request"] as DeduplicationReviewRequest),
    );
  }
}
test("protocol v2 and SDK return identical groups using only review.run", async () => {
  const direct = await deduplicateRecords({
    ...params,
    reviewRunner: { run: async (request) => submission(request) },
  });
  const result = await drive();
  expect(result.exit).toBe(0);
  expect(result.message.result).toEqual(direct);
  expect(result.methods).toEqual(["review.run", "review.run"]);
  expect(Object.keys(result.message.result as object).sort()).toEqual([
    "deduplicationStatus",
    "duplicateGroups",
    "uniqueFindingIds",
  ]);
});
test("host can replay saved raw responses after a lost review reply", async () => {
  const saved = new Map<string, unknown>();
  {
    using s = session();
    s.run();
    const request = await s.next();
    const assignment = request.params["request"] as DeduplicationReviewRequest;
    saved.set(JSON.stringify(assignment), submission(assignment));
    s.input.end();
    expect(await s.done).toBe(2);
  }
  let executions = 0;
  const replay = await drive(params, (request) => {
    const key = JSON.stringify(request);
    if (saved.has(key)) return saved.get(key);
    executions++;
    const value = submission(request);
    saved.set(key, value);
    return value;
  });
  expect(replay.exit).toBe(0);
  expect(executions).toBe(1);
  expect(replay.message.result).toEqual((await drive()).message.result);
  const key = [...saved.keys()].find(
    (key) => JSON.parse(key).stage === "pair-review",
  )!;
  saved.set(key, {
    ...(saved.get(key) as object),
    canonicalFindingId: "foreign",
  });
  const invalid = await drive(params, (request) =>
    saved.get(JSON.stringify(request)),
  );
  expect(invalid.exit).toBe(2);
  expect(invalid.message.result).toBeUndefined();
});
test.each(["SAME", "DISTINCT"] as const)(
  "prior %s survives missing nominations with no callback",
  async (decision) => {
    const result = await drive({
      ...params,
      candidateRelationships: [
        { observationId: first.findingId, candidateIds: [] },
      ],
      priorDecisions: [
        { findingIds: [first.findingId, second.findingId], decision },
      ],
    });
    expect(result.exit).toBe(0);
    expect(result.methods).toEqual([]);
    expect(result.message.result).toMatchObject({
      duplicateGroups:
        decision === "SAME" ? [[first.findingId, second.findingId]] : [],
    });
  },
);
test.each([
  { candidates: [] },
  { candidateRelationships: [] },
  { candidates: [{ ...first, evidence: { changed: true } }] },
  { candidates: [{}] },
  { observations: [{ findingId: "legacy", title: "Not an envelope" }] },
  { protocolVersion: 1 },
  { recordFormat: "evidence-v1" },
  { checkpoints: true },
  { scopeKey: "removed" },
  { sourceManifest: {} },
  { sourceTools: [] },
  { settingsDigest: "removed" },
  {
    priorDecisions: [
      {
        findingIds: [first.findingId, second.findingId],
        decision: "SAME",
        bindingDigest: "removed",
      },
    ],
  },
])(
  "invalid or removed protocol inputs fail before review: %j",
  async (change) => {
    const result = await drive({ ...params, ...change });
    expect(result.exit).toBe(2);
    expect(result.methods).toEqual([]);
    expect(result.message.result).toBeUndefined();
  },
);
test("incomplete model output fails without producing DISTINCT", async () => {
  const result = await drive(params, () => ({}));
  expect(result.exit).toBe(2);
  expect(result.message.result).toBeUndefined();
});
test("completion waits for the host review response", async () => {
  using s = session();
  let settled = false;
  s.done.then(() => {
    settled = true;
  });
  s.run();
  const screening = await s.next();
  await Promise.resolve();
  expect(settled).toBe(false);
  s.reply(
    screening,
    submission(screening.params["request"] as DeduplicationReviewRequest),
  );
  const pair = await s.next();
  await Promise.resolve();
  expect(settled).toBe(false);
  s.reply(
    pair,
    submission(pair.params["request"] as DeduplicationReviewRequest),
  );
  expect((await s.next()).result).toBeDefined();
  expect(await s.done).toBe(0);
});
test.each(["orphan", "malformed", "duplicate"])(
  "rejects %s callback replies",
  async (kind) => {
    using s = session();
    s.run();
    const callback = await s.next();
    expect(callback.method).toBe("review.run");
    if (kind === "duplicate") {
      s.reply(
        callback,
        submission(callback.params["request"] as DeduplicationReviewRequest),
      );
      s.reply(callback, {});
    } else if (kind === "orphan")
      s.send({ jsonrpc: "2.0", id: "unknown", result: {} });
    else
      s.send({
        jsonrpc: "2.0",
        id: callback.id,
        result: {},
        error: { code: 1, message: "both" },
      });
    expect(await s.done).toBe(2);
    expect((await s.next()).error).toBeDefined();
  },
);
test.each(["cancel", "eof", "host-error"])(
  "%s rejects the pending review without a verdict",
  async (kind) => {
    using s = session();
    s.run();
    const callback = await s.next();
    if (kind === "cancel") s.send({ jsonrpc: "2.0", method: "cancel" });
    else if (kind === "eof") s.input.end();
    else
      s.send({
        jsonrpc: "2.0",
        id: callback.id,
        error: { code: -32001, message: "Source unavailable" },
      });
    expect(await s.done).toBe(kind === "cancel" ? 130 : 2);
    const result = await s.next();
    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
  },
);
test("correlates concurrent reviews independently of response order", async () => {
  using s = session();
  s.run({
    ...params,
    observations: [first, second],
    candidates: [first, second],
    candidateRelationships: [
      { observationId: first.findingId, candidateIds: [second.findingId] },
      { observationId: second.findingId, candidateIds: [first.findingId] },
    ],
  });
  const a = await s.next(),
    b = await s.next();
  expect(a.id).not.toBe(b.id);
  for (const message of [b, a])
    s.reply(
      message,
      submission(message.params["request"] as DeduplicationReviewRequest),
    );
  const pair = await s.next();
  expect((pair.params["request"] as DeduplicationReviewRequest).stage).toBe(
    "pair-review",
  );
  s.reply(
    pair,
    submission(pair.params["request"] as DeduplicationReviewRequest),
  );
  expect((await s.next()).result).toBeDefined();
  expect(await s.done).toBe(0);
});
test("rejects execution flags before reading stdin", async () => {
  let error = "";
  expect(
    await runRecordDedupeCli(
      ["dedupe", "--records", "--concurrency", "2"],
      new Writable({
        write() {
          throw new Error("No protocol output expected");
        },
      }),
      new Writable({
        write(text, _encoding, callback) {
          error += text;
          callback();
        },
      }),
    ),
  ).toBe(2);
  expect(error).toContain("run request");
});

test("input stream errors fail the active run through readline", async () => {
  using s = session();
  s.run();
  expect((await s.next()).method).toBe("review.run");
  s.input.destroy(new Error("Synthetic input failure"));
  expect(await s.done).toBe(2);
  const response = await s.next();
  expect(response.id).toBe("run");
  expect(response.error).toBeDefined();
  expect(response.result).toBeUndefined();
});

test.each(["success", "cancel"])(
  "waits for the final %s write and handles asynchronous output failure",
  async (mode) => {
    const input = new PassThrough();
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    const finalWrite = Promise.withResolvers<void>();
    const send = (message: unknown) =>
      input.write(`${JSON.stringify(message)}\n`);
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (chunk.length === 0) {
          callback();
          return;
        }
        const message = JSON.parse(chunk.toString()) as Message;
        if (message.id === "run") {
          if (mode === "success") expect(message.error).toBeUndefined();
          else expect(message.error?.code).toBe(-32800);
          releaseWrite = callback;
          finalWrite.resolve();
          return;
        }
        callback();
        if (mode === "cancel") {
          send({ jsonrpc: "2.0", method: "cancel" });
        } else {
          expect(message.method).toBe("review.run");
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: submission(
              message.params["request"] as DeduplicationReviewRequest,
            ),
          });
        }
      },
    });
    let settled = false;
    const done = runRecordDedupeProtocol(input, output).then((code) => {
      settled = true;
      return code;
    });
    try {
      send({
        jsonrpc: "2.0",
        id: "run",
        method: "run",
        params: {
          ...params,
          ...(mode === "success"
            ? { observations: [], candidates: [], candidateRelationships: [] }
            : {}),
        },
      });
      await finalWrite.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      const fail = releaseWrite!;
      releaseWrite = undefined;
      fail(new Error("Synthetic asynchronous EPIPE"));
      expect(await done).toBe(2);
      expect(output.listenerCount("error")).toBe(0);
    } finally {
      releaseWrite?.();
      input.destroy();
      output.destroy();
    }
  },
);

test("invalid command diagnostics handle asynchronous output failure", async () => {
  const failure = Promise.withResolvers<void>();
  const diagnostics = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => {
        callback(new Error("Synthetic startup diagnostic EPIPE"));
        failure.resolve();
      });
    },
  });
  try {
    expect(
      await runRecordDedupeCli(
        ["dedupe", "--records", "--concurrency", "2"],
        new Writable({
          write() {
            throw new Error("No protocol output expected");
          },
        }),
        diagnostics,
      ),
    ).toBe(2);
    await failure.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.listenerCount("error")).toBe(0);
  } finally {
    diagnostics.destroy();
  }
});

test("unidentifiable input errors use null", async () => {
  using s = session();
  s.input.write("{malformed-json\n");
  expect(await s.done).toBe(2);
  const error = await s.next();
  expect(error.id).toBeNull();
  expect(error.error?.code).toBe(-32600);
  expect(error.result).toBeUndefined();
});
