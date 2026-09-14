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

test('resolveSession: 无任何会话头时设备级兜底头 cf-warp-tag-id 复用同一 UUID(过渡方案)', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 7200000 });
  const a = proxy.resolveSession(m, { 'cf-warp-tag-id': 'dc07968e-c0a8-4601-b979-f98646c67158' });
  const b = proxy.resolveSession(m, { 'cf-warp-tag-id': 'dc07968e-c0a8-4601-b979-f98646c67158' });
  assert.equal(a, b);
});

test('resolveSession: 存在会话头时设备级兜底头不参与(不把不同对话并入同一 session)', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 7200000 });
  const a = proxy.resolveSession(m, { 'x-session-id': 'A', 'cf-warp-tag-id': 'T' });
  const b = proxy.resolveSession(m, { 'x-session-id': 'B', 'cf-warp-tag-id': 'T' });
  assert.notEqual(a, b);
});

test('resolveSession: 无任何可探测头时 auto 仍降级为每请求新 UUID', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 7200000 });
  assert.notEqual(proxy.resolveSession(m, { host: 'proxy.example.com' }), proxy.resolveSession(m, { host: 'proxy.example.com' }));
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
  const realNow = Date.now;
  Date.now = () => 1700000000000; // 冻结时钟:ttlMs=1 时若两次调用跨毫秒就会误报,冻结以确定性固化该边界语义
  try {
    const m = proxy.createSessionManager({ strategy: 'auto', header: 'x-opencode-session', staticId: 'sid', ttlMs: 1 });
    const v1 = proxy.resolveSession(m, { 'x-session-id': 'fast' });
    const v2 = proxy.resolveSession(m, { 'x-session-id': 'fast' });
    assert.equal(v1, v2);
  } finally {
    Date.now = realNow;
  }
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
  assert.ok(all.includes('upstream=200')); // 规格 5.5:每请求一行含上游状态码
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

// ---------- 任务 4:热重载与清理 ----------

test('applyHotConfig: 合法新配置替换,非法新配置保留旧配置并保持 session 映射', () => {
  const file = makeConfigFile(VALID);
  const hot = proxy.createHotReloader(proxy.loadConfig(file, {}));
  proxy.resolveSession(hot.sessionMgr, { 'x-session-id': 'keep-me' });
  const uuidBefore = hot.sessionMgr.entries.get('keep-me').uuid;

  const bad = proxy.applyHotConfig(hot, writeTmp(JSON.stringify({ baseUrl: '', apiKey: 'x' })));
  assert.equal(bad.ok, false);
  assert.equal(hot.config.baseUrl, VALID.baseUrl);
  assert.equal(hot.sessionMgr.entries.get('keep-me').uuid, uuidBefore);

  const changed = { ...VALID, apiKey: 'new-key' };
  const good = proxy.applyHotConfig(hot, makeConfigFile(changed));
  assert.equal(good.ok, true);
  assert.equal(hot.config.apiKey, 'new-key');
  assert.equal(hot.sessionMgr.cfg.ttlMs, VALID.session.ttlMs);
});

test('cleanupSessionMap: 仅清理过期条目并返回数量', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'h', staticId: 'sid', ttlMs: 1000 });
  proxy.resolveSession(m, { 'x-session-id': 'fresh' });
  proxy.resolveSession(m, { 'x-session-id': 'old' });
  m.entries.get('old').createdAt -= 1000; // 恰为 ttlMs:now-createdAt >= ttlMs,删除(边界语义固化)
  const removed = proxy.cleanupSessionMap(m);
  assert.equal(removed, 1);
  assert.ok(m.entries.has('fresh'));
  assert.ok(!m.entries.has('old'));
});

test('cleanupSessionMap: 未达 ttlMs 的条目保留(< 边界不清理)', () => {
  const m = proxy.createSessionManager({ strategy: 'auto', header: 'h', staticId: 'sid', ttlMs: 1000 });
  proxy.resolveSession(m, { 'x-session-id': 'keep' });
  m.entries.get('keep').createdAt -= 1000 - 100; // now-createdAt < ttlMs:保留
  const removed = proxy.cleanupSessionMap(m);
  assert.equal(removed, 0);
  assert.ok(m.entries.has('keep'));
});

// ---------- 最终审查修复轮 ----------

