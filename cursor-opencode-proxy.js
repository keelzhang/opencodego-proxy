'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { randomUUID } = crypto;

const STRATEGIES = ['auto', 'per-request', 'static'];
const PROBE_HEADERS = ['x-session-id', 'x-client-session-id', 'x-request-id'];
// 设备级兜底头:仅当上面一个会话头都没出现时才参与。
// 起因:Cursor 官方确认(forum.cursor.com topic 166994, CursorStaff 回复)发往自定义 OpenAI 兼容 base URL 的请求
// 不带任何 conversation/agent 身份头,故 auto 策略原本每次请求都新 UUID。
// cf-warp-tag-id 由 Cloudflare 注入,是跨请求稳定的设备标识(同一设备的所有对话会共用同一 session,属过渡妥协)。
const DEVICE_PROBE_HEADERS = ['cf-warp-tag-id'];
const HOP_BY_HOP = ['host', 'connection', 'keep-alive', 'expect', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']; // expect: Node 上游请求不会自动发 100 Continue,透传会令上游挂起
const HEADER_TOKEN_RE = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/; // RFC 7230 field-name token

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
    auth: { enabled: false, header: 'authorization', token: '' },
    tunnel: { enabled: false, binary: 'cloudflared', name: 'cursor-proxy', configFile: '', restartDelayMs: 5000 },
    session: { strategy: 'auto', header: 'x-opencode-session', staticId: '00000000-0000-4000-8000-000000000000', ttlMs: 7200000 },
    reasoning: { replay: true, fallbackDisabled: true, cacheTtlMs: 7200000, maxEntries: 2000 },
    log: { headers: true, body: false, tunnel: false, upstreamErrors: true },
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
    if (!HEADER_TOKEN_RE.test(cfg.session.header)) {
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
  if (parsed.auth && typeof parsed.auth === 'object') {
    if (typeof parsed.auth.enabled === 'boolean') cfg.auth.enabled = parsed.auth.enabled;
    if (typeof parsed.auth.header === 'string' && parsed.auth.header) cfg.auth.header = parsed.auth.header;
    if (!HEADER_TOKEN_RE.test(cfg.auth.header)) {
      throw new Error(`config: invalid auth.header: ${JSON.stringify(cfg.auth.header)} (must be an HTTP field-name token)`);
    }
    if (typeof parsed.auth.token === 'string') cfg.auth.token = parsed.auth.token;
  }
  if (typeof env.COP_AUTH_TOKEN === 'string' && env.COP_AUTH_TOKEN) cfg.auth.token = env.COP_AUTH_TOKEN;
  // 开鉴权却空令牌 = 以为受保护实则全开放,启动即拒绝
  if (cfg.auth.enabled && !cfg.auth.token.trim()) {
    throw new Error('config: auth.enabled is true but auth.token is empty (set auth.token in config.json or COP_AUTH_TOKEN env)');
  }
  // session.header 不能与 auth.header 同名:proxyRequest 会无条件写入 headers['authorization']=上游 apiKey,
  // 若随后 headers[session.header]=sessionId 与之同名则覆盖上游鉴权头,导致上游 401。无论鉴权是否开启都必须拦截。
  if (cfg.session.header.toLowerCase() === cfg.auth.header.toLowerCase()) {
    throw new Error(`config: auth.header and session.header must differ, both are ${JSON.stringify(cfg.auth.header)}`);
  }
  if (parsed.tunnel && typeof parsed.tunnel === 'object') {
    if (typeof parsed.tunnel.enabled === 'boolean') cfg.tunnel.enabled = parsed.tunnel.enabled;
    if (typeof parsed.tunnel.binary === 'string' && parsed.tunnel.binary) cfg.tunnel.binary = parsed.tunnel.binary;
    if (typeof parsed.tunnel.name === 'string') cfg.tunnel.name = parsed.tunnel.name;
    if (typeof parsed.tunnel.configFile === 'string') cfg.tunnel.configFile = parsed.tunnel.configFile;
    if (Number.isInteger(parsed.tunnel.restartDelayMs) && parsed.tunnel.restartDelayMs > 0) cfg.tunnel.restartDelayMs = parsed.tunnel.restartDelayMs;
  }
  if (cfg.tunnel.enabled && !cfg.tunnel.name.trim()) {
    throw new Error(`config: invalid tunnel.name: ${JSON.stringify(cfg.tunnel.name)} (must be non-empty)`);
  }
  if (parsed.reasoning && typeof parsed.reasoning === 'object') {
    if (typeof parsed.reasoning.replay === 'boolean') cfg.reasoning.replay = parsed.reasoning.replay;
    if (typeof parsed.reasoning.fallbackDisabled === 'boolean') cfg.reasoning.fallbackDisabled = parsed.reasoning.fallbackDisabled;
    if (Number.isInteger(parsed.reasoning.cacheTtlMs) && parsed.reasoning.cacheTtlMs > 0) cfg.reasoning.cacheTtlMs = parsed.reasoning.cacheTtlMs;
    if (Number.isInteger(parsed.reasoning.maxEntries) && parsed.reasoning.maxEntries > 0) cfg.reasoning.maxEntries = parsed.reasoning.maxEntries;
  }
  if (parsed.log && typeof parsed.log === 'object') {
    if (typeof parsed.log.headers === 'boolean') cfg.log.headers = parsed.log.headers;
    if (typeof parsed.log.body === 'boolean') cfg.log.body = parsed.log.body;
    if (typeof parsed.log.tunnel === 'boolean') cfg.log.tunnel = parsed.log.tunnel;
    if (typeof parsed.log.upstreamErrors === 'boolean') cfg.log.upstreamErrors = parsed.log.upstreamErrors;
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

// 常量时间令牌比对:先 sha256 归一化为等长摘要,再 timingSafeEqual,避免长度与时序泄露
function checkAuth(authCfg, headers) {
  if (!authCfg || !authCfg.enabled) return true;
  if (typeof authCfg.token !== 'string' || !authCfg.token) return false;
  const key = String(authCfg.header || 'authorization').toLowerCase();
  const raw = headers[key];
  if (typeof raw !== 'string' || !raw) return false;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  if (!m) return false;
  const given = m[1].trim();
  if (!given) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(authCfg.token), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// cloudflared 参数拼装:独立成纯函数便于单测
function buildTunnelArgs(tunnelCfg) {
  const args = ['tunnel'];
  if (tunnelCfg.configFile && String(tunnelCfg.configFile).trim()) args.push('--config', tunnelCfg.configFile);
  args.push('run', tunnelCfg.name);
  return args;
}

// ---- 从 cloudflared config.yml 推导 Cursor 应填的公网 Base URL ----
// 起因:Cursor 不能填 127.0.0.1(其服务端代发 BYOK 请求,SSRF 防护拒绝私有网段),
// 而代理只监听 127.0.0.1,唯一的公网地址就是隧道 ingress 的 hostname,故直接从中读取,免得再抄一遍。
// 只做够用的手写扫描(零依赖):识别 block style 的 ingress 列表项,取 hostname 与 service。
// 不支持 flow style(`- {hostname: x}`)、锚点/别名与多行标量——cloudflared tunnel create 生成的是 block style。

// 去掉 YAML 标量的包裹引号与行内注释;不抛异常(解析失败只影响一句启动提示)
function stripYamlScalar(raw) {
  let v = String(raw == null ? '' : raw).trim();
  if (!v) return '';
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) : v.slice(1); // 未闭合引号:尽力而为
  }
  const hash = v.indexOf('#'); // YAML 要求 # 前有空白才算注释,这里放宽为见到即截断
  if (hash >= 0) v = v.slice(0, hash);
  return v.trim();
}

// 返回 [{ hostname, service }]:只保留带 hostname 的项(ingress 末尾的 catch-all 天然被过滤掉)
function parseTunnelHostnames(yamlText) {
  const entries = [];
  let inIngress = false;
  let ingressIndent = 0;
  let current = null;
  for (const rawLine of String(yamlText == null ? '' : yamlText).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (!inIngress) {
      if (indent === 0 && /^ingress\s*:/.test(trimmed)) { inIngress = true; ingressIndent = indent; }
      continue;
    }
    if (indent <= ingressIndent) break; // 缩进回到顶层,ingress 块结束
    const isItem = trimmed === '-' || trimmed.startsWith('- ');
    const kv = /^-?\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (isItem) { current = {}; entries.push(current); }
    if (!kv || !current) continue; // 结构意外的行:跳过而非猜测归属
    if (kv[1] === 'hostname') current.hostname = stripYamlScalar(kv[2]);
    else if (kv[1] === 'service') current.service = stripYamlScalar(kv[2]);
  }
  return entries.filter((e) => e.hostname);
}

// 多条 ingress 时优先选 service 指向本代理端口的那个 hostname,否则回退首个
function pickPublicHost(entries, port) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const re = new RegExp(`:${port}/?$`);
  const match = entries.find((e) => typeof e.service === 'string' && re.test(e.service.trim()));
  return (match || entries[0]).hostname || null;
}

// 启动日志用。任何失败都返回 error 而不抛:推导不出来只影响提示文案,不该拦下代理启动。
function derivePublicBaseUrl(tunnelCfg, port, readFileFn) {
  const read = readFileFn || ((p) => fs.readFileSync(p, 'utf8'));
  const cf = tunnelCfg && tunnelCfg.configFile ? String(tunnelCfg.configFile).trim() : '';
  if (!cf) return { url: null, hostname: null, error: 'tunnel.configFile not set' };
  let text;
  try {
    text = read(cf);
  } catch (e) {
    return { url: null, hostname: null, error: `cannot read ${cf}: ${e.message}` };
  }
  const hostname = pickPublicHost(parseTunnelHostnames(text), port);
  if (!hostname) return { url: null, hostname: null, error: `no ingress hostname found in ${cf}` };
  return { url: `https://${hostname}/v1`, hostname, error: null };
}

// Cursor 接入所需的启动提示(纯函数,便于单测):公网 Base URL + 该填的访问令牌。
// 刻意只打印 auth.token(Cursor 连本代理用的那把),绝不打印 cfg.apiKey(本代理连上游用的那把)——
// 后者不该出现在任何日志里,打印前者则是为了免去手工翻 config.json。
function formatCursorSetup(cfg, publicBase) {
  const lines = [];
  if (publicBase && publicBase.url) {
    lines.push(`Cursor Base URL: ${publicBase.url}  (ingress hostname "${publicBase.hostname}" from ${cfg.tunnel.configFile})`);
  } else {
    const why = (publicBase && publicBase.error) || 'unknown reason';
    lines.push(`Cursor Base URL: unknown (${why}) -- use the tunnel's public HTTPS address + /v1; 127.0.0.1 is rejected by Cursor, see README 公网接入`);
  }
  lines.push(cfg.auth && cfg.auth.enabled
    ? `Cursor API Key:  ${cfg.auth.token}  (auth.token, not the upstream apiKey)`
    : 'Cursor API Key:  any non-empty value (auth disabled; set auth.enabled=true + auth.token to require one)');
  return lines;
}

// 隧道子进程管理:崩溃按延迟重启;不可恢复的 spawn 失败(ENOENT/EACCES/EPERM,重启无意义)只报错不重启;
// 任何失败都不影响代理自身对外服务。
// 监听 'close' 而非 'exit':实测——子进程正常退出触发 'exit'+'close',
// 而 spawn 失败(ENOENT)只触发 'error'+'close'(无 'exit')。用 'close' 可统一覆盖两种情况,
// 并保证 state.child 在任何路径下都被清理。
function startTunnel(cfg, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  const tunnelCfg = cfg.tunnel;
  const state = { child: null, stopped: false, restarts: 0, timer: null };

  function launch() {
    if (state.stopped) return;
    let child;
    let spawnFailed = false;
    try {
      child = spawn(tunnelCfg.binary, buildTunnelArgs(tunnelCfg), {
        stdio: cfg.log && cfg.log.tunnel ? 'inherit' : 'ignore',
      });
    } catch (e) {
      console.error(`[tunnel] failed to spawn "${tunnelCfg.binary}": ${e.message} -- proxy keeps serving without tunnel`);
      return;
    }
    state.child = child;
    child.on('error', (e) => {
      if (e && ['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) spawnFailed = true;
      console.error(`[tunnel] cannot start "${tunnelCfg.binary}" (${e.code || 'error'}): ${e.message} -- check tunnel.binary / install cloudflared; proxy keeps serving`);
    });
    child.on('close', (code, signal) => {
      if (state.child === child) state.child = null;
      if (state.stopped || spawnFailed) return;
      state.restarts += 1;
      console.warn(`[tunnel] cloudflared exited (code=${code} signal=${signal}); restart #${state.restarts} in ${tunnelCfg.restartDelayMs}ms`);
      state.timer = setTimeout(launch, tunnelCfg.restartDelayMs);
      if (state.timer.unref) state.timer.unref();
    });
  }

  function stop() {
    state.stopped = true;
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    const c = state.child;
    state.child = null;
    if (c) { try { c.kill(); } catch { /* 已退出 */ } }
  }

  launch();
  return { stop, state };
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
  const collect = (names) => {
    for (const h of names) {
      const v = reqHeaders[h];
      if (typeof v !== 'string' || !v) continue;
      seen.push(v);
      if (uuid !== null) continue;
      const hit = mgr.entries.get(v);
      if (hit && now - hit.createdAt < mgr.cfg.ttlMs) uuid = hit.uuid;
    }
  };
  collect(PROBE_HEADERS);
  // 设备级兜底头只在完全没有会话头时才参与:它总是命中,若与真实会话头同场会让后者失去区分度。
  if (seen.length === 0) collect(DEVICE_PROBE_HEADERS);
  if (uuid === null) uuid = randomUUID();
  for (const v of seen) mgr.entries.set(v, { uuid, createdAt: now });
  return uuid;
}

const MAX_BODY = 10 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 60000;
const SESSION_HINT_STATUS = new Set([400, 401, 403]); // 上游 session routing 拒绝的典型状态码(规格 5.4)

function redactHeaders(headers, authHeader) {
  const out = {};
  const secret = String(authHeader || 'authorization').toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    const isSecret = /^authorization$/i.test(k) || k.toLowerCase() === secret;
    out[k] = isSecret ? 'Bearer ***' : v; // 日志不回显访问令牌/apiKey
  }
  return out;
}

function logRequest(cfg, req, sessionId) {
  const probed = [...PROBE_HEADERS, ...DEVICE_PROBE_HEADERS]
    .map((h) => {
      const v = req.headers[h];
      if (!v) return null;
      return `${DEVICE_PROBE_HEADERS.includes(h) ? `${h}(device)` : h}=${String(v).slice(0, 12)}…`;
    })
    .filter(Boolean);
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} [${probed.join(' ') || 'no-session-header'}] -> ${cfg.session.header}=${sessionId}`);
  if (cfg.log.headers) console.log('  headers:', JSON.stringify(redactHeaders(req.headers, cfg.auth?.header)));
}

function sendOpenAIError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: { message, type: 'proxy_error', code: status } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ---- reasoning_content 回放(A)与降级(B) ----
// 背景:DeepSeek thinking mode 下,凡请求带 tools,历史 assistant 消息必须回传 reasoning_content,否则上游 400。
// Cursor 走 OpenAI 标准协议,不保留该非标准字段,故长会话必然撞上(见 README)。
// A:透传响应时旁路提取 reasoning_content,按 assistant 消息指纹缓存;下次请求回填。
// B:若仍 400 且错误体提及 reasoning_content,注入 thinking.type=disabled 重发一次。

function createReasoningCache() {
  return { entries: new Map() }; // fingerprint -> { reasoning_content, createdAt }
}

// assistant 消息指纹:不含 tool_call id 与首尾空白,容忍客户端对消息的轻微规范化
function messageFingerprint(msg) {
  if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') return null;
  const content = typeof msg.content === 'string' ? msg.content.trim() : '';
  const calls = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((c) => {
      const fn = c && c.function ? c.function : {};
      return `${fn.name == null ? '' : fn.name}(${fn.arguments == null ? '' : String(fn.arguments)})`;
    })
    : [];
  if (!content && !calls.length) return null; // 空 assistant 消息无法可靠关联
  return crypto.createHash('sha256').update(JSON.stringify([content, calls]), 'utf8').digest('hex').slice(0, 32);
}

// 非流式响应体 -> assistant 消息
function extractAssistantFromJson(text) {
  try {
    const j = JSON.parse(text);
    const msg = j && Array.isArray(j.choices) && j.choices[0] ? j.choices[0].message : null;
    return msg && typeof msg === 'object' ? msg : null;
  } catch { return null; }
}

// 流式 SSE -> 累积 delta 重组 assistant 消息(含 reasoning_content 与 tool_calls)
function extractAssistantFromSse(text) {
  const out = { role: 'assistant', content: '' };
  const calls = new Map();
  let sawData = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    const delta = j && Array.isArray(j.choices) && j.choices[0] ? j.choices[0].delta : null;
    if (!delta) continue;
    sawData = true;
    if (typeof delta.content === 'string') out.content += delta.content;
    if (typeof delta.reasoning_content === 'string') out.reasoning_content = (out.reasoning_content || '') + delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc && Number.isInteger(tc.index) ? tc.index : 0;
        const cur = calls.get(idx) || { name: '', arguments: '' };
        if (tc && tc.function) {
          if (typeof tc.function.name === 'string') cur.name += tc.function.name;
          if (typeof tc.function.arguments === 'string') cur.arguments += tc.function.arguments;
        }
        calls.set(idx, cur);
      }
    }
  }
  if (!sawData) return null;
  if (calls.size) out.tool_calls = [...calls.keys()].sort((a, b) => a - b).map((k) => ({ type: 'function', function: calls.get(k) }));
  return out;
}

function extractAssistant(text) {
  return extractAssistantFromJson(text) || extractAssistantFromSse(text);
}

// 缓存上游 assistant 消息的 reasoning_content
function rememberReasoning(cache, msg, rcfg) {
  const fp = messageFingerprint(msg);
  if (!fp || !msg || typeof msg.reasoning_content !== 'string' || !msg.reasoning_content) return false;
  cache.entries.set(fp, { reasoning_content: msg.reasoning_content, createdAt: Date.now() });
  if (cache.entries.size > rcfg.maxEntries) { // 容量上限:淘汰最旧
    let oldestKey = null;
    let oldest = Infinity;
    for (const [k, v] of cache.entries) if (v.createdAt < oldest) { oldest = v.createdAt; oldestKey = k; }
    if (oldestKey !== null) cache.entries.delete(oldestKey);
  }
  return true;
}

function recallReasoning(cache, fp, rcfg) {
  const hit = cache.entries.get(fp);
  if (!hit) return null;
  if (Date.now() - hit.createdAt >= rcfg.cacheTtlMs) { cache.entries.delete(fp); return null; }
  return hit.reasoning_content;
}

// A:回填。返回 { body, filled, missing };非 JSON / 非 chat 体 / 无可回填时 body 原样返回。
function replayReasoning(buf, cache, rcfg) {
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { return { body: buf, filled: 0, missing: 0 }; }
  if (!parsed || !Array.isArray(parsed.messages)) return { body: buf, filled: 0, missing: 0 };
  // 仅请求带 tools 时才需要回传(官方:不带 tools 时 reasoning_content 被忽略但仍计费)
  if (!Array.isArray(parsed.tools) || !parsed.tools.length) return { body: buf, filled: 0, missing: 0 };
  let filled = 0;
  let missing = 0;
  for (const m of parsed.messages) {
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) continue;
    const fp = messageFingerprint(m);
    if (!fp) continue;
    const rc = recallReasoning(cache, fp, rcfg);
    if (rc) { m.reasoning_content = rc; filled += 1; }
    else if (Array.isArray(m.tool_calls) && m.tool_calls.length) missing += 1;
  }
  if (!filled) return { body: buf, filled: 0, missing };
  return { body: Buffer.from(JSON.stringify(parsed), 'utf8'), filled, missing };
}

// B:注入 thinking disabled(不可解析时返回 null,调用方退回原样透传)
function injectThinkingDisabled(buf) {
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  parsed.thinking = { type: 'disabled' };
  return Buffer.from(JSON.stringify(parsed), 'utf8');
}

function looksLikeReasoningError(text) {
  return typeof text === 'string' && /reasoning_content/i.test(text);
}

function createHotReloader(cfg) {
  // 兜底:测试与外部调用可能直接构造 cfg(不经 loadConfig)。缺省视为关闭两项新能力,保持"纯透传"语义。
  if (!cfg.reasoning) cfg.reasoning = { replay: false, fallbackDisabled: false, cacheTtlMs: 7200000, maxEntries: 2000 };
  return { config: cfg, sessionMgr: createSessionManager(cfg.session), reasoningCache: createReasoningCache() };
}

function proxyRequest(req, res, hot) {
  const cfg = hot.config;
  // 鉴权在 body 缓冲之前:未通过不读取 body、不转发上游
  if (!checkAuth(cfg.auth, req.headers)) {
    console.warn(`${new Date().toISOString()} ${req.method} ${req.url} 401 unauthorized (missing or invalid access token)`);
    sendOpenAIError(res, 401, 'unauthorized: missing or invalid access token');
    req.resume(); // 排空请求体,避免客户端仍在上传时连接悬挂
    return;
  }
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
      // 客户端访问令牌仅用于本地鉴权:先剔除客户端鉴权头(其恰为 authorization 时也被下面覆盖),再写入上游 apiKey,确保访问令牌不外流上游
      delete headers[String(cfg.auth?.header || 'authorization').toLowerCase()];
      headers['authorization'] = `Bearer ${cfg.apiKey}`;
      headers[cfg.session.header] = sessionId;
      const mod = cfg.baseUrl.startsWith('https:') ? https : http;
      const MAX_CAPTURE = 2 * 1024 * 1024; // 响应旁路采集上限:只用于提取 reasoning_content 与错误诊断,不参与透传
      const LOG_ERROR_BODY = 1000; // 上游错误体在日志中的截断长度
      let currentUpReq = null;
      // 发送上行请求。allowFallback=true 时,遇 400 且错误体提及 reasoning_content 会注入 thinking=disabled 重发一次。
      const sendUpstream = (sendBody, allowFallback) => {
        const upReq = mod.request(cfg.baseUrl, {
          method: req.method,
          path: buildUpstreamPath(cfg.baseUrl, req.url),
          headers,
          timeout: UPSTREAM_TIMEOUT_MS,
        }, (upRes) => {
          const status = upRes.statusCode;
          console.log(`${new Date().toISOString()} ${req.method} ${req.url} upstream=${status}`); // 规格 5.5:每请求一行上游状态
          // A:旁路采集成功响应,提取 reasoning_content 以备下轮回填。不阻断 pipe,采集失败只影响回放。
          if (status === 200 && cfg.reasoning.replay && req.method === 'POST') {
            const cap = [];
            let capSize = 0;
            upRes.on('data', (c) => { if (capSize < MAX_CAPTURE) { cap.push(c); capSize += c.length; } });
            upRes.on('end', () => {
              try {
                const msg = extractAssistant(Buffer.concat(cap).toString('utf8'));
                if (msg && rememberReasoning(hot.reasoningCache, msg, cfg.reasoning)) {
                  console.log(`[reasoning] cached ${msg.reasoning_content.length} chars for replay`);
                }
              } catch { /* 采集失败不得影响透传 */ }
            });
          }
          // 上游错误:先采集并打印错误体。此前 401 的根因之所以无法确诊,就是因为错误体被直接透传、代理未留痕。
          // 其中 400 且提及 reasoning_content 时降级重发(B)。
          if (status >= 400) {
            const errChunks = [];
            let errSize = 0;
            upRes.on('data', (c) => { if (errSize < MAX_CAPTURE) { errChunks.push(c); errSize += c.length; } });
            upRes.on('end', () => {
              const errText = Buffer.concat(errChunks).toString('utf8');
              if (cfg.log?.upstreamErrors !== false && errText) {
                console.warn(`[upstream] ${status} body: ${errText.slice(0, LOG_ERROR_BODY)}`);
              }
              if (allowFallback && status === 400 && cfg.reasoning.fallbackDisabled && looksLikeReasoningError(errText)) {
                const fallback = injectThinkingDisabled(sendBody);
                if (fallback) {
                  console.warn('[reasoning] upstream 400 mentions reasoning_content; retrying once with thinking=disabled (thinking lost for this turn)');
                  sendUpstream(fallback, false);
                  return;
                }
              }
              // 原样交回客户端(错误体小,已完整采集;content-length 交 Node 重算)
              if (res.headersSent) { res.destroy(); return; }
              const outHeaders = filterHeaders(upRes.headers);
              delete outHeaders['content-length'];
              res.writeHead(status, outHeaders);
              res.end(errText);
            });
            upRes.on('error', () => { if (!res.headersSent) sendOpenAIError(res, 502, 'upstream response stream error'); });
            return;
          }
          res.writeHead(status, filterHeaders(upRes.headers));
          upRes.pipe(res); // 纯透传:不缓冲、不解析、不重组
          upRes.on('error', () => res.destroy());
          if (SESSION_HINT_STATUS.has(status)) {
            console.warn(`[hint] upstream ${status}: check ${cfg.session.header} injection / upstream session routing (spec 5.4)`);
          }
        });
        currentUpReq = upReq;
        upReq.on('timeout', () => {
          sendOpenAIError(res, 504, `upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms`);
          upReq.destroy();
        });
        upReq.on('error', (e) => {
          if (!res.headersSent) sendOpenAIError(res, 502, `upstream request failed: ${e.message}`);
          else res.destroy();
        });
        if (sendBody.length) upReq.write(sendBody);
        upReq.end();
      };
      res.on('close', () => {
        if (!res.writableEnded && currentUpReq) currentUpReq.destroy(); // 客户端断连 → 中止上游
      });
      // A:转发前回填 reasoning_content(仅请求带 tools 时才有意义;解析失败则原样透传)
      let outBody = body;
      if (cfg.reasoning.replay && body.length) {
        const r = replayReasoning(body, hot.reasoningCache, cfg.reasoning);
        outBody = r.body;
        if (r.filled) console.log(`[reasoning] replayed reasoning_content into ${r.filled} assistant message(s)`);
        if (r.missing) console.warn(`[reasoning] ${r.missing} assistant message(s) with tool_calls lack cached reasoning_content; upstream may reject (see README 已知限制)`);
      }
      sendUpstream(outBody, true);
    } catch (e) {
      // 同步段兜底(如非法 baseUrl):不让异常逸出崩溃进程,统一转 502 OpenAI 错误格式。
      sendOpenAIError(res, 502, `upstream request failed: ${e.message}`);
    }
  });
}

function createServer(hot) {
  return http.createServer((rq, rs) => proxyRequest(rq, rs, hot));
}

const CONFIG_DEBOUNCE_MS = 300;
const SESSION_GC_INTERVAL_MS = 3600000;

function applyHotConfig(hot, file) {
  try {
    const next = loadConfig(file, process.env);
    hot.config = next;
    hot.sessionMgr.cfg = next.session; // session 策略/头名/TTL 热更新,映射保留
    return { ok: true, config: next };
  } catch (e) {
    console.warn(`[hot-reload] keep old config: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function cleanupSessionMap(mgr) {
  const now = Date.now();
  let removed = 0;
  for (const [k, v] of mgr.entries) {
    if (now - v.createdAt >= mgr.cfg.ttlMs) { mgr.entries.delete(k); removed++; }
  }
  return removed;
}

function watchConfig(file, onChange) {
  let timer = null;
  const watcher = fs.watch(file, () => {
    clearTimeout(timer);
    timer = setTimeout(() => onChange(file), CONFIG_DEBOUNCE_MS);
  });
  watcher.on('error', (e) => console.warn(`[hot-reload] watcher error: ${e.message}`)); // 配置文件消失等场景退化为告警,而非未捕获异常崩溃
  return watcher;
}

function main() {
  const configFile = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configFile)) {
    try {
      fs.copyFileSync(path.join(__dirname, 'config.example.json'), configFile);
    } catch (e) {
      console.error(`config: cannot copy template: ${e.message}`);
      process.exit(1);
    }
    console.error(`config.json not found - template copied. Edit ${configFile} (set baseUrl/apiKey), then restart.`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = loadConfig(configFile, process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const hot = createHotReloader(cfg);
  const srv = createServer(hot);
  srv.listen(cfg.port, '127.0.0.1', () => {
    console.log(`cursor-opencode-proxy listening on http://127.0.0.1:${cfg.port} (local listen address only)`);
    console.log(`upstream: ${cfg.baseUrl} | session: ${cfg.session.strategy} via header "${cfg.session.header}"`);
    console.log(cfg.auth.enabled
      ? `auth: enabled via header "${cfg.auth.header}"`
      : 'auth: disabled (anyone who can reach this port can use your upstream key)');
    // Cursor 必须填公网 HTTPS 地址:127.0.0.1 会被其服务端 SSRF 防护拒绝。
    // 该地址只能来自隧道 ingress,故从 config.yml 推导;推导失败只提示,不影响启动。
    for (const line of formatCursorSetup(cfg, derivePublicBaseUrl(cfg.tunnel, cfg.port))) console.log(line);
  });
  srv.on('error', (e) => {
    console.error(`listen failed: ${e.message} (change port in config.json or COP_PORT env)`);
    process.exit(1);
  });

  let tunnel = null;
  if (cfg.tunnel.enabled) {
    tunnel = startTunnel(cfg, {});
    console.log(`[tunnel] starting: ${cfg.tunnel.binary} ${buildTunnelArgs(cfg.tunnel).join(' ')}`);
  } else {
    console.log('[tunnel] disabled (set tunnel.enabled=true to auto-start cloudflared)');
  }

  const shutdown = () => {
    if (tunnel) tunnel.stop();
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref(); // 兜底:关闭超时也退出
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { if (tunnel) tunnel.stop(); }); // 同步清理,避免遗留孤儿 cloudflared

  watchConfig(configFile, () => {
    const r = applyHotConfig(hot, configFile);
    if (r.ok) console.log(`[hot-reload] applied: baseUrl=${r.config.baseUrl} session=${r.config.session.strategy} (port change requires restart)`);
  });
  setInterval(() => {
    const n = cleanupSessionMap(hot.sessionMgr);
    if (n) console.log(`[gc] removed ${n} expired session entries`);
  }, SESSION_GC_INTERVAL_MS).unref();
}

if (require.main === module) main();

module.exports = {
  loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession,
  createHotReloader, proxyRequest, createServer, applyHotConfig, cleanupSessionMap, watchConfig,
  checkAuth, buildTunnelArgs, startTunnel,
  parseTunnelHostnames, pickPublicHost, derivePublicBaseUrl, formatCursorSetup,
  createReasoningCache, messageFingerprint, extractAssistant, extractAssistantFromJson, extractAssistantFromSse,
  rememberReasoning, recallReasoning, replayReasoning, injectThinkingDisabled, looksLikeReasoningError,
};
