# shell-session-mcp

Persistent interactive shell sessions for MCP agents.

This MCP server gives MCP-capable AI clients a PTY-backed terminal session that can stay alive across multiple tool calls. It is for interactive or stateful terminal work: SSH logins that prompt for credentials, REPLs, custom terminal programs, long-running dev servers, prompt/response workflows, special keys, and session state that must carry across steps.

For ordinary non-interactive commands, prefer your client or system command-line execution tool. This server can run one-shot commands, but its main purpose is controlled interactive shell work.

This project is a fork and rename of [pungggi/smart-terminal-mcp](https://github.com/pungggi/smart-terminal-mcp). See [NOTICE](NOTICE) and [LICENSE](LICENSE) for attribution and license details.

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Interface

The server registers exactly one MCP tool:

```text
shell_session
```

The tool input is:

```json
{
  "action": "help",
  "args": {}
}
```

Use `action=help` first when the caller is unsure what to do:

```json
{ "action": "help" }
```

That returns a compact action catalog in `content[0].text` as a JSON string. To see detailed arguments and examples for selected actions:

```json
{ "action": "help", "args": { "actions": ["start", "write", "read"] } }
```

There is no `schema` action and no legacy multi-tool mode. Detailed usage is provided through `help`.

## When To Use It

Good use cases:

- Start an SSH login and respond to prompts.
- Drive a REPL such as Python, Node, database shells, or app-specific consoles.
- Interact with terminal programs that expect typed input over time.
- Start a dev server, wait for readiness text, then keep reading logs.
- Send Ctrl+C, Enter, Tab, Escape, or terminal resize events.
- Keep working directory, environment, and process state across steps.

Poor use cases:

- Simple commands like `git status`, `npm test`, `dir`, or `ls` when your client already has a command execution tool.
- One-shot scripts where no persistent terminal state or interaction is needed.

## Actions

| Action | Purpose |
|--------|---------|
| `help` | Show the action list or detailed help for selected actions. |
| `start` | Start a persistent terminal session. |
| `exec` | Run a command inside an existing session and wait for completion. |
| `run` | Run a one-shot non-interactive command. Prefer the client/system command tool for ordinary cases. |
| `run_paged` | Run a read-only command and return one page of output. |
| `write` | Send text or template input to a session. |
| `read` | Read new output from a session. |
| `get_history` | Read previous output from a session history. |
| `resize` | Resize a terminal session. |
| `send_key` | Send a special key such as Ctrl+C, Enter, Tab, or Escape. |
| `wait` | Wait until session output matches a pattern. |
| `watch` | Wait for one of several trigger patterns in session output. |
| `retry` | Retry a session command with bounded backoff. |
| `diff` | Run two session commands and return a unified diff. |
| `stop` | Stop a session, optionally returning a snapshot or writing a transcript. |
| `list` | List active sessions. |
| `write_file` | Write content to a file relative to the session working directory. |

## Tool Results

Successful structured payloads are returned as JSON strings in MCP `content[0].text`, which keeps the response compatible with clients that consume standard text content:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"usage\":\"...\",\"actions\":[...]}"
    }
  ]
}
```

The model is expected to read that JSON text and decide the next `shell_session` call. Error results are also returned as text with `isError: true`.

## Common Workflows

### Start And Use A Session

```json
{ "action": "start", "args": { "name": "main" } }
```

Then run a command inside that session:

```json
{ "action": "exec", "args": { "sessionId": "calm-reef", "command": "pwd" } }
```

### Interactive REPL

```json
{ "action": "start", "args": { "name": "python" } }
```

```json
{ "action": "write", "args": { "sessionId": "calm-reef", "data": "python3\r" } }
```

```json
{ "action": "read", "args": { "sessionId": "calm-reef" } }
```

### Long-Running Dev Server

```json
{ "action": "start", "args": { "name": "dev-server" } }
```

```json
{ "action": "write", "args": { "sessionId": "calm-reef", "data": "npm run dev\r" } }
```

```json
{ "action": "wait", "args": { "sessionId": "calm-reef", "pattern": "listening on port", "timeout": 60000 } }
```

### Watch Logs Without Polling

```json
{
  "action": "watch",
  "args": {
    "sessionId": "calm-reef",
    "triggers": [
      { "id": "ready", "pattern": "listening on port", "isRegex": false },
      { "id": "error", "pattern": "ERROR|FATAL", "isRegex": true }
    ],
    "timeout": 60000,
    "quietExitMs": 3000
  }
}
```

### Incremental Reads

```json
{ "action": "read", "args": { "sessionId": "calm-reef" } }
```

If the response includes `position: 5000`, read only newer output later:

```json
{ "action": "read", "args": { "sessionId": "calm-reef", "since": 5000 } }
```

### Stop With Snapshot Or Transcript

```json
{ "action": "stop", "args": { "sessionId": "calm-reef", "snapshotLines": 20, "transcriptPath": "/tmp/session.log" } }
```

## Template Input

The `write` action supports `type: "text"` and `type: "template"`.

`type: "text"` interprets common escapes such as `\r`, `\n`, and `\t`.

`type: "template"` expands file and environment placeholders server-side before writing to the PTY. This lets callers inject local file/env content without putting the expanded value in the tool arguments or response. It does not prevent the terminal program itself from echoing input.

Supported placeholders:

| Placeholder | Meaning |
|-------------|---------|
| `${file:path}` | Whole file |
| `${file:path::1}` | Line 1 |
| `${file:path::1-2}` | Lines 1-2 |
| `${file:path::1:1-2:3}` | Line/column range |
| `${env:NAME}` | Environment variable |
| `$${file:path}` | Literal `${file:path}` |

Line and column numbers are 1-based and inclusive. Relative paths are resolved from the session working directory.

Example:

```json
{
  "action": "write",
  "args": {
    "sessionId": "calm-reef",
    "type": "template",
    "data": "${file:info.txt::2}\r"
  }
}
```

## Output Control

Use these actions when terminal output is large or long-running:

- `read` with `since` to avoid re-reading old output.
- `wait` with `returnMode: "match-only"` when only a match result matters.
- `watch` to avoid manual poll loops while waiting for log patterns.
- `get_history` to revisit previous output without dumping the whole buffer.
- `stop` with `transcriptPath` to write full history to disk.
- `run_paged` for large read-only command output.

## Structured Parsers

The `run` action can parse a small set of read-only command signatures:

- `git status --porcelain=v1 --branch`
- `git status --short` and `git status --short --branch`
- `git log --oneline`
- `git branch`, `git branch -vv`, `git branch --all`, `git branch --remotes`, `git branch --show-current`
- `git rev-parse --abbrev-ref HEAD`, `git rev-parse --show-toplevel`, `git rev-parse --is-inside-work-tree`
- `git diff --name-only`, `git diff --name-status`, `git diff --stat`, `git diff --shortstat`
- `git remote -v`
- `git ls-files`
- `tasklist /fo csv /nh`
- `where <name>` / `which <name>`

Use `parseOnly: true` to omit raw output when structured parsing succeeds. Use `summary: true` when counts or compact summaries are more useful than raw text.

The `run_paged` action supports `summary: true` for read-only commands: `git` (`branch`, `diff`, `log`, `ls-files`, `remote`, `rev-parse`, `status`), `tasklist`, `where`, and `which`.

## Installation

Run the stable npm release:

```bash
npx @pkgpub/shell-session-mcp@stable
```

Or install globally:

```bash
npm install -g @pkgpub/shell-session-mcp
```

Or clone for development:

```bash
git clone https://github.com/CarefulDeveloper/shell-session-mcp.git
cd shell-session-mcp
npm install
npm test
```

## MCP Client Configuration

### npm

```json
{
  "mcpServers": {
    "shell-session": {
      "command": "npx",
      "args": ["-y", "@pkgpub/shell-session-mcp@stable"]
    }
  }
}
```

### Local Checkout

```json
{
  "mcpServers": {
    "shell-session": {
      "command": "node",
      "args": ["F:\\VSWorkSpace\\AICoding\\smart-terminal-mcp\\src\\index.js"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add shell-session -- npx -y @pkgpub/shell-session-mcp@stable
```

## Architecture

```text
src/
  index.js            MCP server bootstrap, initialize instructions, graceful shutdown
  tools.js            Single shell_session tool, action registry, help, schemas, handlers
  command-runner.js   One-shot command execution used by run/run_paged
  command-parsers.js  Structured parsers for supported read-only commands
  pager.js            Line-based pagination helper for large stdout
  pty-session.js      PTY session: marker injection, idle read, buffer management
  session-tools.js    Retry and diff helpers for session commands
  regex-utils.js      Shared regex validation and compilation
  session-id.js       Human-readable session ID generation
  session-manager.js  Session lifecycle, TTL cleanup, concurrency limits
  shell-detector.js   Cross-platform shell auto-detection
  ansi.js             ANSI escape code stripping
```

## Development

```bash
npm test
```

For local MCP debugging, point your client at `src/index.js` with `node`; publishing to npm is not required.

## License

MIT. This fork preserves the upstream MIT license and attribution; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
