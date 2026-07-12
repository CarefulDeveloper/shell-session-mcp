import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const SCAN_VALUES = ['1', 'true'];

test('src/index.js skips auto-start when SMITHERY_SCAN is truthy', () => {
  for (const value of SCAN_VALUES) {
    const result = spawnSync(process.execPath, ['src/index.js'], {
      cwd: process.cwd(),
      env: { ...process.env, SMITHERY_SCAN: value },
      encoding: 'utf8',
      timeout: 3_000,
    });

    assert.equal(result.status, 0, `expected exit 0 for SMITHERY_SCAN=${value}, got status=${result.status}, signal=${result.signal}, stderr=${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
  }
});

test('initialize response includes shell_session usage instructions', () => {
  const child = spawnSync(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    input: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    }) + '\n',
    encoding: 'utf8',
    timeout: 3_000,
  });

  assert.equal(child.status, 0, child.stderr);
  const response = child.stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(message => message.id === 1);

  assert.match(response.result.instructions, /Use this MCP server only for interactive or persistent shell work/);
  assert.match(response.result.instructions, /For ordinary non-interactive commands/);
  assert.doesNotMatch(response.result.instructions, /action/);
  assert.doesNotMatch(response.result.instructions, /shell_session/);
});

test('tools/call action=help returns the first-level action catalog', async () => {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const send = (message) => {
    child.stdin.write(JSON.stringify(message) + '\n');
  };

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'shell_session',
      arguments: { action: 'help', args: {} },
      _meta: { progressToken: 0 },
    },
  });
  child.stdin.end();

  const exit = await new Promise(resolve => child.on('close', resolve));
  assert.equal(exit, 0, stderr);

  const response = stdout
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .find(message => message.id === 2);

  const payload = JSON.parse(response.result.content[0].text);
  assert.match(payload.usage, /For detailed parameters/);
  assert.ok(payload.actions.some(action => action.name === 'start'));
  assert.ok(payload.actions.some(action => action.name === 'write'));
  assert.equal(payload.actions.some(action => action.parameters), false);
});
