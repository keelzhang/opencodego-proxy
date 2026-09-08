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

// ---------- 任务 2:纯函数 ----------

test('loadConfig: 顶层 JSON null 抛出明确错误', () => {
  const file = writeTmp('null');
  assert.throws(() => proxy.loadConfig(file, {}), /must be a JSON object/);
});

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
  assert.equal(a, b);
  assert.notEqual(c, a);
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
  m.entries.get('s9').createdAt -= 100;
  const v2 = proxy.resolveSession(m, { 'x-session-id': 's9' });
  assert.notEqual(v1, v2);
});

test('filterHeaders: host 头被过滤(由 Node 按上游自动生成)', () => {
  const out = proxy.filterHeaders({ Host: 'localhost:8787', 'content-type': 'application/json' });
  assert.deepEqual(out, { 'content-type': 'application/json' });
});

test('buildUpstreamPath: 无效 baseUrl 抛出带上下文的错误', () => {
  assert.throws(() => proxy.buildUpstreamPath('not a url', '/v1/chat'), /invalid baseUrl/);
});

test('buildUpstreamPath: reqPath 恰为 /v1 时前缀整段移除(固化 slice 语义)', () => {
  assert.equal(proxy.buildUpstreamPath('https://api.example.com/v4', '/v1'), '/v4');
});

test('resolveSession: ttlMs=1 同毫秒内命中复用', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 1 });
  const v1 = proxy.resolveSession(m, { 'x-session-id': 'fast' });
  const v2 = proxy.resolveSession(m, { 'x-session-id': 'fast' });
  assert.equal(v1, v2);
});

// ---------- 任务 3:转发器与服务(端到端) ----------

const http = require('node:http');

