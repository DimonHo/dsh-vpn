/**
 * Host half of the DSH VPN plugin.
 *
 * One subscription becomes a local mihomo process. While connected, the
 * plugin installs DSH's process-wide outbound proxy policy, so the harness's
 * own `fetch` traffic (models, web tools, MCP) and future subprocesses use the
 * selected node. The system proxy and OS routing table are never touched.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseSubscription, parseUserinfo } from './lib/subscription.js';
import {
  buildConfig,
  CORE_VERSION,
  coreFetch,
  DATA_DIR,
  ensureCore,
  allocatePorts,
  readCoreLog,
  removeConfig,
  resolveCorePath,
  waitForCore,
  waitForGroup,
  writeConfig,
} from './lib/mihomo.js';

const NS = 'dsh-vpn';
const API_PATH = '/dsh-vpn/api';
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const MAX_SUBSCRIPTION_BYTES = 6 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const EGRESS_URLS = ['https://ifconfig.me/ip', 'https://api.ipify.org?format=json', 'https://ipinfo.io/ip'];
const DELAY_URL = 'https://www.gstatic.com/generate_204';

/** @type {{subscriptionUrl:string,nodes:Array<Record<string, unknown>>,selected:string,updatedAt:string|null,format:string|null,warnings:string[],userinfo:Record<string,number>|null,hosts:Record<string,string>}} */
let state = {
  subscriptionUrl: '',
  nodes: [],
  selected: '',
  updatedAt: null,
  format: null,
  warnings: [],
  userinfo: null,
  hosts: {},
};

const runtime = {
  disposed: false,
  phase: 'idle',
  connected: false,
  port: null,
  apiPort: null,
  secret: null,
  group: null,
  coreVersion: null,
  exitIp: null,
  lastError: null,
  coreHandle: null,
  coreAbort: null,
  exitState: null,
  proxyDispose: null,
  generation: 0,
  stopping: false,
};

let ready = Promise.resolve();
let taskQueue = Promise.resolve();
let httpProxyPromise;
let shutdownPromise;
let hostContext;
let configuredCorePath = '';

export const inject = ['webServer', 'connection', 'subprocess', 'tools'];