test('客户端断连 → 中止上游请求', async (t) => {
  let upstreamAborted = false;
  // 假上游:SSE 流写完首个事件后保持打开(不 end)。
  // 判定"上游被中止"的直接信号:rs 在 writableFinished === false 时触发 'close',
  // 即响应未写完连接就被终止;正常完成时 writableFinished === true,不会误报。
  const up = await startFakeUpstream((rq, rs) => {
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    rs.write('data: {"a":1}\n\n');
    rs.on('close', () => { if (!rs.writableFinished) upstreamAborted = true; });
  });
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}/v4`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  // 上游响应故意不 end,残留连接需先强制断开,否则 close() 会等待连接结束而挂起
  t.after(() => {
    p.srv.closeAllConnections();
    up.srv.closeAllConnections();
    return Promise.all([closeSrv(p.srv), closeSrv(up.srv)]);
  });
  // 客户端发起请求,收到第一个数据块后立即断连(等价 Cursor 中按 Esc 停止生成)
  await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/v1/chat/completions', headers: { 'x-session-id': 'abort-1' } }, (res) => {
      res.once('data', () => { r.destroy(); resolve(); });
      res.on('error', () => resolve());
    });
    r.on('error', () => resolve());
    r.end('{}');
  });
  // 轮询等待代理把断连传播到上游(本地 loopback 通常几十毫秒内)
  for (let i = 0; i < 50 && !upstreamAborted; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(upstreamAborted, true, 'upstream request should be aborted after client disconnect');
});

// ---------- 公网隧道 + 鉴权:任务 1 配置加载器 ----------

test('loadConfig: auth/tunnel 缺省时均为关闭状态(向后兼容)', () => {
  const cfg = proxy.loadConfig(makeConfigFile(VALID), {});
  assert.equal(cfg.auth.enabled, false);
  assert.equal(cfg.auth.header, 'authorization');
  assert.equal(cfg.auth.token, '');
  assert.equal(cfg.tunnel.enabled, false);
  assert.equal(cfg.tunnel.binary, 'cloudflared');
  assert.equal(cfg.tunnel.name, 'cursor-proxy');
  assert.equal(cfg.tunnel.configFile, '');
  assert.equal(cfg.tunnel.restartDelayMs, 5000);
  assert.equal(cfg.log.tunnel, false);
});

test('loadConfig: auth/tunnel 字段被解析', () => {
  const cfg = proxy.loadConfig(makeConfigFile({
    ...VALID,
    auth: { enabled: true, header: 'x-api-token', token: 'tok-123' },
    tunnel: { enabled: true, binary: 'C:/cf/cloudflared.exe', name: 'my-tunnel', configFile: 'C:/cf/config.yml', restartDelayMs: 1000 },
    log: { headers: false, body: false, tunnel: true },
  }), {});
  assert.equal(cfg.auth.enabled, true);
  assert.equal(cfg.auth.header, 'x-api-token');
  assert.equal(cfg.auth.token, 'tok-123');
  assert.equal(cfg.tunnel.enabled, true);
  assert.equal(cfg.tunnel.binary, 'C:/cf/cloudflared.exe');
  assert.equal(cfg.tunnel.name, 'my-tunnel');
  assert.equal(cfg.tunnel.configFile, 'C:/cf/config.yml');
  assert.equal(cfg.tunnel.restartDelayMs, 1000);
  assert.equal(cfg.log.tunnel, true);
});

test('loadConfig: auth.enabled=true 且 token 为空抛出错误', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({ ...VALID, auth: { enabled: true } }), {}),
    /auth\.token/,
  );
});

test('loadConfig: COP_AUTH_TOKEN 覆盖 auth.token', () => {
  const cfg = proxy.loadConfig(makeConfigFile({ ...VALID, auth: { enabled: true, token: 'from-file' } }), { COP_AUTH_TOKEN: 'from-env' });
  assert.equal(cfg.auth.token, 'from-env');
});

test('loadConfig: COP_AUTH_TOKEN 可使 enabled 通过校验(空文件令牌+环境变量)', () => {
  const cfg = proxy.loadConfig(makeConfigFile({ ...VALID, auth: { enabled: true } }), { COP_AUTH_TOKEN: 'env-token' });
  assert.equal(cfg.auth.token, 'env-token');
});

test('loadConfig: 非法 auth.header(含空格)抛出错误', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({ ...VALID, auth: { header: 'bad header' } }), {}),
    /auth\.header/,
  );
});

test('loadConfig: tunnel.enabled=true 且 name 为空抛出错误', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({ ...VALID, tunnel: { enabled: true, name: ' ' } }), {}),
    /tunnel\.name/,
  );
});

test('loadConfig: tunnel.restartDelayMs 非正整数退回默认 5000', () => {
  const zero = proxy.loadConfig(makeConfigFile({ ...VALID, tunnel: { restartDelayMs: 0 } }), {});
  assert.equal(zero.tunnel.restartDelayMs, 5000);
  const neg = proxy.loadConfig(makeConfigFile({ ...VALID, tunnel: { restartDelayMs: -1 } }), {});
  assert.equal(neg.tunnel.restartDelayMs, 5000);
});

test('loadConfig: tunnel.binary 空串退回默认 cloudflared', () => {
  const cfg = proxy.loadConfig(makeConfigFile({ ...VALID, tunnel: { binary: '' } }), {});
  assert.equal(cfg.tunnel.binary, 'cloudflared');
});

test('loadConfig: auth.header 空串视为未设置,退回默认 authorization', () => {
  const cfg = proxy.loadConfig(makeConfigFile({ ...VALID, auth: { header: '' } }), {});
  assert.equal(cfg.auth.header, 'authorization');
});

test('loadConfig: auth.header 与 session.header 相同时抛出错误', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({
      ...VALID,
      auth: { enabled: true, header: 'x-opencode-session', token: 'tok' },
    }), {}),
    /must differ/,
  );
});

test('loadConfig: 即使鉴权关闭,session.header 也不能与 auth.header 相同', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({
      ...VALID,
      session: { ...VALID.session, header: 'authorization' },
    }), {}),
    /must differ/,
  );
});

test('loadConfig: auth.header 与 session.header 仅大小写不同也视为冲突', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({
      ...VALID,
      session: { ...VALID.session, header: 'authorization' },
      auth: { enabled: true, header: 'Authorization', token: 'tok' },
    }), {}),
    /must differ/,
  );
});

// ---------- 任务 2:鉴权纯函数 ----------

test('checkAuth: enabled=false 或配置缺失时一律通过', () => {
  assert.equal(proxy.checkAuth({ enabled: false }, {}), true);
  assert.equal(proxy.checkAuth(undefined, {}), true);
  assert.equal(proxy.checkAuth({ enabled: false, header: 'authorization', token: 'x' }, {}), true);
});

test('checkAuth: 缺失/空/无 Bearer 前缀/令牌错误 均拒绝', () => {
  const cfg = { enabled: true, header: 'authorization', token: 'secret' };
  assert.equal(proxy.checkAuth(cfg, {}), false);
  assert.equal(proxy.checkAuth(cfg, { authorization: '' }), false);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'secret' }), false);   // 缺 Bearer 前缀
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer ' }), false);  // 前缀后为空
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer wrong' }), false);
});

test('checkAuth: 正确令牌通过,Bearer 前缀大小写不敏感', () => {
  const cfg = { enabled: true, header: 'authorization', token: 'secret' };
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer secret' }), true);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'bearer secret' }), true);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'BEARER secret' }), true);
});

test('checkAuth: 自定义 header 名生效,其他头不认', () => {
  const cfg = { enabled: true, header: 'x-api-token', token: 'secret' };
  assert.equal(proxy.checkAuth(cfg, { 'x-api-token': 'Bearer secret' }), true);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer secret' }), false);
});

test('checkAuth: 不同长度令牌拒绝且不抛异常(sha256 归一化路径)', () => {
  const cfg = { enabled: true, header: 'authorization', token: 'secret' };
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer a-much-longer-token-value' }), false);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer x' }), false);
});

test('checkAuth: token 非字符串或缺失时短路拒绝(防 String(undefined) 绕过)', () => {
  assert.equal(proxy.checkAuth({ enabled: true, header: 'authorization' }, { authorization: 'Bearer undefined' }), false);
  assert.equal(proxy.checkAuth({ enabled: true, header: 'authorization', token: 123 }, { authorization: 'Bearer 123' }), false);
  assert.equal(proxy.checkAuth({ enabled: true, header: 'authorization', token: '' }, { authorization: 'Bearer ' }), false);
});

test('loadConfig: auth.enabled=true 且 token 为纯空白串抛出错误', () => {
  assert.throws(
    () => proxy.loadConfig(makeConfigFile({ ...VALID, auth: { enabled: true, token: '   ' } }), {}),
    /auth\.token/,
  );
});

test('checkAuth: 未配置 header 时默认回落 authorization', () => {
  assert.equal(proxy.checkAuth({ enabled: true, token: 'secret' }, { authorization: 'Bearer secret' }), true);
});

test('checkAuth: 头值前后空白被 trim 后仍可匹配', () => {
  const cfg = { enabled: true, header: 'authorization', token: 'secret' };
  assert.equal(proxy.checkAuth(cfg, { authorization: '  Bearer secret ' }), true);
  assert.equal(proxy.checkAuth(cfg, { authorization: 'Bearer   secret' }), true);
});

// ---------- 任务 3:鉴权端到端 ----------

test('鉴权通过 → 请求透传上游,访问令牌被替换为上游 apiKey', async (t) => {
  let seenAuth = null;
  const up = await startFakeUpstream((rq, rs) => { seenAuth = rq.headers.authorization; rs.end('{"ok":true}'); });
  const p = await startProxy({
    baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'up-key', session: VALID.session,
    log: { headers: false, body: false }, auth: { enabled: true, header: 'authorization', token: 'access-token' },
  });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer access-token' } }, '{}');
  assert.equal(res.status, 200);
  assert.equal(seenAuth, 'Bearer up-key'); // 令牌与上游 key 隔离:替换为真正的上游 key
});

test('鉴权失败 → 401 且上游收到 0 个请求', async (t) => {
  let upstreamHits = 0;
  const up = await startFakeUpstream((rq, rs) => { upstreamHits++; rs.end('ok'); });
  const p = await startProxy({
    baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session,
    log: { headers: false, body: false }, auth: { enabled: true, header: 'authorization', token: 'secret' },
  });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer wrong' } }, '{}');
  assert.equal(res.status, 401);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.error.code, 401);
  assert.ok(String(res.headers['content-type']).includes('application/json'));
  assert.equal(parsed.error.type, 'proxy_error');
  assert.ok(parsed.error.message);
  assert.equal(upstreamHits, 0);
});

test('鉴权失败 → 无 Authorization 头同样 401', async (t) => {
  const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
  const p = await startProxy({
    baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session,
    log: { headers: false, body: false }, auth: { enabled: true, header: 'authorization', token: 'secret' },
  });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 401);
});

test('鉴权关闭时无令牌亦可透传(向后兼容)', async (t) => {
  const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
  const p = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false } });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
  assert.equal(res.status, 200);
  assert.equal(res.body, 'ok');
});

test('鉴权失败时不回显收到的令牌', async (t) => {
  const logs = [];
  const origWarn = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
    const p = await startProxy({
      baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session,
      log: { headers: false, body: false }, auth: { enabled: true, header: 'authorization', token: 'secret' },
    });
    t.after(() => closeSrv(p.srv));
    t.after(() => closeSrv(up.srv));
    await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer super-secret-guess' } }, '{}');
  } finally {
    console.warn = origWarn;
  }
  const all = logs.join('\n');
  assert.ok(all.includes('401'));
  assert.ok(!all.includes('super-secret-guess'));
});

// ---------- 审查必修轮:令牌隔离与鉴权短路回归 ----------

test('鉴权失败在 body 缓冲之前返回 401(未读完 body 即响应)', { timeout: 5000 }, async (t) => {
  const dead = await getDeadPort();
  const p = await startProxy({
    baseUrl: `http://127.0.0.1:${dead}`, apiKey: 'k', session: VALID.session,
    log: { headers: false, body: false }, auth: { enabled: true, header: 'authorization', token: 'secret' },
  });
  t.after(() => closeSrv(p.srv));
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: p.port, method: 'POST', path: '/v1/chat/completions',
      headers: { authorization: 'Bearer wrong', 'content-length': '1000000' } }, (res) => {
      try { assert.equal(res.statusCode, 401); } catch (e) { reject(e); return; }
      res.resume();
      res.on('end', () => { r.destroy(); resolve(); });
    });
    r.on('error', () => resolve());
    r.write('x'.repeat(1000)); // 只写 1KB,远少于 content-length=1000000
    // 故意不调用 r.end():若服务端等到 body 读完才响应,本测试会超时失败
  });
});

