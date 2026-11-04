/**
 * mihomo (Clash.Meta) process lifecycle: binary provisioning, config
 * generation, readiness checks, and the local Clash API.
 */

import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { stringify as stringifyYaml } from 'yaml';

export const CORE_VERSION = 'v1.19.33';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(PLUGIN_ROOT, '.data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
export const CORE_PATH = path.join(DATA_DIR, 'mihomo');

const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const CORE_DOWNLOAD_ROOT = `https://github.com/MetaCubeX/mihomo/releases/download/${CORE_VERSION}`;

const PACKAGED_CORES = {
  'linux-x64': '@pkgship/mihomo-linux-amd64',
  'linux-arm64': '@pkgship/mihomo-linux-arm64',
  'darwin-x64': '@pkgship/mihomo-darwin-amd64',
  'darwin-arm64': '@pkgship/mihomo-darwin-arm64',
  'win32-x64': '@pkgship/mihomo-windows-amd64',
  'win32-arm64': '@pkgship/mihomo-windows-arm64',
  'android-arm64': '@pkgship/mihomo-android-arm64',
};

/** Path of the platform binary installed from the npm package, if present. */
function packagedCorePath() {
  const packageName = PACKAGED_CORES[`${process.platform}-${process.arch}`];
  if (packageName === undefined) return null;
  try {
    const requireFromPlugin = createRequire(import.meta.url);
    // The platform binary is an optional dependency of the meta package, so it
    // lives below that package instead of being hoisted to the plugin root.
    const metaManifest = requireFromPlugin.resolve('@pkgship/mihomo/package.json');
    const candidate = createRequire(metaManifest)(packageName);
    if (typeof candidate === 'string' && existsSync(candidate)) return candidate;
  } catch {
    // Optional platform package not installed; fall back to a download.
  }
  return null;
}

/** Resolve the core path, honoring a caller override. */
export function resolveCorePath(customPath) {
  if (typeof customPath === 'string' && customPath.trim() !== '') return customPath.trim();
  if (existsSync(CORE_PATH)) return CORE_PATH;
  return packagedCorePath() ?? CORE_PATH;
}

/** Return an installed core, downloading the Linux release as a fallback. */
export async function ensureCore(customPath, onDownloading) {
  const target = resolveCorePath(customPath);
  if (existsSync(target)) return target;

  const asset = coreAssetName();
  if (asset === null) {
    throw new Error(`暂不支持自动安装 ${process.platform}/${process.arch} 的 mihomo 内核；请设置 DSH_VPN_CORE_PATH 指向已有的 mihomo 可执行文件`);
  }
  onDownloading?.();

  const url = `${CORE_DOWNLOAD_ROOT}/${asset}`;
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': `dsh-vpn/1.0 (${CORE_VERSION})`, accept: 'application/octet-stream' },
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    throw new Error(`下载 mihomo 内核失败：${errorMessage(error)}（${url}）`);
  }
  if (!response.ok) {
    throw new Error(`下载 mihomo 内核失败：HTTP ${response.status}（${url}）`);
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  if (compressed.byteLength === 0 || compressed.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`mihomo 内核压缩包大小异常（${compressed.byteLength} 字节）`);
  }

  let binary;
  try {
    binary = gunzipSync(compressed);
  } catch (error) {
    throw new Error(`mihomo 内核解压失败：${errorMessage(error)}`);
  }
  if (binary.byteLength < 1_000_000 || !(binary[0] === 0x7f && binary[1] === 0x45 && binary[2] === 0x4c && binary[3] === 0x46)) {
    throw new Error('下载的 mihomo 内核不是有效的 Linux 可执行文件');
  }

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.download`;
  try {
    await writeFile(temporary, binary, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return target;
}

function coreAssetName() {
  if (process.platform !== 'linux') return null;
  if (process.arch === 'x64') return `mihomo-linux-amd64-compatible-${CORE_VERSION}.gz`;
  if (process.arch === 'arm64') return `mihomo-linux-arm64-${CORE_VERSION}.gz`;
  return null;
}

/** Pick two distinct free loopback ports. */
export async function allocatePorts() {
  const first = await freePort();
  let second = await freePort();
  let attempts = 0;
  while (second === first && attempts++ < 8) second = await freePort();
  return { mixedPort: first, apiPort: second };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error('无法分配本地端口'));
      });
    });
  });
}

/** Generate a complete mihomo configuration for the supplied nodes. */
export function buildConfig(nodes, options) {
  const { mixedPort, apiPort, secret, hosts = {} } = options;
  let group = 'DSH-VPN';
  const names = new Set(nodes.map((node) => node.name));
  while (names.has(group)) group += '_';
  const hostOverrides = hosts !== null && typeof hosts === 'object' && Object.keys(hosts).length > 0 ? { hosts } : {};

  const config = {
    'mixed-port': mixedPort,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    mode: 'rule',
    'log-level': 'warning',
    ipv6: false,
    'external-controller': `127.0.0.1:${apiPort}`,
    secret,
    'unified-delay': true,
    'tcp-concurrent': true,
    profile: { 'store-selected': false, 'store-fake-ip': false },
    ...hostOverrides,
    proxies: nodes.map((node) => ({ ...node })),
    'proxy-groups': [{ name: group, type: 'select', proxies: nodes.map((node) => node.name) }],
    rules: [
      'DOMAIN-SUFFIX,localhost,DIRECT',
      'IP-CIDR,127.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve',
      'IP-CIDR,172.16.0.0/12,DIRECT,no-resolve',
      'IP-CIDR,192.168.0.0/16,DIRECT,no-resolve',
      'IP-CIDR,169.254.0.0/16,DIRECT,no-resolve',
      'IP-CIDR6,::1/128,DIRECT,no-resolve',
      'IP-CIDR6,fc00::/7,DIRECT,no-resolve',
      `MATCH,${group}`,
    ],
  };
  return { text: stringifyYaml(config, { lineWidth: 0 }), group };
}

/** Write the generated configuration with owner-only permissions. */
export async function writeConfig(text) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await chmod(DATA_DIR, 0o700).catch(() => {});
  await writeFile(CONFIG_PATH, text, { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600).catch(() => {});
}

/** Remove the configuration, which contains node credentials. */
export async function removeConfig() {
  await rm(CONFIG_PATH, { force: true }).catch(() => {});
}

/** Call the local Clash-compatible API. */
export async function coreFetch(apiPort, secret, resource, init = {}) {
  const headers = {
    authorization: `Bearer ${secret}`,
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...init.headers,
  };
  const response = await fetch(`http://127.0.0.1:${apiPort}${resource}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(6_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`mihomo API ${response.status}: ${text.slice(0, 300)}`);
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Wait until the core API answers, or fail with the process' stderr. */
export async function waitForCore(apiPort, secret, exitState) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exitState.exited) throw new Error(`mihomo 内核启动失败：${exitState.detail || '进程已退出'}`);
    try {
      const version = await coreFetch(apiPort, secret, '/version', { signal: AbortSignal.timeout(1_200) });
      if (version && typeof version === 'object') return version;
    } catch {
      // Not ready yet.
    }
    await sleep(120);
  }
  throw new Error('mihomo 内核启动超时');
}

/** Wait for the generated select group to appear after the API is up. */
export async function waitForGroup(apiPort, secret, group, exitState) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (exitState.exited) throw new Error(`mihomo 内核启动失败：${exitState.detail || '进程已退出'}`);
    try {
      const info = await coreFetch(apiPort, secret, `/proxies/${encodeURIComponent(group)}`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (info !== null && typeof info === 'object' && Array.isArray(info.all)) return info;
    } catch {
      // The selector is installed right after the API starts answering.
    }
    await sleep(100);
  }
  throw new Error('mihomo 代理组未就绪');
}

export async function readCoreLog(handle) {
  try {
    const stderr = handle?.collected?.stderr?.readFrom(0);
    if (stderr && stderr.text.trim() !== '') return stderr.text.trim().slice(-1_500);
  } catch {
    // The collector may not be available after a failed spawn.
  }
  return '';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${message}${cause}`;
}

