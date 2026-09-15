import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { parse as parseToml } from "smol-toml";
import {
  CodexSecurity,
  selectedScanEnvironment,
  type ScanOptions,
} from "../../../../sdk/typescript/src/api.js";
import {
  scanCompositionOverrides,
  type JsonObject,
} from "../../../../sdk/typescript/src/config.js";
import { ScanSettingsSchema } from "../../../../sdk/typescript/src/scan-settings.js";
import { resolveDeepScanConfig } from "../../../../sdk/typescript/src/deep-config.js";
import type { ScanResult } from "../../../../sdk/typescript/src/result.js";
import {
  resolveCodexPath,
  snapshotNativeEnvironment,
} from "./native-executable.js";
import type { NativeParentSandbox } from "./native-permissions.js";
import type { ScanResults } from "./types.js";

export interface NativeScanInput {
  scan: ScanResults;
  recipe?: JsonObject;
  threadId: string;
  pluginRoot: string;
  pythonPath: string;
  model?: string;
  reasoningEffort?: string;
  parentSandbox: NativeParentSandbox;
  stateDirectory?: string;
}

type NativeClient = Pick<CodexSecurity, "run" | "close">;
type PreparedNativeScan = { client: NativeClient; options: ScanOptions };

/** Native tools join the same ordinary scan operation until it finishes. */
export class NativeScanHost {
  private readonly active = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<ScanResult>;
    }
  >();

  constructor(private readonly prepare = prepareNativeScan) {}

  run(input: NativeScanInput, waiterSignal?: AbortSignal): Promise<ScanResult> {
    let active = this.active.get(input.scan.scanId);
    if (!active) {
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(async () => {
          const { client, options } = await this.prepare(input);
          try {
            return await client.run(input.scan.targetPath, {
              ...options,
              signal: controller.signal,
            });
          } finally {
            await client.close();
          }
        })
        .finally(() => this.active.delete(input.scan.scanId));
      active = { controller, promise };
      this.active.set(input.scan.scanId, active);
      void promise.catch(() => undefined);
    }
    return waitForScan(active.promise, waiterSignal);
  }

  async cancel(scanId: string, reason = "user_canceled_scan"): Promise<void> {
    const active = this.active.get(scanId);
    if (!active) return;
    active.controller.abort(new Error(reason));
    await active.promise.catch(() => undefined);
  }

  async close(): Promise<void> {
    const active = [...this.active.values()];
    for (const run of active)
      run.controller.abort(new Error("mcp_transport_closed"));
    await Promise.allSettled(active.map((run) => run.promise));
  }
}

export async function prepareNativeScan(
  input: NativeScanInput,
): Promise<PreparedNativeScan> {
  const environment = await snapshotNativeEnvironment();
  environment.CODEX_CLI_PATH = resolveCodexPath(environment);
  if (input.stateDirectory)
    environment.CODEX_SECURITY_STATE_DIR = input.stateDirectory;
  const recipe = input.recipe ?? {};
  const savedPermissions =
    recipe.inheritedPermissions as ScanOptions["inheritedPermissions"];
  const savedGlobDepth = savedPermissions?.filesystem.glob_scan_max_depth;
  const inheritedPermissions = {
    filesystem: Object.fromEntries([
      ...Object.entries(savedPermissions?.filesystem ?? {}),
      ...input.parentSandbox.filesystemDenies.map((path) => [path, "deny"]),
      ...(input.parentSandbox.globScanMaxDepth === undefined
        ? []
        : [
            [
              "glob_scan_max_depth",
              typeof savedGlobDepth === "number"
                ? Math.min(savedGlobDepth, input.parentSandbox.globScanMaxDepth)
                : input.parentSandbox.globScanMaxDepth,
            ],
          ]),
    ]) as JsonObject,
    network: { enabled: false },
  };
  const options = ScanSettingsSchema.parse({
    ...(recipe.deepScan as JsonObject | undefined),
    auth: recipe.auth,
    knowledgeBasePaths:
      recipe.knowledgeBasePaths ??
      (environment.CODEX_SECURITY_KNOWLEDGE_BASE
        ? [environment.CODEX_SECURITY_KNOWLEDGE_BASE]
        : undefined),
    maxCostUsd: recipe.maxCostUsd,
    postScanPrompt: recipe.postScanPrompt,
    failureSeverity: recipe.failOnSeverity,
    mode: "deep",
    scanPrompt: input.scan.userContext ?? undefined,
    outputDir: input.scan.scanDir,
  });
  const deep = await resolveDeepScanConfig(
    options,
    environment.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH ??
      join(
        environment.CODEX_HOME ?? join(homedir(), ".codex"),
        "codex-security",
        "config.toml",
      ),
  );
  const config = await nativeScanConfiguration(
    environment,
    input,
    deep.settings.subagents,
  );
  const selectedEnvironment = selectedScanEnvironment(
    environment,
    options.auth,
    config.model_provider,
  );
  if (selectedEnvironment.CODEX_API_KEY?.trim())
    delete selectedEnvironment.OPENAI_API_KEY;
  const client = new CodexSecurity(
    {
      pluginPath: input.pluginRoot,
      pythonPath: input.pythonPath,
      codexOverrides: config,
    },
    {
      createCodex: (options) => new Codex(options),
      environment: selectedEnvironment,
      inheritedPermissions,
    },
    { surface: "sdk" },
  );
  return {
    client,
    options: {
      ...options,
      ...deep.settings,
      inheritedPermissions,
      target:
        (recipe.target as JsonObject | undefined)?.kind === "paths"
          ? ((recipe.target as JsonObject).paths as string[])
          : input.scan.scope && input.scan.scope !== "."
            ? [input.scan.scope]
            : "repository",
      ...(typeof recipe.safetyIdentifier === "string"
        ? { safetyIdentifier: recipe.safetyIdentifier }
        : {}),
      registeredScan: {
        scanId: input.scan.scanId,
        scanDir: input.scan.scanDir,
        threadId: input.threadId,
        handoffClaimToken: input.scan.handoffClaimToken,
      },
    },
  };
}

export async function nativeScanConfiguration(
  environment: NodeJS.ProcessEnv,
  input: Pick<NativeScanInput, "recipe" | "model" | "reasoningEffort">,
  subagents: number,
): Promise<JsonObject> {
  const ambientPath = join(
    environment.CODEX_HOME ?? join(homedir(), ".codex"),
    "config.toml",
  );
  const ambient = await readFile(ambientPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const selected = environment.CODEX_SECURITY_CONFIG_PATH
    ? parseToml(await readFile(environment.CODEX_SECURITY_CONFIG_PATH, "utf8"))
    : {};
  const config = scanCompositionOverrides(
    {
      ...parseToml(ambient),
      ...selected,
      ...(input.recipe?.config as JsonObject | undefined),
    } as JsonObject,
    subagents,
  );
  if (input.model) config.model = input.model;
  if (input.reasoningEffort)
    config.model_reasoning_effort = input.reasoningEffort;
  return config;
}

function waitForScan(
  promise: Promise<ScanResult>,
  signal?: AbortSignal,
): Promise<ScanResult> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error("Deep Scan waiter detached."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