function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
async function getDeadPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
function closeSrv(srv) { return new Promise((r) => srv.close(() => r())); }
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
      res.on('aborted', () => reject(new Error(`client response aborted (status=${res.statusCode}, bytes=${Buffer.concat(chunks).length})`)));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('proxyRequest: 换 Authorization、注入 session、透传 body 与路径', async (t) => {
  let seen = null;
  const up = await startFakeUpstream((rq, rs) => {
    seen = { url: rq.url, auth: rq.headers.authorization, session: rq.headers['x-opencode-session'], host: rq.headers.host, body: '' };
    rq.on('data', (c) => (seen.body += c));
    rq.on('end', () => { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end('{"ok":true}'); });
  });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4`, apiKey: 'up-key', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer cursor-key', 'x-session-id': 'cur-1' } }, '{"model":"glm-4.6","messages":[]}');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(seen.url, '/v4/chat/completions');
  assert.equal(seen.auth, 'Bearer up-key');
  assert.ok(/^[0-9a-f-]{36}$/.test(seen.session));
  assert.equal(seen.host, `127.0.0.1:${up.port}`);
  assert.equal(seen.body, '{"model":"glm-4.6","messages":[]}');
});

test('SSE 透传:多个 chunk 顺序完整到达', async (t) => {
  const up = await startFakeUpstream((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    rs.write('data: {"a":1}\n\n');
    setTimeout(() => rs.write('data: {"a":2}\n\n'), 30);
    setTimeout(() => rs.end('data: [DONE]\n\n'), 60);
  });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'sse-1' } }, '{}');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  const events = res.body.split('\n\n').filter(Boolean);
  assert.deepEqual(events, ['data: {"a":1}', 'data: {"a":2}', 'data: [DONE]']);
});

test('同一 Cursor 会话复用同一注入 UUID,新会话新 UUID', async (t) => {
  const sessions = [];
  const up = await startFakeUpstream((rq, rs) => { sessions.push(rq.headers['x-opencode-session']); rs.end('ok'); });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'same' } }, '{}');
  await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'same' } }, '{}');
  await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'other' } }, '{}');
  assert.equal(sessions[0], sessions[1]);
  assert.notEqual(sessions[2], sessions[0]);
});

test('上游连接失败 → 502 + OpenAI 错误格式', async (t) => {
  const dead = await getDeadPort();
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 502);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.type, 'proxy_error');
  assert.ok(parsed.error.message);
});

test('上游 4xx/5xx 原样透传', async (t) => {
  const up = await startFakeUpstream((rq, rs) => { rs.writeHead(429, { 'content-type': 'application/json' }); rs.end('{"error":{"message":"rate limited","type":"rate_limit"}}'); });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 429);
  assert.equal(JSON.parse(res.body).error.type, 'rate_limit');
});

test('body 超过 10MB → 413,不触碰上游', async (t) => {
  const dead = await getDeadPort();
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, 'x'.repeat(10 * 1024 * 1024 + 1));
  assert.equal(res.status, 413);
});

test('log.headers=true 打印脱敏请求头;log.body=true 打印 body 前 2KB', async (t) => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
    const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'up-key', session: VALID.session, log: { headers: true, body: true } });
    t.after(() => closeSrv(p.srv));
    t.after(() => closeSrv(up.srv));
    await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer cursor-key', 'x-session-id': 'log-1' } }, '{"q":1}');
  } finally {
    console.log = orig;
  }
  const all = logs.join('\n');
  assert.ok(all.includes('x-session-id'));
  assert.ok(all.includes('log-1'));
  assert.ok(!all.includes('cursor-key'));
  assert.ok(all.includes('{"q":1}'));
});

// ---------- 质量审查修复轮 ----------

test('loadConfig: 非法 baseUrl 抛出 invalid baseUrl(启动即拒绝)', () => {
  assert.throws(() => proxy.loadConfig(makeConfigFile({ baseUrl: 'not a url', apiKey: 'k' }), {}), /invalid baseUrl/);
});

test('loadConfig: baseUrl 协议白名单 http:/https:,其他协议抛出 invalid baseUrl', () => {
  assert.throws(() => proxy.loadConfig(makeConfigFile({ baseUrl: 'ftp://x', apiKey: 'k' }), {}), /invalid baseUrl/);
});

test('loadConfig: 环境变量覆盖后的非法 baseUrl 同样抛出(两入口最终值均校验)', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({ ...VALID }), { COP_BASE_URL: 'not a url' }),
    /invalid baseUrl/,
  );
});

test('loadConfig: session.header 非法(含空格)抛出错误', () => {
  const bad = { ...VALID, session: { ...VALID.session, header: 'bad header' } };
  assert.throws(() => proxy.loadConfig(makeConfigFile(bad), {}), /session\.header/);
});

test('loadConfig: staticId 为空白抛出错误', () => {
  const bad = { ...VALID, session: { ...VALID.session, staticId: ' ' } };
  assert.throws(() => proxy.loadConfig(makeConfigFile(bad), {}), /staticId/);
});

test('filterHeaders: Expect: 100-continue 被过滤(避免上游等待 100 Continue 挂起)', () => {
  const out = proxy.filterHeaders({ Expect: '100-continue', 'content-type': 'a' });
  assert.equal(out.expect, undefined);
  assert.equal(out['content-type'], 'a');
});

test('非法 baseUrl 启动不崩,首个请求得到 502 + proxy_error JSON', async (t) => {
  const p = await startProxy({ baseUrl: 'not a url', apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 502);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.type, 'proxy_error');
  assert.ok(parsed.error.message);
});

test('baseUrl 带 query 时转发 path 不含该 query(固化 Node options.path 整段替换行为,防版本回归)', async (t) => {
  let seen = null;
  const up = await startFakeUpstream((rq, rs) => {
    seen = { url: rq.url };
    rs.end('ok');
  });
  t.after(() => closeSrv(up.srv));
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4?api-key=SECRET`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(seen.url, '/v4/chat/completions');
  assert.ok(!seen.url.includes('SECRET'));
});