export function apply(ctx, config = {}) {
  hostContext = ctx;
  configuredCorePath = typeof config?.corePath === 'string' ? config.corePath : '';
  // A module can be re-activated after HMR without re-evaluation. Reset the
  // process-local runtime flags that a previous unload marked as disposed.
  runtime.disposed = false;
  runtime.phase = 'idle';
  runtime.connected = false;
  runtime.port = null;
  runtime.apiPort = null;
  runtime.secret = null;
  runtime.group = null;
  runtime.coreVersion = null;
  runtime.exitIp = null;
  runtime.lastError = null;
  runtime.coreHandle = null;
  runtime.coreAbort = null;
  runtime.exitState = null;
  runtime.proxyDispose = null;
  runtime.generation = 0;
  runtime.stopping = false;
  state = {
    subscriptionUrl: '',
    nodes: [],
    selected: '',
    updatedAt: null,
    format: null,
    warnings: [],
    userinfo: null,
    hosts: {},
  };
  shutdownPromise = undefined;
  taskQueue = Promise.resolve();
  httpProxyPromise = undefined;

  const log = (level, message) => {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level](`vpn: ${message}`);
  };

  ready = loadState().catch((error) => {
    runtime.lastError = `读取本地状态失败：${errorMessage(error)}`;
    runtime.phase = 'error';
    log('warn', runtime.lastError);
  });

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: API_PATH, handler: (req, res) => handleApi(ctx, req, res) }),
    'vpn: management API',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'vpn_connection',
        description:
          'Inspect or control the Harness VPN. Use status before acting, subscribe to load a Clash or base64 subscription URL, import to load raw Clash YAML or a base64 node list, connect to route the harness through the selected node, disconnect to restore direct access, select to choose a node, and test to report the current exit IP.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              description: 'One of: status, subscribe, import, connect, disconnect, select, test.',
            },
            url: {
              type: 'string',
              description: 'Subscription URL for the subscribe action.',
            },
            content: {
              type: 'string',
              description: 'Raw Clash YAML or base64/plain node list for the import action.',
            },
            node: {
              type: 'string',
              description: 'Exact node name for the select action. Use status to discover names.',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        timeoutMs: 180_000,
        isConcurrencySafe: (args) => args?.action === 'status' || args?.action === 'test',
        async execute(args, exec) {
          await ready;
          exec.signal.throwIfAborted();
          const action = typeof args?.action === 'string' ? args.action : '';
          if (action === 'status') return { ok: true, message: statusMessage() };
          if (action === 'subscribe') {
            if (typeof args?.url !== 'string' || args.url.trim() === '') throw new Error('subscribe 需要 url 参数');
            await enqueue(() => updateSubscription(args.url));
            return { ok: true, message: statusMessage() };
          }
          if (action === 'import') {
            if (typeof args?.content !== 'string' || args.content.trim() === '') throw new Error('import 需要 content 参数');
            await enqueue(() => importSubscription(args.content));
            return { ok: true, message: statusMessage() };
          }
          if (action === 'connect') {
            await enqueue(connectInternal);
            return { ok: true, message: statusMessage() };
          }
          if (action === 'disconnect') {
            await enqueue(disconnectInternal);
            return { ok: true, message: statusMessage() };
          }
          if (action === 'select') {
            if (typeof args?.node !== 'string' || args.node.trim() === '') throw new Error('select 需要 node 参数');
            await enqueue(() => selectNode(args.node));
            return { ok: true, message: statusMessage() };
          }
          if (action === 'test') {
            const result = await testEgress();
            return { ok: true, message: `出口 IP：${result.ip}（${result.latencyMs} ms）` };
          }
          throw new Error('action 必须是 status、subscribe、connect、disconnect、select 或 test');
        },
      }),
    'vpn: agent tool',
  );

  ctx.effect(
    () => () => shutdown(),
    'vpn: runtime lifecycle',
  );
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  let raw;
  try {
    raw = await readFile(STATE_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('state.json 不是有效的 JSON');
  }
  if (parsed === null || typeof parsed !== 'object') return;

  state.subscriptionUrl = typeof parsed.subscriptionUrl === 'string' ? parsed.subscriptionUrl : '';
  state.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
  state.format = typeof parsed.format === 'string' ? parsed.format : null;
  state.warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((item) => typeof item === 'string').slice(0, 8) : [];
  state.userinfo = sanitizeUserinfo(parsed.userinfo);
  state.nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter(isStoredNode) : [];
  state.hosts = sanitizeHosts(parsed.hosts);
  state.selected = typeof parsed.selected === 'string' ? parsed.selected : '';
  if (!state.nodes.some((node) => node.name === state.selected)) state.selected = state.nodes[0]?.name ?? '';
}

async function saveState() {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  const temporary = `${STATE_PATH}.${randomBytes(4).toString('hex')}.tmp`;
  const body = JSON.stringify(
    {
      version: 1,
      subscriptionUrl: state.subscriptionUrl,
      updatedAt: state.updatedAt,
      format: state.format,
      warnings: state.warnings,
      userinfo: state.userinfo,
      hosts: state.hosts,
      nodes: state.nodes,
      selected: state.selected,
    },
    null,
    2,
  );
  try {
    await writeFile(temporary, body, { mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, STATE_PATH);
    await chmod(STATE_PATH, 0o600).catch(() => {});
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function isStoredNode(node) {
  return (
    node !== null &&
    typeof node === 'object' &&
    typeof node.name === 'string' &&
    node.name !== '' &&
    typeof node.type === 'string' &&
    typeof node.server === 'string' &&
    Number.isInteger(node.port)
  );
}

function sanitizeUserinfo(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['upload', 'download', 'total', 'expire']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return Object.keys(result).length === 0 ? null : result;
}

function sanitizeHosts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, target] of Object.entries(value)) {
    if (typeof target !== 'string' || key === '' || key === '__proto__') continue;
    result[key] = target;
  }
  return result;
}

function publicState() {
  return {
    phase: runtime.phase,
    connected: runtime.connected,
    port: runtime.port,
    coreVersion: runtime.coreVersion,
    exitIp: runtime.exitIp,
    lastError: runtime.lastError,
    group: runtime.group,
    coreAvailable: existsSync(resolveCorePath(configuredCorePath)),
    subscription: {
      url: state.subscriptionUrl,
      updatedAt: state.updatedAt,
      format: state.format,
      warnings: state.warnings,
      userinfo: state.userinfo,
      nodeCount: state.nodes.length,
    },
    nodes: state.nodes.map((node) => ({ name: node.name, type: node.type })),
    selected: state.selected,
  };
}

