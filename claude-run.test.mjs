import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";
import os from "node:os";
import {
  assertClaudeVersion,
  buildClaudeArgs,
  normalizeRequest,
  parseClaudeResult,
  PROGRESS_INTERVAL_MS,
  resolveModelId,
  runClaude,
  spawnClaude,
  startProgressHeartbeat,
  stripBillingEnv,
} from "./claude-run.mjs";

test("accepts Claude Code 2.1.259 and rejects older builds", () => {
  assert.equal(assertClaudeVersion("2.1.310 (Claude Code)\n"), "2.1.310");
  assert.equal(assertClaudeVersion("2.1.259"), "2.1.259");
  assert.equal(assertClaudeVersion("2.2.0"), "2.2.0");
  assert.throws(() => assertClaudeVersion("1.0.3 (Claude Code)"), /too old/);
  assert.throws(() => assertClaudeVersion("2.1.258"), /2\.1\.259/);
  assert.throws(() => assertClaudeVersion("2.0.0"), /too old/);
});

test("strips API billing env and keeps other variables", () => {
  const next = stripBillingEnv({
    ANTHROPIC_API_KEY: "sk-ant-secret",
    ANTHROPIC_AUTH_TOKEN: "token",
    PATH: "/usr/bin",
  });
  assert.equal(next.ANTHROPIC_API_KEY, undefined);
  assert.equal(next.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(next.PATH, "/usr/bin");
});

test("read mode cannot name Bash, Edit, or bypass", () => {
  const args = buildClaudeArgs({
    mode: "read",
    prompt: "Look at api.ts",
    model: "opus",
    maxBudgetUsd: 1.5,
    addDirs: [],
  });
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(args[0], "-p");
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "Look at api.ts");
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("dontAsk"));
  assert.equal(
    args[args.indexOf("--tools") + 1],
    "Read,Grep,Glob,WebFetch,WebSearch"
  );
  assert.equal(args[args.indexOf("--allowedTools") + 1], "WebFetch,WebSearch");
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.join(" ").includes("Bash"), false);
});

test("edit mode adds file writes and still omits Bash", () => {
  const args = buildClaudeArgs({
    mode: "edit",
    prompt: "Set the title",
    model: "sonnet",
    maxBudgetUsd: 4,
    resume: "8898fedb-1457-4c8f-ba3a-4172f100c3bd",
    addDirs: ["/tmp/cc-probe"],
  });
  assert.ok(args.includes("acceptEdits"));
  assert.equal(
    args[args.indexOf("--tools") + 1],
    "Read,Grep,Glob,Edit,Write,WebFetch,WebSearch"
  );
  assert.equal(args[args.indexOf("--allowedTools") + 1], "WebFetch,WebSearch");
  assert.equal(
    args[args.indexOf("--resume") + 1],
    "8898fedb-1457-4c8f-ba3a-4172f100c3bd"
  );
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/cc-probe");
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(args.join(" ").includes("Bash"), false);
  assert.ok(args.indexOf("--") > args.indexOf("--add-dir"));
  assert.equal(args.at(-1), "Set the title");
});

test("shell mode can run Bash and still refuses bypass", () => {
  const args = buildClaudeArgs({
    mode: "shell",
    prompt: "Run the tests",
    model: "haiku",
    maxBudgetUsd: 4,
    addDirs: [],
  });
  assert.equal(
    args[args.indexOf("--tools") + 1],
    "Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch"
  );
  assert.equal(
    args[args.indexOf("--allowedTools") + 1],
    "Bash,WebFetch,WebSearch"
  );
  assert.ok(args.includes("acceptEdits"));
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.equal(args.at(-2), "--");
  assert.equal(args.at(-1), "Run the tests");
});

test("a prompt that starts with dashes stays behind --", () => {
  const prompt = "--dangerously-skip-permissions";
  const args = buildClaudeArgs({
    mode: "read",
    prompt,
    model: "opus",
    maxBudgetUsd: 1.5,
    addDirs: [],
  });
  const end = args.indexOf("--");
  assert.equal(args[end + 1], prompt);
  assert.equal(args.indexOf(prompt), end + 1);
  assert.equal(args.includes("--bare"), false);
});

