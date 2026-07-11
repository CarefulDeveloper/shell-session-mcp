import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { writeFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, runCommand } from './command-runner.js';
import { normalizeCommandName, summarizeCommandOutput } from './command-parsers.js';
import { DEFAULT_PAGE_SIZE, paginateOutput } from './pager.js';
import { DEFAULT_EXEC_MAX_LINES, DEFAULT_HISTORY_FORMAT, DEFAULT_HISTORY_LIMIT, DEFAULT_READ_MAX_LINES } from './pty-session.js';
import { execAndDiff, execWithRetry } from './session-tools.js';

const FS_ERROR_MESSAGES = {
  EACCES: 'Permission denied',
  ENOSPC: 'No space left on device',
  EROFS: 'Read-only file system',
  ENOENT: 'Invalid path — a component does not exist',
  ENOTDIR: 'A component of the path is not a directory',
  ENAMETOOLONG: 'File name too long',
  EISDIR: 'Path is a directory, not a file',
};
const READ_ONLY_PAGED_COMMANDS = new Set(['tasklist', 'where', 'which']);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(['branch', 'diff', 'log', 'ls-files', 'remote', 'rev-parse', 'status']);
const MAX_TERMINAL_WRITE_SOURCE_BYTES = 1024 * 1024;
const MAX_TEMPLATE_PLACEHOLDERS = 32;