function statusMessage() {
  const location = state.selected ? `，当前节点 ${state.selected}` : '';
  const preview = state.nodes.slice(0, 12).map((node) => node.name).join('、');
  const more = state.nodes.length > 12 ? ` 等 ${state.nodes.length} 个` : '';
  const inventory = preview === '' ? '' : `；节点：${preview}${more}`;
  if (runtime.connected) {
    const exit = runtime.exitIp ? `，出口 IP ${runtime.exitIp}` : '';
    return `已连接${location}（本地端口 ${runtime.port}${exit}）${inventory}`;
  }
  if (runtime.phase === 'error' && runtime.lastError) return `未连接：${runtime.lastError}${inventory}`;
  return state.nodes.length > 0
    ? `未连接；已保存 ${state.nodes.length} 个节点${location}${inventory}`
    : '未连接；尚未配置订阅';
}

async function handleApi(ctx, req, res) {
  try {
    let rejection;
    try {
      rejection = ctx.connection.requestRejection(req);
    } catch {
      rejection = 403;
    }
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'POST');
      res.end();
      return;
    }
    const mediaType = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== 'application/json') {
      sendJson(res, 415, { ok: false, error: { code: 'unsupported-media-type', message: '请求必须使用 application/json' } });
      return;
    }

    const raw = await readBody(req, MAX_REQUEST_BYTES);
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'bad-json', message: '请求体不是有效的 JSON' } });
      return;
    }
    if (message === null || typeof message !== 'object' || typeof message.action !== 'string') {
      sendJson(res, 400, { ok: false, error: { code: 'bad-request', message: '缺少 action' } });
      return;
    }

    await ready;
    const result = await dispatch(message.action, message);
    sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 200, {
        ok: false,
        error: { code: error?.code ?? 'vpn-error', message: errorMessage(error) },
      });
    }
  }
}

async function dispatch(action, message) {
  if (action === 'state') return { state: publicState() };
  if (action === 'subscribe') {
    await enqueue(() => updateSubscription(String(message.url ?? '')));
    return { state: publicState() };
  }
  if (action === 'import') {
    await enqueue(() => importSubscription(String(message.content ?? '')));
    return { state: publicState() };
  }
  if (action === 'clear') {
    await enqueue(clearSubscription);
    return { state: publicState() };
  }
  if (action === 'connect') {
    await enqueue(connectInternal);
    return { state: publicState() };
  }
  if (action === 'disconnect') {
    await enqueue(disconnectInternal);
    return { state: publicState() };
  }
  if (action === 'select') {
    await enqueue(() => selectNode(String(message.name ?? '')));
    return { state: publicState() };
  }
  if (action === 'latency') {
    const result = await measureLatency(typeof message.name === 'string' ? message.name : '');
    return { ...result, state: publicState() };
  }
  if (action === 'test') {
    const result = await testEgress();
    return { ...result, state: publicState() };
  }
  throw new Error(`未知操作：${action}`);
}

function enqueue(task) {
  const run = taskQueue.then(task, task);
  taskQueue = run.catch(() => {});
  return run;
}

