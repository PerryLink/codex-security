import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { afterEach, expect, test } from "bun:test";
import { parse as parseToml } from "smol-toml";
import { CodexSecurity, type ScanOptions } from "../src/api.js";
import { main } from "../src/cli.js";
import type { JsonObject } from "../src/config.js";
import { runWorkbench, type WorkbenchCommandOptions } from "../src/runtime.js";
import { capture, dependencies, fakeResult } from "./cli-fixtures.js";

const roots: string[] = [];
const pluginRoot = fileURLToPath(
  new URL("../../../plugins/codex-security/", import.meta.url),
);
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "scan-resume-permissions-")),
  );
  roots.push(root);
  const repository = join(root, "repository");
  const codexHome = join(root, "codex");
  await Promise.all([mkdir(repository), mkdir(codexHome)]);
  await writeFile(join(repository, "app.py"), "print('synthetic fixture')\n");
  const inheritedPermissions = {
    filesystem: { [join(root, "private")]: "deny", glob_scan_max_depth: 6 },
    network: { enabled: false },
  };
  return { root, repository, codexHome, inheritedPermissions };
}

test("saved ordinary passes retain native permissions at the resumed Codex process boundary", async () => {
  const { root, repository, codexHome, inheritedPermissions } = await fixture();
  const scanDir = join(root, "scan");
  const captures = join(root, "launches.jsonl");
  const preload = join(root, "codex-stub.mjs");
  const threadId = randomUUID();
  await writeFile(
    preload,
    `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
appendFileSync(${JSON.stringify(captures)}, JSON.stringify({
  args: process.argv.slice(1),
  selected: process.env.SYNTHETIC_SCAN_SETTING,
}) + "\\n");
const directory = join(process.env.CODEX_HOME, "sessions", "2026", "01", "01");
mkdirSync(directory, {recursive:true});
writeFileSync(join(directory, "rollout-${threadId}.jsonl"), JSON.stringify({
  type: "session_meta", payload: {id: ${JSON.stringify(threadId)}, cwd: process.env.CODEX_SECURITY_SCAN_DIR},
}) + "\\n");
console.log(JSON.stringify({type:"thread.started", thread_id:${JSON.stringify(threadId)}}));
console.log(JSON.stringify({type:"turn.failed", error:{message:"Synthetic interrupted pass"}}));
setInterval(() => {}, 1000);
await new Promise(() => {});
`,
  );
  const nodeExecutable = execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
  }).trim();
  const version = JSON.parse(
    await readFile(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
  ).version;
  const environment = {
    ...process.env,
    CODEX_SECURITY_STATE_DIR: join(root, "state"),
    SYNTHETIC_SCAN_SETTING: "selected-value",
  };
  let registration: JsonObject | undefined;
  let workbenchOptions: WorkbenchCommandOptions | undefined;
  const makeClient = (native: boolean, config: JsonObject) =>
    new CodexSecurity(
      { pluginPath: pluginRoot, codexOverrides: config },
      {
        environment,
        ...(native ? { inheritedPermissions } : {}),
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
        resolvePluginPython: async () => process.env["PYTHON"] ?? "python",
        runWorkbench: async (options, args, input) => {
          const result = await runWorkbench(options, args, input);
          if (args[0] === "register-cli-scan") {
            registration = result;
            workbenchOptions = options;
          }
          return result;
        },
        createCodex: (options) =>
          new Codex({
            ...options,
            codexPathOverride: nodeExecutable,
            env: {
              ...options.env,
              NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
            },
          }),
      },
      { surface: "sdk" },
    );
  const first = makeClient(true, {
    model: "gpt-6-astra",
    model_reasoning_effort: "ultra",
  });
  try {
    await expect(
      first.run(repository, {
        mode: "standard",
        outputDir: scanDir,
        deepScanPass: true,
      }),
    ).rejects.toThrow("Synthetic interrupted pass");
  } finally {
    await first.close();
  }
  const saved = await runWorkbench(workbenchOptions!, [
    "get-cli-scan-resume",
    "--scan-id",
    registration!["scanId"] as string,
  ]);
  const recipe = saved["recipe"] as JsonObject;
  expect(recipe["inheritedPermissions"]).toEqual(inheritedPermissions);
  const resumed = makeClient(false, recipe["config"] as JsonObject);
  try {
    await expect(
      resumed.run(repository, {
        mode: "standard",
        outputDir: scanDir,
        resumeScanId: saved["scanId"] as string,
        deepScanPass: true,
        inheritedPermissions: recipe[
          "inheritedPermissions"
        ] as ScanOptions["inheritedPermissions"],
      }),
    ).rejects.toThrow("Synthetic interrupted pass");
  } finally {
    await resumed.close();
  }
  const launches = (await readFile(captures, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; selected: string });
  expect(launches).toHaveLength(2);
  for (const launch of launches) {
    const permission = launch.args.find((value) =>
      value.startsWith("permissions.codex_security_scan="),
    );
    expect(permission).toBeDefined();
    expect(parseToml(permission!)).toMatchObject({
      permissions: {
        codex_security_scan: {
          filesystem: {
            ...inheritedPermissions.filesystem,
            ":root": "read",
            ":workspace_roots": "write",
          },
          network: inheritedPermissions.network,
        },
      },
    });
    expect(launch.selected).toBe("selected-value");
  }
  expect(launches[1]!.args).toContain("resume");
  expect(launches[1]!.args).toContain(threadId);
});

test("CLI resume restores saved native permissions into the shared SDK operation", async () => {
  const { root, repository, inheritedPermissions } = await fixture();
  const id = randomUUID();
  let selected: ScanOptions | undefined;
  const stderr = capture();
  const result = await main(
    ["scans", "resume", id, "--json"],
    capture().stream,
    stderr.stream,
    {
      ...dependencies({
        currentDirectory: root,
        result: fakeResult(),
        onTurn: (_repository, options) => {
          selected = options as ScanOptions;
        },
      }),
      runWorkbench: async () => ({
        scanId: id,
        scanDir: join(root, "scan"),
        recipe: {
          repository,
          target: { kind: "repository", paths: [] },
          mode: "deep",
          config: { model: "gpt-6-astra", model_reasoning_effort: "ultra" },
          inheritedPermissions,
        },
      }),
    },
  );
  expect(result).toBe(0);
  expect(selected).toMatchObject({ resumeScanId: id, inheritedPermissions });
});