/**
 * Format a filesystem error into a human-readable message with the error code.
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
function formatFsError(err) {
  const hint = FS_ERROR_MESSAGES[err.code];
  return hint ? `${hint} (${err.code})` : err.message;
}

function jsonContent(payload) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload),
    }],
  };
}

function errorContent(message) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: message,
    }],
  };
}

function assertPagedCommandIsReadOnly(cmd, args = []) {
  const commandName = normalizeCommandName(cmd);
  if (READ_ONLY_PAGED_COMMANDS.has(commandName)) return;

  if (commandName === 'git') {
    const subcommand = args[0]?.toLowerCase();
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return;
  }

  throw new Error('terminal_run_paged only supports read-only commands: git (branch, diff, log, ls-files, remote, rev-parse, status), tasklist, where, which.');
}

function assertReadTimeouts(timeout, idleTimeout) {
  if (idleTimeout >= timeout) {
    throw new Error('idleTimeout must be less than timeout.');
  }
}

async function resolveTerminalWriteData({ type = 'text', data }, session) {
  if (type === 'text') {
    return {
      data: data
        .replace(/\\r/g, '\r')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t'),
      source: 'text',
    };
  }

  if (type === 'environment') {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(data)) {
      throw new Error('Environment variable name is invalid.');
    }
    if (!Object.prototype.hasOwnProperty.call(process.env, data)) {
      throw new Error(`Environment variable "${data}" is not set.`);
    }
    return {
      data: process.env[data] ?? '',
      source: 'environment',
    };
  }

  if (type === 'file') {
    const absolutePath = resolve(session.cwd, data);
    let content;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch (err) {
      throw new Error(`Failed to read "${absolutePath}": ${formatFsError(err)}`);
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_TERMINAL_WRITE_SOURCE_BYTES) {
      throw new Error(`Refusing to write file larger than ${MAX_TERMINAL_WRITE_SOURCE_BYTES} bytes.`);
    }

    return {
      data: content,
      source: 'file',
    };
  }

  if (type === 'template') {
    return {
      data: await expandTerminalWriteTemplate(data, session),
      source: 'template',
    };
  }

  throw new Error(`Unknown terminal_write type: "${type}".`);
}

async function expandTerminalWriteTemplate(template, session) {
  let output = '';
  let placeholderCount = 0;

  for (let index = 0; index < template.length;) {
    if (template.startsWith('$${', index)) {
      output += '${';
      index += 3;
      continue;
    }

    if (!template.startsWith('${', index)) {
      output += template[index];
      index++;
      continue;
    }

    const end = template.indexOf('}', index + 2);
    if (end === -1) {
      throw new Error('Unterminated template placeholder.');
    }

    placeholderCount++;
    if (placeholderCount > MAX_TEMPLATE_PLACEHOLDERS) {
      throw new Error(`Template has more than ${MAX_TEMPLATE_PLACEHOLDERS} placeholders.`);
    }

    const placeholder = template.slice(index + 2, end);
    const expanded = await expandTemplatePlaceholder(placeholder, session);
    output += expanded;

    if (Buffer.byteLength(output, 'utf8') > MAX_TERMINAL_WRITE_SOURCE_BYTES) {
      throw new Error(`Refusing to write template larger than ${MAX_TERMINAL_WRITE_SOURCE_BYTES} bytes.`);
    }

    index = end + 1;
  }

  return output;
}

async function expandTemplatePlaceholder(placeholder, session) {
  if (!placeholder.startsWith('file:')) {
    throw new Error(`Unsupported template placeholder: "${placeholder.split(':', 1)[0]}".`);
  }

  const { path, range } = parseTemplateFileSpec(placeholder.slice('file:'.length));
  if (!path) {
    throw new Error('Template file path is empty.');
  }

  const absolutePath = resolve(session.cwd, path);
  let content;
  try {
    content = await readFile(absolutePath, 'utf8');
  } catch (err) {
    throw new Error(`Failed to read "${absolutePath}": ${formatFsError(err)}`);
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_TERMINAL_WRITE_SOURCE_BYTES) {
    throw new Error(`Refusing to read template file larger than ${MAX_TERMINAL_WRITE_SOURCE_BYTES} bytes.`);
  }

  return range ? selectFileRange(content, range) : content;
}

function parseTemplateFileSpec(spec) {
  if (spec.startsWith('"')) {
    const endQuote = spec.indexOf('"', 1);
    if (endQuote === -1) {
      throw new Error('Quoted template file path is unterminated.');
    }
    const path = spec.slice(1, endQuote);
    const rest = spec.slice(endQuote + 1);
    if (!rest) return { path, range: null };
    if (!rest.startsWith('::')) {
      throw new Error('Quoted template file path must be followed by a range or end of placeholder.');
    }
    return { path, range: parseTemplateRange(rest.slice(2)) };
  }

  const separator = spec.lastIndexOf('::');
  if (separator === -1) {
    return { path: spec, range: null };
  }

  const suffix = spec.slice(separator + 2);
  if (!suffix.startsWith('L')) {
    return { path: spec, range: null };
  }

  return {
    path: spec.slice(0, separator),
    range: parseTemplateRange(suffix),
  };
}

function parseTemplateRange(value) {
  const match = value.match(/^L(\d+)(?::C(\d+))?(?:-L(\d+)(?::C(\d+))?)?$/);
  if (!match) {
    throw new Error(`Invalid template file range: "${value}".`);
  }

  const startLine = Number(match[1]);
  const startColumn = match[2] === undefined ? null : Number(match[2]);
  const endLine = match[3] === undefined ? startLine : Number(match[3]);
  const endColumn = match[4] === undefined ? null : Number(match[4]);

  if (startLine < 1 || endLine < 1 || endLine < startLine) {
    throw new Error(`Invalid template file range: "${value}".`);
  }
  if ((startColumn === null) !== (endColumn === null)) {
    throw new Error(`Template file range must use columns on both ends: "${value}".`);
  }
  if (startColumn !== null && (startColumn < 1 || endColumn < 1)) {
    throw new Error(`Invalid template file range: "${value}".`);
  }
  if (startLine === endLine && startColumn !== null && endColumn < startColumn) {
    throw new Error(`Invalid template file range: "${value}".`);
  }

  return { startLine, startColumn, endLine, endColumn };
}

function splitLogicalLines(content) {
  const lines = [];
  let start = 0;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char !== '\r' && char !== '\n') continue;

    let eol = char;
    if (char === '\r' && content[index + 1] === '\n') {
      eol = '\r\n';
      index++;
    }

    lines.push({ text: content.slice(start, index + 1 - eol.length), eol });
    start = index + 1;
  }

  if (start < content.length) {
    lines.push({ text: content.slice(start), eol: '' });
  }

  return lines;
}

function selectFileRange(content, range) {
  const lines = splitLogicalLines(content);
  const startIndex = range.startLine - 1;
  const endIndex = range.endLine - 1;

  if (startIndex >= lines.length || endIndex >= lines.length) {
    throw new Error('Template file range is outside the file.');
  }

  if (range.startColumn === null) {
    return selectWholeLineRange(lines, startIndex, endIndex);
  }

  return selectColumnRange(lines, startIndex, range.startColumn, endIndex, range.endColumn);
}

function selectWholeLineRange(lines, startIndex, endIndex) {
  let output = '';
  for (let index = startIndex; index <= endIndex; index++) {
    output += lines[index].text;
    if (index < endIndex) {
      output += lines[index].eol;
    }
  }
  return output;
}

function selectColumnRange(lines, startIndex, startColumn, endIndex, endColumn) {
  let output = '';

  for (let index = startIndex; index <= endIndex; index++) {
    const chars = Array.from(lines[index].text);
    let from = 0;
    let to = chars.length;

    if (index === startIndex) {
      if (startColumn > chars.length) {
        throw new Error('Template file range start column is outside the line.');
      }
      from = startColumn - 1;
    }

    if (index === endIndex) {
      if (endColumn > chars.length) {
        throw new Error('Template file range end column is outside the line.');
      }
      to = endColumn;
    }

    output += chars.slice(from, to).join('');
    if (index < endIndex) {
      output += lines[index].eol;
    }
  }

  return output;
}

/**
 * Register all MCP tools on the server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./session-manager.js').SessionManager} manager
 */
