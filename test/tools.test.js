import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { registerTools } from '../src/tools.js';

function createFakeServer() {
  const tools = new Map();
  return {
    tools,
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  };
}

function getDescription(schema) {
  return schema.description ?? schema?._def?.description ?? '';
}

test('terminal_list returns compact JSON content', async () => {
  const server = createFakeServer();
  const sessions = [{ id: 's1', cwd: 'C:/repo' }];
  const listCalls = [];
  const manager = {
    list: (opts) => {
      listCalls.push(opts);
      return sessions;
    },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_list').handler({});
  const expected = { sessions, count: sessions.length };

  assert.deepEqual(listCalls, [{ verbose: true }]);
  assert.equal(result.content[0].text, JSON.stringify(expected));
  assert.deepEqual(JSON.parse(result.content[0].text), expected);
});

test('terminal_list forwards verbose=false for minimal output', async () => {
  const server = createFakeServer();
  const sessions = [{ id: 's1', name: 'main', cwd: 'C:/repo', alive: true, busy: false }];
  const listCalls = [];
  const manager = {
    list: (opts) => {
      listCalls.push(opts);
      return sessions;
    },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_list').handler({ verbose: false });

  assert.deepEqual(listCalls, [{ verbose: false }]);
  assert.deepEqual(JSON.parse(result.content[0].text), { sessions, count: 1 });
});

test('tools source does not pretty-print JSON responses', async () => {
  const source = await readFile(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /JSON\.stringify\([^\n]*null,\s*2/);
});

test('tool metadata stays concise', () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
    const server = createFakeServer();
    registerTools(server, {});
    for (const [name, { description, schema }] of server.tools) {
      assert.ok(description.length <= 70, `${name} description is too long`);
      assert.doesNotMatch(description, /Supported keys:/);
      for (const [fieldName, fieldSchema] of Object.entries(schema)) {
        const fieldDescription = getDescription(fieldSchema);
        const maxDescriptionLength = name === 'terminal_write' && fieldName === 'data' ? 110 : 30;
        assert.ok(fieldDescription.length <= maxDescriptionLength, `${name}.${fieldName} description is too long`);
        assert.doesNotMatch(fieldDescription, /\(default:|e\.g\.|Defaults to|such as/i);
      }
    }
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('tool schemas keep agent-friendly default output sizes', () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
  const server = createFakeServer();
  registerTools(server, {});
  assert.deepEqual({
    terminalExecMaxLines: server.tools.get('terminal_exec').schema.maxLines.parse(undefined),
    terminalReadMaxLines: server.tools.get('terminal_read').schema.maxLines.parse(undefined),
    terminalHistoryMaxLines: server.tools.get('terminal_get_history').schema.maxLines.parse(undefined),
    terminalHistoryFormat: server.tools.get('terminal_get_history').schema.format.parse(undefined),
    terminalRunPagedPageSize: server.tools.get('terminal_run_paged').schema.pageSize.parse(undefined),
    terminalRunParseOnly: server.tools.get('terminal_run').schema.parseOnly.parse(undefined),
    terminalRunSummary: server.tools.get('terminal_run').schema.summary.parse(undefined),
    terminalRunSuccessExitCode: server.tools.get('terminal_run').schema.successExitCode.parse(undefined),
    terminalRunPagedSummary: server.tools.get('terminal_run_paged').schema.summary.parse(undefined),
    terminalListVerbose: server.tools.get('terminal_list').schema.verbose.parse(undefined),
  }, {
    terminalExecMaxLines: 200,
    terminalReadMaxLines: 200,
    terminalHistoryMaxLines: 200,
    terminalHistoryFormat: 'lines',
    terminalRunPagedPageSize: 100,
    terminalRunParseOnly: false,
    terminalRunSummary: false,
    terminalRunSuccessExitCode: 0,
    terminalRunPagedSummary: false,
    terminalListVerbose: true,
  });
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_start returns compact session metadata', async () => {
  const server = createFakeServer();
  const createCalls = [];
  const manager = {
    create: async (opts) => {
      createCalls.push(opts);
      return {
        id: 's1',
        shell: 'pwsh.exe',
        shellType: 'powershell',
        cwd: 'C:/repo',
        waitForBanner: async () => 'PowerShell 7',
      };
    },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_start').handler({
    cols: 140,
    rows: 40,
    cwd: 'C:/repo',
    name: 'smc-verify',
  });

  assert.deepEqual(createCalls, [{ cols: 140, rows: 40, cwd: 'C:/repo', name: 'smc-verify', shell: undefined, env: undefined }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    sessionId: 's1',
    shell: 'pwsh.exe',
    shellType: 'powershell',
    cwd: 'C:/repo',
    banner: 'PowerShell 7',
  });
});

test('terminal_start stops a created session when banner startup fails', async () => {
  const server = createFakeServer();
  const stopCalls = [];
  const manager = {
    create: async () => ({
      id: 's1',
      cwd: 'C:/repo',
      waitForBanner: async () => {
        throw new Error('banner failed');
      },
    }),
    stop: (sessionId) => {
      stopCalls.push(sessionId);
    },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_start').handler({});
  assert.ok(result.isError, 'expected isError to be true');
  assert.match(result.content[0].text, /banner failed/);
  // Hint only appears when shell was explicitly provided; this test passes no shell.
  assert.doesNotMatch(result.content[0].text, /call terminal_start with NO shell parameter/i);
  assert.deepEqual(stopCalls, ['s1']);
});

test('SHELL_SESSION_DISABLED_TOOLS moves tools behind terminal_extra', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = 'terminal_diff, terminal_retry';
  try {
    const server = createFakeServer();
    registerTools(server, {});
    // Disabled tools are NOT registered individually
    assert.ok(!server.tools.has('terminal_diff'), 'terminal_diff should not be a standalone tool');
    assert.ok(!server.tools.has('terminal_retry'), 'terminal_retry should not be a standalone tool');
    // Enabled tools still work
    assert.ok(server.tools.has('terminal_run'), 'terminal_run should be present');
    assert.ok(server.tools.has('terminal_list'), 'terminal_list should be present');
    // Meta-tool is registered
    assert.ok(server.tools.has('terminal_extra'), 'terminal_extra should be present');
    assert.match(server.tools.get('terminal_extra').description, /terminal_diff/);
    assert.match(server.tools.get('terminal_extra').description, /terminal_retry/);
    // list=true returns catalog
    const listResult = await server.tools.get('terminal_extra').handler({ list: true });
    const catalog = JSON.parse(listResult.content[0].text);
    assert.ok(catalog.terminal_diff, 'catalog should contain terminal_diff');
    assert.ok(catalog.terminal_retry, 'catalog should contain terminal_retry');
    assert.ok(catalog.terminal_diff.parameters, 'should include parameter schemas');
    // Unknown tool returns error
    const badResult = await server.tools.get('terminal_extra').handler({ tool: 'nope', args: {} });
    assert.ok(badResult.isError, 'unknown tool should return isError');
    // Validation error returns helpful message
    const valResult = await server.tools.get('terminal_extra').handler({ tool: 'terminal_diff', args: { timeout: 'not-a-number' } });
    assert.ok(valResult.isError, 'bad args should return isError');
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('SMART_TERMINAL_DISABLED_TOOLS remains a compatibility fallback', () => {
  delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  process.env.SMART_TERMINAL_DISABLED_TOOLS = 'terminal_diff';
  try {
    const server = createFakeServer();
    registerTools(server, {});
    assert.ok(!server.tools.has('terminal_diff'), 'terminal_diff should honor legacy env var');
    assert.ok(server.tools.has('terminal_extra'), 'terminal_extra should be present');
  } finally {
    delete process.env.SMART_TERMINAL_DISABLED_TOOLS;
  }
});

test('default: convenience tools behind terminal_extra', () => {
  delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  delete process.env.SMART_TERMINAL_DISABLED_TOOLS;
  const server = createFakeServer();
  registerTools(server, {});
  // Core tools registered normally
  assert.ok(server.tools.has('terminal_start'), 'terminal_start is core');
  assert.ok(server.tools.has('terminal_exec'), 'terminal_exec is core');
  assert.ok(server.tools.has('terminal_run'), 'terminal_run is core');
  assert.ok(server.tools.has('terminal_read'), 'terminal_read is core');
  assert.ok(server.tools.has('terminal_write'), 'terminal_write is core');
  assert.ok(server.tools.has('terminal_wait'), 'terminal_wait is core');
  assert.ok(server.tools.has('terminal_stop'), 'terminal_stop is core');
  assert.ok(server.tools.has('terminal_list'), 'terminal_list is core');
  // Convenience tools behind terminal_extra
  assert.ok(server.tools.has('terminal_extra'), 'terminal_extra should exist by default');
  assert.ok(!server.tools.has('terminal_diff'), 'terminal_diff is extra by default');
  assert.ok(!server.tools.has('terminal_retry'), 'terminal_retry is extra by default');
  assert.ok(!server.tools.has('terminal_resize'), 'terminal_resize is extra by default');
});

test('SHELL_SESSION_DISABLED_TOOLS="" registers all tools normally', () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
    const server = createFakeServer();
    registerTools(server, {});
    assert.ok(!server.tools.has('terminal_extra'), 'no meta-tool when all enabled');
    assert.ok(server.tools.has('terminal_diff'), 'terminal_diff registered normally');
    assert.ok(server.tools.has('terminal_retry'), 'terminal_retry registered normally');
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_write data schema documents template placeholders', () => {
  const server = createFakeServer();
  registerTools(server, {});

  const dataDescription = getDescription(server.tools.get('terminal_write').schema.data);
  assert.match(dataDescription, /\$\{file:path\}/);
  assert.match(dataDescription, /\$\{file:path::L1-L2\}/);
  assert.match(dataDescription, /\$\{file:path::L1:C1-L2:C3\}/);
  assert.match(dataDescription, /\$\{env:NAME\}/);
});

test('terminal_write writes text with escaped control characters', async () => {
  const server = createFakeServer();
  const writes = [];
  const manager = {
    get: (sessionId) => ({
      id: sessionId,
      cwd: process.cwd(),
      write: (data) => writes.push(data),
    }),
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_write').handler({
    sessionId: 's1',
    type: 'text',
    data: 'hello\\n',
  });

  assert.deepEqual(writes, ['hello\n']);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    success: true,
    sessionId: 's1',
    type: 'text',
    bytes: 6,
  });
});

test('terminal_write expands template file placeholders server-side', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    await writeFile(join(tempDir, 'password.txt'), 'secret-value');
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: tempDir,
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    const result = await server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: 'password=${file:password.txt}\r\n',
    });

    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(writes, ['password=secret-value\r\n']);
    assert.deepEqual(payload, {
      success: true,
      sessionId: 's1',
      type: 'template',
      bytes: 23,
    });
    assert.doesNotMatch(result.content[0].text, /secret-value/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_write template supports line and column ranges', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    const secretPath = join(tempDir, 'secret.txt');
    await writeFile(secretPath, 'alpha\r\nbravo\r\ncharlie');
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: tempDir,
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    await server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: 'lines=${file:secret.txt::L1-L2}; cols=${file:secret.txt::L2:C2-L3:C3}',
    });

    assert.deepEqual(writes, ['lines=alpha\r\nbravo; cols=ravo\r\ncha']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_write template supports absolute Windows-style paths with ranges', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    const secretPath = resolve(tempDir, 'absolute-secret.txt');
    await writeFile(secretPath, 'first\nsecond\n');
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: tempDir,
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    await server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: `value=${'${'}file:${secretPath}::L2}`,
    });

    assert.deepEqual(writes, ['value=second']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_write template treats final newline as a line terminator only', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    await writeFile(join(tempDir, 'secret.txt'), 'only-line\r\n');
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: tempDir,
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    await server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: '${file:secret.txt::L1}',
    });

    await assert.rejects(
      server.tools.get('terminal_write').handler({
        sessionId: 's1',
        type: 'template',
        data: '${file:secret.txt::L2}',
      }),
      /outside the file/
    );
    assert.deepEqual(writes, ['only-line']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_write template supports escaped placeholders', async () => {
  const server = createFakeServer();
  const writes = [];
  const manager = {
    get: (sessionId) => ({
      id: sessionId,
      cwd: process.cwd(),
      write: (data) => writes.push(data),
    }),
  };

  registerTools(server, manager);

  await server.tools.get('terminal_write').handler({
    sessionId: 's1',
    type: 'template',
    data: '$${file:secret.txt}',
  });

  assert.deepEqual(writes, ['${file:secret.txt}']);
});

