import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { expect, test } from "bun:test";
import type { Finding, FindingsDocument } from "../src/models.js";
import type { DeduplicationReviewRequest } from "../src/deduplication/records.js";
import {
  runRecordDedupeCli,
  runRecordDedupeProtocol,
} from "../src/deduplication/records-cli.js";
import { PLUGIN_ROOT } from "./plugin-root.js";

const fixture: FindingsDocument = JSON.parse(
  await readFile(
    join(PLUGIN_ROOT, "examples/completed-scan/findings.json"),
    "utf8",
  ),
);
function finding(n: number): Finding {
  return {
    ...structuredClone(fixture.findings[0]!),
    findingId: `csf_${n.toString(16).padStart(24, "0")}`,
    occurrenceId: `occ_${n.toString(16).padStart(24, "0")}`,
    title: `Synthetic issue ${n}`,
  };
}
const first = finding(1),
  second = finding(2);
const params = {
  observations: [first],
  scopeKey: "synthetic-scope",
  sourceManifest: { revision: "synthetic-revision" },
  concurrency: 2,
};
type Message = {
  jsonrpc: "2.0";
  id: string | number;
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
  const initialize = async (checkpoints = false) => {
    send({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: { protocolVersion: 1, checkpoints },
    });
    expect((await next()).result).toEqual({ protocolVersion: 1 });
  };
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
    initialize,
    run,
    close,
  };
}
function reviewResult(request: DeduplicationReviewRequest): unknown {
  if (request.stage === "screening")
    return {
      decisions: {
        "pair-1": {
          decision: "SAME",
          rationale: "One correction addresses both paths.",
        },
      },
    };
  return {
    decision: "SAME",
    rationale: "One correction addresses both paths.",
    canonicalFindingId: first.findingId,
    mergedFinding: first,
  };
}
async function drive(
  checkpoints: Map<string, unknown>,
  options: {
    malformedReview?: boolean;
    onPut?: () => Promise<void>;
    priorDecisions?: unknown[];
  } = {},
) {
  const s = session(),
    methods: string[] = [];
  try {
    await s.initialize(true);
    s.run({
      ...params,
      ...(options.priorDecisions
        ? { priorDecisions: options.priorDecisions }
        : {}),
    });
    for (;;) {
      const message = await s.next();
      if (!message.method) return { message, exit: await s.done, methods };
      methods.push(message.method);
      switch (message.method) {
        case "source.verify":
          s.reply(message, null);
          break;
        case "candidates.get":
          s.reply(message, [second]);
          break;
        case "checkpoint.get":
          s.reply(
            message,
            checkpoints.get(String(message.params["key"])) ?? null,
          );
          break;
        case "checkpoint.put":
          await options.onPut?.();
          checkpoints.set(
            String(message.params["key"]),
            message.params["result"],
          );
          expect(message.params["binding"]).toBeObject();
          s.reply(message, null);
          break;
        case "review.run":
          s.reply(
            message,
            options.malformedReview
              ? {}
              : reviewResult(
                  message.params["request"] as DeduplicationReviewRequest,
                ),
          );
          break;
        default:
          throw new Error(`Unexpected callback: ${message.method}`);
      }
    }
  } finally {
    s.close();
  }
}

