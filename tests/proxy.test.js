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