test('自定义鉴权头时访问令牌不泄露给上游(令牌与上游 key 隔离)', async (t) => {
  let seen = null;
  const up = await startFakeUpstream((rq, rs) => { seen = { x: rq.headers['x-api-token'], a: rq.headers.authorization }; rs.end('ok'); });
  const p = await startProxy({
    baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'up-key', session: VALID.session,
    log: { headers: false, body: false }, auth: { enabled: true, header: 'x-api-token', token: 'access-token' },
  });
  t.after(() => closeSrv(p.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-api-token': 'Bearer access-token' } }, '{}');
  assert.equal(res.status, 200);
  assert.equal(seen.a, 'Bearer up-key');
  assert.equal(seen.x, undefined); // 访问令牌不得转发给上游
});

test('自定义鉴权头时日志不泄露访问令牌', async (t) => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
    const p = await startProxy({
      baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session,
      log: { headers: true, body: false }, auth: { enabled: true, header: 'x-api-token', token: 'access-token' },
    });
    t.after(() => closeSrv(p.srv));
    t.after(() => closeSrv(up.srv));
    await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'x-api-token': 'Bearer access-token' } }, '{}');
  } finally {
    console.log = orig;
  }
  assert.ok(!logs.join('\n').includes('access-token'));
});

// ---------- 从 cloudflared config.yml 推导 Cursor 的公网 Base URL ----------

