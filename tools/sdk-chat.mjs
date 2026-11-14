import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  prompts: [],
  timeout: 240,
  shutdown: false,
  newSession: false,
  hold: 0,
};

const usage = `Usage: node tools/sdk-chat.mjs --session <sessionId> [options]

Options:
  --prompt <text>       Send a prompt (repeatable)
  --prompt-file <path>  Read a UTF-8 prompt from a file (repeatable)
  --session <id>        Session id (required)
  --new                 Start a fresh session; skip session/resume
  --hold <seconds>      Keep the runtime alive after prompts, printing events
  --out <path>          Write the transcript to this path
  --timeout <seconds>   Request timeout (default: 240)
  --shutdown            Shut down the runtime after prompts or the hold
  --help                Show this help
`;

function fail(message) {
  throw new Error(message);
}

for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === '--prompt' || argument === '--prompt-file') {
    const value = process.argv[++i];
    if (value === undefined) fail(`${argument} requires a value`);
    options.prompts.push(argument === '--prompt' ? value : readFileSync(path.resolve(value), 'utf8'));
  } else if (argument === '--session' || argument === '--out' || argument === '--timeout' || argument === '--hold') {
    const value = process.argv[++i];
    if (value === undefined) fail(`${argument} requires a value`);
    if (argument === '--session') options.session = value;
    else if (argument === '--out') options.out = value;
    else if (argument === '--timeout') options.timeout = Number(value);
    else options.hold = Number(value);
  } else if (argument === '--new') {
    options.newSession = true;
  } else if (argument === '--shutdown') {
    options.shutdown = true;
  } else if (argument === '--help' || argument === '-h') {
    console.log(usage);
    process.exit(0);
  } else {
    fail(`Unknown argument: ${argument}`);
  }
}

if (!options.session) fail('Missing required --session <sessionId>');
if (!Number.isFinite(options.timeout) || options.timeout <= 0) fail('--timeout must be a positive number');
if (!Number.isFinite(options.hold) || options.hold < 0) fail('--hold must be a non-negative number');
if (options.hold > 0) options.shutdown = true;
const timestamp = new Date().toISOString().replaceAll(':', '-');
const logPath = path.resolve(root, options.out ?? `.cache/sdk-run-${timestamp}.log`);
mkdirSync(path.dirname(logPath), { recursive: true });
writeFileSync(logPath, '');

function log(line) {
  console.log(line);
  appendFileSync(logPath, `${line}\n`, 'utf8');
}

function short(value, maxLength = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

const env = {
  ...process.env,
  DSH_HOME: 'C:\\Users\\Names\\.dsh-nightdesk',
  NIGHTDESK_DATA_DIR: 'C:\\Users\\Names\\.dsh-nightdesk\\nightdesk-data',
};
log(`[info] log=${logPath}`);
log(`[info] MAGPIE_GATEWAY_KEY=${env.MAGPIE_GATEWAY_KEY ? '[set]' : '[not set]'}`);
const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '-y', '@deepseek-ai/dsh@0.2.2-rc.3', 'nightdesk-sdk'], {
  cwd: root,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let nextId = 1;
let lineBuffer = '';
let settled = false;
let failure = null;
const pending = new Map();
const exitPromise = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    const reason = `Runtime exited (code=${code}, signal=${signal ?? 'none'})`;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    pending.clear();
    resolve({ code, signal });
  });
});