async function updateSubscription(rawUrl) {
  if (runtime.connected) throw new Error('请先断开连接，再更新订阅');
  const url = rawUrl.trim();
  if (url === '') throw new Error('请输入订阅链接');
  if (url.length > 4096) throw new Error('订阅链接过长');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('订阅链接不是有效的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('订阅链接必须使用 http 或 https');
  }

  let response;
  try {
    response = await fetch(parsed, {
      redirect: 'follow',
      headers: {
        'user-agent': 'clash.meta/1.19.33',
        accept: 'text/yaml,text/plain,application/yaml,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`获取订阅失败：${errorMessage(error).split(url).join('<订阅链接>')}`);
  }
  if (!response.ok) throw new Error(`订阅地址返回 HTTP ${response.status}`);
  const body = await readCapped(response, MAX_SUBSCRIPTION_BYTES, '订阅内容');
  if (body.trim().startsWith('<')) throw new Error('订阅地址返回了网页而不是节点配置，请检查链接是否需要 Clash UA 或已过期');

  let result;
  try {
    result = parseSubscription(body);
  } catch (error) {
    throw new Error(errorMessage(error));
  }

  return applySubscription(result, {
    url,
    userinfo: parseUserinfo(response.headers.get('subscription-userinfo')) ?? state.userinfo,
  });
}

/**
 * Import a raw Clash YAML document (or base64/plain URI list) from the UI. It
 * has no URL to update from, so the stored URL is cleared and the cached nodes
 * become the source of truth.
 */
async function importSubscription(rawContent) {
  if (runtime.connected) throw new Error('请先断开连接，再导入配置');
  const content = String(rawContent ?? '');
  if (content.trim() === '') throw new Error('请粘贴 Clash YAML 或节点列表');
  if (Buffer.byteLength(content, 'utf8') > MAX_SUBSCRIPTION_BYTES) {
    throw new Error(`配置内容超过 ${Math.round(MAX_SUBSCRIPTION_BYTES / 1024 / 1024)} MB`);
  }
  if (content.trim().startsWith('<')) throw new Error('内容看起来是网页而不是 YAML 配置');

  let result;
  try {
    result = parseSubscription(content);
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  return applySubscription(result, { url: '', userinfo: null });
}

async function applySubscription(result, options) {
  state.subscriptionUrl = options.url;
  state.nodes = result.nodes;
  state.hosts = result.hosts ?? {};
  state.format = result.format;
  state.warnings = result.warnings;
  state.updatedAt = new Date().toISOString();
  state.userinfo = options.userinfo ?? null;
  if (!state.nodes.some((node) => node.name === state.selected)) state.selected = state.nodes[0]?.name ?? '';
  runtime.lastError = null;
  await saveState();
  return publicState();
}

async function clearSubscription() {
  if (runtime.connected) throw new Error('请先断开连接，再删除订阅');
  state = {
    subscriptionUrl: '',
    nodes: [],
    selected: '',
    updatedAt: null,
    format: null,
    warnings: [],
    userinfo: null,
    hosts: {},
  };
  runtime.lastError = null;
  await removeConfig();
  await saveState();
  return publicState();
}

async function connectInternal() {
  if (runtime.disposed) throw new Error('插件已卸载');
  if (runtime.connected) return publicState();
  if (runtime.proxyDispose !== null || runtime.coreHandle !== null) await teardownRuntime();

  runtime.lastError = null;
  setPhase('preparing');
  try {
    if (state.nodes.length === 0) {
      if (state.subscriptionUrl === '') throw new Error('请先在设置中填写订阅链接');
      await updateSubscription(state.subscriptionUrl);
    }
    if (state.nodes.length === 0) throw new Error('订阅中没有可用节点');

    const corePath = await ensureCore(configuredCorePath, () => setPhase('downloading'));
    if (runtime.disposed) throw new Error('插件已卸载');
    const { mixedPort, apiPort } = await allocatePorts();
    const secret = randomBytes(24).toString('hex');
    const { text, group } = buildConfig(state.nodes, { mixedPort, apiPort, secret, hosts: state.hosts });
    await writeConfig(text);

    const abort = new AbortController();
    const exitState = { exited: false, detail: '' };
    const generation = ++runtime.generation;
    runtime.stopping = false;
    setPhase('starting');

    const handle = hostContext.subprocess.spawn({
      argv: [corePath, '-d', DATA_DIR, '-f', path.join(DATA_DIR, 'config.yaml')],
      cwd: DATA_DIR,
      env: { HOME: DATA_DIR, TMPDIR: DATA_DIR },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 256 * 1024 },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 2_000,
      signal: abort.signal,
    });

    runtime.coreHandle = handle;
    runtime.coreAbort = abort;
    runtime.exitState = exitState;
    runtime.port = mixedPort;
    runtime.apiPort = apiPort;
    runtime.secret = secret;
    runtime.group = group;
    runtime.coreVersion = null;

    handle.done
      .then(async (outcome) => {
        const detail = await readCoreLog(handle);
        exitState.exited = true;
        exitState.detail = detail || `退出码 ${outcome.exitCode ?? outcome.signal ?? 'unknown'}`;
        if (generation !== runtime.generation || runtime.stopping) return;
        await failFromCoreExit(generation, exitState.detail);
      })
      .catch(async (error) => {
        exitState.exited = true;
        exitState.detail = errorMessage(error);
        if (generation !== runtime.generation || runtime.stopping) return;
        await failFromCoreExit(generation, exitState.detail);
      });

    const version = await waitForCore(apiPort, secret, exitState);
    if (runtime.disposed) throw new Error('插件已卸载');
    runtime.coreVersion = typeof version.version === 'string' ? version.version : CORE_VERSION;
    const groupInfo = await waitForGroup(apiPort, secret, group, exitState);
    if (groupInfo === null || typeof groupInfo !== 'object') throw new Error('mihomo 没有创建代理组');
    if (state.selected !== '') {
      await selectOnCore(group, state.selected);
    }
    await installProxy(mixedPort);
    if (runtime.disposed) throw new Error('插件已卸载');
    runtime.connected = true;
    runtime.exitIp = null;
    setPhase('connected');
    return publicState();
  } catch (error) {
    const message = errorMessage(error);
    await teardownRuntime();
    runtime.lastError = message;
    setPhase('error');
    throw error;
  }
}

async function disconnectInternal() {
  setPhase('stopping');
  await teardownRuntime();
  runtime.lastError = null;
  runtime.exitIp = null;
  setPhase('idle');
  return publicState();
}

async function teardownRuntime() {
  runtime.stopping = true;
  runtime.generation += 1;
  const proxyDispose = runtime.proxyDispose;
  runtime.proxyDispose = null;
  if (proxyDispose !== null) {
    try {
      await proxyDispose();
    } catch {
      // Restoring the previous dispatcher is best effort during teardown.
    }
  }

  const handle = runtime.coreHandle;
  const abort = runtime.coreAbort;
  runtime.coreHandle = null;
  runtime.coreAbort = null;
  runtime.exitState = null;
  runtime.connected = false;
  runtime.port = null;
  runtime.apiPort = null;
  runtime.secret = null;
  runtime.group = null;
  runtime.coreVersion = null;

  if (abort !== null) abort.abort();
  if (handle !== null) {
    try {
      handle.terminate();
    } catch {
      // The process may already have exited.
    }
    await withTimeout(handle.waitForExit(), 4_000);
  }
  await removeConfig();
}

async function failFromCoreExit(generation, detail) {
  if (generation !== runtime.generation || runtime.stopping) return;
  runtime.stopping = true;
  runtime.generation += 1;
  const proxyDispose = runtime.proxyDispose;
  runtime.proxyDispose = null;
  if (proxyDispose !== null) {
    try {
      await proxyDispose();
    } catch {
      // The previous dispatcher is still usable even if cleanup reports an error.
    }
  }
  runtime.connected = false;
  runtime.port = null;
  runtime.apiPort = null;
  runtime.secret = null;
  runtime.group = null;
  runtime.coreVersion = null;
  runtime.coreHandle = null;
  runtime.coreAbort = null;
  runtime.exitState = null;
  await removeConfig();
  runtime.lastError = `mihomo 已退出：${detail}`;
  setPhase('error');
}

async function selectNode(name) {
  const node = state.nodes.find((candidate) => candidate.name === name);
  if (node === undefined) throw new Error('节点不存在，请刷新订阅');
  if (runtime.connected && runtime.group !== null) {
    await selectOnCore(runtime.group, name);
  }
  state.selected = name;
  await saveState();
  return publicState();
}

async function selectOnCore(group, name) {
  if (runtime.apiPort === null || runtime.secret === null) throw new Error('内核尚未就绪');
  await coreFetch(runtime.apiPort, runtime.secret, `/proxies/${encodeURIComponent(group)}`, {
    method: 'PUT',
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(5_000),
  });
}

async function measureLatency(name) {
  if (!runtime.connected || runtime.apiPort === null || runtime.secret === null) {
    throw new Error('请先连接后再测速');
  }
  if (name.trim() !== '') {
    const delay = await delayFor(name.trim());
    return { results: { [name.trim()]: delay } };
  }
  const names = state.nodes.map((node) => node.name).slice(0, 80);
  const results = {};
  let cursor = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < names.length) {
      const current = names[cursor++];
      try {
        results[current] = await delayFor(current);
      } catch {
        results[current] = null;
      }
    }
  });
  await Promise.all(workers);
  return { results, tested: names.length, total: state.nodes.length };
}