test('parseTunnelHostnames: 解析 ingress 的 hostname/service,catch-all 项被忽略', () => {
  const entries = proxy.parseTunnelHostnames([
    'tunnel: b0477f95-b418-431d-91df-cd8c863629fa',
    'credentials-file: C:\\Users\\u\\.cloudflared\\b0477f95.json',
    '',
    'ingress:',
    '  - hostname: proxy.example.com',
    '    service: http://127.0.0.1:8787',
    '  - service: http_status:404',
  ].join('\n'));
  assert.deepEqual(entries, [{ hostname: 'proxy.example.com', service: 'http://127.0.0.1:8787' }]);
});

test('parseTunnelHostnames: 引号与行内注释被剥离', () => {
  const entries = proxy.parseTunnelHostnames([
    'ingress:',
    "  - hostname: 'proxy.example.com'   # 主入口",
    '    service: http://127.0.0.1:8787 # 本地代理',
    '  - hostname: "alt.example.com"',
    '    service: http://127.0.0.1:9999',
  ].join('\n'));
  assert.deepEqual(entries, [
    { hostname: 'proxy.example.com', service: 'http://127.0.0.1:8787' },
    { hostname: 'alt.example.com', service: 'http://127.0.0.1:9999' },
  ]);
});

test('parseTunnelHostnames: ingress 块返回顶层后不再摄取(缩进判定)', () => {
  const entries = proxy.parseTunnelHostnames([
    'ingress:',
    '  - hostname: proxy.example.com',
    '    service: http://127.0.0.1:8787',
    'warp-routing:',
    '  enabled: true',
    'originRequest:',
    '  connectTimeout: 30',
  ].join('\n'));
  assert.deepEqual(entries, [{ hostname: 'proxy.example.com', service: 'http://127.0.0.1:8787' }]);
});

test('parseTunnelHostnames: 注释行与空行被跳过', () => {
  const entries = proxy.parseTunnelHostnames([
    '# 说明',
    'ingress:',
    '',
    '  # 入口',
    '  - hostname: proxy.example.com',
    '    service: http://127.0.0.1:8787',
  ].join('\n'));
  assert.deepEqual(entries, [{ hostname: 'proxy.example.com', service: 'http://127.0.0.1:8787' }]);
});

test('parseTunnelHostnames: 无 ingress / 无 hostname 时返回空数组', () => {
  assert.deepEqual(proxy.parseTunnelHostnames('tunnel: x\n'), []);
  assert.deepEqual(proxy.parseTunnelHostnames('ingress:\n  - service: http_status:404\n'), []);
  assert.deepEqual(proxy.parseTunnelHostnames(''), []);
});

test('pickPublicHost: 优先选 service 端口与本代理 port 一致的那条', () => {
  const entries = [
    { hostname: 'other.example.com', service: 'http://127.0.0.1:9999' },
    { hostname: 'proxy.example.com', service: 'http://127.0.0.1:8787' },
  ];
  assert.equal(proxy.pickPublicHost(entries, 8787), 'proxy.example.com');
});

test('pickPublicHost: 无端口匹配时回退首个 hostname;空列表返回 null', () => {
  const entries = [
    { hostname: 'first.example.com', service: 'http://127.0.0.1:9999' },
    { hostname: 'second.example.com', service: 'http://127.0.0.1:8888' },
  ];
  assert.equal(proxy.pickPublicHost(entries, 8787), 'first.example.com');
  assert.equal(proxy.pickPublicHost([], 8787), null);
});