function send(message) {
  if (child.stdin.destroyed || child.stdin.writableEnded) fail('Runtime stdin is not writable');
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeout = options.timeout * 1000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method} response (${timeout} ms)`));
    }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    try {
      send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function extractText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'input_text' && typeof block.text === 'string') return block.text;
  return '';
}

function transcriptEvent(event) {
  if (!event || typeof event !== 'object') {
    log(`[event] ${short(event)}`);
    return;
  }
  const { type, seq = '', data } = event;
  const assistantEvent = type === 'assistant/message';
  if (!type) {
    log(`[event] ${short(event)}`);
    return;
  }
  if (Array.isArray(data)) {
    if (assistantEvent) for (const block of data) {
      const text = extractText(block);
      if (text) log(`[assistant] ${text}`);
    }
  } else if (data && typeof data === 'object') {
    if (assistantEvent && Array.isArray(data.message?.content)) {
      for (const block of data.message.content) {
        const text = extractText(block);
        if (text) log(`[assistant] ${text}`);
      }
    }
    if (assistantEvent && Array.isArray(data.contentBlocks)) {
      for (const block of data.contentBlocks) {
        const text = extractText(block);
        if (text) log(`[assistant] ${text}`);
      }
    }
    if (assistantEvent && Array.isArray(data.content)) {
      for (const block of data.content) {
        const text = extractText(block);
        if (text) log(`[assistant] ${text}`);
      }
    }
    const text = assistantEvent ? extractText(data) : '';
    if (text && (type.includes('text') || type.includes('message'))) log(`[assistant] ${text}`);
    if (type.includes('tool') && (type.includes('result') || type.includes('output') || type.includes('complete'))) {
      log(`[tool-result] ${short(data.output ?? data.result ?? data.content ?? data)}`);
    } else if (type.includes('tool')) {
      const toolName = data.toolName ?? data.name ?? data.tool?.name ?? 'unknown';
      const input = data.input ?? data.arguments ?? data.args ?? data.params ?? data;
      log(`[tool] ${toolName} ${short(input)}`);
    } else if (type.includes('error')) {
      log(`[error] ${type} ${seq} ${short(data)}`);
    } else if (!text) {
      log(`[event] ${type} ${seq}`);
    }
  } else {
    log(`[event] ${type} ${seq}`);
  }
}

function handleMessage(message) {
  if (message.id !== undefined && pending.has(message.id)) {
    const requestInfo = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(requestInfo.timer);
    if (message.error) {
      const text = JSON.stringify(message.error);
      log(`[error] ${requestInfo.method}: ${text}`);
      failure = new Error(text);
      requestInfo.reject(new Error(text));
    } else {
      requestInfo.resolve(message.result);
    }
    return;
  }
  if (message.method === 'approval/request') {
    log(`[event] approval/request allowed-once ${short(message.params)}`);
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'allowed-once' } });
    return;
  }
  if (message.method === 'user-question/ask') {
    log(`[event] user-question/ask cancelled`);
    if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: { cancelled: true } });
    return;
  }
  if (message.method === 'session.status') {
    log(`[status] ${message.params?.status ?? 'unknown'}`);
    return;
  }
  if (message.method === 'session.query.completed') {
    log(`[event] session.query.completed ${short(message.params)}`);
    if (message.params?.finalResponse) log(`[assistant-final] ${message.params.finalResponse}`);
    return;
  }
  if (message.method === 'session.event') {
    transcriptEvent(message.params?.event);
    return;
  }
  if (message.method) {
    log(`[event] ${message.method} ${short(message.params)}`);
  } else if (message.error) {
    log(`[error] ${short(message.error)}`);
    failure = new Error(JSON.stringify(message.error));
  } else {
    log(`[event] ${short(message)}`);
  }
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  lineBuffer += chunk;
  while (lineBuffer.includes('\n')) {
    const index = lineBuffer.indexOf('\n');
    const line = lineBuffer.slice(0, index).trim();
    lineBuffer = lineBuffer.slice(index + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {
      log(`[runtime] ${short(line)}`);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split(/\r?\n/)) if (line) log(`[stderr] ${line}`);
});
child.stdin.on('error', (error) => log(`[error] stdin: ${error.message}`));

async function waitForExit(timeout) {
  let timer;
  try {
    return await Promise.race([
      exitPromise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime did not exit after shutdown')), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await request('initialize', {
    cwd: root,
    provider: 'magpie',
    model: 'auto/deepseek-v4.1-flash',
    approvalRequests: true,
  }, Math.max(options.timeout * 1000, 300000));
  if (!options.newSession) await request('session/resume', { sessionId: options.session });
  else log('[info] fresh session; session/resume skipped');
  for (let i = 0; i < options.prompts.length; i++) {
    log(`[turn ${i + 1}] ${options.prompts[i]}`);
    await request('session/query', {
      sessionId: options.session,
      contentBlocks: [{ type: 'text', text: options.prompts[i] }],
    });
    const waitResult = await request('session/wait', { sessionId: options.session });
    log(`[event] session/wait completed ${short(waitResult)}`);
  }
  if (options.hold > 0) {
    log(`[hold] ${options.hold}s`);
    await new Promise((resolve) => setTimeout(resolve, options.hold * 1000));
  }
  if (options.shutdown) {
    await request('shutdown', undefined, 30000);
    try {
      await waitForExit(15000);
    } catch {
      log('[event] Runtime did not exit; terminating it');
      child.kill();
      await waitForExit(15000);
    }
  }
} catch (error) {
  failure ??= error;
} finally {
  if (!settled) {
    settled = true;
    if (!options.shutdown) {
      child.stdin.end();
      try {
        await waitForExit(10000);
      } catch {
        child.kill();
        await waitForExit(10000);
      }
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForExit(10000);
    }
  }
}

if (failure) {
  log(`[fail] ${failure.message}`);
  process.exitCode = 1;
} else {
  log('[ok]');
}
