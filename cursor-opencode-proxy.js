'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STRATEGIES = ['auto', 'per-request', 'static'];
const PROBE_HEADERS = ['x-session-id', 'x-client-session-id', 'x-request-id'];
const HOP_BY_HOP = ['host', 'connection', 'keep-alive', 'expect', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']; // expect: Node 上游请求不会自动发 100 Continue,透传会令上游挂起

function loadConfig(file, env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`config: cannot read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config: invalid JSON in ${file}: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`config: root of ${file} must be a JSON object`);
  const cfg = {
    port: 8787,
    baseUrl: '',
    apiKey: '',
    session: { strategy: 'auto', header: 'x-opencode-session', staticId: '00000000-0000-4000-8000-000000000000', ttlMs: 7200000 },
    log: { headers: true, body: false },
  };
  const missing = [];
  if (typeof parsed.baseUrl === 'string' && parsed.baseUrl) cfg.baseUrl = parsed.baseUrl.replace(/\/+$/, '');
  else missing.push('baseUrl');
  if (typeof parsed.apiKey === 'string' && parsed.apiKey) cfg.apiKey = parsed.apiKey;
  else missing.push('apiKey');
  if (missing.length) throw new Error(`config: missing: ${missing.join(', ')}`);
  if (Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) cfg.port = parsed.port;
  if (typeof env.COP_PORT === 'string' && /^\d+$/.test(env.COP_PORT) && +env.COP_PORT > 0 && +env.COP_PORT < 65536) cfg.port = +env.COP_PORT;
  if (typeof env.COP_BASE_URL === 'string' && env.COP_BASE_URL) cfg.baseUrl = env.COP_BASE_URL.replace(/\/+$/, '');
  if (typeof env.COP_API_KEY === 'string' && env.COP_API_KEY) cfg.apiKey = env.COP_API_KEY;
  // baseUrl 双入口(文件/环境变量)的最终值统一校验:非法或协议不在 http(s) 白名单,启动即拒绝。
  let baseUrlValid = true;
  try {
    const u = new URL(cfg.baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') baseUrlValid = false;
  } catch { baseUrlValid = false; }
  if (!baseUrlValid) throw new Error(`config: invalid baseUrl: ${JSON.stringify(cfg.baseUrl)} (must be an absolute http/https URL)`);
  if (parsed.session && typeof parsed.session === 'object') {
    if (typeof parsed.session.header === 'string' && parsed.session.header) cfg.session.header = parsed.session.header;
    if (!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(cfg.session.header)) {
      throw new Error(`config: invalid session.header: ${JSON.stringify(cfg.session.header)} (must be an HTTP field-name token)`);
    }
    if (typeof parsed.session.staticId === 'string' && parsed.session.staticId) cfg.session.staticId = parsed.session.staticId;
    if (!cfg.session.staticId || !cfg.session.staticId.trim()) {
      throw new Error(`config: invalid session.staticId: ${JSON.stringify(cfg.session.staticId)} (must be non-empty)`);
    }
    if (Number.isInteger(parsed.session.ttlMs) && parsed.session.ttlMs > 0) cfg.session.ttlMs = parsed.session.ttlMs;
    if (STRATEGIES.includes(parsed.session.strategy)) cfg.session.strategy = parsed.session.strategy;
    else throw new Error(`config: invalid session.strategy: ${JSON.stringify(parsed.session.strategy)} (allowed: ${STRATEGIES.join(', ')})`);
  }
  if (parsed.log && typeof parsed.log === 'object') {
    if (typeof parsed.log.headers === 'boolean') cfg.log.headers = parsed.log.headers;
    if (typeof parsed.log.body === 'boolean') cfg.log.body = parsed.log.body;
  }
  return cfg;
}

function buildUpstreamPath(baseUrl, reqPath) {
  let base;
  try {
    base = new URL(baseUrl).pathname.replace(/\/+$/, '');
  } catch (e) {
    throw new Error(`upstream path: invalid baseUrl: ${JSON.stringify(baseUrl)}: ${e.message}`);
  }
  if (reqPath === '/v1' || reqPath.startsWith('/v1/')) {
    return base + reqPath.slice('/v1'.length); // '/v1/chat' → base + '/chat'
  }
  return base + reqPath;
}

function filterHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  }
  return out;
}

function createSessionManager(sessionCfg) {
  return { cfg: sessionCfg, entries: new Map() };
}

function resolveSession(mgr, reqHeaders) {
  if (mgr.cfg.strategy === 'static') return mgr.cfg.staticId;
  if (mgr.cfg.strategy === 'per-request') return randomUUID();
  const now = Date.now();
  // 同一请求探测到的所有会话头共享同一 uuid:按 PROBE_HEADERS 顺序取首个有效 TTL 命中;否则生成新 uuid 并绑定到全部出现的头。
  let uuid = null;
  const seen = [];
  for (const h of PROBE_HEADERS) {
    const v = reqHeaders[h];
    if (typeof v !== 'string' || !v) continue;
    seen.push(v);
    if (uuid !== null) continue;
    const hit = mgr.entries.get(v);
    if (hit && now - hit.createdAt < mgr.cfg.ttlMs) uuid = hit.uuid;
  }
  if (uuid === null) uuid = randomUUID();
  for (const v of seen) mgr.entries.set(v, { uuid, createdAt: now });
  return uuid;
}

const MAX_BODY = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60000;
const SESSION_HINT_STATUS = new Set([400, 401, 403]); // 上游 session routing 拒绝的典型状态码(规格 5.4)

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = /^authorization$/i.test(k) ? 'Bearer ***' : v; // 日志不回显 apiKey
  }
  return out;
}

function logRequest(cfg, req, sessionId) {
  const probed = PROBE_HEADERS
    .map((h) => (req.headers[h] ? `${h}=${String(req.headers[h]).slice(0, 12)}…` : null))
    .filter(Boolean);
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} [${probed.join(' ') || 'no-session-header'}] -> ${cfg.session.header}=${sessionId}`);
  if (cfg.log.headers) console.log('  headers:', JSON.stringify(redactHeaders(req.headers)));
}

