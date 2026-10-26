import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  formatClaudeResult,
  MODEL_CHOICES,
  runClaude,
  startProgressHeartbeat,
} from "./claude-run.mjs";

const server = new McpServer({
  name: "claude-subagent",
  version: "1.2.2",
});

server.registerTool(
  "run_claude_subagent",
  {
    title: "Run Claude Code subagent",
    description: [
      "Run a scoped Claude Code session on the signed-in Claude subscription (Opus by default).",
      "This does not use Cursor model credits.",
      "mode=read (default) can Read, Grep, Glob, and search or fetch the web. mode=edit can also Edit and Write inside cwd.",
      "mode=shell can also run Bash. No mode can call MCP tools.",
      "Pass cwd as the absolute workspace root. The child does not see this chat, so put the task, file paths, and constraints in prompt.",
      "The call stays open and reports progress until Claude exits. Do not start another call because this one is quiet.",
      "Use resume with the returned session_id to continue that session.",
    ].join(" "),
    inputSchema: z.object({
      prompt: z
        .string()
        .describe("Full task. Include paths and what to return."),
      mode: z
        .enum(["read", "edit", "shell"])
        .optional()
        .describe(
          "read is the default. edit may change files under cwd. shell may also run Bash. Every mode can search and fetch the web. No mode can call MCP tools."
        ),
      cwd: z
        .string()
        .optional()
        .describe(
          "Absolute working directory. Required for edit and shell. Cannot be / or your home directory."
        ),
      paths: z
        .array(z.string())
        .optional()
        .describe(
          "Extra absolute directories. In read mode, a file path allows that file's directory. edit and shell accept directories only."
        ),
      model: z
        .enum(MODEL_CHOICES)
        .optional()
        .describe(
          "Default opus. opus is Claude Opus 5.5, sonnet is Claude Sonnet 5.5, haiku is Claude Haiku 5.5, and fable is Claude Fable 5.1. Full ids are accepted too."
        ),
      max_budget_usd: z
        .number()
        .optional()
        .describe(
          "Estimated spend cap from 0.25 to 8. Default 1.5 for read and 4 for edit and shell."
        ),
      resume: z
        .string()
        .optional()
        .describe("session_id from an earlier result."),
      timeout_sec: z
        .number()
        .int()
        .optional()
        .describe("Wall clock limit from 30 to 300. Default 180."),
    }),
  },
  async (args, extra) => {
    const stopHeartbeat = startProgressHeartbeat({
      progressToken: extra?._meta?.progressToken,
      sendNotification: (notification) => extra.sendNotification(notification),
    });
    try {
      const run = await runClaude(args, { signal: extra?.signal });
      const failed =
        run.isError ||
        run.timedOut ||
        run.cancelled ||
        run.exitCode !== 0 ||
        !run.parsed;
      return {
        isError: failed,
        content: [{ type: "text", text: formatClaudeResult(run) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    } finally {
      stopHeartbeat();
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
