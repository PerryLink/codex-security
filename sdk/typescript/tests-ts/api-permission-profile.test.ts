import * as childProcess from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { CodexSecurity, type ScanOptions } from "../src/api.js";
import type { JsonObject } from "../src/config.js";
import { DEEP_SCAN_CHECKPOINT } from "../src/deep-scan.js";
import { executablePathForSpawn } from "../src/runtime.js";
import { ScanPermissionError } from "../src/scan-execution.js";
import { PLUGIN_ROOT } from "./plugin-root.js";
import { mockWorkbench, TEST_SNAPSHOT_DIGEST } from "./support/api-client.js";
import {
  createApiTestFixtures,
  preparedRuntime,
} from "./support/api-events.js";

const { temporaryDirectory, cleanup } = createApiTestFixtures();
afterEach(cleanup);

type Role = "discovery" | "merge" | "standard" | "custom";
type Scenario = "rejected" | "fallback";

async function fixture(
  role: Role,
  resumed: boolean,
  scenario: Scenario,
  surface: "sdk" | "cli",
) {
  const root = await temporaryDirectory();
  const repository = join(root, "repository");
  const scanDir = join(root, "scan");
  const codexHome = join(root, "codex-home");
  const executable = join(root, "synthetic-codex.exe");
  const script = join(root, "synthetic-codex.cjs");
  const capture = join(root, "processes.jsonl");
  const scanId = "parent-permission-fixture";
  const threadId = "00000000-0000-4000-8000-000000000001";
  const cwd =
    role === "merge" ? join(scanDir, "artifacts/deep-scan/merge") : scanDir;
  await Promise.all([
    mkdir(repository),
    mkdir(codexHome),
    mkdir(scanDir, { mode: 0o700 }),
  ]);
  await writeFile(join(repository, "app.py"), "print('synthetic fixture')\n");
  await writeFile(capture, "");
  await writeFile(
    script,
    [
      'const fs = require("node:fs");',
      "const { parse } = require(" +
        JSON.stringify(createRequire(import.meta.url).resolve("smol-toml")) +
        ");",
      "const args = process.argv.slice(2);",
      "const record = (value) => fs.appendFileSync(" +
        JSON.stringify(capture) +
        ', JSON.stringify(value) + "\\n");',
      'record({ kind: args.includes("app-server") ? "preflight" : "exec", args, cwd: process.cwd(), surface: process.env.CODEX_SECURITY_SURFACE });',
      'if (args.includes("app-server")) {',
      "  const config = {};",
      "  const merge = (target, value) => {",
      '    for (const [key, child] of Object.entries(value)) target[key] = child && typeof child === "object" && !Array.isArray(child) ? merge(target[key] ?? {}, child) : child;',
      "    return target;",
      "  };",
      '  for (let index = 0; index < args.length; index++) if (["-c", "--config"].includes(args[index])) merge(config, parse(args[++index]));',
      '  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {',
      "    const request = JSON.parse(line);",
      "    if (request.id === undefined) return;",
      '    const result = request.method === "initialize" ? {} : request.method === "config/read" ? { config } : request.method === "permissionProfile/list" ? { data: [{ id: config.default_permissions, allowed: ' +
        (scenario !== "rejected") +
        " }], nextCursor: null } : undefined;",
      '    if (!result) throw new Error("Unexpected fixture request " + request.method);',
      "    console.log(JSON.stringify({ id: request.id, result }));",
      "  });",
      "} else {",
      '  console.log(JSON.stringify({ type: "thread.started", thread_id: ' +
        JSON.stringify(threadId) +
        " }));",
      "  console.log(JSON.stringify(" +
        JSON.stringify(
          role === "standard"
            ? {
                type: "turn.failed",
                error: { message: "synthetic standard execution" },
              }
            : {
                type: "error",
                message:
                  "Configured value for `permission_profile` is disallowed by requirements; falling back from `codex_security_scan` to required value `:read-only`.",
              },
        ) +
        "));",
      '  process.on("SIGTERM", () => process.exit(0));',
      ...(role === "standard" ? [] : ["  setInterval(() => {}, 1000);"]),
      "}",
    ].join("\n"),
  );
  if (resumed) {
    await mkdir(join(codexHome, "sessions"));
    await writeFile(
      join(codexHome, "sessions", "rollout-" + threadId + ".jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd } }) +
        "\n",
    );
  }
  const childDir = join(scanDir, "artifacts/deep-scan/passes/pass-1");
  if (role === "merge") {
    await cp(join(PLUGIN_ROOT, "examples/completed-scan"), childDir, {
      recursive: true,
    });
    await chmod(childDir, 0o700);
    await writeFile(
      join(scanDir, DEEP_SCAN_CHECKPOINT),
      JSON.stringify({
        version: 2,
        startedAt: new Date().toISOString(),
        passes: [{ directory: "artifacts/deep-scan/passes/pass-1" }],
        mergedScanIds: [],
        aggregate: null,
        noNewStreak: 0,
        consecutiveErrors: 0,
      }),
    );
  }
  const environment = Object.fromEntries(
    Object.entries({
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
      CODEX_HOME: codexHome,
      CODEX_SECURITY_STATE_DIR: join(root, "state"),
      CODEX_CLI_PATH: executable,
      OPENAI_API_KEY: "synthetic-fixture-key",
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const commands: string[] = [];
  let customCalls = 0;
  const registration: JsonObject = {
    scanId,
    scanDir,
    targetId: "target_sha256_example",
    targetRevision: "unversioned",
    threadId: resumed ? threadId : null,
    recipe: { repository, target: { kind: "repository", paths: [] } },
    contract: {
      target: {
        allowedKinds: ["directory_snapshot"],
        requiredSnapshotDigest: TEST_SNAPSHOT_DIGEST,
      },
    },
  };
  const client = new CodexSecurity(
    { pluginPath: PLUGIN_ROOT },
    {
      environment,
      prepareRuntime: async () => ({
        ...preparedRuntime(codexHome),
        environment,
        persistentCredentialHome: true,
      }),
      resolvePluginPython: async () => process.execPath,
      prepareOutputDir: async () => scanDir,
      acquireScanExecution: async () => () => {},
      repositoryRevision: async () => null,
      prepareScanArtifactRestorer: async () => ({
        async prepareDirectory(path) {
          await mkdir(join(scanDir, path), { recursive: true });
        },
        async restore(path, contents) {
          await mkdir(dirname(join(scanDir, path)), { recursive: true });
          await writeFile(join(scanDir, path), contents);
        },
        async remove(path) {
          await rm(join(scanDir, path), { force: true });
        },
      }),
      runWorkbench: async (_options, args, input): Promise<JsonObject> => {
        commands.push(args[0]!);
        if (["register-cli-scan", "get-cli-scan-resume"].includes(args[0]!))
          return registration;
        if (args[0] === "get-scan-feedback")
          return {
            scanId,
            targetId: registration["targetId"]!,
            falsePositives: [],
          };
        if (args[0] === "list-scans")
          return {
            scans:
              role === "merge"
                ? [
                    {
                      scanId: "scan_example_001",
                      scanDir: childDir,
                      parentScanId: scanId,
                      targetPath: repository,
                      progress: { status: "complete" },
                    },
                  ]
                : [],
          };
        if (args[0] === "get-scan")
          return { scan: { progress: { status: "running" } } };
        if (args[0] === "save-scan-artifact") {
          await writeFile(join(scanDir, DEEP_SCAN_CHECKPOINT), input!);
          return {};
        }
        return mockWorkbench(args, input);
      },
      ...(role === "custom"
        ? {
            createCodex: () => ({
              startThread: () => ({
                id: null,
                async runStreamed() {
                  customCalls++;
                  throw new Error("synthetic custom factory");
                },
              }),
            }),
          }
        : {}),
    },
    { surface },
  );
  const originalSpawn = childProcess.spawn;
  const children: childProcess.ChildProcess[] = [];
  const spawn = spyOn(childProcess, "spawn").mockImplementation(((
    ...args: Parameters<typeof childProcess.spawn>
  ) => {
    const [command, argv, options] = args;
    if (command !== executablePathForSpawn(executable) || !Array.isArray(argv))
      return originalSpawn(...args);
    const child = originalSpawn(process.execPath, [script, ...argv], options);
    children.push(child);
    return child;
  }) as typeof childProcess.spawn);
  const options: ScanOptions = {
    mode: role === "merge" ? "deep" : "standard",
    outputDir: scanDir,
    ...(role === "discovery" || role === "custom"
      ? { deepScanPass: true }
      : {}),
    ...(resumed || role === "merge" ? { resumeScanId: scanId } : {}),
    ...(role === "merge"
      ? { workers: 1, subagents: 0, maxDiscoveryRuns: 1, maxTimeHours: 1 }
      : {}),
    signal: AbortSignal.timeout(10000),
  };
  return {
    run: () => client.run(repository, options),
    commands,
    scanDir,
    cwd,
    customCalls: () => customCalls,
    observations: async () =>
      (await readFile(capture, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async close() {
      try {
        await client.close();
        // The Codex SDK removes child listeners during cleanup; exit state is retained.
        for (const child of children)
          while (child.exitCode === null && child.signalCode === null)
            await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        spawn.mockRestore();
      }
    },
  };
}

test.each(["sdk", "cli"] as const)(
  "%s default factory checks fresh and resumed discovery and merge permissions",
  async (surface) => {
    for (const role of ["discovery", "merge"] as const)
      for (const resumed of [false, true])
        for (const scenario of ["rejected", "fallback"] as const) {
          const h = await fixture(role, resumed, scenario, surface);
          try {
            await expect(h.run()).rejects.toBeInstanceOf(ScanPermissionError);
            const observations = await h.observations();
            expect(
              observations.filter(({ kind }) => kind === "preflight"),
            ).toMatchObject([{ cwd: h.cwd, surface }]);
            const executions = observations.filter(
              ({ kind }) => kind === "exec",
            );
            expect(executions).toHaveLength(scenario === "rejected" ? 0 : 1);
            if (executions.length)
              expect(executions[0].args.includes("resume")).toBe(resumed);
            expect(h.commands).not.toContain("complete-scan");
            if (role === "merge")
              expect(
                JSON.parse(
                  await readFile(join(h.scanDir, DEEP_SCAN_CHECKPOINT), "utf8"),
                ),
              ).toMatchObject({ terminalReason: "failed", mergedScanIds: [] });
          } finally {
            await h.close();
          }
        }
  },
);

test.each(["standard", "custom"] as const)(
  "preserves the %s factory path",
  async (role) => {
    const h = await fixture(role, false, "rejected", "sdk");
    try {
      await expect(h.run()).rejects.toThrow(
        role === "standard"
          ? "synthetic standard execution"
          : "synthetic custom factory",
      );
      const observations = await h.observations();
      expect(
        observations.filter(({ kind }) => kind === "preflight"),
      ).toHaveLength(0);
      expect(observations.filter(({ kind }) => kind === "exec")).toHaveLength(
        role === "standard" ? 1 : 0,
      );
      expect(h.customCalls()).toBe(role === "custom" ? 1 : 0);
    } finally {
      await h.close();
    }
  },
);
