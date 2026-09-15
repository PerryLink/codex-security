import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { acquireScanExecution } from "../src/scan-execution.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("two independent hosts cannot execute one parent; owner exit permits recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "scan-ownership-"));
  roots.push(root);
  const state = join(root, "state");
  const first = join(root, "first");
  const other = join(root, "other");
  await Promise.all([mkdir(first), mkdir(other)]);
  const module = new URL("../src/scan-execution.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `import {acquireScanExecution} from ${JSON.stringify(module)};
    await acquireScanExecution(${JSON.stringify(state)}, ${JSON.stringify(first)});
    console.log("owned"); setInterval(() => {}, 1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    await once(child.stdout!, "data");
    await expect(acquireScanExecution(state, first)).rejects.toThrow(
      "already running",
    );
    const releaseOther = await acquireScanExecution(state, other);
    releaseOther();
    child.kill();
    await exited;
    const release = await acquireScanExecution(state, first);
    await expect(acquireScanExecution(state, first)).rejects.toThrow(
      "already running",
    );
    release();
    (await acquireScanExecution(state, first))();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
});