function sendOpenAIError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { message, type: 'proxy_error', code: status } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function createHotReloader(cfg) {
  return { config: cfg, sessionMgr: createSessionManager(cfg.session) };
}

function proxyRequest(req, res, hot) {
  const cfg = hot.config;
  const chunks = [];
  let size = 0;
  let rejected = false;
  req.on('data', (c) => {
    if (rejected) return;
    size += c.length;
    if (size > MAX_BODY) {
      rejected = true;
      sendOpenAIError(res, 413, 'request body too large (proxy limit 10MB)');
      req.pause(); // 停止缓冲剩余 body,让客户端先读完 413 错误体,避免立即 destroy 造成 RST
      res.on('close', () => req.destroy()); // 响应结束后统一中止请求流
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
    try {
      const sessionId = resolveSession(hot.sessionMgr, req.headers);
      logRequest(cfg, req, sessionId);
      if (cfg.log.body) console.log('  body[0:2048]:', body.toString('utf8', 0, 2048));
      const headers = filterHeaders(req.headers);
      delete headers['content-length']; // Node 按实际转发字节自动设置
      delete headers['host'];           // Node 按 baseUrl 自动设置上游 host
      headers['authorization'] = `Bearer ${cfg.apiKey}`;
      headers[cfg.session.header] = sessionId;
      const mod = cfg.baseUrl.startsWith('https:') ? https : http;
      const upReq = mod.request(cfg.baseUrl, {
        method: req.method,
        path: buildUpstreamPath(cfg.baseUrl, req.url),
        headers,
        timeout: UPSTREAM_TIMEOUT_MS,
      }, (upRes) => {
        res.writeHead(upRes.statusCode, filterHeaders(upRes.headers));
        upRes.pipe(res); // 纯透传:不缓冲、不解析、不重组
        upRes.on('error', () => res.destroy());
        if (SESSION_HINT_STATUS.has(upRes.statusCode)) {
          console.warn(`[hint] upstream ${upRes.statusCode}: check ${cfg.session.header} injection / upstream session routing (spec 5.4)`);
        }
      });
      upReq.on('timeout', () => {
        sendOpenAIError(res, 504, `upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
        upReq.destroy();
      });
      upReq.on('error', (e) => {
        if (!res.headersSent) sendOpenAIError(res, 502, `upstream request failed: ${e.message}`);
        else res.destroy();
      });
      res.on('close', () => {
        if (!res.writableEnded) upReq.destroy(); // 客户端断连 → 中止上游
      });
      if (body.length) upReq.write(body);
      upReq.end();
    } catch (e) {
      // 同步段兜底(如非法 baseUrl):不让异常逸出崩溃进程,统一转 502 OpenAI 错误格式。
      sendOpenAIError(res, 502, `upstream request failed: ${e.message}`);
    }
  });
}

function createServer(hot) {
  return http.createServer((rq, rs) => proxyRequest(rq, rs, hot));
}

module.exports = {
  loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession,
  createHotReloader, proxyRequest, createServer,
};
