import { execFile, spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const READ_TOOLS = "Read,Grep,Glob";
const EDIT_TOOLS = "Read,Grep,Glob,Edit,Write";
const SHELL_TOOLS = "Read,Grep,Glob,Edit,Write,Bash";
// Aliases are pinned to the current ids. The bare `opus` alias can land on Opus 4.8.
export const MODEL_IDS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
  "claude-opus-5-5": "claude-opus-5-5",
  "claude-sonnet-5-5": "claude-sonnet-5-5",
  "claude-haiku-5-5": "claude-haiku-5-5",
  "claude-fable-5-1": "claude-fable-5-1",
};
export const MODEL_CHOICES = Object.keys(MODEL_IDS);
const BILLING_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_BUDGET = { read: 1.5, edit: 4, shell: 4 };
const MIN_BUDGET = 0.25;
const MAX_BUDGET = 8;
const DEFAULT_TIMEOUT_SEC = 180;
const MIN_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 300;

export function assertClaudeVersion(versionText) {
  const match = String(versionText).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 2) {
    throw new Error(
      `claude ${String(
        versionText
      ).trim()} is too old. Install with: brew install --cask claude-code@latest`
    );
  }
  return match[0];
}

export function resolveModelId(model) {
  const id = MODEL_IDS[model];
  if (!id) {
    throw new Error(`model must be one of: ${MODEL_CHOICES.join(", ")}`);
  }
  return id;
}

export function stripBillingEnv(env) {
  const next = { ...env };
  for (const key of BILLING_ENV) delete next[key];
  return next;
}

export function toolsForMode(mode) {
  if (mode === "shell") return SHELL_TOOLS;
  if (mode === "edit") return EDIT_TOOLS;
  return READ_TOOLS;
}

export function buildClaudeArgs(input) {
  const mode = input.mode;
  const args = [
    "-p",
    input.prompt,
    "--model",
    resolveModelId(input.model),
    "--output-format",
    "json",
    "--permission-mode",
    mode === "read" ? "dontAsk" : "acceptEdits",
    "--permission-prompts",
    "none",
    "--safe-mode",
    "--restricted",
    "--strict-mcp-config",
    "--tools",
    toolsForMode(mode),
    "--max-budget-usd",
    String(input.maxBudgetUsd),
  ];
  if (mode === "shell") args.push("--allowedTools", "Bash");
  if (input.resume) args.push("--resume", input.resume);
  for (const dir of input.addDirs) args.push("--add-dir", dir);
  return args;
}

export async function normalizeRequest(raw, options = {}) {
  const mode = raw.mode ?? "read";
  if (mode !== "read" && mode !== "edit" && mode !== "shell") {
    throw new Error('mode must be "read", "edit", or "shell"');
  }
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");
  if (prompt.length > 100_000) throw new Error("prompt is too long");

  const model = raw.model ?? "opus";
  resolveModelId(model);

  let resume;
  if (raw.resume != null && raw.resume !== "") {
    resume = String(raw.resume);
    if (!UUID_RE.test(resume)) throw new Error("resume must be a session UUID");
  }

  const defaultBudget = DEFAULT_BUDGET[mode];
  const maxBudgetUsd =
    raw.max_budget_usd == null ? defaultBudget : Number(raw.max_budget_usd);
  if (
    !Number.isFinite(maxBudgetUsd) ||
    maxBudgetUsd < MIN_BUDGET ||
    maxBudgetUsd > MAX_BUDGET
  ) {
    throw new Error(
      `max_budget_usd must be between ${MIN_BUDGET} and ${MAX_BUDGET}`
    );
  }

  const timeoutSec =
    raw.timeout_sec == null ? DEFAULT_TIMEOUT_SEC : Number(raw.timeout_sec);
  if (
    !Number.isInteger(timeoutSec) ||
    timeoutSec < MIN_TIMEOUT_SEC ||
    timeoutSec > MAX_TIMEOUT_SEC
  ) {
    throw new Error(
      `timeout_sec must be an integer between ${MIN_TIMEOUT_SEC} and ${MAX_TIMEOUT_SEC}`
    );
  }

  const cwd = await existingDirectory(
    raw.cwd ?? options.cwd ?? process.cwd(),
    "cwd"
  );
  const addDirs = [];
  for (const entry of raw.paths ?? []) {
    const dir = await existingDirectory(entry, "paths entry", {
      allowFile: true,
    });
    if (dir !== cwd && !addDirs.includes(dir)) addDirs.push(dir);
  }

  return {
    mode,
    prompt,
    model,
    resume,
    maxBudgetUsd,
    timeoutSec,
    cwd,
    addDirs,
  };
}