test('terminal_write template expands environment placeholders server-side', async () => {
  process.env.SHELL_SESSION_MCP_TEST_SECRET = 'from-env';
  try {
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: process.cwd(),
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    const result = await server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: 'secret=${env:SHELL_SESSION_MCP_TEST_SECRET}',
    });

    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(writes, ['secret=from-env']);
    assert.deepEqual(payload, {
      success: true,
      sessionId: 's1',
      type: 'template',
      bytes: 15,
    });
    assert.doesNotMatch(result.content[0].text, /from-env/);
  } finally {
    delete process.env.SHELL_SESSION_MCP_TEST_SECRET;
  }
});

test('terminal_write template does not write partial output on expansion failure', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    await writeFile(join(tempDir, 'secret.txt'), 'secret');
    const server = createFakeServer();
    const writes = [];
    const manager = {
      get: (sessionId) => ({
        id: sessionId,
        cwd: tempDir,
        write: (data) => writes.push(data),
      }),
    };

    registerTools(server, manager);

    await assert.rejects(
      server.tools.get('terminal_write').handler({
        sessionId: 's1',
        type: 'template',
        data: 'before ${file:secret.txt} after ${file:missing.txt}',
      }),
      /Failed to read/
    );
    assert.deepEqual(writes, []);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_write template rejects invalid or unset environment placeholders', async () => {
  const server = createFakeServer();
  const writes = [];
  const manager = {
    get: (sessionId) => ({
      id: sessionId,
      cwd: process.cwd(),
      write: (data) => writes.push(data),
    }),
  };

  registerTools(server, manager);

  await assert.rejects(
    server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: '${env:BAD-NAME}',
    }),
    /environment variable name is invalid/
  );

  await assert.rejects(
    server.tools.get('terminal_write').handler({
      sessionId: 's1',
      type: 'template',
      data: '${env:SHELL_SESSION_MCP_TEST_SECRET_MISSING}',
    }),
    /is not set/
  );

  assert.deepEqual(writes, []);
});

