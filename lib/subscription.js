/**
 * Subscription parsing for the VPN plugin.
 *
 * Supports:
 *  - Clash / Clash.Meta / mihomo YAML documents with an inline `proxies` list.
 *  - Base64-encoded or plain URI lists (ss, vmess, trojan, vless, hysteria2,
 *    tuic, socks5, http).
 *
 * Only node definitions are kept. Subscription-provided groups and rules are
 * deliberately ignored: the plugin owns a single deterministic group so the
 * user can select a node from the management page.
 */

import { parse as parseYaml } from 'yaml';

const MAX_NODES = 500;

/** Parse the de-facto `subscription-userinfo` response header. */
export function parseUserinfo(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const info = {};
  for (const part of value.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const number = Number(part.slice(index + 1).trim());
    if (!['upload', 'download', 'total', 'expire'].includes(key)) continue;
    if (Number.isFinite(number) && number >= 0) info[key] = number;
  }
  return Object.keys(info).length === 0 ? null : info;
}

/** Parse a subscription body into normalized proxy nodes. */
export function parseSubscription(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('配置内容为空');
  }

  const input = text.trim();
  if (/^\s*(proxies|proxy-groups|proxy-providers)\s*:/m.test(input)) {
    return parseClash(input);
  }

  const decoded = decodeBase64Text(input);
  if (decoded !== null && /^\s*(proxies|proxy-groups|proxy-providers)\s*:/m.test(decoded)) {
    return parseClash(decoded);
  }
  const body = decoded !== null && decoded.includes('://') ? decoded : input;
  return parseUriList(body);
}

function parseClash(text) {
  let document;
  try {
    document = parseYaml(text, { maxAliasCount: 100, uniqueKeys: false, prettyErrors: false });
  } catch (error) {
    throw new Error(`Clash 配置解析失败：${errorMessage(error)}`);
  }

  const rawList = Array.isArray(document) ? document : document?.proxies;
  if (!Array.isArray(rawList)) {
    throw new Error('内容中没有找到 proxies 节点列表，请确认是 Clash 配置');
  }
  const hosts = normalizeHosts(document?.hosts);

  const nodes = [];
  let skipped = 0;
  for (const raw of rawList) {
    const node = normalizeClashNode(raw);
    if (node === null) {
      skipped += 1;
      continue;
    }
    nodes.push(node);
  }

  const warnings = [];
  if (skipped > 0) warnings.push(`${skipped} 个节点缺少必要字段，已跳过`);
  if (nodes.length === 0) {
    throw new Error('订阅中的节点均缺少 name/server/port，无法使用');
  }
  return finish(nodes, 'clash', warnings, hosts);
}

/**
 * Keep the Clash `hosts` overrides. Many providers publish pseudo hostnames in
 * `server` and map them to real CDN names here; without the map those nodes
 * cannot resolve at all.
 */
function normalizeHosts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const hosts = {};
  for (const [key, target] of Object.entries(value)) {
    if (key === '' || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (typeof target !== 'string' || target.trim() === '') continue;
    hosts[key] = target.trim();
  }
  return hosts;
}

function normalizeClashNode(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(raw));
  } catch {
    return null;
  }
  const name = cleanName(clone.name || `${clone.type || 'node'} ${clone.server || ''}`);
  const type = String(clone.type || '').trim().toLowerCase();
  const server = String(clone.server || '').trim();
  const port = Number(clone.port);
  if (name === '' || type === '' || server === '' || !validPort(port)) return null;
  return { ...clone, name, type, server, port };
}

function parseUriList(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line.includes('://'));

  const nodes = [];
  const warnings = [];
  let unsupported = 0;
  for (const line of lines) {
    const node = parseProxyUri(line);
    if (node === null) {
      unsupported += 1;
      continue;
    }
    nodes.push(node);
  }

  if (unsupported > 0) warnings.push(`${unsupported} 个节点使用了暂不支持的协议或参数，已跳过`);
  if (nodes.length === 0) {
    throw new Error('无法识别内容格式：请使用 Clash YAML，或包含 ss/vmess/trojan/vless/hysteria2/tuic/socks5/http 节点的链接列表');
  }
  return finish(nodes, 'uri', warnings);
}