async function existingDirectory(input, label, { allowFile = false } = {}) {
  if (typeof input !== "string" || !path.isAbsolute(input)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = await realpath(input);
  const info = await stat(resolved);
  if (info.isDirectory()) return resolved;
  if (allowFile && info.isFile()) return path.dirname(resolved);
  throw new Error(`${label} must be a directory`);
}

let claudeBinPromise;

export function resolveClaudeBin(env = process.env) {
  if (env === process.env && claudeBinPromise) return claudeBinPromise;
  const pending = loadClaudeBin(env).catch((err) => {
    if (env === process.env) claudeBinPromise = undefined;
    throw err;
  });
  if (env === process.env) claudeBinPromise = pending;
  return pending;
}

async function loadClaudeBin(env) {
  const bin = env.CLAUDE_BIN || "claude";
  let stdout = "";
  try {
    const result = await execFileAsync(bin, ["--version"], {
      encoding: "utf8",
      env: stripBillingEnv(env),
    });
    stdout = result.stdout;
  } catch (err) {
    throw new Error(
      `Could not run ${bin}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const version = assertClaudeVersion(stdout);
  return { bin, version };
}

export async function runClaude(raw, options = {}) {
  const request = await normalizeRequest(raw, options);
  const { bin, version } = await resolveClaudeBin(options.env);
  const args = buildClaudeArgs(request);
  const childEnv = stripBillingEnv(options.env ?? process.env);
  const { stdout, stderr, exitCode, timedOut } = await spawnClaude({
    bin,
    args,
    cwd: request.cwd,
    env: childEnv,
    timeoutMs: request.timeoutSec * 1000,
  });

  const parsed = parseClaudeResult(stdout);
  return {
    ...parsed,
    exitCode,
    timedOut,
    stderr: stderr.trim(),
    claudeVersion: version,
    mode: request.mode,
    cwd: request.cwd,
  };
}

function spawnClaude({ bin, args, cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? 1, timedOut });
    });
  });
}

export function parseClaudeResult(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) {
    return { parsed: null, resultText: "", isError: true };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        parsed = null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return { parsed: null, resultText: text.slice(0, 8000), isError: true };
  }
  const resultText = typeof parsed.result === "string" ? parsed.result : "";
  return {
    parsed,
    resultText,
    isError: Boolean(parsed.is_error),
  };
}

export function formatClaudeResult(run) {
  const parsed = run.parsed ?? {};
  const models = parsed.modelUsage ? Object.keys(parsed.modelUsage) : [];
  const denials = Array.isArray(parsed.permission_denials)
    ? parsed.permission_denials
    : [];
  const lines = [run.resultText || "(no result text)"];
  lines.push("");
  lines.push(`session_id: ${parsed.session_id ?? ""}`);
  lines.push(`model: ${models.join(", ") || run.model || ""}`);
  lines.push(`mode: ${run.mode}`);
  lines.push(`cwd: ${run.cwd}`);
  lines.push(`cost_usd: ${parsed.total_cost_usd ?? ""}`);
  lines.push(`turns: ${parsed.num_turns ?? ""}`);
  lines.push(`claude: ${run.claudeVersion}`);
  if (denials.length) {
    lines.push(`permission_denials: ${JSON.stringify(denials)}`);
  }
  if (run.timedOut) lines.push("timed_out: true");
  if (run.exitCode !== 0) lines.push(`exit_code: ${run.exitCode}`);
  if (run.stderr) lines.push(`stderr: ${run.stderr.slice(-2000)}`);
  return lines.join("\n");
}