test('terminal_run forwards summary mode for concise output', async () => {
  const server = createFakeServer();
  const lookupCommand = process.platform === 'win32' ? 'where' : 'which';

  registerTools(server, {});

  const result = await server.tools.get('terminal_run').handler({
    cmd: lookupCommand,
    args: [lookupCommand],
    parse: false,
    summary: true,
  });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.stdout.raw, '');
  assert.equal(payload.stdout.parsed, null);
  assert.ok(payload.stdout.summary.pathCount > 0);
});

test('terminal_run can re-evaluate success from a file pattern', async () => {
  const server = createFakeServer();

  registerTools(server, {});

  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    const result = await server.tools.get('terminal_run').handler({
      cmd: process.execPath,
      cwd: tempDir,
      args: ['-e', 'require("node:fs").writeFileSync("build.log", "BUILD FAILED\\n")'],
      parse: false,
      successFile: 'build.log',
      successFilePattern: 'BUILD OK',
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.checks.exitCode.ok, true);
    assert.equal(payload.checks.successFile.matched, false);
    assert.equal(payload.checks.successFile.path, join(tempDir, 'build.log'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_run shell=true executes commands via the system shell', async () => {
  const server = createFakeServer();
  registerTools(server, {});

  const result = await server.tools.get('terminal_run').handler({
    cmd: 'echo shell-ok',
    args: [],
    shell: true,
    parse: false,
  });

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.match(payload.stdout.raw, /shell-ok/);
});

test('terminal_run ENOENT error hints at shell=true and terminal_start', async () => {
  const server = createFakeServer();
  registerTools(server, {});

  await assert.rejects(
    () => server.tools.get('terminal_run').handler({
      cmd: 'shell-session-missing-binary-xyz',
      args: [],
      parse: false,
    }),
    /use shell:true\. Alternatively, start an interactive session with terminal_start/
  );
});

test('terminal_read rejects idleTimeout values that are not less than timeout', async () => {
  const server = createFakeServer();
  let getCalls = 0;
  const manager = {
    get: () => {
      getCalls++;
      throw new Error('manager.get should not be called');
    },
  };

  registerTools(server, manager);

  await assert.rejects(
    () => server.tools.get('terminal_read').handler({
      sessionId: 's1',
      timeout: 500,
      idleTimeout: 500,
    }),
    /idleTimeout must be less than timeout\./
  );
  assert.equal(getCalls, 0);
});

test('terminal_run_paged can return summaries for read-only commands', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
    const server = createFakeServer();
    const lookupCommand = process.platform === 'win32' ? 'where' : 'which';

    registerTools(server, {});

    const result = await server.tools.get('terminal_run_paged').handler({
      cmd: lookupCommand,
      args: [lookupCommand],
      page: 0,
      pageSize: 5,
      summary: true,
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.stdout.raw, '');
    assert.equal(payload.stdout.parsed, null);
    assert.ok(payload.stdout.summary.pathCount > 0);
    assert.ok(payload.pageInfo.totalLines > 0);
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_get_history forwards format and returns text payloads', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
    const server = createFakeServer();
    const historyCalls = [];
    const manager = {
      get: () => ({
        getHistory: (opts) => {
          historyCalls.push(opts);
          return { text: 'line 2\nline 3', totalLines: 3, returnedFrom: 1, returnedTo: 3 };
        },
      }),
    };

    registerTools(server, manager);

    const result = await server.tools.get('terminal_get_history').handler({
      sessionId: 's1',
      offset: 0,
      maxLines: 2,
      format: 'text',
    });

    assert.deepEqual(historyCalls, [{ offset: 0, limit: 2, format: 'text' }]);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      sessionId: 's1',
      text: 'line 2\nline 3',
      totalLines: 3,
      returnedFrom: 1,
      returnedTo: 3,
    });
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_wait forwards returnMode and tailLines', async () => {
  const server = createFakeServer();
  const waitCalls = [];
  const manager = {
    get: () => ({
      waitForPattern: async (opts) => {
        waitCalls.push(opts);
        return { output: 'ready', matched: true, timedOut: false };
      },
    }),
  };
  const sendNotification = () => { };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_wait').handler(
    {
      sessionId: 's1',
      pattern: 'ready',
      timeout: 1234,
      returnMode: 'full',
      tailLines: 99,
    },
    {
      sendNotification,
      _meta: { progressToken: 'progress-1' },
    }
  );

  assert.deepEqual(waitCalls, [{
    pattern: 'ready',
    timeout: 1234,
    returnMode: 'full',
    tailLines: 99,
    sendNotification,
    progressToken: 'progress-1',
  }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    output: 'ready',
    matched: true,
    timedOut: false,
  });
});

