import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  bundle: true,
  entryPoints: [
    fileURLToPath(new URL("../src/native-scan.ts", import.meta.url)),
  ],
  define: {
    "import.meta.url": JSON.stringify(
      new URL("../src/native-scan.ts", import.meta.url).href,
    ),
  },
  format: "cjs",
  platform: "node",
  write: false,
  plugins: [
    {
      name: "capture-ordinary-client",
      setup(build) {
        build.onResolve({ filter: /sdk\/typescript\/src\/api\.js$/ }, () => ({
          path: "client",
          namespace: "fixture",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          resolveDir: fileURLToPath(new URL("../src/", import.meta.url)),
          contents: `export { selectedScanEnvironment } from ${JSON.stringify(fileURLToPath(new URL("../../../../sdk/typescript/src/api.ts", import.meta.url)))};
             export class CodexSecurity { constructor(config, dependencies) { this.config = config; this.dependencies = dependencies; } }`,
        }));
      },
    },
  ],
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { NativeScanHost, prepareNativeScan, nativeScanConfiguration } =
  module.exports;

function input(id = "parent") {
  return {
    scan: {
      scanId: id,
      scanDir: join(tmpdir(), id),
      targetPath: tmpdir(),
      userContext: "Review the boundary.",
    },
    threadId: "native-owner",
    pluginRoot: tmpdir(),
    pythonPath: process.execPath,
    parentSandbox: { filesystemDenies: [] },
  };
}

test("native waiters join one ordinary scan and detaching leaves it running", async () => {
  const started = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let preparations = 0;
  let closes = 0;
  let signal;
  const host = new NativeScanHost(async () => {
    preparations++;
    return {
      options: { mode: "deep" },
      client: {
        run(_repository, options) {
          signal = options.signal;
          started.resolve();
          return completed.promise;
        },
        async close() {
          closes++;
        },
      },
    };
  });
  const waiter = new AbortController();
  const first = host.run(input(), waiter.signal);
  const joined = host.run(input());
  await started.promise;
  const rejected = assert.rejects(first, /detached/);
  waiter.abort(new Error("detached"));
  await rejected;
  assert.equal(signal.aborted, false);
  completed.resolve({ scanDir: "sealed-parent" });
  assert.deepEqual(await joined, { scanDir: "sealed-parent" });
  assert.equal(preparations, 1);
  assert.equal(closes, 1);
});

