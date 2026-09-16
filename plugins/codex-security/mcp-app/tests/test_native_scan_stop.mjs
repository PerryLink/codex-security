import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entrypoint = fileURLToPath(new URL("../server.ts", import.meta.url));
const bundle = await build({
  bundle: true,
  entryPoints: [entrypoint],
  define: { __dirname: JSON.stringify(dirname(entrypoint)) },
  format: "cjs",
  platform: "node",
  write: false,
  plugins: [
    {
      name: "native-stop-boundaries",
      setup(build) {
        const modules = {
          "@modelcontextprotocol/sdk/server/mcp.js": `
          export class McpServer {
            server = {};
            tools = new Map();
            registerTool(name, _config, handler) { this.tools.set(name, handler); }
            async close() {}
          }`,
          "./src/native-scan.js": `
          export class NativeScanHost {
            cancel(...args) { return fixture.cancel(...args); }
            async close() {}
          }`,
          "./src/python_command.js": `
          export async function resolvePythonCommand() { return "fixture-python"; }
          export function missingPythonHelperMessage() {}`,
          "node:child_process": `
          export function execFile() {}
          execFile[Symbol.for("nodejs.util.promisify.custom")] = (_command, args) =>
            fixture.workbench(args.slice(1)).then(result => ({ stdout: JSON.stringify(result) }));`,
        };
        build.onResolve({ filter: /.*/ }, ({ path }) =>
          Object.hasOwn(modules, path)
            ? { path, namespace: "fixture" }
            : undefined,
        );
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
          contents: modules[path],
        }));
      },
    },
  ],
});

function serverFor(fixture) {
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    "fixture",
    bundle.outputFiles[0].text,
  )(createRequire(import.meta.url), module, module.exports, fixture);
  return module.exports.createCodexSecurityServer();
}

for (const operation of ["cancel", "fail"]) {
  test(`native ${operation} authorizes, drains late child output, then publishes`, async () => {
    const scanId = "synthetic-parent";
    const claimToken = "synthetic-current-claim";
    const events = [];
    const draining = Promise.withResolvers();
    const release = Promise.withResolvers();
    const lateFindings = [];
    let rejectAuthority = true;
    let interrupted = true;
    let active = true;
    const scan = () => ({
      scanId,
      handoffClaimToken: claimToken,
      findings: [...lateFindings],
    });
    const workspace = () => ({ setup: { submitted: true }, results: scan() });
    const fixture = {
      async workbench(args) {
        const [command] = args;
        events.push(command);
        assert.equal(args[args.indexOf("--scan-id") + 1], scanId);
        if (command === `${operation}-scan`) {
          assert.ok(args.includes("--defer-publication"));
          if (rejectAuthority) throw new Error("Wrong scan owner or claim.");
          return operation === "cancel"
            ? workspace()
            : { scan: scan(), workspace: workspace() };
        }
        if (command === "get-scan")
          return { scan: scan(), workspace: workspace() };
        assert.equal(command, "preserve-scan-results");
        assert.ok(args.includes("--after-stop"));
        assert.equal(args[args.indexOf("--claim-token") + 1], claimToken);
        if (operation === "cancel") {
          assert.equal(
            args[args.indexOf("--thread-id") + 1],
            "synthetic-owner",
          );
        }
        assert.equal(active, false);
        assert.deepEqual(lateFindings, ["synthetic-child-finding"]);
        if (interrupted)
          throw new Error("Interrupted before result publication.");
        return {
          scan: scan(),
          workspace: workspace(),
          recipe: { private: "host-only" },
        };
      },
      async cancel(id, reason) {
        assert.equal(id, scanId);
        assert.equal(
          reason,
          operation === "fail" ? "Synthetic terminal failure." : undefined,
        );
        events.push("drain");
        if (!active) return;
        draining.resolve();
        await release.promise;
        lateFindings.push("synthetic-child-finding");
        active = false;
        events.push("drained");
      },
    };
    const server = serverFor(fixture);
    const handler = server.tools.get(`${operation}_codex_security_scan`);
    const call = () =>
      handler(
        {
          scanId,
          message: "Synthetic terminal failure.",
          handoffClaimToken: claimToken,
        },
        { _meta: { "openai/threadId": "synthetic-owner" } },
      );
    await assert.rejects(call(), /Wrong scan owner or claim/);
    assert.deepEqual(events, [`${operation}-scan`]);
    assert.equal(active, true);
    rejectAuthority = false;
    events.length = 0;
    const pending = assert.rejects(
      call(),
      /Interrupted before result publication/,
    );
    try {
      await draining.promise;
      assert.deepEqual(events, [`${operation}-scan`, "drain"]);
      assert.deepEqual(lateFindings, []);
    } finally {
      release.resolve();
    }
    await pending;
    assert.deepEqual(events, [
      `${operation}-scan`,
      "drain",
      "drained",
      ...(operation === "cancel" ? ["get-scan"] : []),
      "preserve-scan-results",
    ]);
    interrupted = false;
    const completed = await call();
    const context = completed.structuredContent;
    assert.deepEqual(context.workspace.results.findings, [
      "synthetic-child-finding",
    ]);
    assert.equal(context.recipe, undefined);
  });
}