test('terminal_retry returns retry results as compact JSON', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
  const server = createFakeServer();
  let calls = 0;
  const manager = {
    get: () => ({
      exec: async (opts) => {
        calls++;
        assert.deepEqual(opts, { command: 'npm test', timeout: 1234, maxLines: 25 });
        return { output: 'ok', exitCode: 0, cwd: 'C:/repo', timedOut: false };
      },
    }),
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_retry').handler({
    sessionId: 's1',
    command: 'npm test',
    maxRetries: 0,
    backoff: 'fixed',
    delayMs: 1,
    timeout: 1234,
    maxLines: 25,
    successExitCode: 0,
    successPattern: null,
  });

  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    success: true,
    attempts: 1,
    lastResult: { output: 'ok', exitCode: 0, cwd: 'C:/repo', timedOut: false },
    history: [{ attempt: 1, output: 'ok', exitCode: 0, cwd: 'C:/repo', timedOut: false }],
  });
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_diff returns diff results as compact JSON', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
  const server = createFakeServer();
  const execCalls = [];
  const manager = {
    get: () => ({
      exec: async (opts) => {
        execCalls.push(opts);
        return execCalls.length === 1
          ? { output: 'alpha', exitCode: 0, cwd: 'C:/repo', timedOut: false }
          : { output: 'beta', exitCode: 0, cwd: 'C:/repo', timedOut: false };
      },
    }),
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_diff').handler({
    sessionId: 's1',
    commandA: 'type before.txt',
    commandB: 'type after.txt',
    timeout: 4321,
    maxLines: 30,
    contextLines: 2,
  });

  assert.deepEqual(execCalls, [
    { command: 'type before.txt', timeout: 4321, maxLines: 30 },
    { command: 'type after.txt', timeout: 4321, maxLines: 30 },
  ]);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.identical, false);
  assert.match(payload.diff, /--- type before.txt/);
  assert.match(payload.diff, /\+\+\+ type after.txt/);
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});