test("pins the current model ids", () => {
  assert.equal(resolveModelId("haiku"), "claude-haiku-5-5");
  assert.equal(resolveModelId("fable"), "claude-fable-5-1");
  assert.equal(resolveModelId("claude-opus-5-5"), "claude-opus-5-5");
  assert.throws(() => resolveModelId("mythos"), /model must be one of/);
});

test("parses a JSON result and a noisy prefix", () => {
  const clean = parseClaudeResult(
    JSON.stringify({ type: "result", result: "pong", is_error: false })
  );
  assert.equal(clean.resultText, "pong");
  assert.equal(clean.isError, false);
  const noisy = parseClaudeResult(
    'warning\n{"type":"result","result":"beta","is_error":true}\n'
  );
  assert.equal(noisy.resultText, "beta");
  assert.equal(noisy.isError, true);
});

test("progress heartbeat repeats inside the 120s idle window and then stops", async () => {
  assert.ok(PROGRESS_INTERVAL_MS > 0);
  assert.ok(PROGRESS_INTERVAL_MS < 120_000);
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const sent = [];
    const stop = startProgressHeartbeat({
      progressToken: 7,
      intervalMs: PROGRESS_INTERVAL_MS,
      sendNotification: (notification) => {
        sent.push(notification);
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "notifications/progress");
    assert.equal(sent[0].params.progressToken, 7);
    assert.equal(sent[0].params.progress, 1);
    assert.equal(sent[0].params.message, "Claude Code is still running");
    mock.timers.tick(PROGRESS_INTERVAL_MS);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].params.progress, 2);
    stop();
    mock.timers.tick(PROGRESS_INTERVAL_MS);
    assert.equal(sent.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("progress heartbeat ignores a missing token and a failed send", () => {
  const stop = startProgressHeartbeat({
    sendNotification: () => {
      throw new Error("no listener");
    },
  });
  stop();
  const sent = [];
  const stopAgain = startProgressHeartbeat({
    progressToken: "",
    sendNotification: (notification) => sent.push(notification),
  });
  stopAgain();
  assert.equal(sent.length, 0);
  assert.doesNotThrow(() => {
    const stopThrow = startProgressHeartbeat({
      progressToken: 4,
      intervalMs: 60_000,
      sendNotification: () => {
        throw new Error("closed");
      },
    });
    stopThrow();
  });
});

test("timeout and cancel both stop the child", async () => {
  const hanging = [process.execPath, ["-e", "setInterval(() => {}, 1000)"]];
  const timed = await spawnClaude({
    bin: hanging[0],
    args: hanging[1],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 200,
  });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.cancelled, false);

  const ac = new AbortController();
  const pending = spawnClaude({
    bin: hanging[0],
    args: hanging[1],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 30_000,
    signal: ac.signal,
  });
  setTimeout(() => ac.abort(), 50);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.timedOut, false);

  ac.abort();
  const already = await spawnClaude({
    bin: hanging[0],
    args: hanging[1],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 30_000,
    signal: ac.signal,
  });
  assert.equal(already.cancelled, true);
});

test("runClaude stops the child when the caller aborts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-subagent-"));
  const started = path.join(dir, "started");
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
if (process.argv[2] === "--version") {
  console.log("2.1.310 (Claude Code)");
  process.exit(0);
}
fs.writeFileSync(process.env.STARTED_FILE, String(process.pid));
setInterval(() => {}, 1000);
`
  );
  chmodSync(bin, 0o755);
  const ac = new AbortController();
  try {
    const pending = runClaude(
      { prompt: "review", cwd: dir, timeout_sec: 30 },
      {
        env: { ...process.env, CLAUDE_BIN: bin, STARTED_FILE: started },
        signal: ac.signal,
      }
    );
    const pid = await waitForFile(started);
    ac.abort();
    const run = await pending;
    assert.equal(run.cancelled, true);
    assert.equal(run.timedOut, false);
    assert.equal(processAlive(Number(pid)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit and shell require a project cwd and real directories", async () => {
  await assert.rejects(
    normalizeRequest({ mode: "edit", prompt: "Set the title" }),
    /cwd is required/
  );
  await assert.rejects(
    normalizeRequest({ mode: "shell", prompt: "Run", cwd: "/" }),
    /home directory/
  );
  await assert.rejects(
    normalizeRequest({ mode: "edit", prompt: "Set", cwd: os.homedir() }),
    /home directory/
  );

  const project = mkdtempSync(path.join(tmpdir(), "claude-subagent-cwd-"));
  const outside = mkdtempSync(path.join(tmpdir(), "claude-subagent-out-"));
  const file = path.join(outside, "secret.txt");
  writeFileSync(file, "nope");
  try {
    const read = await normalizeRequest({
      mode: "read",
      prompt: "Look",
      cwd: project,
      paths: [file],
    });
    assert.deepEqual(read.addDirs, [realpathSync(outside)]);
    await assert.rejects(
      normalizeRequest({
        mode: "edit",
        prompt: "Change",
        cwd: project,
        paths: [file],
      }),
      /must be a directory/
    );
    const edit = await normalizeRequest({
      mode: "shell",
      prompt: "Run",
      cwd: project,
      paths: [outside],
    });
    assert.deepEqual(edit.addDirs, [realpathSync(outside)]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("cancel kills the process group", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-subagent-group-"));
  const grandFile = path.join(dir, "grand");
  const bin = writeNodeBin(
    dir,
    "parent.cjs",
    `const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.env.GRAND_FILE, String(process.pid)); setInterval(() => {}, 1000);"], { stdio: "ignore" });