function parseProxyUri(line) {
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  try {
    switch (scheme) {
      case 'ss':
        return parseShadowsocks(line);
      case 'vmess':
        return parseVmess(line);
      case 'trojan':
        return parseTrojan(line);
      case 'vless':
        return parseVless(line);
      case 'hysteria2':
      case 'hy2':
        return parseHysteria2(line);
      case 'tuic':
        return parseTuic(line);
      case 'socks':
      case 'socks5':
      case 'socks5h':
        return parseSocks(line);
      case 'http':
      case 'https':
        return parseHttpProxy(line);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function parseShadowsocks(uri) {
  const hash = uri.indexOf('#');
  const name = hash === -1 ? '' : decodeFragment(uri.slice(hash + 1));
  let body = hash === -1 ? uri.slice(5) : uri.slice(5, hash);
  let query = '';
  const question = body.indexOf('?');
  if (question !== -1) {
    query = body.slice(question + 1);
    body = body.slice(0, question);
  }

  let method;
  let password;
  let host;
  let port;

  if (body.includes('@')) {
    const at = body.lastIndexOf('@');
    let userinfo = body.slice(0, at);
    const hostport = splitHostPort(body.slice(at + 1));
    if (hostport === null) return null;
    const decodedUserinfo = decodeBase64Text(userinfo);
    if (decodedUserinfo !== null && decodedUserinfo.includes(':')) userinfo = decodedUserinfo;
    else userinfo = decodeURIComponent(userinfo);
    const colon = userinfo.indexOf(':');
    if (colon === -1) return null;
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
    host = hostport.host;
    port = hostport.port;
  } else {
    const decoded = decodeBase64Text(body);
    if (decoded === null) return null;
    const at = decoded.lastIndexOf('@');
    if (at === -1) return null;
    const credentials = decoded.slice(0, at);
    const hostport = splitHostPort(decoded.slice(at + 1));
    if (hostport === null) return null;
    const colon = credentials.indexOf(':');
    if (colon === -1) return null;
    method = credentials.slice(0, colon);
    password = credentials.slice(colon + 1);
    host = hostport.host;
    port = hostport.port;
  }

  password = decodeURIComponent(password);
  method = decodeURIComponent(method).trim();
  if (method === '' || password === '' || !validPort(port)) return null;

  const node = {
    name: cleanName(name || `ss ${host}:${port}`),
    type: 'ss',
    server: host,
    port,
    cipher: method,
    password,
    udp: true,
  };

  if (query !== '') {
    const plugin = ssPlugin(query);
    if (plugin === null) return null;
    Object.assign(node, plugin);
  }
  return node;
}

function ssPlugin(query) {
  const params = new URLSearchParams(query);
  const plugin = params.get('plugin');
  if (!plugin) return {};
  const parts = plugin.split(';');
  const kind = parts.shift();
  const options = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    options[part.slice(0, index)] = part.slice(index + 1);
  }
  if (kind === 'obfs-local' || kind === 'simple-obfs') {
    return {
      plugin: 'obfs',
      'plugin-opts': {
        mode: options.obfs || 'http',
        host: options['obfs-host'] || '',
      },
    };
  }
  if (kind === 'v2ray-plugin') {
    return {
      plugin: 'v2ray-plugin',
      'plugin-opts': {
        mode: options.mode || 'websocket',
        host: options.host || '',
        path: options.path || '/',
        tls: options.tls === 'true',
      },
    };
  }
  return null;
}

function parseVmess(uri) {
  const payload = decodeBase64Text(uri.slice(8));
  if (payload === null) return null;
  const json = JSON.parse(payload);
  if (json === null || typeof json !== 'object') return null;
  const server = String(json.add || '').trim();
  const port = Number(json.port);
  const uuid = String(json.id || '').trim();
  if (server === '' || uuid === '' || !validPort(port)) return null;

  const node = {
    name: cleanName(json.ps || `vmess ${server}:${port}`),
    type: 'vmess',
    server,
    port,
    uuid,
    alterId: Number(json.aid || 0) || 0,
    cipher: String(json.scy || 'auto') || 'auto',
    udp: true,
  };

  const network = String(json.net || 'tcp');
  node.network = network;
  if (network === 'ws') {
    node['ws-opts'] = {
      path: String(json.path || '/'),
      headers: json.host ? { Host: String(json.host) } : {},
    };
  } else if (network === 'grpc') {
    node['grpc-opts'] = { 'grpc-service-name': String(json.path || '') };
  }

  if (json.tls === 'tls' || json.tls === true) {
    node.tls = true;
    node.servername = String(json.sni || json.host || server);
    if (json.skip_cert_verify === true || json.verify_cert === false) node['skip-cert-verify'] = true;
  }
  return node;
}

function parseTrojan(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, 443);
  const password = decodeURIComponent(url.username);
  if (server === '' || password === '' || !validPort(port)) return null;

  const query = url.searchParams;
  const network = query.get('type') || 'tcp';
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `trojan ${server}:${port}`),
    type: 'trojan',
    server,
    port,
    password,
    udp: true,
    network,
  };
  if (query.get('security') !== 'none') {
    node.tls = true;
    node.sni = query.get('sni') || query.get('peer') || server;
    if (query.get('allowInsecure') === '1' || query.get('insecure') === '1') node['skip-cert-verify'] = true;
  }
  if (network === 'ws') {
    node['ws-opts'] = {
      path: query.get('path') || '/',
      headers: query.get('host') ? { Host: query.get('host') } : {},
    };
  } else if (network === 'grpc') {
    node['grpc-opts'] = { 'grpc-service-name': query.get('serviceName') || '' };
  }
  return node;
}