test('terminal_exec forwards quietExitMs and minOutputBytes', async () => {
  const server = createFakeServer();
  const execCalls = [];
  const manager = {
    get: () => ({
      exec: async (opts) => {
        execCalls.push(opts);
        return { output: 'ok', exitCode: 0, cwd: '/tmp', timedOut: false, quietExited: false };
      },
    }),
  };
  const sendNotification = () => {};

  registerTools(server, manager);

  await server.tools.get('terminal_exec').handler(
    { sessionId: 's1', command: 'npm run dev', timeout: 5000, maxLines: 50, quietExitMs: 2000, minOutputBytes: 10 },
    { sendNotification, _meta: {} },
  );

  assert.deepEqual(execCalls, [{
    command: 'npm run dev',
    timeout: 5000,
    maxLines: 50,
    quietExitMs: 2000,
    minOutputBytes: 10,
    sendNotification,
    progressToken: undefined,
  }]);
});

test('terminal_read forwards since parameter', async () => {
  const server = createFakeServer();
  const readCalls = [];
  const manager = {
    get: () => ({
      read: async (opts) => {
        readCalls.push(opts);
        return { output: 'new data', timedOut: false, position: 500 };
      },
    }),
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_read').handler({
    sessionId: 's1',
    timeout: 5000,
    idleTimeout: 200,
    maxLines: 50,
    since: 400,
  });

  assert.deepEqual(readCalls, [{ timeout: 5000, idleTimeout: 200, maxLines: 50, since: 400 }]);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    output: 'new data',
    timedOut: false,
    position: 500,
  });
});