child.unref();
setInterval(() => {}, 1000);
`
  );
  const ac = new AbortController();
  try {
    const pending = spawnClaude({
      bin,
      args: [],
      cwd: dir,
      env: { ...process.env, GRAND_FILE: grandFile },
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    const pid = Number(await waitForFile(grandFile));
    ac.abort();
    const run = await pending;
    assert.equal(run.cancelled, true);
    assert.equal(processAlive(pid), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandchild holding the output pipe cannot hang the call", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-subagent-pipe-"));
  const grandFile = path.join(dir, "grand");
  const bin = writeNodeBin(
    dir,
    "parent.cjs",
    `const { spawn } = require("child_process");
const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(process.env.GRAND_FILE, String(process.pid)); setInterval(() => {}, 1000);"], { detached: true, stdio: "inherit" });
child.unref();
console.log("parent-exit");
process.exit(0);
`
  );
  let pid = 0;
  try {
    const started = Date.now();
    const run = await spawnClaude({
      bin,
      args: [],
      cwd: dir,
      env: { ...process.env, GRAND_FILE: grandFile },
      timeoutMs: 30_000,
    });
    assert.ok(Date.now() - started < 4000);
    assert.equal(run.timedOut, false);
    assert.equal(run.cancelled, false);
    assert.match(run.stdout, /parent-exit/);
    pid = Number(await waitForFile(grandFile));
    assert.equal(processAlive(pid), true);
  } finally {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an MCP call reports progress before the Claude result", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-subagent-mcp-"));
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
if (process.argv[2] === "--version") {
  console.log("2.1.310 (Claude Code)");
  process.exit(0);
}
setTimeout(() => {
  console.log(JSON.stringify({
    type: "result",
    result: "pong",
    is_error: false,
    session_id: "8898fedb-1457-4c8f-ba3a-4172f100c3bd",
    total_cost_usd: 0,
    num_turns: 1
  }));
  process.exit(0);
}, 50);
`
  );
  chmodSync(bin, 0o755);
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.CLAUDE_BIN = bin;
  const root = path.dirname(fileURLToPath(import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "server.mjs")],
    cwd: root,
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "claude-subagent-test", version: "0.0.0" });
  const notes = [];
  try {
    await client.connect(transport);
    const result = await client.callTool(
      {
        name: "run_claude_subagent",
        arguments: { prompt: "hi", cwd: dir, timeout_sec: 30, model: "haiku" },
      },
      undefined,
      {
        timeout: 10_000,
        resetTimeoutOnProgress: true,
        onprogress: (progress) => notes.push(progress),
      }
    );
    assert.equal(result.isError, false);
    assert.match(String(result.content?.[0]?.text), /pong/);
    assert.ok(notes.length >= 1);
    assert.equal(notes[0].progress, 1);
    assert.equal(notes[0].message, "Claude Code is still running");
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeNodeBin(dir, name, source) {
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${source}`);
  chmodSync(bin, 0o755);
  return bin;
}

function waitForFile(file) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        const text = readFileSync(file, "utf8").trim();
        if (text) {
          clearInterval(timer);
          resolve(text);
        }
      } catch {
        if (Date.now() - startedAt > 4000) {
          clearInterval(timer);
          reject(new Error("child did not start"));
        }
      }
    }, 20);
  });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