export function registerTools(server, manager) {
  const DEFAULT_EXTRA = 'terminal_run_paged,terminal_retry,terminal_diff,terminal_resize,terminal_send_key,terminal_get_history,terminal_write_file,terminal_watch';
  const disabledTools = process.env.SHELL_SESSION_DISABLED_TOOLS ?? process.env.SMART_TERMINAL_DISABLED_TOOLS ?? DEFAULT_EXTRA;
  const _off = new Set(
    disabledTools.split(',').map(s => s.trim()).filter(Boolean)
  );
  const _extras = new Map();
  const tool = (name, desc, schema, handler) => {
    if (_off.has(name)) {
      _extras.set(name, { description: desc, schema, handler });
      return;
    }
    server.tool(name, desc, schema, handler);
  };

  // --- terminal_start ---
  tool(
    'terminal_start',
    'Start a terminal session. Auto-detects shell if omitted.',
    {
      shell: z.string().optional(),
      cols: z.number().int().min(20).max(500).default(120),
      rows: z.number().int().min(5).max(200).default(30),
      cwd: z.string().optional(),
      name: z.string().optional(),
      env: z.record(z.string()).optional(),
    },
    async ({ shell, cols, rows, cwd, name, env }) => {
      let session;
      try {
        session = await manager.create({ shell, cols, rows, cwd, name, env });
        const banner = await session.waitForBanner();
        return jsonContent({
          sessionId: session.id,
          shell: session.shell,
          shellType: session.shellType,
          cwd: session.cwd,
          banner: banner || '(no banner)',
        });
      } catch (err) {
        if (session?.id && typeof manager.stop === 'function') {
          try {
            manager.stop(session.id);
          } catch {
            // Preserve the original startup failure.
          }
        }
        const hint = shell
          ? '\n\nHint: call terminal_start with NO shell parameter to auto-detect the best available shell.'
          : '';
        return errorContent(`${err.message}${hint}`);
      }
    }
  );

  // --- terminal_exec ---
  tool(
    'terminal_exec',
    'Run a command in a session and wait for completion.',
    {
      sessionId: z.string(),
      command: z.string(),
      timeout: z.number().int().min(1000).max(600000).default(30000),
      maxLines: z.number().int().min(10).max(10000).default(DEFAULT_EXEC_MAX_LINES),
      quietExitMs: z.number().int().min(500).max(600000).optional()
        .describe('Exit if silent for N ms'),
      minOutputBytes: z.number().int().min(0).default(1)
        .describe('Min bytes before quiet exit'),
    },
    async ({ sessionId, command, timeout, maxLines, quietExitMs, minOutputBytes }, extra) => {
      const session = manager.get(sessionId);
      const result = await session.exec({
        command,
        timeout,
        maxLines,
        quietExitMs,
        minOutputBytes,
        sendNotification: extra.sendNotification,
        progressToken: extra._meta?.progressToken,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_run ---
  tool(
    'terminal_run',
    'Run a binary directly. shell=true for built-ins/pipes/redirects.',
    {
      cmd: z.string(),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES),
      parse: z.boolean().default(true).describe('Parse structured output'),
      parseOnly: z.boolean().default(false).describe('Omit raw when parsed'),
      summary: z.boolean().default(false),
      successExitCode: z.number().int().nullable().default(0).describe('null=any'),
      successFile: z.string().optional(),
      successFilePattern: z.string().optional().describe('Regex'),
      shell: z.boolean().default(false).describe('Run via system shell'),
    },
    async ({ cmd, args, cwd, timeout, maxOutputBytes, parse, parseOnly, summary, successExitCode, successFile, successFilePattern, shell }) => {
      const result = await runCommand({
        cmd,
        args,
        cwd,
        timeout,
        maxOutputBytes,
        parse,
        parseOnly,
        summary,
        successExitCode,
        successFile,
        successFilePattern,
        shell,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_run_paged ---
  tool(
    'terminal_run_paged',
    'Run a read-only command and return one page of output.',
    {
      cmd: z.string(),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      timeout: z.number().int().min(1000).max(600000).default(DEFAULT_TIMEOUT_MS),
      maxOutputBytes: z.number().int().min(1024).max(1048576).default(DEFAULT_MAX_OUTPUT_BYTES),
      page: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(1000).default(DEFAULT_PAGE_SIZE),
      summary: z.boolean().default(false),
    },
    async ({ cmd, args, cwd, timeout, maxOutputBytes, page, pageSize, summary }) => {
      assertPagedCommandIsReadOnly(cmd, args);

      const result = await runCommand({
        cmd,
        args,
        cwd,
        timeout,
        maxOutputBytes,
        parse: summary,
      });
      const pagination = paginateOutput(result.stdout.raw, { page, pageSize });
      const stdoutSummary = summary
        ? summarizeCommandOutput({ cmd, args, parsed: result.stdout.parsed })
        : null;

      return jsonContent({
        ...result,
        stdout: {
          raw: stdoutSummary ? '' : pagination.pageText,
          parsed: null,
          ...(stdoutSummary ? { summary: stdoutSummary } : {}),
        },
        pageInfo: {
          page: pagination.page,
          pageSize: pagination.pageSize,
          totalLines: pagination.totalLines,
          hasNext: pagination.hasNext,
        },
      });
    }
  );

  // --- terminal_write ---
  tool(
    'terminal_write',
    'Write data to a terminal session.',
    {
      sessionId: z.string(),
      type: z.enum(['text', 'file', 'environment', 'template']).default('text'),
      data: z.string(),
    },
    async ({ sessionId, type, data }) => {
      const session = manager.get(sessionId);
      const resolved = await resolveTerminalWriteData({ type, data }, session);
      session.write(resolved.data);
      return jsonContent({
        success: true,
        sessionId,
        type: resolved.source,
        bytes: Buffer.byteLength(resolved.data, 'utf8'),
      });
    }
  );

  // --- terminal_read ---
  tool(
    'terminal_read',
    'Read new output from a terminal session.',
    {
      sessionId: z.string(),
      timeout: z.number().int().min(500).max(300000).default(30000),
      idleTimeout: z.number().int().min(100).max(10000).default(500).describe('Must be < timeout'),
      maxLines: z.number().int().min(10).max(10000).default(DEFAULT_READ_MAX_LINES),
      since: z.number().int().min(0).optional()
        .describe('Byte position for inc. read'),
    },
    async ({ sessionId, timeout, idleTimeout, maxLines, since }) => {
      assertReadTimeouts(timeout, idleTimeout);
      const session = manager.get(sessionId);
      const result = await session.read({ timeout, idleTimeout, maxLines, since });
      return jsonContent(result);
    }
  );

  // --- terminal_get_history ---
  tool(
    'terminal_get_history',
    'Get past output from a terminal session.',
    {
      sessionId: z.string(),
      offset: z.number().int().min(0).default(0),
      maxLines: z.number().int().min(1).max(10000).default(DEFAULT_HISTORY_LIMIT),
      format: z.enum(['lines', 'text']).default(DEFAULT_HISTORY_FORMAT),
    },
    async ({ sessionId, offset, maxLines, format }) => {
      const session = manager.get(sessionId);
      const result = session.getHistory({ offset, limit: maxLines, format });
      return jsonContent({ sessionId, ...result });
    }
  );

  // --- terminal_resize ---
  tool(
    'terminal_resize',
    'Resize terminal dimensions.',
    {
      sessionId: z.string(),
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(200),
    },
    async ({ sessionId, cols, rows }) => {
      const session = manager.get(sessionId);
      session.resize(cols, rows);
      return jsonContent({ success: true, cols, rows });
    }
  );

  // --- terminal_send_key ---
  tool(
    'terminal_send_key',
    'Send a special key (Enter, Tab, Escape, Ctrl-C etc.).',
    {
      sessionId: z.string(),
      key: z.string(),
    },
    async ({ sessionId, key }) => {
      const session = manager.get(sessionId);
      session.sendKey(key);
      return jsonContent({ success: true, key });
    }
  );

  // --- terminal_wait ---
  tool(
    'terminal_wait',
    'Wait for a pattern to appear in terminal output.',
    {
      sessionId: z.string(),
      pattern: z.string(),
      timeout: z.number().int().min(1000).max(600000).default(30000),
      returnMode: z.enum(['tail', 'full', 'match-only']).default('tail'),
      tailLines: z.number().int().min(1).max(1000).default(50),
    },
    async ({ sessionId, pattern, timeout, returnMode, tailLines }, extra) => {
      const session = manager.get(sessionId);
      const result = await session.waitForPattern({
        pattern,
        timeout,
        returnMode,
        tailLines,
        sendNotification: extra.sendNotification,
        progressToken: extra._meta?.progressToken,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_watch ---
  tool(
    'terminal_watch',
    'Wait for a pattern match in session output.',
    {
      sessionId: z.string(),
      triggers: z.array(z.object({
        id: z.string().describe('Trigger label, returned in response'),
        pattern: z.string().describe('Regex or literal pattern'),
        isRegex: z.boolean().default(true),
        cooldownMs: z.number().int().min(0).default(0)
          .describe('Min ms between matches'),
      })).min(1).max(10),
      timeout: z.number().int().min(1000).max(3600000).default(60000),
      quietExitMs: z.number().int().min(0).optional()
        .describe('Exit if no output for N ms'),
      contextLines: z.number().int().min(0).max(50).default(3)
        .describe('Context lines before match'),
      since: z.number().int().min(0).optional()
        .describe('Match after byte position'),
    },
    async ({ sessionId, triggers, timeout, quietExitMs, contextLines, since }) => {
      const session = manager.get(sessionId);
      const result = await session.watch({ triggers, timeout, quietExitMs, contextLines, since });
      return jsonContent(result);
    }
  );

  // --- terminal_retry ---
  tool(
    'terminal_retry',
    'Retry a command with backoff.',
    {
      sessionId: z.string(),
      command: z.string(),
      maxRetries: z.number().int().min(0).max(10).default(3),
      backoff: z.enum(['fixed', 'exponential', 'linear']).default('exponential'),
      delayMs: z.number().int().min(10).max(60000).default(1000),
      timeout: z.number().int().min(1000).max(600000).default(30000),
      maxLines: z.number().int().min(10).max(10000).default(DEFAULT_EXEC_MAX_LINES),
      successExitCode: z.number().int().nullable().default(0).describe('null=any'),
      successPattern: z.string().nullable().default(null).describe('Regex'),
    },
    async ({ sessionId, command, maxRetries, backoff, delayMs, timeout, maxLines, successExitCode, successPattern }) => {
      const session = manager.get(sessionId);
      const result = await execWithRetry(session, {
        command,
        maxRetries,
        backoff,
        delayMs,
        timeout,
        maxLines,
        successExitCode,
        successPattern,
      });
      return jsonContent(result);
    }
  );

  // --- terminal_diff ---
  tool(
    'terminal_diff',
    'Run two commands and return a unified diff.',
    {
      sessionId: z.string(),
      commandA: z.string(),
      commandB: z.string(),
      timeout: z.number().int().min(1000).max(600000).default(30000),
      maxLines: z.number().int().min(10).max(10000).default(DEFAULT_EXEC_MAX_LINES),
      contextLines: z.number().int().min(0).max(20).default(3),
    },
    async ({ sessionId, commandA, commandB, timeout, maxLines, contextLines }) => {
      const session = manager.get(sessionId);
      const result = await execAndDiff(session, { commandA, commandB, timeout, maxLines, contextLines });
      return jsonContent(result);
    }
  );

  // --- terminal_stop ---
  tool(
    'terminal_stop',
    'Stop a terminal session.',
    {
      sessionId: z.string(),
      snapshotLines: z.number().int().min(0).max(2000).default(0)
        .describe('Return last N lines. 0 = none.'),
      transcriptPath: z.string().optional()
        .describe('Write history to this path'),
    },
    async ({ sessionId, snapshotLines, transcriptPath }) => {
      const session = manager.get(sessionId);

      let snapshot = null;
      let transcript = null;

      if (snapshotLines > 0) {
        const hist = session.getHistory({ offset: 0, limit: snapshotLines, format: 'text' });
        snapshot = {
          text: hist.text,
          lineCount: hist.returnedTo - hist.returnedFrom,
          totalLines: hist.totalLines,
        };
      }

      if (transcriptPath) {
        const absolutePath = resolve(transcriptPath);
        try {
          await mkdir(dirname(absolutePath), { recursive: true });
          const full = session.getHistory({ offset: 0, limit: 10000, format: 'text' });
          await writeFile(absolutePath, full.text, 'utf-8');
          transcript = { path: absolutePath, bytes: Buffer.byteLength(full.text) };
        } catch (err) {
          return errorContent(`Failed to write transcript: ${formatFsError(err)}`);
        }
      }

      manager.stop(sessionId);
      return jsonContent({
        success: true,
        message: `Session ${sessionId} stopped.`,
        ...(snapshot && { snapshot }),
        ...(transcript && { transcript }),
      });
    }
  );

  // --- terminal_list ---
  tool(
    'terminal_list',
    'List active terminal sessions.',
    {
      verbose: z.boolean().default(true),
    },
    async ({ verbose = true }) => {
      const sessions = manager.list({ verbose });
      return jsonContent({ sessions, count: sessions.length });
    }
  );

  // --- terminal_write_file ---
  tool(
    'terminal_write_file',
    'Write content to a file.',
    {
      sessionId: z.string(),
      path: z.string(),
      content: z.string(),
      encoding: z.enum(['utf-8', 'ascii', 'base64', 'hex', 'latin1']).default('utf-8'),
      append: z.boolean().default(false),
    },
    async ({ sessionId, path: filePath, content, encoding, append }) => {
      const session = manager.get(sessionId);
      const absolutePath = resolve(session.cwd, filePath);

      try {
        await mkdir(dirname(absolutePath), { recursive: true });
      } catch (err) {
        throw new Error(`Failed to create directory "${dirname(absolutePath)}": ${formatFsError(err)}`);
      }

      try {
        const writeFn = append ? appendFile : writeFile;
        await writeFn(absolutePath, content, { encoding });
      } catch (err) {
        throw new Error(`Failed to write "${absolutePath}": ${formatFsError(err)}`);
      }

      const size = Buffer.byteLength(content, encoding);
      return jsonContent({
        success: true,
        path: absolutePath,
        size,
        append,
      });
    }
  );

  // --- terminal_extra (meta-tool for disabled tools) ---
  if (_extras.size > 0) {
    const names = [..._extras.keys()].join(', ');
    server.tool(
      'terminal_extra',
      `${_extras.size} more tools: ${names}. list=true for full schemas, or pass tool + args to call.`,
      {
        list: z.boolean().default(false),
        tool: z.string().optional(),
        args: z.record(z.any()).optional(),
      },
      async (params, extra) => {
        if (params.list) {
          const catalog = {};
          for (const [n, def] of _extras) {
            const s = zodToJsonSchema(z.object(def.schema));
            catalog[n] = { description: def.description, parameters: s.properties || {}, required: s.required || [] };
          }
          return jsonContent(catalog);
        }

        if (!params.tool) {
          return errorContent(`Pass list=true to see schemas, or specify tool. Available: ${names}`);
        }

        const def = _extras.get(params.tool);
        if (!def) return errorContent(`Unknown tool "${params.tool}". Available: ${names}`);

        try {
          const validated = z.object(def.schema).parse(params.args || {});
          return await def.handler(validated, extra);
        } catch (err) {
          if (err instanceof z.ZodError) {
            return errorContent(`Invalid args for ${params.tool}: ${err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
          }
          throw err;
        }
      }
    );
  }
}