test("runs the SDK and reuses host-persisted validated checkpoints", async () => {
  const checkpoints = new Map<string, unknown>(),
    fresh = await drive(checkpoints);
  expect(fresh.exit).toBe(0);
  expect(fresh.message.error).toBeUndefined();
  expect(fresh.message.result).toMatchObject({
    deduplicationStatus: "completed",
    pairOutcomes: [{ decision: "SAME" }],
  });
  expect(checkpoints.size).toBeGreaterThan(0);
  const resumed = await drive(checkpoints);
  expect(resumed.exit).toBe(0);
  expect(resumed.message.result).toEqual(fresh.message.result);
  expect(resumed.methods).not.toContain("review.run");
  expect(resumed.methods).toContain("source.verify");
  const prior = await drive(new Map(), {
    priorDecisions: (fresh.message.result as { pairOutcomes: unknown[] })
      .pairOutcomes,
  });
  expect(prior.exit).toBe(0);
  expect(prior.methods).not.toContain("review.run");
  expect(prior.message.result).toMatchObject({
    pairOutcomes: [{ origin: "prior", checkpointKeys: [] }],
  });
});
test("malformed model output fails instead of producing DISTINCT", async () => {
  const result = await drive(new Map(), { malformedReview: true });
  expect(result.exit).toBe(2);
  expect(result.message.error).toBeDefined();
  expect(result.message.result).toBeUndefined();
  expect(result.methods).not.toContain("checkpoint.put");
});
test("checkpoint completion waits for the host acknowledgement", async () => {
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let completed = false;
  const result = drive(new Map(), {
    onPut: async () => {
      entered();
      await barrier;
    },
  }).then((value) => {
    completed = true;
    return value;
  });
  await reached;
  expect(completed).toBe(false);
  release();
  expect((await result).exit).toBe(0);
});
test.each(["orphan", "malformed", "duplicate"])(
  "rejects %s callback replies",
  async (kind) => {
    const s = session();
    try {
      await s.initialize();
      s.run();
      const callback = await s.next();
      expect(callback.method).toBe("source.verify");
      if (kind === "duplicate") {
        s.reply(callback, null);
        s.reply(callback, null);
      } else if (kind === "orphan")
        s.send({ jsonrpc: "2.0", id: "unknown", result: null });
      else
        s.send({
          jsonrpc: "2.0",
          id: callback.id,
          result: null,
          error: { code: 1, message: "both" },
        });
      expect(await s.done).toBe(2);
      expect((await s.next()).error).toBeDefined();
    } finally {
      s.close();
    }
  },
);
test.each(["cancel", "eof", "host-error", "bad-ack"])(
  "%s rejects pending source verification",
  async (kind) => {
    const s = session();
    try {
      await s.initialize();
      s.run();
      const callback = await s.next();
      if (kind === "cancel") s.send({ jsonrpc: "2.0", method: "cancel" });
      else if (kind === "eof") s.input.end();
      else if (kind === "bad-ack") s.reply(callback, {});
      else
        s.send({
          jsonrpc: "2.0",
          id: callback.id,
          error: { code: -32001, message: "Synthetic source unavailable." },
        });
      expect(await s.done).toBe(kind === "cancel" ? 130 : 2);
      const result = await s.next();
      expect(result.id).toBe("run");
      expect(result.error).toBeDefined();
      expect(result.result).toBeUndefined();
    } finally {
      s.close();
    }
  },
);
test("correlates concurrent callbacks independently of reply order", async () => {
  const s = session();
  try {
    await s.initialize();
    s.run({ ...params, observations: [first, second] });
    s.reply(await s.next(), null);
    const a = await s.next(),
      b = await s.next();
    expect(a.method).toBe("candidates.get");
    expect(b.method).toBe("candidates.get");
    expect(a.id).not.toBe(b.id);
    s.reply(b, []);
    s.reply(a, []);
    for (;;) {
      const message = await s.next();
      if (message.id === "run") {
        expect(message.error).toBeUndefined();
        break;
      }
      expect(message.method).toBe("source.verify");
      s.reply(message, null);
    }
    expect(await s.done).toBe(0);
  } finally {
    s.close();
  }
});
test("rejects undeclared run options", async () => {
  const s = session();
  try {
    await s.initialize();
    s.run({ ...params, repositoryPath: "/synthetic/repository" });
    expect(await s.done).toBe(2);
    expect((await s.next()).error).toBeDefined();
  } finally {
    s.close();
  }
});
test("rejects execution flags before reading stdin", async () => {
  let error = "";
  expect(
    await runRecordDedupeCli(
      ["dedupe", "--records", "--concurrency", "2"],
      {
        write() {
          throw new Error("No protocol output expected");
        },
      },
      {
        write(text) {
          error += text;
        },
      },
    ),
  ).toBe(2);
  expect(error).toContain("run request");
});

test("closed output terminates pending callbacks", async () => {
  const input = new PassThrough();
  const done = runRecordDedupeProtocol(input, {
    write() {
      throw new Error("Closed output");
    },
  });
  input.write(
    '{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}\n',
  );
  expect(await done).toBe(2);
  input.destroy();
});

test("unsupported protocol version fails before callback dispatch", async () => {
  const s = session();
  try {
    s.send({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: { protocolVersion: 2 },
    });
    expect(await s.done).toBe(2);
  } finally {
    s.close();
  }
});

test("input stream errors fail the active run through readline", async () => {
  const s = session();
  try {
    await s.initialize();
    s.run();
    expect((await s.next()).method).toBe("source.verify");
    s.input.destroy(new Error("Synthetic input failure"));
    expect(await s.done).toBe(2);
    const response = await s.next();
    expect(response.id).toBe("run");
    expect(response.error).toBeDefined();
    expect(response.result).toBeUndefined();
  } finally {
    s.close();
  }
});

test.each(["success", "cancel"])(
  "waits for the final %s write and handles asynchronous output failure",
  async (mode) => {
    const input = new PassThrough();
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    let reached!: () => void;
    const finalWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
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
          reached();
          return;
        }
        callback();
        if (message.id === "init") {
          send({
            jsonrpc: "2.0",
            id: "run",
            method: "run",
            params: { ...params, observations: [] },
          });
        } else if (mode === "cancel") {
          send({ jsonrpc: "2.0", method: "cancel" });
        } else {
          expect(message.method).toBe("source.verify");
          send({ jsonrpc: "2.0", id: message.id, result: null });
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
        id: "init",
        method: "initialize",
        params: { protocolVersion: 1 },
      });
      await finalWrite;
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
  let failed!: () => void;
  const failure = new Promise<void>((resolve) => {
    failed = resolve;
  });
  const diagnostics = new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => {
        callback(new Error("Synthetic startup diagnostic EPIPE"));
        failed();
      });
    },
  });
  try {
    expect(
      await runRecordDedupeCli(
        ["dedupe", "--records", "--concurrency", "2"],
        {
          write() {
            throw new Error("No protocol output expected");
          },
        },
        diagnostics,
      ),
    ).toBe(2);
    await failure;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.listenerCount("error")).toBe(0);
  } finally {
    diagnostics.destroy();
  }
});
