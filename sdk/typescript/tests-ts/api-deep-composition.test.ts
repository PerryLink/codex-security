import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { CodexSecurity, type ScanOptions } from "../src/api.js";
import type { JsonObject } from "../src/config.js";
import { runWorkbench, type WorkbenchCommandOptions } from "../src/runtime.js";
import { prepareSemanticScanDraft } from "../src/scan-semantics.js";
import { DEEP_SCAN_CHECKPOINT } from "../src/deep-scan.js";
import { ScanTransportClosedError } from "../src/scan-execution.js";

const pluginRoot = fileURLToPath(
  new URL("../../../plugins/codex-security/", import.meta.url),
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test.each([
  { workers: 1, budget: false, provider: undefined },
  { workers: 2, budget: false, provider: undefined },
  { workers: 1, budget: true, provider: undefined },
  { workers: 1, budget: false, provider: { env_key: "OPENAI_API_KEY" } },
  {
    workers: 1,
    budget: false,
    provider: { auth: { type: "command", command: "synthetic-auth-provider" } },
  },
  { workers: 1, budget: false, native: "feedback" },
  { workers: 1, budget: false, native: "discovery" },
  { workers: 1, budget: false, native: "sealed" },
] as {
  workers: number;
  budget: boolean;
  provider?: JsonObject;
  native?: "feedback" | "discovery" | "sealed";
}[])(
  "Deep composes sealed ordinary scans and preserves a budgeted parent: %j",
  async ({ workers, budget, provider, native }) => {
    const python = Bun.which("python3") ?? Bun.which("python");
    if (python === null) throw new Error("Python is required for this test.");
    const root = await mkdtemp(join(tmpdir(), "ordinary-composition-"));
    roots.push(root);
    const repo = join(root, "repo");
    const codexHome = join(root, "codex");
    let scanDir = join(root, "scan");
    await Promise.all([mkdir(repo), mkdir(codexHome)]);
    await writeFile(
      join(repo, "app.py"),
      "print('public synthetic fixture')\n",
    );
    const version = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    ).version;
    let runtimeVersion = version;
    const environment = {
      ...process.env,
      CODEX_SECURITY_STATE_DIR: join(root, "state"),
      CODEX_CLI_PATH: process.execPath,
      SYNTHETIC_SCAN_SETTING: "inherited",
      CODEX_SAFETY_IDENTIFIER: "ambient-identifier",
      ...(native ? { OPENAI_API_KEY: "synthetic-native-key" } : {}),
      ...(provider === undefined
        ? {}
        : {
            OPENAI_API_KEY: "synthetic-provider-key",
            CODEX_API_KEY: "synthetic-native-key",
          }),
    };
    const commandOptions = { python, pluginRoot, environment };
    let registeredScan: ScanOptions["registeredScan"];
    let feedbackBefore: Buffer<ArrayBuffer> | undefined;
    if (native) {
      if (native === "feedback") {
        execFileSync(python, [
          "-c",
          `import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from workbench_test_support import create_saved_workspace, start_delivered_scan, write_completed_contract, run_workbench
state, repository, scans = map(Path, sys.argv[2:])
workspace = create_saved_workspace(state, repository)
scan = start_delivered_scan(state, '--workspace-id', workspace['id'], '--scan-root', str(scans))['results']
write_completed_contract(Path(scan['scanDir']), scan['scanId'], repository, relative_path='app.py')
completed = run_workbench(state, 'complete-scan', '--scan-id', scan['scanId'])['scan']
run_workbench(state, 'set-finding-triage', '--occurrence-id', completed['findings'][0]['occurrenceId'], '--status', 'closed', '--close-reason', 'false_positive', '--note', 'The synthetic route verifies the session.')`,
          join(pluginRoot, "tests"),
          environment.CODEX_SECURITY_STATE_DIR,
          repo,
          join(root, "prior-scans"),
        ]);
      }
      const started = await runWorkbench(commandOptions, [
        "begin-deep-scan",
        "--thread-id",
        "native-owner",
        "--target-path",
        repo,
        "--scope",
        ".",
        "--scan-root",
        join(root, "scans"),
      ]);
      const scan = started["scan"] as JsonObject;
      scanDir = scan["scanDir"] as string;
      registeredScan = {
        scanId: scan["scanId"] as string,
        scanDir,
        threadId: "native-owner",
        handoffClaimToken: scan["handoffClaimToken"] as string,
      };
      if (native === "feedback")
        feedbackBefore = await readFile(
          join(scanDir, "artifacts/01_context/false_positive_feedback.json"),
        );
    }
    let controller = new AbortController();
    let interrupted = false;
    let savedExecutionThread: string | undefined;
    let sealedArtifacts: Map<string, Buffer<ArrayBuffer>> | undefined;
    const registrations = new Map<string, JsonObject>();
    let childTurns = 0;
    const workbenches = new Map<string, WorkbenchCommandOptions>();
    const commands: Array<{ command: string; id: string | undefined }> = [];
    const turns: Array<{
      id: string;
      mode: string;
      cwd: string;
      prompt: string;
      config: unknown;
      overrides?: string[];
      executable?: string;
      environment: Record<string, string>;
    }> = [];
    const makeClient = () =>
      new CodexSecurity(
        {
          pluginPath: pluginRoot,
          codexOverrides: {
            model: "gpt-6-astra",
            model_reasoning_effort: "ultra",
            ...(provider === undefined
              ? {}
              : {
                  model_provider: "custom",
                  cli_auth_credentials_store: "file",
                  model_providers: { custom: provider },
                }),
          },
        },
        {
          environment,
          inheritedPermissions: {
            filesystem: { [join(root, "private")]: "deny" },
            network: { enabled: false },
          },
          prepareRuntime: async () => ({
            codexHome,
            environment,
            credentialsAvailable: true,
            persistentCredentialHome: true,
            plugin: {
              pluginRoot,
              installedRoot: pluginRoot,
              marketplaceRoot: pluginRoot,
              marketplaceName: "codex-security-sdk",
              name: "codex-security",
              version: runtimeVersion,
            },
          }),
          resolvePluginPython: async () => python,
          runWorkbench: async (options, args, input) => {
            const result = await runWorkbench(options, args, input);
            const id = args.includes("--scan-id")
              ? args[args.indexOf("--scan-id") + 1]
              : undefined;
            commands.push({ command: args[0]!, id });
            if (args[0] === "register-cli-scan") {
              const scanId = result["scanId"] as string;
              registrations.set(scanId, {
                ...result,
                mode: JSON.parse(input!).recipe.mode,
                recipe: JSON.parse(input!).recipe,
              });
              workbenches.set(scanId, options);
            }
            if (args[0] === "get-cli-scan-resume")
              workbenches.set(result["scanId"] as string, options);
            if (
              native === "sealed" &&
              !interrupted &&
              args[0] === "prepare-scan-completion" &&
              id === registeredScan!.scanId
            ) {
              const manifest = JSON.parse(
                await readFile(join(scanDir, "scan-manifest.json"), "utf8"),
              );
              sealedArtifacts = new Map(
                await Promise.all(
                  [
                    "scan-manifest.json",
                    "report.md",
                    ...manifest.scan.artifacts.map(
                      (artifact: { path: string }) => artifact.path,
                    ),
                  ].map(
                    async (path: string) =>
                      [path, await readFile(join(scanDir, path))] as const,
                  ),
                ),
              );
              interrupted = true;
              controller.abort(
                new ScanTransportClosedError("mcp_transport_closed"),
              );
            }
            return result;
          },
          createCodex: (options) => {
            if (provider !== undefined) {
              expect(options.apiKey).toBeUndefined();
              expect(options.env?.["OPENAI_API_KEY"]).toBe(
                "synthetic-provider-key",
              );
              expect(options.env?.["CODEX_API_KEY"]).toBe(
                "synthetic-native-key",
              );
            }
            const env = options.env!;
            const id = env["CODEX_SECURITY_SCAN_ID"]!;
            const makeThread = (
              threadOptions: ThreadOptions,
              savedThreadId: string | null = null,
            ) => {
              const thread = {
                id: savedThreadId,
                async runStreamed(prompt: string) {
                  const record = registrations.get(id)!;
                  const mode = record["mode"] as string;
                  turns.push({
                    id,
                    mode,
                    cwd: threadOptions.workingDirectory!,
                    prompt,
                    config: options.config,
                    overrides: options.configOverrides,
                    executable: options.codexPathOverride,
                    environment: options.env!,
                  });
                  async function* events(): AsyncGenerator<ThreadEvent> {
                    thread.id ??= randomUUID();
                    await mkdir(join(codexHome, "sessions"), {
                      recursive: true,
                    });
                    await appendFile(
                      join(codexHome, "sessions", `rollout-${thread.id}.jsonl`),
                      JSON.stringify({
                        type: "session_meta",
                        payload: {
                          id: thread.id,
                          cwd: threadOptions.workingDirectory,
                        },
                      }) + "\n",
                    );
                    yield { type: "thread.started", thread_id: thread.id };
                    if (mode === "standard") {
                      childTurns += 1;
                      const directory = record["scanDir"] as string;
                      if (
                        native === "discovery" &&
                        childTurns === 2 &&
                        !interrupted
                      ) {
                        interrupted = true;
                        await appendFile(
                          join(
                            codexHome,
                            "sessions",
                            `rollout-${thread.id}.jsonl`,
                          ),
                          JSON.stringify({
                            type: "event_msg",
                            payload: {
                              type: "token_count",
                              info: {
                                total_token_usage: {
                                  input_tokens: 10,
                                  output_tokens: 3,
                                },
                              },
                            },
                          }) + "\n",
                        );
                        const error = new ScanTransportClosedError(
                          "mcp_transport_closed",
                        );
                        controller.abort(error);
                        throw error;
                      }
                      const draft = {
                        scanId: id,
                        findings: [],
                        coverage: {
                          completeness: "complete",
                          surfaces: [],
                          deferred: [],
                        },
                      };
                      const documents = prepareSemanticScanDraft(
                        {
                          targetContract: record["contract"] as JsonObject,
                          mode: "standard",
                          targetRevision: record["targetRevision"] as string,
                        },
                        draft,
                      );
                      const draftPath = join(
                        directory,
                        "drafts",
                        randomUUID() + ".json",
                      );
                      const checkpointPath = join(
                        directory,
                        "drafts",
                        randomUUID() + ".checkpoint.json",
                      );
                      await mkdir(join(directory, "drafts"), {
                        recursive: true,
                        mode: 0o700,
                      });
                      await writeFile(draftPath, JSON.stringify(documents));
                      await writeFile(checkpointPath, JSON.stringify(draft));
                      await runWorkbench(workbenches.get(id)!, [
                        "write-scan-draft",
                        "--scan-id",
                        id,
                        "--draft-path",
                        draftPath,
                        "--checkpoint-path",
                        checkpointPath,
                      ]);
                    }
                    yield {
                      type: "item.completed",
                      item: {
                        id: "response",
                        type: "agent_message",
                        text:
                          mode === "deep"
                            ? JSON.stringify({ scanId: id, findings: [] })
                            : "Complete",
                      },
                    };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens:
                          budget && mode === "standard" && childTurns === 2
                            ? 100000
                            : 10,
                        cached_input_tokens: 0,
                        output_tokens: 3,
                        cache_write_input_tokens: 0,
                        reasoning_output_tokens: 0,
                      },
                    };
                  }
                  return { events: events() };
                },
              };
              return thread;
            };
            return {
              startThread: (threadOptions) => makeThread(threadOptions),
              resumeThread: (threadId, threadOptions) =>
                makeThread(threadOptions, threadId),
            };
          },
        },
        { surface: "sdk" },
      );
    let client = makeClient();
    try {
      const scanOptions: ScanOptions = {
        mode: "deep",
        preserveProviderEnvironment: provider !== undefined,
        workers,
        subagents: 3,
        stopAfterNoNew: 2,
        maxDiscoveryRuns: 4,
        maxTimeHours: 1,
        outputDir: scanDir,
        registeredScan,
        ...(native ? { safetyIdentifier: "saved-native-identifier" } : {}),
        scanPrompt: "Inspect the synthetic source.",
        ...(budget ? { maxCostUsd: 0.001 } : {}),
        postScanPrompt: "Post-scan instructions once.",
        onWarning: (message) => console.error(message),
      };
      const run = () =>
        client.run(repo, {
          ...scanOptions,
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(20000),
          ]),
        });
      if (native === "discovery" || native === "sealed") {
        await expect(run()).rejects.toBeInstanceOf(ScanTransportClosedError);
        const saved = await runWorkbench(commandOptions, [
          "get-scan",
          "--scan-id",
          registeredScan!.scanId,
        ]);
        expect(saved["scan"]).toMatchObject({
          progress: { status: "running" },
        });
        savedExecutionThread = (saved["scan"] as JsonObject)[
          "continuationThreadId"
        ] as string;
        expect(savedExecutionThread).not.toBe(registeredScan!.threadId);
        const checkpoint = JSON.parse(
          await readFile(join(scanDir, DEEP_SCAN_CHECKPOINT), "utf8"),
        );
        if (native === "discovery") {
          expect(checkpoint).toMatchObject({
            noNewStreak: 1,
            consecutiveErrors: 0,
          });
          expect(checkpoint.terminalReason).toBeUndefined();
          const child = await runWorkbench(commandOptions, [
            "get-scan",
            "--scan-id",
            checkpoint.passes[1].scanId,
          ]);
          expect(child["scan"]).toMatchObject({
            progress: { status: "running" },
          });
          expect(
            ((child["scan"] as JsonObject)["cost"] as JsonObject)[
              "estimatedUsd"
            ],
          ).toBeGreaterThan(0);
        } else runtimeVersion = "99.0.0";
        expect(
          commands.filter(({ command }) => command === "fail-scan"),
        ).toEqual([]);
        controller = new AbortController();
        environment.CODEX_SAFETY_IDENTIFIER = "changed-ambient-identifier";
        await client.close();
        client = makeClient();
      }
      const result = await run();
      if (savedExecutionThread)
        expect(result.threadId).toBe(savedExecutionThread);
      if (sealedArtifacts) {
        for (const [path, bytes] of sealedArtifacts)
          expect(await readFile(join(scanDir, path))).toEqual(bytes);
        expect(result.manifest.scan.producer.version).toBe(version);
      }
      if (feedbackBefore) {
        expect(
          await readFile(
            join(scanDir, "artifacts/01_context/false_positive_feedback.json"),
          ),
        ).toEqual(feedbackBefore);
        expect(
          turns
            .filter((turn) => turn.mode === "standard")
            .every((turn) =>
              turn.prompt.includes("false_positive_feedback.json"),
            ),
        ).toBe(true);
      }
      expect(result.findings.findings).toEqual([]);
      expect(result.coverage.completeness).toBe(
        budget ? "partial" : "complete",
      );
      const checkpoint = JSON.parse(
        await readFile(join(scanDir, DEEP_SCAN_CHECKPOINT), "utf8"),
      );
      expect(checkpoint.terminalReason).toBe(budget ? "capped" : "saturated");
      expect(checkpoint.noNewStreak).toBe(budget ? 1 : 2);
      expect(checkpoint.passes).toHaveLength(2);
      expect(checkpoint.mergedScanIds).toHaveLength(budget ? 1 : 2);
      expect(registrations.size).toBe(3);
      if (provider !== undefined) {
        for (const registration of registrations.values()) {
          const saved = registration["recipe"] as JsonObject;
          expect(saved["preserveProviderEnvironment"]).toBe(true);
          expect(
            (saved["config"] as JsonObject)["model_providers"],
          ).toMatchObject({ custom: provider });
          expect(
            (saved["config"] as JsonObject)["cli_auth_credentials_store"],
          ).toBe("file");
        }
        expect(environment.OPENAI_API_KEY).toBe("synthetic-provider-key");
        expect(environment.CODEX_API_KEY).toBe("synthetic-native-key");
      }
      for (const turn of turns) {
        const permission = turn.overrides?.find((value) =>
          value.startsWith("permissions.codex_security_scan="),
        );
        expect(permission).toBeDefined();
        expect(parseToml(permission!)).toMatchObject({
          permissions: {
            codex_security_scan: {
              filesystem: {
                [join(root, "private")]: "deny",
                ":root": "read",
                ":workspace_roots": "write",
              },
              network: { enabled: false },
            },
          },
        });
        expect(turn.executable).toBe(process.execPath);
        expect(turn.environment["SYNTHETIC_SCAN_SETTING"]).toBe("inherited");
        expect(turn.environment["CODEX_SAFETY_IDENTIFIER"]).toBe(
          native ? "saved-native-identifier" : undefined,
        );
      }
      const children = turns.filter((turn) => turn.mode === "standard");
      expect(children).toHaveLength(native === "discovery" ? 3 : 2);
      expect(new Set(children.map((turn) => turn.id)).size).toBe(2);
      for (const child of children) {
        expect(child.prompt).toContain("Inspect the synthetic source.");
        expect(child.prompt).not.toContain("sourceFindingIds");
        expect(child.config).toMatchObject({
          model: "gpt-6-astra",
          model_reasoning_effort: "ultra",
          features: {
            multi_agent_v2: {
              enabled: true,
              max_concurrent_threads_per_session: 4,
            },
          },
        });
        const completed = checkpoint.mergedScanIds.includes(child.id);
        expect(
          commands.filter(
            (command) =>
              command.command === "complete-scan" && command.id === child.id,
          ),
        ).toHaveLength(completed ? 1 : 0);
        const record = registrations.get(child.id)!;
        const manifest = JSON.parse(
          await readFile(
            join(record["scanDir"] as string, "scan-manifest.json"),
            "utf8",
          ),
        );
        expect(manifest.scan.complete).not.toBe(false);
      }
      expect(
        commands.filter(
          (command) =>
            command.command ===
              (budget ? "complete-budget-exhausted-scan" : "complete-scan") &&
            command.id === result.manifest.scan.id,
        ),
      ).toHaveLength(1);
      expect(
        turns.filter((turn) => turn.prompt === "Post-scan instructions once."),
      ).toHaveLength(budget ? 0 : 1);
      if (budget) {
        expect(result.cost!.estimatedUsd).toBeGreaterThan(0.001);
        expect(result.coverage.deferred.length).toBeGreaterThan(0);
        const stopped = await runWorkbench(
          { ...workbenches.get(children[1]!.id)!, signal: undefined },
          ["get-scan", "--scan-id", children[1]!.id],
        );
        expect((stopped["scan"] as JsonObject)["cost"]).toBeDefined();
      }
      const listed = await runWorkbench(
        { ...workbenches.get(result.manifest.scan.id)!, signal: undefined },
        ["list-scans"],
      );
      const listedIds = (listed["scans"] as JsonObject[]).map(
        (scan) => scan["scanId"],
      );
      expect(listedIds).toContain(result.manifest.scan.id);
      expect(listedIds).toHaveLength(native === "feedback" ? 2 : 1);
    } finally {
      await client.close();
    }
  },
);