async function delayFor(name) {
  const params = new URLSearchParams({ timeout: '3000', url: DELAY_URL });
  const info = await coreFetch(runtime.apiPort, runtime.secret, `/proxies/${encodeURIComponent(name)}/delay?${params.toString()}`, {
    signal: AbortSignal.timeout(6_000),
  });
  return info !== null && typeof info === 'object' && Number.isFinite(info.delay) ? info.delay : null;
}

async function testEgress() {
  if (!runtime.connected) throw new Error('请先连接后再测试出口');
  const started = Date.now();
  let lastError = '';
  for (const url of EGRESS_URLS) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'dsh-vpn/1.0', accept: 'application/json,text/plain' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }
      const text = (await response.text()).trim();
      let ip = text.slice(0, 80);
      if (text.startsWith('{')) {
        try {
          const data = JSON.parse(text);
          if (data !== null && typeof data === 'object' && typeof data.ip === 'string') ip = data.ip;
        } catch {
          // Keep the raw text as a best-effort answer.
        }
      }
      if (ip === '') {
        lastError = 'empty response';
        continue;
      }
      runtime.exitIp = ip;
      return { ip, latencyMs: Date.now() - started, state: publicState() };
    } catch (error) {
      lastError = errorMessage(error);
    }
  }
  throw new Error(`出口测试失败：${lastError || '没有可用的出口检测服务'}`);
}

