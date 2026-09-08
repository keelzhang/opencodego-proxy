# cursor-opencode-proxy 实现计划

> **面向 AI 代理的工作者：** 必需技能:使用 subagent-driven-development(推荐)或 executing-plans 逐任务实现此计划。步骤使用复选框(`- [ ]`)语法来跟踪进度。

**目标:** Node 22 单文件零依赖本地代理,Cursor Base URL 指向 `http://127.0.0.1:8787/v1` 即可使用;代理自动注入 `x-opencode-session`(自动探测 Cursor 会话头并映射,探测不到降级为每请求新 UUID),SSE streaming 原样透传。

**架构:** 纯透传只换头——请求 body 整体缓冲后原样转发(不解析),响应逐字节 `pipe` 回客户端(不解析、不缓冲、不重组),只在请求侧做头改写:替换 `Authorization` 为配置的 apiKey、注入 `x-opencode-session`。配置 `config.json` 热重载(`fs.watch` + 300ms 防抖,非法配置保留旧配置并告警),环境变量 `COP_PORT`/`COP_BASE_URL`/`COP_API_KEY` 每次加载时覆盖。单文件内四个单元:配置加载器、session 管理器、转发器、热重载器;纯函数(路径拼接、hop-by-hop 过滤、session 探测/映射、配置校验)与 HTTP I/O 分离,便于 `node:test` 直接断言。任务 3 引入 `hot` 容器 `{ config, sessionMgr }` 作为服务运行态,任务 4 的热重载只替换 `hot.config` 字段并同步 `sessionMgr.cfg`。

**技术栈:** Node.js 22(`node:http`/`node:https`/`node:fs`/`node:crypto`/`node:test`/`node:assert`),零第三方依赖,Windows 下 `node cursor-opencode-proxy.js` 直接运行。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| 创建:`cursor-opencode-proxy.js` | 单文件代理:配置加载、session 管理、转发、热重载、HTTP 服务;`module.exports` 暴露函数供测试 |
| 创建:`tests/proxy.test.js` | `node:test` 测试:纯函数单测 + 真实 HTTP 服务的端到端测试(本地假上游) |
| 已存在:`.gitignore` | 忽略 `config.json`(含 apiKey 不入库) |
| 已存在:`config.example.json` | 配置模板 |
| 创建:`README.md` | 使用说明(任务 5) |

设计文档:`docs/superpowers/specs/2026-09-08-cursor-opencode-proxy-design.md`(已批准,实现以其为准)。

---

### 任务 1:配置加载器(loadConfig)

**文件:**
- 创建:`cursor-opencode-proxy.js`
- 测试:`tests/proxy.test.js`

- [ ] **步骤 1.1:编写失败的测试**

`tests/proxy.test.js` 全部内容:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proxy = require('../cursor-opencode-proxy.js');

