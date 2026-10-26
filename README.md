# claude-subagent-mcp

An MCP server that runs a scoped [Claude Code](https://code.claude.com) session on your Claude subscription. Cursor, or any other MCP client, can hand it a bounded task. The work is billed to that subscription, not to Cursor model credits.

## Why this exists

Cursor's model picker and Claude Code are separate bills. Choosing Opus, Sonnet, or another Claude model inside Cursor spends Cursor's third-party model allowance (or an Anthropic API key). A Claude Pro, Max, Team, or Enterprise seat cannot be attached to that picker. Anthropic ties that subscription to Claude's own apps, including the Claude Code CLI and the Claude Code extension.

That split shows up when Cursor credits for other models run out and Claude Code still has room. The useful shape is to keep the Cursor agent on an included Cursor model, and send one bounded slice to Claude Code: read a file and list the failure paths, review a diff, or edit a single directory. This server is that handoff. It starts the official `claude` binary, so the subscription login stays inside Claude Code.

It is not a way to put a Claude subscription behind Cursor's own model picker.

## What a call can do

`run_claude_subagent` starts one non-interactive Claude Code session.

| Mode | Default | Can do | Cannot do |
| --- | --- | --- | --- |
| `read` | yes | Read, Grep, and Glob inside the working directory | Edit files, run a shell, fetch the web, call MCP tools |
| `edit` | no | Those reads, plus Edit and Write inside the working directory | Run a shell, fetch the web, call MCP tools |
| `shell` | no | Those edits, plus Bash | Fetch the web, call MCP tools |

The child does not see the parent chat. Put the task, the file paths, and the limits in `prompt`. Pass `cwd` as the absolute workspace root.

A headless run cannot show a permission dialog. Read mode denies anything that would have prompted. Edit mode auto-approves file edits inside `cwd` and the extra directories in `paths`. Shell mode also runs Bash, so one approved call can execute commands, including commands that read files outside the workspace or reach the network. Web and MCP tools are not offered in any mode. The session skips personal and project Claude Code customizations (hooks, skills, MCP servers, and saved allow rules). The Claude login is still used.

`opus` is sent as Claude Opus 5.5. The bare `opus` alias in Claude Code can land on an older Opus. `sonnet`, `haiku`, and `fable` are pinned the same way:

| `model` | Runs |
| --- | --- |
| `opus` (default) | Claude Opus 5.5 |
| `sonnet` | Claude Sonnet 5.5 |
| `haiku` | Claude Haiku 5.5 |
| `fable` | Claude Fable 5.1 |

Full ids (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1`) are accepted too. Your plan has to include the model. If it does not, Claude Code returns an error and this server passes that error back.

Each call returns the result text, a `session_id`, the model that ran, and an estimated cost. Pass that `session_id` as `resume` to continue the same session. `max_budget_usd` stops the run at an estimated spend from 0.25 to 8 (default 1.5 for read, 4 for edit and shell). `timeout_sec` is the wall clock limit from 30 to 300 (default 180).

The parent approves this one MCP call. After the process starts, Cursor does not see each file read or edit. Those follow the fence above.

## Setup

You need:

- Node.js 20 or newer
- Claude Code 2.x on your `PATH` (`claude --version`)
- A Claude subscription that includes Claude Code, already logged in

Install Claude Code, then log in once in a terminal and confirm the subscription login:

```bash
claude
claude auth status
```

`authMethod` should be `claude.ai`. If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set in the environment, Claude Code bills the Anthropic API instead of the subscription. This server removes those two variables for the child process. Other API-key settings are left alone.

On macOS, Homebrew installs a current Claude Code binary:

```bash
brew install --cask claude-code@latest
```

Other systems: follow the Claude Code install instructions at [code.claude.com](https://code.claude.com).

Clone this repo and install its dependencies:

```bash
git clone https://github.com/claude-abounegm/claude-subagent-mcp.git
cd claude-subagent-mcp
npm install
```

`npm test` runs the unit tests. They do not call Claude.

### Cursor

Add this to `~/.cursor/mcp.json`. Use the absolute path of `server.mjs` from the clone. If Cursor cannot find `node` (common with nvm when Cursor is opened from the dock), use the absolute path of `node` as `command` too.

```json
{
  "mcpServers": {
    "claude-subagent": {
      "command": "node",
      "args": ["/absolute/path/to/claude-subagent-mcp/server.mjs"]
    }
  }
}
```

Reload MCP servers. The tool name is `run_claude_subagent`.

Optional environment variables, set on that MCP entry:

| Variable | Purpose |
| --- | --- |
| `CLAUDE_BIN` | Absolute path to `claude` when it is not on `PATH` |

### Any other MCP client

The server speaks MCP over stdio. Point the client at:

```bash
node /absolute/path/to/claude-subagent-mcp/server.mjs
```

## Example

A read-only handoff from the parent agent:

```json
{
  "prompt": "Read src/api.ts and list the failure paths. Do not edit files.",
  "cwd": "/absolute/path/to/the/workspace",
  "mode": "read",
  "model": "opus",
  "max_budget_usd": 1.5
}
```

Use `mode: "edit"` when that slice is supposed to change files without running commands. Use `mode: "shell"` when it needs Bash. The parent approves that choice once, and the commands then run without another prompt.

## License

MIT
