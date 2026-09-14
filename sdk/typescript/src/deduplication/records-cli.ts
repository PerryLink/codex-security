import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import type { JsonObject } from "../config.js";
import type { Finding } from "../models.js";
import { deduplicateRecords } from "./records.js";

const object = z.record(z.string(), z.json());
const runParams = z.strictObject({
  protocolVersion: z.literal(1),
  checkpoints: z.boolean().default(false),
  observations: z.array(z.unknown()),
  candidates: z.array(z.unknown()),
  candidateRelationships: z.array(
    z.strictObject({
      observationId: z.string(),
      candidateIds: z.array(z.string()),
    }),
  ),
  scopeKey: z.string(),
  sourceManifest: object,
  settingsDigest: z.string().optional(),
  resultToolNamespace: z.string().optional(),
  sourceTools: z
    .array(
      z.strictObject({
        namespace: z.string(),
        name: z.string(),
        description: z.string(),
        inputSchema: object,
        version: z.string(),
      }),
    )
    .optional(),
  priorDecisions: z
    .array(
      // Like the SDK, accept a previous full outcome and retain only its constraint.
      z.object({
        findingIds: z.tuple([z.string(), z.string()]),
        decision: z.enum(["SAME", "DISTINCT"]),
        bindingDigest: z.string(),
      }),
    )
    .optional(),
  concurrency: z.number().int().positive().optional(),
});
const rpcId = z.union([z.string(), z.number().int()]);
const request = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: rpcId,
  method: z.string(),
  params: z.unknown(),
});
const response = z.union([
  z.strictObject({ jsonrpc: z.literal("2.0"), id: rpcId, result: z.unknown() }),
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    id: rpcId,
    error: z.strictObject({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    }),
  }),
]);
const cancel = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.literal("cancel"),
});

type Id = z.infer<typeof rpcId>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

function writeDiagnostic(stream: Writable, message: string): void {
  const ignoreError = () => {};
  const release = () => stream.removeListener("error", ignoreError);
  stream.on("error", ignoreError);
  try {
    // Diagnostics never delay the result; retain their observer for late errors.
    stream.write(message, () => setImmediate(release));
  } catch {
    setImmediate(release);
  }
}