test('derivePublicBaseUrl: 从 config.yml 推导 https://host/v1', () => {
  const r = proxy.derivePublicBaseUrl({ configFile: 'C:/cf/config.yml' }, 8787,
    () => 'ingress:\n  - hostname: proxy.example.com\n    service: http://127.0.0.1:8787\n  - service: http_status:404\n');
  assert.equal(r.url, 'https://proxy.example.com/v1');
  assert.equal(r.hostname, 'proxy.example.com');
  assert.equal(r.error, null);
});

test('derivePublicBaseUrl: 未配置 configFile 时返回 error 而非抛异常', () => {
  const r = proxy.derivePublicBaseUrl({ configFile: '  ' }, 8787, () => { throw new Error('should not read'); });
  assert.equal(r.url, null);
  assert.ok(r.error);
});

test('derivePublicBaseUrl: 读文件失败返回 error 而非抛异常(启动不中断)', () => {
  const r = proxy.derivePublicBaseUrl({ configFile: 'C:/nope.yml' }, 8787,
    () => { const e = new Error('ENOENT: no such file'); e.code = 'ENOENT'; throw e; });
  assert.equal(r.url, null);
  assert.ok(r.error.includes('ENOENT'));
});

test('derivePublicBaseUrl: config.yml 无 hostname 时返回 error', () => {
  const r = proxy.derivePublicBaseUrl({ configFile: 'C:/cf/config.yml' }, 8787,
    () => 'ingress:\n  - service: http_status:404\n');
  assert.equal(r.url, null);
  assert.ok(r.error);
});

test('formatCursorSetup: 打印公网 Base URL 与访问令牌(便于直接照抄到 Cursor)', () => {
  const lines = proxy.formatCursorSetup(
    { auth: { enabled: true, header: 'authorization', token: 'cop-abc123' }, tunnel: { configFile: 'C:/cf/config.yml' } },
    { url: 'https://proxy.example.com/v1', hostname: 'proxy.example.com', error: null },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('https://proxy.example.com/v1'));
  assert.ok(lines[0].includes('proxy.example.com'));
  assert.ok(lines[1].includes('cop-abc123'));
  assert.ok(lines[1].includes('not the upstream apiKey')); // 明确区分,避免把上游 key 误填进 Cursor
});

test('formatCursorSetup: 只打印访问令牌,绝不回显上游 apiKey', () => {
  const lines = proxy.formatCursorSetup(
    { apiKey: 'sk-UPSTREAM-SECRET', auth: { enabled: true, header: 'authorization', token: 'cop-abc123' }, tunnel: { configFile: 'C:/cf/config.yml' } },
    { url: 'https://proxy.example.com/v1', hostname: 'proxy.example.com', error: null },
  );
  assert.ok(!lines.join('\n').includes('sk-UPSTREAM-SECRET'));
});

test('formatCursorSetup: 鉴权关闭时提示填任意值,不提示空令牌', () => {
  const lines = proxy.formatCursorSetup(
    { auth: { enabled: false, header: 'authorization', token: '' }, tunnel: { configFile: 'C:/cf/config.yml' } },
    { url: 'https://proxy.example.com/v1', hostname: 'proxy.example.com', error: null },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('auth disabled'));
  assert.ok(/any/i.test(lines[1]));
});

test('formatCursorSetup: 地址推导失败时给出 unknown 与指引,令牌行照常打印', () => {
  const lines = proxy.formatCursorSetup(
    { auth: { enabled: true, header: 'authorization', token: 'cop-abc123' }, tunnel: { configFile: 'C:/nope.yml' } },
    { url: null, hostname: null, error: 'cannot read C:/nope.yml: ENOENT' },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('unknown'));
  assert.ok(lines[0].includes('ENOENT'));
  assert.ok(lines[0].includes('README'));
  assert.ok(lines[1].includes('cop-abc123')); // 地址推导失败不影响令牌提示
});

// ---------- 任务 4:隧道参数构造 ----------

test('buildTunnelArgs: 指定 configFile 时含 --config', () => {
  assert.deepEqual(
    proxy.buildTunnelArgs({ binary: 'cloudflared', name: 'cursor-proxy', configFile: 'C:/cf/config.yml', restartDelayMs: 5000 }),
    ['tunnel', '--config', 'C:/cf/config.yml', 'run', 'cursor-proxy'],
  );
});

test('buildTunnelArgs: 未指定 configFile 时不含 --config', () => {
  assert.deepEqual(
    proxy.buildTunnelArgs({ binary: 'cloudflared', name: 'cursor-proxy', configFile: '', restartDelayMs: 5000 }),
    ['tunnel', 'run', 'cursor-proxy'],
  );
});

test('buildTunnelArgs: configFile 为纯空白串时不加 --config', () => {
  assert.deepEqual(
    proxy.buildTunnelArgs({ binary: 'cloudflared', name: 't', configFile: '   ', restartDelayMs: 5000 }),
    ['tunnel', 'run', 't'],
  );
});

// ---------- reasoning_content 回放(A)与降级(B) ----------
// 背景:DeepSeek thinking mode 下请求带 tools 时,历史 assistant 必须回传 reasoning_content,否则上游 400。
// Cursor 走 OpenAI 标准协议不保留该字段,故需要代理补(A)或降级(B)。

const RCFG = { replay: true, fallbackDisabled: true, cacheTtlMs: 7200000, maxEntries: 100 };