async function installProxy(port) {
  const module = await loadHttpProxy();
  const existingNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
  const values = new Map([
    ['http_proxy', `http://127.0.0.1:${port}`],
    ['https_proxy', `http://127.0.0.1:${port}`],
  ]);
  if (existingNoProxy !== '') values.set('no_proxy', existingNoProxy);
  const env = {
    get(name) {
      const value = values.get(name);
      return value === undefined ? undefined : { value };
    },
  };
  runtime.proxyDispose = await module.installProxyFromEnvironment(env, (message) => {
    const logger = hostContext?.logger;
    if (logger && typeof logger.warn === 'function') logger.warn(`vpn: ${message}`);
  });
}

async function loadHttpProxy() {
  if (httpProxyPromise !== undefined) return httpProxyPromise;
  httpProxyPromise = (async () => {
    const candidates = [];
    const entry = process.argv[1];
    if (typeof entry === 'string' && entry !== '') {
      const root = path.resolve(path.dirname(entry), '..');
      candidates.push(path.join(root, 'node_modules', '@deepseek-ai', 'dsh-http-proxy', 'lib', 'index.js'));
      try {
        candidates.push(createRequire(entry).resolve('@deepseek-ai/dsh-http-proxy'));
      } catch {
        // The global installation layout differs; try the remaining candidates.
      }
    }
    try {
      candidates.push(fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-http-proxy')));
    } catch {
      // Not installed as a direct dependency of this bundle.
    }

    const seen = new Set();
    for (const candidate of candidates) {
      if (seen.has(candidate) || !existsSync(candidate)) continue;
      seen.add(candidate);
      try {
        const module = await import(pathToFileURL(candidate).href);
        if (typeof module.installProxyFromEnvironment === 'function') return module;
      } catch {
        // Try the next candidate.
      }
    }
    throw new Error('无法加载 DSH 的 http-proxy 模块，外网路由未启用');
  })().catch((error) => {
    httpProxyPromise = undefined;
    throw error;
  });
  return httpProxyPromise;
}

async function shutdown() {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    runtime.disposed = true;
    await teardownRuntime();
  })();
  return shutdownPromise;
}

function setPhase(phase) {
  runtime.phase = phase;
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readCapped(response, maxBytes, label) {
  const length = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(length) && length > maxBytes) throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (response.body === null) throw new Error(`${label}为空`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const contentType = response.headers.get('content-type') ?? '';
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder();
  }
  return decoder.decode(Buffer.concat(chunks));
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${message}${cause}`;
}