/** One isolated attempt: all source, model and durable state operations belong to the host. */
export async function runRecordDedupeProtocol(
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
): Promise<number> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const controller = new AbortController();
  const pending = new Map<string, Pending>();
  let sequence = 0;
  let runId: Id | undefined;
  let requestId: Id | null = null;
  let finished = false;
  let outputFailed = false;
  let resolveExit!: (code: number) => void;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const send = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  function finish(code: number, error?: Error, rpcCode = -32000): void {
    if (finished) return;
    finished = true;
    controller.abort(
      error ?? new Error("Record deduplication attempt finished."),
    );
    for (const entry of pending.values())
      entry.reject(error ?? new Error("Attempt finished."));
    pending.clear();
    try {
      if (error) {
        send({
          jsonrpc: "2.0",
          id: runId ?? requestId,
          error: { code: rpcCode, message: error.message },
        });
      }
    } catch {
      outputFailed = true;
      // A closed output pipe cannot receive a final protocol error.
    } finally {
      lines.close();
      signal?.removeEventListener("abort", aborted);
      input.removeListener("error", inputError);
      const drained = () => {
        output.removeListener("error", outputError);
        resolveExit(outputFailed ? 2 : code);
      };
      try {
        // Keep the error listener through queued writes and their error events.
        output.write("", (error) => {
          if (error) outputFailed = true;
          // Writable error events can follow callbacks in the same turn.
          setImmediate(drained);
        });
      } catch {
        outputFailed = true;
        setImmediate(drained);
      }
    }
  }
  function aborted(): void {
    finish(130, new Error("Record deduplication canceled."), -32800);
  }
  function outputError(): void {
    outputFailed = true;
    finish(2, new Error("Record protocol output failed."));
  }
  function inputError(): void {
    finish(2, new Error("Record protocol input failed."));
  }
  function call(method: string, params: unknown): Promise<unknown> {
    if (controller.signal.aborted)
      return Promise.reject(controller.signal.reason);
    const id = `sdk:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch {
        finish(2, new Error("Record protocol output failed."));
      }
    });
  }
  async function acknowledge(method: string, params: unknown): Promise<void> {
    if ((await call(method, params)) !== null)
      throw new Error(`${method} requires a null acknowledgement.`);
  }
  function handle(line: string): void {
    if (finished) return;
    requestId = null;
    const value: unknown = JSON.parse(line);
    if (
      typeof value === "object" &&
      value !== null &&
      "method" in value &&
      "id" in value
    ) {
      const parsedId = rpcId.safeParse(value.id);
      if (parsedId.success) requestId = parsedId.data;
    }
    if (cancel.safeParse(value).success) {
      if (runId === undefined)
        throw new Error("Cancel requires an active run.");
      aborted();
      return;
    }
    // A response is never reinterpreted as another command or a dedupe verdict.
    if (
      typeof value === "object" &&
      value !== null &&
      ("result" in value || "error" in value)
    ) {
      const reply = response.parse(value);
      const entry =
        typeof reply.id === "string" ? pending.get(reply.id) : undefined;
      if (!entry)
        throw new Error(
          "Record protocol received an unknown or duplicate response ID.",
        );
      pending.delete(String(reply.id));
      if ("error" in reply) entry.reject(new Error(reply.error.message));
      else entry.resolve(reply.result);
      return;
    }
    const message = request.parse(value);
    if (message.method !== "run" || runId !== undefined)
      throw new Error("Expected one run request.");
    runId = message.id;
    const params = runParams.parse(message.params);
    void deduplicateRecords({
      ...params,
      observations: params.observations as Finding[],
      sourceManifest: params.sourceManifest as JsonObject,
      candidates: params.candidates as Finding[],
      reviewRunner: {
        run: (review) => call("review.run", { request: review }),
      },
      verifySource: (manifest) => acknowledge("source.verify", { manifest }),
      ...(params.checkpoints
        ? {
            checkpointStore: {
              getReview: (key: string) => call("checkpoint.get", { key }),
              saveReview: (key: string, binding: object, result: unknown) =>
                acknowledge("checkpoint.put", { key, binding, result }),
            },
          }
        : {}),
      signal: controller.signal,
    }).then(
      (result) => {
        if (finished) return;
        try {
          send({ jsonrpc: "2.0", id: runId, result });
          finish(0);
        } catch {
          finish(2, new Error("Record protocol output failed."));
        }
      },
      (error: unknown) => {
        finish(
          2,
          error instanceof Error
            ? error
            : new Error("Record deduplication failed."),
        );
      },
    );
  }
  lines.on("line", (line) => {
    try {
      handle(line);
    } catch (error) {
      finish(
        2,
        error instanceof SyntaxError || error instanceof z.ZodError
          ? new Error("Malformed record protocol message or parameters.")
          : error instanceof Error
            ? error
            : new Error("Record protocol failed."),
        -32600,
      );
    }
  });
  lines.on("close", () => {
    if (!finished)
      finish(2, new Error("Record protocol input closed before completion."));
  });
  lines.on("error", inputError);
  input.on("error", inputError);
  output.on("error", outputError);
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  return await exit;
}

/** Bypass interactive CLI setup and update checks for the headless transport. */
export async function runRecordDedupeCli(
  argv: readonly string[],
  output: Writable,
  diagnostics: Writable,
): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "dedupe" || argv[1] !== "--records") {
    writeDiagnostic(
      diagnostics,
      "codex-security: dedupe --records takes no scan, model, output or other flags; pass options in the run request.\n",
    );
    return 2;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await runRecordDedupeProtocol(
      process.stdin,
      output,
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    // This one-attempt CLI owns stdin; a canceled readline callback can leave
    // Node's input socket active even after the interface has closed.
    process.stdin.destroy();
  }
}