test('messageFingerprint: 容忍 tool_call id 与首尾空白,区分不同内容,空消息返回 null', () => {
  const a = { role: 'assistant', content: 'hi', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] };
  const b = { role: 'assistant', content: '  hi  ', tool_calls: [{ id: 'other-id', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] };
  const c = { role: 'assistant', content: 'different', tool_calls: [] };
  assert.equal(proxy.messageFingerprint(a), proxy.messageFingerprint(b)); // id/空白不影响
  assert.notEqual(proxy.messageFingerprint(a), proxy.messageFingerprint(c));
  assert.equal(proxy.messageFingerprint({ role: 'assistant', content: '' }), null); // 空消息无法关联
  assert.equal(proxy.messageFingerprint({ role: 'user', content: 'x' }), null);
});

test('extractAssistantFromSse: 累积 reasoning_content 并重组分片 tool_calls', () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"more"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_","arguments":"{\\"pa"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}',
    'data: [DONE]',
    '',
  ].join('\n');
  const msg = proxy.extractAssistantFromSse(sse);
  assert.equal(msg.reasoning_content, 'think more');
  assert.deepEqual(msg.tool_calls, [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }]);
  assert.equal(proxy.extractAssistantFromSse('data: [DONE]\n'), null);
});

test('extractAssistantFromJson: 取 choices[0].message;非 JSON 返回 null', () => {
  const msg = proxy.extractAssistantFromJson('{"choices":[{"message":{"role":"assistant","content":"x","reasoning_content":"rc"}}]}');
  assert.equal(msg.reasoning_content, 'rc');
  assert.equal(proxy.extractAssistantFromJson('not json'), null);
});

test('replayReasoning: 回填已缓存项;无 tools 或无非 JSON 时原样返回', () => {
  const cache = proxy.createReasoningCache();
  const upstreamMsg = { role: 'assistant', content: 'done', reasoning_content: 'RC-TEXT', tool_calls: [{ type: 'function', function: { name: 'grep', arguments: '{"p":"x"}' } }] };
  assert.equal(proxy.rememberReasoning(cache, upstreamMsg, RCFG), true);

  const clientMsg = { role: 'assistant', content: 'done', tool_calls: [{ type: 'function', function: { name: 'grep', arguments: '{"p":"x"}' } }] }; // 无 rc,模拟 Cursor
  const reqWithTools = Buffer.from(JSON.stringify({ messages: [clientMsg], tools: [{ type: 'function', function: { name: 'grep' } }] }));
  const r = proxy.replayReasoning(reqWithTools, cache, RCFG);
  assert.equal(r.filled, 1);
  assert.equal(JSON.parse(r.body.toString('utf8')).messages[0].reasoning_content, 'RC-TEXT');

  const noTools = proxy.replayReasoning(Buffer.from(JSON.stringify({ messages: [clientMsg] })), cache, RCFG);
  assert.equal(noTools.filled, 0);
  assert.equal(noTools.body.toString('utf8'), JSON.stringify({ messages: [clientMsg] })); // 原样

  const notJson = Buffer.from('not json');
  assert.equal(proxy.replayReasoning(notJson, cache, RCFG).body, notJson); // 原样透传
});

test('replayReasoning: 未命中缓存时计入 missing(供告警观测)', () => {
  const cache = proxy.createReasoningCache();
  const body = Buffer.from(JSON.stringify({ messages: [{ role: 'assistant', content: 'x', tool_calls: [{ type: 'function', function: { name: 'f', arguments: '{}' } }] }], tools: [{ type: 'function', function: { name: 'f' } }] }));
  const r = proxy.replayReasoning(body, cache, RCFG);
  assert.equal(r.filled, 0);
  assert.equal(r.missing, 1);
});

test('recallReasoning: 超过 cacheTtlMs 后不再命中', () => {
  const cache = proxy.createReasoningCache();
  const msg = { role: 'assistant', content: 'c', reasoning_content: 'rc' };
  proxy.rememberReasoning(cache, msg, RCFG);
  const fp = proxy.messageFingerprint(msg);
  assert.equal(proxy.recallReasoning(cache, fp, RCFG), 'rc');
  cache.entries.get(fp).createdAt -= RCFG.cacheTtlMs + 1; // 使其过期
  assert.equal(proxy.recallReasoning(cache, fp, RCFG), null);
});

test('rememberReasoning: 超过 maxEntries 时淘汰最旧条目', () => {
  const cache = proxy.createReasoningCache();
  const small = { ...RCFG, maxEntries: 2 };
  for (const n of ['a', 'b', 'c']) proxy.rememberReasoning(cache, { role: 'assistant', content: n, reasoning_content: 'rc-' + n }, small);
  assert.equal(cache.entries.size, 2);
  assert.equal(proxy.recallReasoning(cache, proxy.messageFingerprint({ role: 'assistant', content: 'a' }), small), null); // 最旧被淘汰
});

test('injectThinkingDisabled / looksLikeReasoningError', () => {
  const out = proxy.injectThinkingDisabled(Buffer.from(JSON.stringify({ messages: [], tools: [] })));
  assert.deepEqual(JSON.parse(out.toString('utf8')).thinking, { type: 'disabled' });
  assert.equal(proxy.injectThinkingDisabled(Buffer.from('not json')), null); // 不可解析 → null
  assert.equal(proxy.looksLikeReasoningError('The reasoning_content in the thinking mode must be passed back'), true);
  assert.equal(proxy.looksLikeReasoningError('{"ok":true}'), false);
  assert.equal(proxy.looksLikeReasoningError(undefined), false);
});