test("native cancellation drains only its parent; shutdown drains the rest", async () => {
  const started = new Map();
  const closed = [];
  const closing = Promise.withResolvers();
  const releaseClose = Promise.withResolvers();
  const host = new NativeScanHost(async ({ scan }) => ({
    options: { mode: "deep" },
    client: {
      run(_repository, { signal }) {
        started.set(scan.scanId, signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      async close() {
        if (scan.scanId === "second") {
          closing.resolve();
          await releaseClose.promise;
        }
        closed.push(scan.scanId);
      },
    },
  }));
  const first = host.run(input("first"));
  const second = host.run(input("second"));
  const firstRejected = assert.rejects(first, /user_canceled_scan/);
  const secondRejected = assert.rejects(second, (error) => {
    assert.equal(error.constructor.name, "ScanTransportClosedError");
    assert.equal(error.message, "mcp_transport_closed");
    return true;
  });
  await Promise.resolve();
  await Promise.resolve();
  await host.cancel("first");
  await firstRejected;
  assert.equal(started.get("first").reason.constructor, Error);
  assert.equal(started.get("second").aborted, false);
  assert.deepEqual(closed, ["first"]);
  let drained = false;
  const shutdown = host.close().then(() => {
    drained = true;
  });
  await closing.promise;
  assert.equal(drained, false);
  assert.deepEqual(closed, ["first"]);
  releaseClose.resolve();
  await shutdown;
  await secondRejected;
  assert.deepEqual(closed, ["first", "second"]);
});

test("native launches snapshot safety identifiers and prefer saved recipes", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-safety-identifier-"));
  const keys = [
    "CODEX_HOME",
    "CODEX_CLI_PATH",
    "CODEX_SECURITY_CONFIG_PATH",
    "CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH",
    "CODEX_SAFETY_IDENTIFIER",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      CODEX_HOME: root,
      CODEX_CLI_PATH: process.execPath,
    });
    delete process.env.CODEX_SECURITY_CONFIG_PATH;
    delete process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH;
    await writeFile(
      join(root, "config.toml"),
      'model_provider = "synthetic"\n[model_providers.synthetic]\nbase_url = "https://example.invalid"\n',
    );
    const launches = [
      ["synthetic-fresh", undefined, "synthetic-fresh"],
      ["synthetic-resumed", {}, "synthetic-resumed"],
      [
        "synthetic-current",
        { safetyIdentifier: "synthetic-saved" },
        "synthetic-saved",
      ],
      [undefined, undefined, undefined],
    ].map(([ambient, recipe, expected], index) => {
      if (ambient === undefined) delete process.env.CODEX_SAFETY_IDENTIFIER;
      else process.env.CODEX_SAFETY_IDENTIFIER = ambient;
      return prepareNativeScan({ ...input(`parent-${index}`), recipe }).then(
        ({ client, options }) => {
          assert.equal(options.safetyIdentifier, expected);
          assert.equal(
            client.dependencies.environment.CODEX_SAFETY_IDENTIFIER,
            ambient,
          );
        },
      );
    });
    await Promise.all(launches);
    assert.equal(process.env.CODEX_SAFETY_IDENTIFIER, undefined);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "native-selected credentials reach actual SDK child processes",
  {
    skip:
      process.platform === "win32"
        ? "Synthetic executable uses a POSIX shebang."
        : false,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "native-auth-child-"));
    const executable = join(root, "codex");
    const capture = join(root, "capture.json");
    const keys = [
      "CODEX_HOME",
      "CODEX_CLI_PATH",
      "CODEX_SECURITY_CONFIG_PATH",
      "CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
    ];
    const before = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    try {
      await writeFile(
        executable,
        `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("login")) {
  fs.writeFileSync(${JSON.stringify(join(root, "login.json"))}, JSON.stringify({
    codex: process.env.CODEX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    argv: process.argv.slice(2),
  }));
  if (fs.existsSync(${JSON.stringify(join(root, "account-error"))})) {
    console.error("Could not access the selected keyring");
    process.exit(2);
  }
  const authenticated = fs.existsSync(${JSON.stringify(join(root, "account-present"))});
  console.error(authenticated ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(authenticated ? 0 : 1);
}
fs.writeFileSync(process.env.NATIVE_AUTH_CAPTURE, JSON.stringify({
  codex: process.env.CODEX_API_KEY,
  openai: process.env.OPENAI_API_KEY,
  executable: process.execPath,
  argv: process.argv.slice(2),
}));
console.log(JSON.stringify({ type: "thread.started", thread_id: "synthetic-auth-thread" }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }));
`,
      );
      await chmod(executable, 0o700);
      Object.assign(process.env, {
        CODEX_HOME: root,
        CODEX_CLI_PATH: executable,
        CODEX_API_KEY: "synthetic-native-selected",
        OPENAI_API_KEY: "synthetic-competing-key",
      });
      delete process.env.CODEX_SECURITY_CONFIG_PATH;
      delete process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH;
      for (const [provider, modelProvider] of [
        [undefined, undefined],
        [{ env_key: "OPENAI_API_KEY" }, "custom"],
        [
          { auth: { type: "command", command: "synthetic-auth-provider" } },
          "custom",
        ],
        [{ requires_openai_auth: true }, "custom"],
        [{ env_key: "OPENAI_API_KEY" }, undefined],
        [
          { auth: { type: "command", command: "synthetic-auth-provider" } },
          undefined,
        ],
      ]) {
        const selected = provider !== undefined;
        const providerName = modelProvider ?? "openai";
        const configured = selected && provider.requires_openai_auth !== true;
        const config = {
          model: "saved-model",
          model_reasoning_effort: "ultra",
          ...(selected
            ? {
                ...(modelProvider === undefined
                  ? {}
                  : { model_provider: modelProvider }),
                model_providers: { [providerName]: provider },
              }
            : {}),
        };
        await writeFile(
          join(root, "config.toml"),
          selected
            ? (modelProvider === undefined
                ? ""
                : `model_provider = "${modelProvider}"\n`) +
                `[model_providers.${providerName}]\n` +
                (provider.auth
                  ? `[model_providers.${providerName}.auth]\ntype = "command"\ncommand = "synthetic-auth-provider"\n`
                  : provider.requires_openai_auth
                    ? "requires_openai_auth = true\n"
                    : 'env_key = "OPENAI_API_KEY"\n')
            : "",
        );
        for (const recipe of [undefined, { auth: "api-key", config }]) {
          const prepared = await prepareNativeScan({
            ...input(),
            recipe,
            model: "current-model",
            reasoningEffort: "low",
          });
          assert.equal(
            prepared.options.preserveProviderEnvironment,
            configured ? true : undefined,
          );
          assert.equal(
            prepared.client.config.codexOverrides.model_provider,
            selected ? providerName : undefined,
          );
          const sdk = prepared.client.dependencies.createCodex({
            codexPathOverride: executable,
            config: prepared.client.config.codexOverrides,
            env: {
              ...prepared.client.dependencies.environment,
              NATIVE_AUTH_CAPTURE: capture,
            },
          });
          await sdk
            .startThread({ workingDirectory: root, skipGitRepoCheck: true })
            .run("Synthetic credential launch only.");
          const observed = JSON.parse(await readFile(capture, "utf8"));
          assert.equal(observed.codex, "synthetic-native-selected");
          assert.equal(
            observed.openai,
            configured ? "synthetic-competing-key" : undefined,
          );
          assert.ok(
            observed.argv.includes(
              `model=${JSON.stringify(recipe ? "saved-model" : "current-model")}`,
            ),
          );
          assert.ok(
            observed.argv.includes(
              `model_reasoning_effort=${JSON.stringify(recipe ? "ultra" : "low")}`,
            ),
          );
          assert.equal(observed.executable, process.execPath);
          assert.equal(process.env.CODEX_API_KEY, "synthetic-native-selected");
          assert.equal(process.env.OPENAI_API_KEY, "synthetic-competing-key");
        }
      }
      const accountConfig = {
        cli_auth_credentials_store: "file",
        forced_chatgpt_workspace_id: "synthetic-workspace",
      };
      await writeFile(
        join(root, "config.toml"),
        'cli_auth_credentials_store = "file"\nforced_chatgpt_workspace_id = "synthetic-workspace"\n',
      );
      delete process.env.CODEX_API_KEY;
      for (const authenticated of [true, false]) {
        if (authenticated)
          await writeFile(join(root, "account-present"), "synthetic");
        else await rm(join(root, "account-present"));
        for (const recipe of [
          undefined,
          { auth: "auto", config: accountConfig },
        ]) {
          const prepared = await prepareNativeScan({ ...input(), recipe });
          const login = JSON.parse(
            await readFile(join(root, "login.json"), "utf8"),
          );
          assert.equal(login.codex, undefined);
          assert.equal(login.openai, undefined);
          assert.ok(login.argv.includes('cli_auth_credentials_store="file"'));
          assert.ok(
            login.argv.includes(
              'forced_chatgpt_workspace_id="synthetic-workspace"',
            ),
          );
          assert.equal(
            prepared.options.auth,
            authenticated ? "chatgpt" : recipe?.auth,
          );
          assert.equal(
            prepared.client.dependencies.environment.OPENAI_API_KEY,
            authenticated ? undefined : "synthetic-competing-key",
          );
          assert.equal(process.env.OPENAI_API_KEY, "synthetic-competing-key");
        }
      }
      await writeFile(join(root, "account-error"), "synthetic");
      for (const [provider, providerToml] of [
        [undefined, ""],
        [{ requires_openai_auth: true }, "requires_openai_auth = true\n"],
        [
          { requires_openai_auth: true, env_key: "OPENAI_API_KEY" },
          'requires_openai_auth = true\nenv_key = "OPENAI_API_KEY"\n',
        ],
        [
          { auth: { type: "command", command: "synthetic-auth-provider" } },
          '[model_providers.custom.auth]\ntype = "command"\ncommand = "synthetic-auth-provider"\n',
        ],
      ]) {
        const config = {
          ...accountConfig,
          ...(provider && {
            model_provider: "custom",
            model_providers: { custom: provider },
          }),
        };
        await writeFile(
          join(root, "config.toml"),
          'cli_auth_credentials_store = "file"\nforced_chatgpt_workspace_id = "synthetic-workspace"\n' +
            (provider
              ? 'model_provider = "custom"\n[model_providers.custom]\n' +
                providerToml
              : ""),
        );
        for (const recipe of [undefined, { auth: "auto", config }]) {
          await rm(join(root, "login.json"), { force: true });
          if (provider?.env_key || provider?.auth) {
            const prepared = await prepareNativeScan({ ...input(), recipe });
            assert.equal(prepared.options.preserveProviderEnvironment, true);
            assert.equal(
              prepared.client.dependencies.environment.OPENAI_API_KEY,
              "synthetic-competing-key",
            );
            await assert.rejects(readFile(join(root, "login.json")), {
              code: "ENOENT",
            });
          } else {
            await assert.rejects(prepareNativeScan({ ...input(), recipe }), {
              name: "CodexSecurityError",
              message: "Could not access the selected keyring",
            });
            const login = JSON.parse(
              await readFile(join(root, "login.json"), "utf8"),
            );
            assert.ok(login.argv.includes('cli_auth_credentials_store="file"'));
            assert.ok(
              login.argv.includes(
                'forced_chatgpt_workspace_id="synthetic-workspace"',
              ),
            );
            assert.equal(login.openai, undefined);
            assert.equal(login.codex, undefined);
          }
          assert.equal(process.env.OPENAI_API_KEY, "synthetic-competing-key");
        }
      }
      await rm(join(root, "account-error"));
      await writeFile(join(root, "account-present"), "synthetic");
      await writeFile(
        join(root, "config.toml"),
        'model_provider = "custom"\n[model_providers.custom]\nrequires_openai_auth = true\n',
      );
      for (const recipe of [
        undefined,
        {
          auth: "auto",
          config: {
            model_provider: "custom",
            model_providers: { custom: { requires_openai_auth: true } },
          },
        },
      ]) {
        await rm(join(root, "login.json"), { force: true });
        const prepared = await prepareNativeScan({ ...input(), recipe });
        assert.equal(prepared.options.preserveProviderEnvironment, undefined);
        assert.equal(prepared.options.auth, "chatgpt");
        assert.equal(
          prepared.client.dependencies.environment.OPENAI_API_KEY,
          undefined,
        );
        const login = JSON.parse(
          await readFile(join(root, "login.json"), "utf8"),
        );
        assert.equal(login.openai, undefined);
        assert.equal(process.env.OPENAI_API_KEY, "synthetic-competing-key");
      }
      await rm(join(root, "login.json"));
      const forced = await prepareNativeScan({
        ...input(),
        recipe: { auth: "auto", config: { forced_login_method: "chatgpt" } },
      });
      assert.equal(forced.options.auth, "chatgpt");
      assert.equal(
        forced.client.dependencies.environment.OPENAI_API_KEY,
        undefined,
      );
      await assert.rejects(readFile(join(root, "login.json")), {
        code: "ENOENT",
      });
    } finally {
      for (const key of keys) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native saved scans retain settings, auth environment, permissions and identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-scan-settings-"));
  const keys = [
    "CODEX_HOME",
    "CODEX_CLI_PATH",
    "CODEX_SECURITY_CONFIG_PATH",
    "CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CODEX_SECURITY_KNOWLEDGE_BASE",
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    await writeFile(
      join(root, "config.toml"),
      'model_provider = "synthetic"\n[model_providers.synthetic]\nbase_url = "https://example.invalid"\nwire_api = "responses"\n[plugins]\nfixture = true\n',
    );
    await writeFile(
      join(root, "selected.toml"),
      'model = "selected-model"\nmodel_reasoning_summary = "detailed"\n[agents]\nmax_threads = 20\nmax_depth = 2\n[features]\nenable_fanout = false\n[features.multi_agent_v2]\nenabled = false\n',
    );
    Object.assign(process.env, {
      CODEX_HOME: root,
      CODEX_CLI_PATH: process.execPath,
      CODEX_SECURITY_CONFIG_PATH: join(root, "selected.toml"),
      CODEX_API_KEY: "synthetic-key",
      OPENAI_API_KEY: "synthetic-other-key",
      OPENROUTER_API_KEY: "synthetic-provider-key",
    });
    delete process.env.CODEX_SECURITY_KNOWLEDGE_BASE;
    delete process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH;
    const request = {
      ...input(),
      model: "active-model",
      reasoningEffort: "ultra",
      stateDirectory: join(root, "state"),
      parentSandbox: {
        filesystemDenies: ["/fixture/.env"],
        globScanMaxDepth: 3,
      },
      scan: { ...input().scan, handoffClaimToken: "saved-claim" },
      recipe: {
        auth: "api-key",
        target: { kind: "paths", paths: ["src/auth", "src/data"] },
        deepScan: { workers: 4, subagents: 3 },
        maxCostUsd: 10,
        postScanPrompt: "Publish once.",
      },
    };
    const { client, options } = await prepareNativeScan(request);
    assert.equal(client.config.pluginPath, request.pluginRoot);
    assert.equal(client.config.codexOverrides.model, "active-model");
    assert.equal(client.config.codexOverrides.model_reasoning_effort, "ultra");
    assert.equal(
      client.config.codexOverrides.model_reasoning_summary,
      "detailed",
    );
    assert.equal(
      client.config.codexOverrides.model_providers.synthetic.base_url,
      "https://example.invalid",
    );
    assert.equal(client.config.codexOverrides.plugins, undefined);
    assert.deepEqual(client.config.codexOverrides.agents, { max_depth: 2 });
    assert.deepEqual(client.config.codexOverrides.features, {
      enable_fanout: false,
      multi_agent_v2: { enabled: true, max_concurrent_threads_per_session: 4 },
    });
    assert.equal(
      client.dependencies.environment.CODEX_API_KEY,
      "synthetic-key",
    );
    assert.equal(
      client.dependencies.environment.OPENAI_API_KEY,
      "synthetic-other-key",
    );
    assert.equal(process.env.OPENAI_API_KEY, "synthetic-other-key");
    assert.equal(process.env.CODEX_API_KEY, "synthetic-key");
    for (const [auth, modelProvider] of [
      ["auto", "openai"],
      ["chatgpt", "openai"],
      ["api-key", "openrouter"],
    ]) {
      const selected = await prepareNativeScan({
        ...request,
        recipe: {
          ...request.recipe,
          auth,
          config: { model_provider: modelProvider },
        },
      });
      assert.equal(
        selected.client.dependencies.environment.OPENAI_API_KEY,
        modelProvider === "openrouter" ? "synthetic-other-key" : undefined,
      );
      assert.equal(
        selected.client.dependencies.environment.CODEX_API_KEY,
        auth === "chatgpt" ? undefined : "synthetic-key",
      );
      assert.equal(
        selected.client.dependencies.environment.OPENROUTER_API_KEY,
        "synthetic-provider-key",
      );
      assert.equal(process.env.OPENAI_API_KEY, "synthetic-other-key");
      assert.equal(process.env.CODEX_API_KEY, "synthetic-key");
    }
    assert.equal(
      client.dependencies.environment.CODEX_CLI_PATH,
      process.execPath,
    );
    assert.equal(
      client.dependencies.environment.CODEX_SECURITY_STATE_DIR,
      request.stateDirectory,
    );
    assert.deepEqual(client.dependencies.inheritedPermissions, {
      filesystem: { "/fixture/.env": "deny", glob_scan_max_depth: 3 },
      network: { enabled: false },
    });
    assert.equal(options.workers, 4);
    assert.equal(options.subagents, 3);
    assert.equal(options.auth, "api-key");
    assert.equal(options.maxCostUsd, 10);
    assert.equal(options.postScanPrompt, "Publish once.");
    const withoutContext = await prepareNativeScan({
      ...request,
      scan: { ...request.scan, userContext: null },
    });
    assert.equal(withoutContext.options.scanPrompt, undefined);
    for (const [savedDepth, currentDepth] of [
      [3, 10],
      [10, 3],
      [3, undefined],
    ]) {
      const savedPermissions = await prepareNativeScan({
        ...request,
        parentSandbox: {
          ...request.parentSandbox,
          globScanMaxDepth: currentDepth,
        },
        recipe: {
          ...request.recipe,
          inheritedPermissions: {
            filesystem: {
              "/saved/.env": "deny",
              glob_scan_max_depth: savedDepth,
            },
            network: { enabled: false },
          },
        },
      });
      assert.deepEqual(savedPermissions.options.inheritedPermissions, {
        filesystem: {
          "/saved/.env": "deny",
          "/fixture/.env": "deny",
          glob_scan_max_depth: 3,
        },
        network: { enabled: false },
      });
      assert.deepEqual(
        savedPermissions.client.dependencies.inheritedPermissions,
        savedPermissions.options.inheritedPermissions,
      );
    }
    assert.deepEqual(options.target, ["src/auth", "src/data"]);
    assert.deepEqual(options.registeredScan, {
      scanId: "parent",
      scanDir: input().scan.scanDir,
      threadId: "native-owner",
      handoffClaimToken: "saved-claim",
    });
    assert.equal(process.env.CODEX_HOME, root);
    const resumed = await nativeScanConfiguration(
      process.env,
      {
        recipe: {
          config: { model: "saved-model", model_reasoning_summary: "none" },
        },
      },
      3,
    );
    assert.equal(resumed.model, "saved-model");
    assert.equal(resumed.model_reasoning_summary, "none");
    const savedDeepScanSettings = {
      workers: 2,
      subagents: 1,
      stopAfterNoNew: 3,
      stopAfterConsecutiveErrors: 4,
      maxDiscoveryRuns: 7,
      maxTimeHours: 0.5,
    };
    process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH = join(root, "deep.toml");
    await writeFile(
      process.env.CODEX_SECURITY_DEEP_SCAN_CONFIG_PATH,
      "[invalid",
    );
    for (const recipe of [
      undefined,
      { deepScan: { workers: 3, subagents: 2 } },
    ]) {
      const restored = await prepareNativeScan({
        ...request,
        recipe,
        savedDeepScanSettings,
      });
      const expected = { ...savedDeepScanSettings, ...recipe?.deepScan };
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(restored.options[key], value);
      }
      assert.equal(
        restored.client.config.codexOverrides.features.multi_agent_v2
          .max_concurrent_threads_per_session,
        expected.subagents + 1,
      );
    }
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
