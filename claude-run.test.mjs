import assert from "node:assert/strict";
import test from "node:test";
import {
  assertClaudeVersion,
  buildClaudeArgs,
  parseClaudeResult,
  resolveModelId,
  stripBillingEnv,
} from "./claude-run.mjs";

test("accepts Claude Code 2 and rejects 1.0.3", () => {
  assert.equal(assertClaudeVersion("2.1.310 (Claude Code)\n"), "2.1.310");
  assert.throws(() => assertClaudeVersion("1.0.3 (Claude Code)"), /too old/);
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
  assert.ok(args.includes("--restricted"));
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("dontAsk"));
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
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
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob,Edit,Write");
  assert.equal(
    args[args.indexOf("--resume") + 1],
    "8898fedb-1457-4c8f-ba3a-4172f100c3bd"
  );
  assert.equal(args[args.indexOf("--add-dir") + 1], "/tmp/cc-probe");
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.equal(args.join(" ").includes("Bash"), false);
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
    "Read,Grep,Glob,Edit,Write,Bash"
  );
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Bash");
  assert.ok(args.includes("acceptEdits"));
  assert.equal(args.includes("bypassPermissions"), false);
  assert.equal(args.includes("--bare"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
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