test('proxyRequest(B): 上游 400 提及 reasoning_content 时注入 thinking=disabled 重发一次', async (t) => {
  const attempts = [];
  const up = await startFakeUpstream((rq, rs) => {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => {
      const j = JSON.parse(b);
      const disabled = !!(j.thinking && j.thinking.type === 'disabled');
      attempts.push({ disabled, toolsKept: Array.isArray(j.tools) && j.tools.length > 0, model: j.model });
      rs.writeHead(disabled ? 200 : 400, { 'content-type': 'application/json' });
      rs.end(disabled ? '{"ok":true}' : JSON.stringify({ error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API.' } }));
    });
  });
  const px = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false }, reasoning: RCFG });
  t.after(() => closeSrv(px.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'x' } }] }));
  assert.equal(res.status, 200);        // 客户端全程看不到 400
  assert.equal(res.body, '{"ok":true}');
  assert.equal(attempts.length, 2);     // 首次 + 重试
  assert.equal(attempts[0].disabled, false);
  assert.equal(attempts[1].disabled, true);
  assert.equal(attempts[1].toolsKept, true); // 重试保留 tools
  assert.equal(attempts[1].model, 'deepseek-v4-flash'); // 其余字段不变
});

test('proxyRequest(B): 与 reasoning 无关的 400 原样透传,不重试', async (t) => {
  let hits = 0;
  const up = await startFakeUpstream((rq, rs) => {
    hits += 1;
    rq.resume();
    rs.writeHead(400, { 'content-type': 'application/json' });
    rs.end('{"error":{"message":"some unrelated bad request"}}');
  });
  const px = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false }, reasoning: RCFG });
  t.after(() => closeSrv(px.srv));
  t.after(() => closeSrv(up.srv));
  const res = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, '{"model":"m","messages":[]}');
  assert.equal(res.status, 400);
  assert.equal(res.body, '{"error":{"message":"some unrelated bad request"}}'); // 原样
  assert.equal(hits, 1); // 未重试
});

test('proxyRequest(A): 缓存上游 reasoning_content 并在下轮请求回填', async (t) => {
  const rcText = 'Let me read the file first.';
  const rcSeen = [];
  const up = await startFakeUpstream((rq, rs) => {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => {
      const j = JSON.parse(b);
      rcSeen.push((j.messages || []).filter((m) => m.role === 'assistant').map((m) => m.reasoning_content || null));
      rs.writeHead(200, { 'content-type': 'application/json' });
      if (rcSeen.length === 1) {
        rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done', reasoning_content: rcText, tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] } }] }));
      } else {
        rs.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
      }
    });
  });
  const px = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false }, reasoning: RCFG });
  t.after(() => closeSrv(px.srv));
  t.after(() => closeSrv(up.srv));
  // 第 1 轮:建立缓存
  const r1 = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'read_file' } }] }));
  assert.equal(r1.status, 200);
  // 第 2 轮:带上一轮的 assistant 消息但不含 reasoning_content(模拟 Cursor 行为)
  const r2 = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ model: 'm', messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done', tool_calls: [{ type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
    ], tools: [{ type: 'function', function: { name: 'read_file' } }] }));
  assert.equal(r2.status, 200);
  assert.deepEqual(rcSeen[1], [rcText]); // 代理已把 reasoning_content 补回
});

test('proxyRequest: 上游 4xx 错误体写入日志(401 得以确诊),且响应仍原样透传', async (t) => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => {
      rq.resume();
      rs.writeHead(401, { 'content-type': 'application/json' });
      rs.end('{"error":{"message":"invalid api key or subscription expired"}}');
    });
    const px = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false }, reasoning: RCFG });
    t.after(() => closeSrv(px.srv));
    t.after(() => closeSrv(up.srv));
    const res = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, '{}');
    assert.equal(res.status, 401);
    assert.equal(res.body, '{"error":{"message":"invalid api key or subscription expired"}}'); // 客户端仍拿到完整错误体
  } finally {
    console.warn = origWarn;
  }
  const all = warns.join('\n');
  assert.ok(all.includes('[upstream] 401 body:'), 'should log the upstream error body for diagnosis');
  assert.ok(all.includes('subscription expired'));
});

test('proxyRequest: log.upstreamErrors=false 时不打印上游错误体(仍原样透传)', async (t) => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const up = await startFakeUpstream((rq, rs) => {
      rq.resume();
      rs.writeHead(500, { 'content-type': 'application/json' });
      rs.end('{"error":{"message":"boom-secret"}}');
    });
    const px = await startProxy({ baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session, log: { headers: false, body: false, upstreamErrors: false }, reasoning: RCFG });
    t.after(() => closeSrv(px.srv));
    t.after(() => closeSrv(up.srv));
    const res = await req(px.port, { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, '{}');
    assert.equal(res.status, 500);
    assert.equal(res.body, '{"error":{"message":"boom-secret"}}');
  } finally {
    console.warn = origWarn;
  }
  assert.ok(!warns.join('\n').includes('boom-secret'));
});

// ---------- 任务 5:隧道管理器 ----------

const { EventEmitter } = require('node:events');

function makeFakeSpawn() {
  const children = [];
  const calls = [];
  const spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const c = new EventEmitter();
    c.kill = () => { c.killed = true; };
    children.push(c);
    return c;
  };
  return { spawn, calls, children };
}