// ---------- 测试辅助 ----------
const tmpDirs = [];
function writeTmp(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-'));
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, content);
  tmpDirs.push(dir);
  return p;
}
function makeConfigFile(cfg) { return writeTmp(JSON.stringify(cfg)); }
process.on('exit', () => { for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const VALID = {
  port: 8787,
  baseUrl: 'https://api.example.com/v4',
  apiKey: 'cfg-key',
  session: { strategy: 'auto', header: 'x-opencode-session', staticId: '00000000-0000-4000-8000-000000000000', ttlMs: 7200000 },
  log: { headers: true, body: false },
};

// ---------- 任务 1:配置加载器 ----------

test('loadConfig: 完整配置通过校验,环境变量覆盖生效', () => {
  const cfg = proxy.loadConfig(makeConfigFile(VALID), {
    COP_PORT: '9000', COP_BASE_URL: 'https://env.example.com/v1/', COP_API_KEY: 'env-key',
  });
  assert.equal(cfg.port, 9000);
  assert.equal(cfg.baseUrl, 'https://env.example.com/v1');
  assert.equal(cfg.apiKey, 'env-key');
  assert.equal(cfg.session.strategy, 'auto');
  assert.equal(cfg.log.headers, true);
});

test('loadConfig: 无环境变量时使用文件值与默认值', () => {
  const minimal = { baseUrl: 'https://api.example.com/v4', apiKey: 'k' };
  const cfg = proxy.loadConfig(makeConfigFile(minimal), {});
  assert.equal(cfg.port, 8787);
  assert.equal(cfg.session.strategy, 'auto');
  assert.equal(cfg.session.header, 'x-opencode-session');
  assert.equal(cfg.session.ttlMs, 7200000);
  assert.equal(cfg.log.headers, true);
  assert.equal(cfg.log.body, false);
});

test('loadConfig: 非法 JSON 抛出异常', () => {
  const file = writeTmp('{ not json');
  assert.throws(() => proxy.loadConfig(file, {}), /invalid JSON/);
});

test('loadConfig: 缺失必填字段抛出异常(报 missing: baseUrl)', () => {
  const file = writeTmp(JSON.stringify({ port: 8787 }));
  assert.throws(() => proxy.loadConfig(file, {}), /missing: baseUrl/);
});

test('loadConfig: 非法 strategy 抛出异常', () => {
  const bad = { ...VALID, session: { ...VALID.session, strategy: 'bogus' } };
  const file = makeConfigFile(bad);
  assert.throws(() => proxy.loadConfig(file, {}), /session\.strategy/);
});
```

- [ ] **步骤 1.2:运行测试验证失败**

运行:`node --test tests/`
预期:FAIL,报 `Cannot find module '../cursor-opencode-proxy.js'`

- [ ] **步骤 1.3:编写最少实现代码**

`cursor-opencode-proxy.js` 全部内容:

```js
'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STRATEGIES = ['auto', 'per-request', 'static'];
const PROBE_HEADERS = ['x-session-id', 'x-client-session-id', 'x-request-id'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

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
  if (parsed.session && typeof parsed.session === 'object') {
    if (typeof parsed.session.header === 'string' && parsed.session.header) cfg.session.header = parsed.session.header;
    if (typeof parsed.session.staticId === 'string' && parsed.session.staticId) cfg.session.staticId = parsed.session.staticId;
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

module.exports = { loadConfig };
```

- [ ] **步骤 1.4:运行测试验证通过**

运行:`node --test tests/`
预期:PASS(任务 1 的 5 个测试)

- [ ] **步骤 1.5:Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 配置加载器(校验+环境变量覆盖)"
```

---

### 任务 2:路径拼接、hop-by-hop 过滤、session 探测(纯函数)

**文件:**
- 修改:`cursor-opencode-proxy.js`(追加纯函数并导出)
- 测试:`tests/proxy.test.js`(追加)

- [ ] **步骤 2.1:编写失败的测试**

在 `tests/proxy.test.js` 末尾追加:

```js
// ---------- 任务 2:纯函数 ----------

test('buildUpstreamPath: /v1/xxx → baseUrl + /xxx', () => {
  assert.equal(proxy.buildUpstreamPath('https://api.example.com/v4', '/v1/chat/completions'), '/v4/chat/completions');
});

test('buildUpstreamPath: baseUrl 带 /v1 不产生 //v1', () => {
  assert.equal(proxy.buildUpstreamPath('https://api.example.com/v1', '/v1/chat/completions'), '/v1/chat/completions');
});

test('buildUpstreamPath: 非 /v1 开头原样拼接', () => {
  assert.equal(proxy.buildUpstreamPath('https://api.example.com/v4', '/chat/completions'), '/v4/chat/completions');
  assert.equal(proxy.buildUpstreamPath('https://api.example.com/v4', '/models'), '/v4/models');
});

test('buildUpstreamPath: baseUrl 根路径', () => {
  assert.equal(proxy.buildUpstreamPath('https://api.example.com', '/v1/chat/completions'), '/chat/completions');
});

test('filterHeaders: 过滤 hop-by-hop 头并小写化', () => {
  const out = proxy.filterHeaders({
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
    'x-session-id': 'abc',
  });
  assert.deepEqual(out, { 'content-type': 'application/json', 'x-session-id': 'abc' });
});

test('resolveSession: 探测顺序 x-session-id → x-client-session-id → x-request-id', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 100 });
  const a = proxy.resolveSession(m, { 'x-request-id': 'r1', 'x-client-session-id': 'c1', 'x-session-id': 's1' });
  const b = proxy.resolveSession(m, { 'x-request-id': 'r2', 'x-client-session-id': 'c1' });
  const c = proxy.resolveSession(m, { 'x-request-id': 'r3' });
  assert.equal(a, b);          // 同客户端会话 c1 → 同一注入 UUID
  assert.notEqual(c, a);       // 只带 x-request-id → 每次新 UUID
  assert.notEqual(c, b);
});

test('resolveSession: per-request 每次不同;static 固定值', () => {
  const m1 = proxy.createSessionManager({ strategy: 'per-request', header: 'x-opencode-session', staticId: 'sid', ttlMs: 100 });
  assert.notEqual(proxy.resolveSession(m1, {}), proxy.resolveSession(m1, {}));
  const m2 = proxy.createSessionManager({ strategy: 'static', header: 'x-opencode-session', staticId: 'fixed-id', ttlMs: 100 });
  assert.equal(proxy.resolveSession(m2, {}), 'fixed-id');
});

test('resolveSession: TTL 过期后同 key 生成新 UUID', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 30 });
  const v1 = proxy.resolveSession(m, { 'x-session-id': 's9' });
  m.entries.get('s9').createdAt -= 100; // 人为过期
  const v2 = proxy.resolveSession(m, { 'x-session-id': 's9' });
  assert.notEqual(v1, v2);
});
```

- [ ] **步骤 2.2:运行测试验证失败**

运行:`node --test tests/`
预期:FAIL,`proxy.buildUpstreamPath is not a function`

- [ ] **步骤 2.3:编写最少实现代码**

在 `cursor-opencode-proxy.js` 的 `module.exports` 之前追加,并把导出行替换为:

```js
function buildUpstreamPath(baseUrl, reqPath) {
  const base = baseUrl.replace(/\/+$/, '');
  if (reqPath === '/v1' || reqPath.startsWith('/v1/')) {
    return base + reqPath.slice(3); // '/v1/chat' → base + '/chat'
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
  for (const h of PROBE_HEADERS) {
    const v = reqHeaders[h];
    if (typeof v === 'string' && v) {
      const now = Date.now();
      const hit = mgr.entries.get(v);
      if (hit && now - hit.createdAt < mgr.cfg.ttlMs) return hit.uuid;
      const uuid = randomUUID();
      mgr.entries.set(v, { uuid, createdAt: now });
      return uuid;
    }
  }
  return randomUUID();
}

module.exports = { loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession };
```

- [ ] **步骤 2.4:运行测试验证通过**

运行:`node --test tests/`
预期:PASS(任务 1+2 共 13 个测试)

- [ ] **步骤 2.5:Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 路径拼接/hop-by-hop 过滤/session 探测映射纯函数"
```

---

### 任务 3:转发器(proxyRequest)+ HTTP 服务(createServer)

运行态容器 `hot = { config, sessionMgr }` 在本任务引入:`createServer(hot)` 是唯一服务入口,session 一律从 `hot.sessionMgr` 解析(任务 4 的热重载只替换 `hot.config`,映射不丢)。

**文件:**
- 修改:`cursor-opencode-proxy.js`(追加日志、错误响应、转发器、服务装配)
- 测试:`tests/proxy.test.js`(追加端到端测试)

- [ ] **步骤 3.1:编写失败的测试**

在 `tests/proxy.test.js` 末尾追加:

```js
// ---------- 任务 3:转发器与服务(端到端) ----------

const http = require('node:http');

function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
// 取一个"刚释放"的端口当作死上游:先占住→拿到端口号→关闭
async function getDeadPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
function startProxy(cfg) {
  return new Promise((resolve) => {
    const srv = proxy.createServer(proxy.createHotReloader(cfg));
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function req(port, opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('proxyRequest: 换 Authorization、注入 session、透传 body 与路径', async () => {
  let seen = null;
  const up = await startFakeUpstream((rq, rs) => {
    seen = { url: rq.url, auth: rq.headers.authorization, session: rq.headers['x-opencode-session'], host: rq.headers.host, body: '' };
    rq.on('data', (c) => (seen.body += c));
    rq.on('end', () => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}'); });
  });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4`, apiKey: 'up-key', session: VALID.session, log: { headers: false, body: false } });
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer cursor-key', 'x-session-id': 'cur-1' } }, '{"model":"glm-4.6","messages":[]}');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(seen.url, '/v4/chat/completions');
  assert.equal(seen.auth, 'Bearer up-key');                       // Authorization 已替换
  assert.ok(/^[0-9a-f-]{36}$/.test(seen.session));                // 注入 UUID
  assert.equal(seen.host, `127.0.0.1:${up.port}`);                // host 重写为上游
  assert.equal(seen.body, '{"model":"glm-4.6","messages":[]}');   // body 原样
  p.srv.close(); up.srv.close();
});

test('SSE 透传:多个 chunk 顺序完整到达', async () => {
  const up = await startFakeUpstream((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    rs.write('data: {"a":1}\n\n');
    setTimeout(() => rs.write('data: {"a":2}\n\n'), 30);
    setTimeout(() => rs.end('data: [DONE]\n\n'), 60);
  });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'sse-1' } }, '{}');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const events = res.body.split('\n\n').filter(Boolean);
  assert.deepEqual(events, ['data: {"a":1}', 'data: {"a":2}', 'data: [DONE]']);
  p.srv.close(); up.srv.close();
});

test('同一 Cursor 会话复用同一注入 UUID,新会话新 UUID', async () => {
  const sessions = [];
  const up = await startFakeUpstream((rq, rs) => { sessions.push(rq.headers['x-opencode-session']); rs.end('ok'); });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  await req(p.port, { path: '/v1/chat/completions', headers: { 'x-session-id': 'same' } }, '{}');
  await req(p.port, { path: '/v1/chat/completions', headers: { 'x-session-id': 'same' } }, '{}');
  await req(p.port, { path: '/v1/chat/completions', headers: { 'x-session-id': 'other' } }, '{}');
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[2], sessions[0]);
  p.srv.close(); up.srv.close();
});

test('上游连接失败 → 502 + OpenAI 错误格式', async () => {
  const dead = await getDeadPort();
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 502);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.type, 'proxy_error');
  assert.ok(parsed.error.message);
  p.srv.close();
});

test('上游 4xx/5xx 原样透传', async () => {
  const up = await startFakeUpstream((rq, rs) => { rs.writeHead(429, { 'content-type': 'application/json' }); rs.end('{"error":{"message":"rate limited","type":"rate_limit"}}'); });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  const res = await req(p.port, { path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 429);
  assert.equal(JSON.parse(res.body).error.type, 'rate_limit');
  p.srv.close(); up.srv.close();
});

test('body 超过 10MB → 413,不触碰上游', async () => {
  const dead = await getDeadPort();
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, 'x'.repeat(10 * 1024 * 1024 + 1));
  assert.equal(res.status, 413);
  p.srv.close();
});

test('log.headers=true 打印脱敏请求头;log.body=true 打印 body 前 2KB', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
    const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'up-key', session: VALID.session, log: { headers: true, body: true } });
    await req(p.port, { path: '/v1/chat/completions', headers: { authorization: 'Bearer cursor-key', 'x-session-id': 'log-1' } }, '{"q":1}');
    p.srv.close(); up.srv.close();
  } finally {
    console.log = orig;
  }
  const all = logs.join('\n');
  assert.ok(all.includes('x-session-id'));   // 会话头可见
  assert.ok(all.includes('log-1'));
  assert.ok(!all.includes('cursor-key'));    // Authorization 脱敏:原文不出现
  assert.ok(all.includes('{"q":1}'));        // body 前 2KB 可见
});
```

- [ ] **步骤 3.2:运行测试验证失败**

运行:`node --test tests/`
预期:FAIL,`proxy.createServer is not a function`

- [ ] **步骤 3.3:编写最少实现代码**

在 `cursor-opencode-proxy.js` 的 `module.exports` 之前追加,并把导出行替换为:

```js
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
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('error', () => {});
  req.on('end', () => {
    if (rejected) return;
    const body = Buffer.concat(chunks);
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
  });
}

function createServer(hot) {
  return http.createServer((rq, rs) => proxyRequest(rq, rs, hot));
}

module.exports = {
  loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession,
  createHotReloader, proxyRequest, createServer,
};
```

- [ ] **步骤 3.4:运行测试验证通过**

运行:`node --test tests/`
预期:PASS(任务 1+2+3 共 20 个测试)

- [ ] **步骤 3.5:Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 转发器与 HTTP 服务(SSE pipe 透传/502/504/413/4xx 透传/会话复用)"
```

---

### 任务 4:热重载(applyHotConfig/watchConfig)+ TTL 清理 + 主入口(main)

**文件:**
- 修改:`cursor-opencode-proxy.js`(追加热重载、清理、main)
- 测试:`tests/proxy.test.js`(追加)

- [ ] **步骤 4.1:编写失败的测试**

在 `tests/proxy.test.js` 末尾追加:

```js
// ---------- 任务 4:热重载与清理 ----------

test('applyHotConfig: 合法新配置替换,非法新配置保留旧配置并保持 session 映射', () => {
  const file = makeConfigFile(VALID);
  const hot = proxy.createHotReloader(proxy.loadConfig(file, {}));
  proxy.resolveSession(hot.sessionMgr, { 'x-session-id': 'keep-me' });
  const uuidBefore = hot.sessionMgr.entries.get('keep-me').uuid;

  const bad = proxy.applyHotConfig(hot, writeTmp(JSON.stringify({ baseUrl: '', apiKey: 'x' })));
  assert.equal(bad.ok, false);
  assert.equal(hot.config.baseUrl, VALID.baseUrl); // 旧配置保留
  assert.equal(hot.sessionMgr.entries.get('keep-me').uuid, uuidBefore); // 映射不丢

  const changed = { ...VALID, apiKey: 'new-key' };
  const good = proxy.applyHotConfig(hot, makeConfigFile(changed));
  assert.equal(good.ok, true);
  assert.equal(hot.config.apiKey, 'new-key');
  assert.equal(hot.sessionMgr.cfg.ttlMs, VALID.session.ttlMs); // session 配置同步
});

test('cleanupSessionMap: 仅清理过期条目并返回数量', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'h', staticId: 'sid', ttlMs: 50 });
  proxy.resolveSession(m, { 'x-session-id': 'fresh' });
  proxy.resolveSession(m, { 'x-session-id': 'old' });
  m.entries.get('old').createdAt -= 1000;
  const removed = proxy.cleanupSessionMap(m);
  assert.equal(removed, 1);
  assert.ok(m.entries.has('fresh'));
  assert.ok(!m.entries.has('old'));
});
```

- [ ] **步骤 4.2:运行测试验证失败**

运行:`node --test tests/`
预期:FAIL,`proxy.applyHotConfig is not a function`

- [ ] **步骤 4.3:编写最少实现代码**

在 `cursor-opencode-proxy.js` 的 `module.exports` 之前追加,并把导出行替换为:

```js
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
  return watcher;
}

function main() {
  const configFile = path.join(__dirname, 'config.json');
  if (!fs.existsSync(configFile)) {
    fs.copyFileSync(path.join(__dirname, 'config.example.json'), configFile);
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
    console.log(`cursor-opencode-proxy listening on http://127.0.0.1:${cfg.port} (Cursor Base URL: http://127.0.0.1:${cfg.port}/v1)`);
    console.log(`upstream: ${cfg.baseUrl} | session: ${cfg.session.strategy} via header "${cfg.session.header}"`);
  });
  srv.on('error', (e) => { console.error(`listen failed: ${e.message}`); process.exit(1); });
  watchConfig(configFile, () => {
    const r = applyHotConfig(hot, configFile);
    if (r.ok) console.log(`[hot-reload] applied: baseUrl=${r.config.baseUrl} session=${r.config.session.strategy} (port change requires restart)`);
  });
  setInterval(() => cleanupSessionMap(hot.sessionMgr), SESSION_GC_INTERVAL_MS).unref();
}

if (require.main === module) main();

module.exports = {
  loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession,
  createHotReloader, proxyRequest, createServer, applyHotConfig, cleanupSessionMap, watchConfig,
};
```

- [ ] **步骤 4.4:运行测试验证通过**

运行:`node --test tests/`
预期:PASS(全部 22 个测试)

- [ ] **步骤 4.5:主入口冒烟测试**

```bash
node cursor-opencode-proxy.js; echo "exit=$?"
```

预期:输出 `config.json not found - template copied. ...` 后退出码为 1;生成的 `config.json` 已被 `.gitignore` 覆盖,`git status --short` 应无新增。

- [ ] **步骤 4.6:Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 热重载 + TTL 清理 + 主入口(模板复制/防抖 watch/仅监听 127.0.0.1)"
```

---

### 任务 5:端到端验证(Python 假上游)与 README

**文件:**
- 临时(不入库):`%TEMP%\fake_upstream.py`(验证完删除)
- 创建:`README.md`

- [ ] **步骤 5.1:Python 假上游端到端验证**

`%TEMP%\fake_upstream.py`:

```python
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        self.rfile.read(n)
        session = self.headers.get('x-opencode-session')
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(b'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n')
        self.wfile.write(b'data: [DONE]\n\n')
        print(json.dumps({"path": self.path, "session": session}), flush=True)

    def log_message(self, *a):
        pass

HTTPServer(('127.0.0.1', 9911), H).serve_forever()
```

验证序列(config.json 设 `baseUrl: http://127.0.0.1:9911`,`apiKey: test`):

```bash
python "%TEMP%\fake_upstream.py" &
node cursor-opencode-proxy.js &
curl -s -N -X POST http://127.0.0.1:8787/v1/chat/completions -H "x-session-id: e2e-1" -H "content-type: application/json" -d '{"model":"glm-4.6","stream":true}'
# 预期:两行 SSE(data: {...} 与 data: [DONE]);代理日志显示 x-session-id=e2e-1 与注入的 UUID
curl -s -N -X POST http://127.0.0.1:8787/v1/chat/completions -H "x-session-id: e2e-1" -H "content-type: application/json" -d '{}'
# 预期:假上游打印的 session 与上一步相同(同会话复用)
```

验证完删除 `%TEMP%\fake_upstream.py`,并停掉两个后台进程。

- [ ] **步骤 5.2:热重载手工验证**

编辑 `config.json` 把 `log.headers` 改为 `false` 保存。
预期:代理控制台输出 `[hot-reload] applied: ...`;下一个请求不再打印 headers 行。

- [ ] **步骤 5.3:真实 Cursor 验证(需用户操作)**

Cursor 设置 → Models → OpenAI API Key 填任意占位,Base URL 填 `http://127.0.0.1:8787/v1`,模型名填上游支持的模型(如 `glm-4.6`),发起对话。
预期:对话正常返回;代理日志可见 Cursor 实际发送的会话头名与注入的 session;若 Cursor 无会话头则日志显示 `no-session-header`(降级路径,功能仍可用)。

- [ ] **步骤 5.4:创建 README.md**

```markdown
# cursor-opencode-proxy

OpenCode Go 后端启用强制 session routing(要求 `x-opencode-session` 头)后,Cursor 因无法配置自定义请求头而无法直连。本代理在本地替 Cursor 注入该头,SSE 流式原样透传。

## 使用

1. 复制 `config.example.json` 为 `config.json`,填入 `baseUrl` 与 `apiKey`
2. `node cursor-opencode-proxy.js`
3. Cursor → Models → OpenAI Base URL 填 `http://127.0.0.1:8787/v1`,模型名填上游支持的模型名
4. 对话;`log.headers: true` 时控制台可见 Cursor 实际发送的会话头

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| port | 8787 | 监听端口(仅 127.0.0.1) |
| baseUrl | (必填) | 上游 OpenAI 兼容端点 |
| apiKey | (必填) | 上游 API key |
| session.strategy | auto | auto / per-request / static |
| session.header | x-opencode-session | 注入的请求头名 |
| session.staticId | 00000000-… | strategy=static 时注入的固定值 |
| session.ttlMs | 7200000 | Cursor 会话 → 注入 UUID 映射的 TTL |
| log.headers | true | 打印收到的请求头(Authorization 脱敏) |
| log.body | false | 打印请求 body 前 2KB |

- 环境变量 `COP_PORT` / `COP_BASE_URL` / `COP_API_KEY` 可覆盖对应字段,热重载后依然生效
- 修改 `config.json` 保存即热重载;非法配置保留旧配置并告警;端口变更需重启
- 首次启动若无 `config.json`,自动从模板复制后退出

## 测试

```
node --test tests/
```
```

- [ ] **步骤 5.5:Commit**

```bash
git add README.md
git commit -m "docs: README 使用说明"
```

---

## 自检记录

- **规格覆盖度**:配置加载/环境变量覆盖/校验(任务 1)、热重载+防抖+非法保留旧配置(任务 4)、session 三策略+探测顺序+TTL+定期清理(任务 2/4)、路径拼接两种 baseUrl 写法(任务 2)、hop-by-hop 过滤(任务 2/3)、纯透传+Authorization 替换+session 注入+host 处理(任务 3)、SSE pipe 不缓冲(任务 3)、502/504/413/4xx 透传(任务 3)、session-hint 日志(任务 3,状态码 400/401/403 驱动)、日志每请求一行+headers 脱敏+body 前 2KB(任务 3)、仅监听 127.0.0.1(任务 3/4 main)、模板复制+端口占用报错退出(任务 4 main)、端到端与真实 Cursor 验证(任务 5)、README(任务 5)。规格 5.4 中"响应 body 含 session 字样"分支合并为状态码驱动判定——读 body 会破坏纯透传(与 pipe 竞争消费流),已在 hint 日志中标注 spec 5.4 便于追溯。
- **占位符扫描**:全部代码块为完整可运行代码,无 TODO/待定/存根。
- **类型一致性**:`hot = { config, sessionMgr }` 贯穿任务 3/4(`createHotReloader` → `createServer(hot)` → `applyHotConfig(hot, file)`);`mgr.entries`/`mgr.cfg` 在任务 2/4 中一致;`resolveSession(mgr, headers)` 签名在任务 2 定义、任务 3 使用。
- **测试计数**:任务 1(5)+ 任务 2(8)+ 任务 3(7)+ 任务 4(2)= 22 个。