function parseVless(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, 443);
  const uuid = decodeURIComponent(url.username);
  if (server === '' || uuid === '' || !validPort(port)) return null;

  const query = url.searchParams;
  const security = query.get('security') || 'none';
  const network = query.get('type') || 'tcp';
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `vless ${server}:${port}`),
    type: 'vless',
    server,
    port,
    uuid,
    udp: true,
    network,
  };
  if (query.get('flow')) node.flow = query.get('flow');
  if (security === 'tls' || security === 'reality') {
    node.tls = true;
    node.servername = query.get('sni') || query.get('host') || server;
    if (query.get('fp')) node['client-fingerprint'] = query.get('fp');
    if (query.get('allowInsecure') === '1' || query.get('insecure') === '1') node['skip-cert-verify'] = true;
  }
  if (security === 'reality') {
    const publicKey = query.get('pbk');
    const shortId = query.get('sid');
    if (publicKey) node['reality-opts'] = { 'public-key': publicKey, ...(shortId ? { 'short-id': shortId } : {}) };
  }
  if (network === 'ws') {
    node['ws-opts'] = {
      path: query.get('path') || '/',
      headers: query.get('host') ? { Host: query.get('host') } : {},
    };
  } else if (network === 'grpc') {
    node['grpc-opts'] = { 'grpc-service-name': query.get('serviceName') || '' };
  }
  return node;
}

function parseHysteria2(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, 443);
  const password = decodeURIComponent(url.username) || decodeURIComponent(url.password);
  if (server === '' || password === '' || !validPort(port)) return null;

  const query = url.searchParams;
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `hysteria2 ${server}:${port}`),
    type: 'hysteria2',
    server,
    port,
    password,
    udp: true,
  };
  if (query.get('sni')) node.sni = query.get('sni');
  if (query.get('insecure') === '1' || query.get('allowInsecure') === '1') node['skip-cert-verify'] = true;
  if (query.get('obfs')) {
    node.obfs = query.get('obfs');
    if (query.get('obfs-password')) node['obfs-password'] = query.get('obfs-password');
  }
  if (query.get('up')) node.up = query.get('up');
  if (query.get('down')) node.down = query.get('down');
  return node;
}

function parseTuic(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, 443);
  const uuid = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (server === '' || uuid === '' || password === '' || !validPort(port)) return null;

  const query = url.searchParams;
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `tuic ${server}:${port}`),
    type: 'tuic',
    server,
    port,
    uuid,
    password,
    udp: true,
  };
  if (query.get('sni')) node.sni = query.get('sni');
  if (query.get('alpn')) node.alpn = query.get('alpn').split(',').filter(Boolean);
  if (query.get('congestion_control')) node['congestion-controller'] = query.get('congestion_control');
  if (query.get('udp_relay_mode')) node['udp-relay-mode'] = query.get('udp_relay_mode');
  if (query.get('allowInsecure') === '1' || query.get('insecure') === '1') node['skip-cert-verify'] = true;
  return node;
}

function parseSocks(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, 1080);
  if (server === '' || !validPort(port)) return null;
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `socks5 ${server}:${port}`),
    type: 'socks5',
    server,
    port,
    udp: true,
  };
  if (url.username) node.username = decodeURIComponent(url.username);
  if (url.password) node.password = decodeURIComponent(url.password);
  if (url.protocol === 'socks5h:') node['remote-dns-resolve'] = true;
  return node;
}

function parseHttpProxy(uri) {
  const url = new URL(uri);
  const server = hostOf(url);
  const port = portOf(url, url.protocol === 'https:' ? 443 : 80);
  if (server === '' || !validPort(port)) return null;
  const node = {
    name: cleanName(decodeFragment(url.hash.slice(1)) || `${url.protocol.slice(0, -1)} ${server}:${port}`),
    type: 'http',
    server,
    port,
  };
  if (url.username) node.username = decodeURIComponent(url.username);
  if (url.password) node.password = decodeURIComponent(url.password);
  if (url.protocol === 'https:') node.tls = true;
  return node;
}

function finish(nodes, format, warnings, hosts = {}) {
  const normalized = [];
  const used = new Set();
  for (const node of nodes) {
    if (normalized.length >= MAX_NODES) {
      warnings.push(`节点数量超过 ${MAX_NODES}，仅保留前 ${MAX_NODES} 个`);
      break;
    }
    const base = cleanName(node.name) || `${node.type} ${node.server}:${node.port}`;
    let name = base;
    let index = 2;
    while (used.has(name)) name = `${base} (${index++})`;
    used.add(name);
    normalized.push({ ...node, name });
  }
  return { nodes: normalized, format, warnings, hosts };
}

function decodeBase64Text(input) {
  let value = input.trim();
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma === -1) return null;
    value = value.slice(comma + 1);
  }
  value = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  while (value.length % 4 !== 0) value += '=';
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function splitHostPort(value) {
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return null;
    const host = value.slice(1, close);
    const rest = value.slice(close + 1);
    if (!rest.startsWith(':')) return null;
    return { host, port: Number(rest.slice(1)) };
  }
  const colon = value.lastIndexOf(':');
  if (colon === -1) return null;
  return { host: value.slice(0, colon), port: Number(value.slice(colon + 1)) };
}

function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

function portOf(url, fallback) {
  return url.port === '' ? fallback : Number(url.port);
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 80);
}

function decodeFragment(value) {
  if (value === '') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