test('terminal_stop returns snapshot when snapshotLines > 0', async () => {
  const server = createFakeServer();
  let stopped = false;
  const manager = {
    get: () => ({
      getHistory: () => ({ text: 'line 1\nline 2', totalLines: 5, returnedFrom: 3, returnedTo: 5 }),
    }),
    stop: (id) => { stopped = id; },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_stop').handler({
    sessionId: 's1',
    snapshotLines: 2,
  });

  assert.equal(stopped, 's1');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.snapshot.text, 'line 1\nline 2');
  assert.equal(payload.snapshot.lineCount, 2);
  assert.equal(payload.snapshot.totalLines, 5);
});

test('terminal_stop writes transcript to disk', async () => {
  const server = createFakeServer();
  const tempDir = await mkdtemp(join(tmpdir(), 'shell-session-mcp-'));
  try {
    const transcriptPath = join(tempDir, 'output.log');
    const manager = {
      get: () => ({
        getHistory: () => ({ text: 'full history', totalLines: 3, returnedFrom: 0, returnedTo: 3 }),
      }),
      stop: () => {},
    };

    registerTools(server, manager);

    const result = await server.tools.get('terminal_stop').handler({
      sessionId: 's1',
      transcriptPath,
    });

    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.success, true);
    assert.equal(payload.transcript.path, resolve(transcriptPath));
    assert.ok(payload.transcript.bytes > 0);

    const written = await readFile(transcriptPath, 'utf-8');
    assert.equal(written, 'full history');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('terminal_stop does not stop session on transcript write failure', async () => {
  // On Windows, deep path writes often succeed (no permission constraints)
  // Use a path with a null byte which is universally invalid
  const server = createFakeServer();
  let stopped = false;
  const manager = {
    get: () => ({
      getHistory: () => ({ text: 'data', totalLines: 1, returnedFrom: 0, returnedTo: 1 }),
    }),
    stop: () => { stopped = true; },
  };

  registerTools(server, manager);

  // Using a path that resolves to something that will fail on write
  // On Unix: /dev/null/impossible/output.log (ENOTDIR)
  // On Windows: NUL\impossible (still writable sometimes)
  // Instead, skip on Windows
  if (process.platform === 'win32') return;

  const result = await server.tools.get('terminal_stop').handler({
    sessionId: 's1',
    transcriptPath: '/dev/null/impossible/output.log',
  });

  assert.ok(result.isError, 'should return error on write failure');
  assert.equal(stopped, false, 'session should NOT be stopped');
});

test('terminal_stop preserves original behavior with no options', async () => {
  const server = createFakeServer();
  let stopped = false;
  const manager = {
    get: () => ({}),
    stop: (id) => { stopped = id; },
  };

  registerTools(server, manager);

  const result = await server.tools.get('terminal_stop').handler({ sessionId: 's1' });

  assert.equal(stopped, 's1');
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.success, true);
  assert.equal(payload.snapshot, undefined);
  assert.equal(payload.transcript, undefined);
});

test('terminal_watch forwards triggers and options', async () => {
  process.env.SHELL_SESSION_DISABLED_TOOLS = '';
  try {
    const server = createFakeServer();
    const watchCalls = [];
    const manager = {
      get: () => ({
        watch: async (opts) => {
          watchCalls.push(opts);
          return { reason: 'trigger', triggerId: 'ready', matchedLine: 'done', context: [], position: 100, timedOut: false };
        },
      }),
    };

    registerTools(server, manager);

    const result = await server.tools.get('terminal_watch').handler({
      sessionId: 's1',
      triggers: [{ id: 'ready', pattern: 'done', isRegex: true, cooldownMs: 0 }],
      timeout: 5000,
      contextLines: 5,
      since: 50,
    });

    assert.deepEqual(watchCalls, [{
      triggers: [{ id: 'ready', pattern: 'done', isRegex: true, cooldownMs: 0 }],
      timeout: 5000,
      quietExitMs: undefined,
      contextLines: 5,
      since: 50,
    }]);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.reason, 'trigger');
    assert.equal(payload.triggerId, 'ready');
  } finally {
    delete process.env.SHELL_SESSION_DISABLED_TOOLS;
  }
});
