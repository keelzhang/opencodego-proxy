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
