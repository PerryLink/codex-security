import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import type { ThreadEvent } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { CodexSecurity } from "../src/api.js";
import type { JsonObject } from "../src/config.js";
import { runWorkbench, type WorkbenchCommandOptions } from "../src/runtime.js";
import { prepareSemanticScanDraft } from "../src/scan-semantics.js";
import { DEEP_SCAN_CHECKPOINT } from "../src/deep-scan.js";

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
] as { workers: number; budget: boolean; provider?: JsonObject }[])(
  "Deep composes sealed ordinary scans and preserves a budgeted parent: %j",
  async ({ workers, budget, provider }) => {
    const root = await mkdtemp(join(tmpdir(), "ordinary-composition-"));
    roots.push(root);
    const repo = join(root, "repo");
    const codexHome = join(root, "codex");
    const scanDir = join(root, "scan");
    await Promise.all([mkdir(repo), mkdir(codexHome)]);
    await writeFile(
      join(repo, "app.py"),
      "print('public synthetic fixture')\n",
    );
    const version = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    ).version;
    const environment = {
      ...process.env,
      CODEX_SECURITY_STATE_DIR: join(root, "state"),
      CODEX_CLI_PATH: process.execPath,
      SYNTHETIC_SCAN_SETTING: "inherited",
      ...(provider === undefined
        ? {}
        : {
            OPENAI_API_KEY: "synthetic-provider-key",
            CODEX_API_KEY: "synthetic-native-key",
          }),
    };
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
    const client = new CodexSecurity(
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
            version,
          },
        }),
        resolvePluginPython: async () => "/usr/bin/python3",
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
          return result;
        },
        createCodex: (options) => {
          if (provider !== undefined) {
            expect(options.apiKey).toBeUndefined();
            expect(options.env?.["OPENAI_API_KEY"]).toBe(
              "synthetic-provider-key",
            );
            expect(options.env?.["CODEX_API_KEY"]).toBe("synthetic-native-key");
          }
          const env = options.env!;
          const id = env["CODEX_SECURITY_SCAN_ID"]!;
          return {
            startThread: (threadOptions) => {
              const thread = {
                id: null as string | null,
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
                    yield { type: "thread.started", thread_id: thread.id };
                    if (mode === "standard") {
                      childTurns += 1;
                      const directory = record["scanDir"] as string;
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
            },
          };
        },
      },
      { surface: "sdk" },
    );
    try {
      const result = await client.run(repo, {
        mode: "deep",
        preserveProviderEnvironment: provider !== undefined,
        workers,
        subagents: 3,
        stopAfterNoNew: 2,
        maxDiscoveryRuns: 4,
        maxTimeHours: 1,
        outputDir: scanDir,
        scanPrompt: "Inspect the synthetic source.",
        ...(budget ? { maxCostUsd: 0.001 } : {}),
        postScanPrompt: "Post-scan instructions once.",
        signal: AbortSignal.timeout(20000),
        onWarning: (message) => console.error(message),
      });
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
      }
      const children = turns.filter((turn) => turn.mode === "standard");
      expect(children).toHaveLength(2);
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
      expect(
        (listed["scans"] as JsonObject[]).map((scan) => scan["scanId"]),
      ).toEqual([result.manifest.scan.id]);
    } finally {
      await client.close();
    }
  },
);