test('startTunnel: 按 buildTunnelArgs 拉起子进程', () => {
  const fake = makeFakeSpawn();
  const cfg = {
    log: { tunnel: false },
    tunnel: { enabled: true, binary: 'cloudflared', name: 'cursor-proxy', configFile: '', restartDelayMs: 5000 },
  };
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  try {
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].bin, 'cloudflared');
    assert.deepEqual(fake.calls[0].args, ['tunnel', 'run', 'cursor-proxy']);
    assert.equal(fake.calls[0].opts.stdio, 'ignore'); // log.tunnel=false 时静音
  } finally {
    tun.stop();
  }
});

test('startTunnel: log.tunnel=true 时透传子进程输出(stdio=inherit)', () => {
  const fake = makeFakeSpawn();
  const cfg = {
    log: { tunnel: true },
    tunnel: { enabled: true, binary: 'cloudflared', name: 't', configFile: 'C:/cf/config.yml', restartDelayMs: 5000 },
  };
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  try {
    assert.equal(fake.calls[0].opts.stdio, 'inherit');
    assert.deepEqual(fake.calls[0].args, ['tunnel', '--config', 'C:/cf/config.yml', 'run', 't']);
  } finally {
    tun.stop();
  }
});

test('startTunnel: 子进程异常退出后按 restartDelayMs 重启', async (t) => {
  const fake = makeFakeSpawn();
  const cfg = {
    log: { tunnel: false },
    tunnel: { enabled: true, binary: 'cloudflared', name: 't', configFile: '', restartDelayMs: 20 },
  };
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  t.after(() => tun.stop());
  assert.equal(fake.calls.length, 1);
  // 真实子进程退出时触发 'exit' + 'close';ENOENT 时只触发 'error' + 'close'。
  // 管理器监听 'close' 以统一覆盖两种情况(探针实测)。
  fake.children[0].emit('close', 1, null);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.calls.length, 2, 'should relaunch after abnormal exit');
});

test('startTunnel: stop() 终止子进程且不再重启', async (t) => {
  const fake = makeFakeSpawn();
  const cfg = {
    log: { tunnel: false },
    tunnel: { enabled: true, binary: 'cloudflared', name: 't', configFile: '', restartDelayMs: 20 },
  };
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  tun.stop();
  assert.equal(fake.children[0].killed, true);
  fake.children[0].emit('close', 0, null);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.calls.length, 1, 'should not relaunch after stop');
});

test('startTunnel: 二进制不存在(ENOENT)不无限重启,代理仍正常服务', async (t) => {
  const up = await startFakeUpstream((rq, rs) => rs.end('ok'));
  t.after(() => closeSrv(up.srv));
  const cfg = {
    baseUrl: `http://127.0.0.1:${up.port}`, apiKey: 'k', session: VALID.session,
    log: { headers: false, body: false, tunnel: false },
    tunnel: { enabled: true, binary: 'cop-nonexistent-binary-xyz', name: 't', configFile: '', restartDelayMs: 20 },
  };
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const tun = proxy.startTunnel(cfg, {});
  t.after(() => tun.stop());
  try {
    const p = await startProxy(cfg);
    t.after(() => closeSrv(p.srv));
    const res = await req(p.port, { method: 'POST', path: '/v1/chat/completions', headers: {} }, '{}');
    assert.equal(res.status, 200);   // 隧道挂掉不影响代理
    assert.equal(res.body, 'ok');
    await new Promise((r) => setTimeout(r, 120)); // 等 spawn 的 ENOENT 暴露
    assert.ok(errs.join('\n').includes('cop-nonexistent-binary-xyz'), 'should report the missing binary');
  } finally {
    console.error = origErr;
  }
});

test('startTunnel: ENOENT 只 spawn 一次,不无限重启(断言 spawn 次数)', async (t) => {
  const fake = makeFakeSpawn();
  const cfg = {
    log: { tunnel: false },
    tunnel: { enabled: true, binary: 'cop-missing', name: 't', configFile: '', restartDelayMs: 20 },
  };
  const origErr = console.error;
  console.error = () => {}; // 抑制预期的错误信息,避免污染测试输出
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  t.after(() => { tun.stop(); console.error = origErr; });
  const child = fake.children[0];
  // 模拟真实的 ENOENT 事件序:'error'(code=ENOENT) 后跟 'close'
  child.emit('error', Object.assign(new Error('spawn cop-missing ENOENT'), { code: 'ENOENT' }));
  child.emit('close', -2, null);
  await new Promise((r) => setTimeout(r, 200)); // 远大于 restartDelayMs*2
  console.error = origErr;
  assert.equal(fake.calls.length, 1, 'ENOENT must not trigger relaunch');
  assert.equal(tun.state.restarts, 0, 'restarts must stay 0 on ENOENT');
});

test('startTunnel: 致命 spawn 错误(EACCES)同样不无限重启', async (t) => {
  const fake = makeFakeSpawn();
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  const cfg = {
    log: { tunnel: false },
    tunnel: { enabled: true, binary: 'cop-noexec', name: 't', configFile: '', restartDelayMs: 20 },
  };
  const tun = proxy.startTunnel(cfg, { spawn: fake.spawn });
  t.after(() => { tun.stop(); console.error = origErr; });
  fake.children[0].emit('error', Object.assign(new Error('spawn cop-noexec EACCES'), { code: 'EACCES' }));
  fake.children[0].emit('close', -2, null);
  await new Promise((r) => setTimeout(r, 200));
  console.error = origErr;
  assert.equal(fake.calls.length, 1, 'EACCES must not trigger relaunch');
});
