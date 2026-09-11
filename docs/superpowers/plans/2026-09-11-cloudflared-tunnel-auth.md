# cursor-opencode-proxy 公网隧道 + 鉴权 实现计划

> **面向 AI 代理的工作者：** 必需技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为现有单文件代理新增「访问令牌鉴权」与「cloudflared 命名隧道自动拉起」两项能力，使 Cursor 能通过公网 HTTPS 端点安全接入。

**架构：** 在 `cursor-opencode-proxy.js` 内新增两个单元——鉴权校验器（纯函数 `checkAuth`）与隧道管理器（`buildTunnelArgs` / `startTunnel` / `stopTunnel`）。鉴权在 `proxyRequest` 最前部短路，通过后沿用既有「纯透传只换头」链路；隧道管理器以子进程方式拉起 cloudflared，失败时降级但不影响代理服务。

**技术栈：** Node.js 22，单文件，零第三方依赖；测试用 `node:test` + `node:assert`。

**规格：** `docs/superpowers/specs/2026-09-11-cloudflared-tunnel-auth-design.md`（commit b318fc0）

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `cursor-opencode-proxy.js` | 修改 | 全部运行时逻辑（新增 auth/tunnel 配置解析、`checkAuth`、`buildTunnelArgs`、`startTunnel`/`stopTunnel`，`proxyRequest` 鉴权短路，`main()` 接线） |
| `tests/proxy.test.js` | 修改 | 新增测试（沿用既有辅助函数，不重复定义） |
| `config.example.json` | 修改 | 入库模板，新增 `auth` / `tunnel` 两节（默认关闭） |
| `README.md` | 修改 | 公网接入说明、配置表更新、修订「Base URL 填 127.0.0.1」的过时说法 |

**关键约束（贯穿所有任务）：**
- 保持单文件、零第三方依赖
- `auth` / `tunnel` 两节缺省时，行为与当前版本完全一致
- 现有 37 个测试必须始终保持全绿

---

## 任务 1：配置加载器扩展（auth 与 tunnel 两节）

**文件：**
- 修改：`cursor-opencode-proxy.js:26-32`（默认 cfg 对象）、`cursor-opencode-proxy.js:62-66`（解析块）
- 测试：`tests/proxy.test.js`（追加到文件末尾）

- [ ] **步骤 1：编写失败的测试**

在 `tests/proxy.test.js` 末尾追加：

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/proxy.test.js`
预期：新测试 FAIL（`cfg.auth` 为 `undefined`，报 `Cannot read properties of undefined`），其余 37 个 PASS。

- [ ] **步骤 3：编写最少实现代码**

修改 `cursor-opencode-proxy.js` 中的默认 cfg 对象（约第 26-32 行），在 `apiKey: ''` 之后插入两节：

```js
  const cfg = {
    port: 8787,
    baseUrl: '',
    apiKey: '',
    auth: { enabled: false, header: 'authorization', token: '' },
    tunnel: { enabled: false, binary: 'cloudflared', name: 'cursor-proxy', configFile: '', restartDelayMs: 5000 },
    session: { strategy: 'auto', header: 'x-opencode-session', staticId: '00000000-0000-4000-8000-000000000000', ttlMs: 7200000 },
    log: { headers: true, body: false, tunnel: false },
  };
```

在 `if (parsed.session ...)` 块结束之后、`if (parsed.log ...)` 之前插入解析逻辑：

```js
  if (parsed.auth && typeof parsed.auth === 'object') {
    if (typeof parsed.auth.enabled === 'boolean') cfg.auth.enabled = parsed.auth.enabled;
    if (typeof parsed.auth.header === 'string' && parsed.auth.header) cfg.auth.header = parsed.auth.header;
    if (!/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(cfg.auth.header)) {
      throw new Error(`config: invalid auth.header: ${JSON.stringify(cfg.auth.header)} (must be an HTTP field-name token)`);
    }
    if (typeof parsed.auth.token === 'string') cfg.auth.token = parsed.auth.token;
  }
  if (typeof env.COP_AUTH_TOKEN === 'string' && env.COP_AUTH_TOKEN) cfg.auth.token = env.COP_AUTH_TOKEN;
  // 开鉴权却空令牌 = 以为受保护实则全开放,启动即拒绝
  if (cfg.auth.enabled && !cfg.auth.token) {
    throw new Error('config: auth.enabled is true but auth.token is empty (set auth.token in config.json or COP_AUTH_TOKEN env)');
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
```

并把 `log` 解析块补上 `tunnel` 字段：

```js
  if (parsed.log && typeof parsed.log === 'object') {
    if (typeof parsed.log.headers === 'boolean') cfg.log.headers = parsed.log.headers;
    if (typeof parsed.log.body === 'boolean') cfg.log.body = parsed.log.body;
    if (typeof parsed.log.tunnel === 'boolean') cfg.log.tunnel = parsed.log.tunnel;
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/proxy.test.js`
预期：全部 PASS（37 旧 + 7 新 = 44）。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 配置加载器支持 auth/tunnel 两节(缺省向后兼容)"
```

---

## 任务 2：checkAuth 鉴权校验纯函数

**文件：**
- 修改：`cursor-opencode-proxy.js`（新增函数 + 导出）
- 测试：`tests/proxy.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/proxy.test.js`
预期：新测试 FAIL，报 `proxy.checkAuth is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `cursor-opencode-proxy.js` 顶部 `randomUUID` 引入处补上 `crypto`：把

```js
const { randomUUID } = require('node:crypto');
```

改为

```js
const crypto = require('node:crypto');
const { randomUUID } = crypto;
```

在 `filterHeaders` 函数（约第 83-89 行）之后新增：

```js
// 常量时间令牌比对:先 sha256 归一化为等长摘要,再 timingSafeEqual,避免长度与时序泄露
function checkAuth(authCfg, headers) {
  if (!authCfg || !authCfg.enabled) return true;
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
```

在文件末尾 `module.exports` 中加入 `checkAuth`：

```js
module.exports = {
  loadConfig, buildUpstreamPath, filterHeaders, createSessionManager, resolveSession,
  createHotReloader, proxyRequest, createServer, applyHotConfig, cleanupSessionMap, watchConfig,
  checkAuth,
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/proxy.test.js`
预期：全部 PASS（44 旧 + 5 新 = 49）。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 新增 checkAuth 常量时间访问令牌校验纯函数"
```

---

## 任务 3：鉴权接入 proxyRequest（401 短路）

**文件：**
- 修改：`cursor-opencode-proxy.js:146-150`（`proxyRequest` 开头）
- 测试：`tests/proxy.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/proxy.test.js`
预期：鉴权相关新测试 FAIL（错误令牌返回 200 而非 401），其余 PASS。

- [ ] **步骤 3：编写最少实现代码**

修改 `proxyRequest`（约第 146-150 行），在函数体最前面插入鉴权短路：

```js
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
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/proxy.test.js`
预期：全部 PASS（49 旧 + 5 新 = 54）。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: proxyRequest 接入鉴权短路(401 不转发上游)"
```

---

## 任务 4：buildTunnelArgs 隧道参数纯函数

**文件：**
- 修改：`cursor-opencode-proxy.js`（新增函数 + 导出）
- 测试：`tests/proxy.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

```js
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/proxy.test.js`
预期：新测试 FAIL，报 `proxy.buildTunnelArgs is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `checkAuth` 之后新增：

```js
// cloudflared 参数拼装:独立成纯函数便于单测
function buildTunnelArgs(tunnelCfg) {
  const args = ['tunnel'];
  if (tunnelCfg.configFile) args.push('--config', tunnelCfg.configFile);
  args.push('run', tunnelCfg.name);
  return args;
}
```

在 `module.exports` 中加入 `buildTunnelArgs`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/proxy.test.js`
预期：全部 PASS（54 旧 + 2 新 = 56）。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 新增 buildTunnelArgs 隧道参数拼装纯函数"
```

---

## 任务 5：隧道管理器 startTunnel / stopTunnel

**文件：**
- 修改：`cursor-opencode-proxy.js`（新增函数 + 导出 + 顶部引入 child_process）
- 测试：`tests/proxy.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

```js
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
  await new Promise((r) => setTimeout(r, 80));
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
  await new Promise((r) => setTimeout(r, 80));
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test tests/proxy.test.js`
预期：新测试 FAIL，报 `proxy.startTunnel is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `cursor-opencode-proxy.js` 顶部的 require 区加入：

```js
const childProcess = require('node:child_process');
```

在 `buildTunnelArgs` 之后新增：

```js
// 隧道子进程管理:崩溃按延迟重启;二进制缺失(ENOENT)只报错不重启(重启无意义);
// 任何失败都不影响代理自身对外服务。
// 监听 'close' 而非 'exit':探针实测——子进程正常退出触发 'exit'+'close',
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
      if (e && e.code === 'ENOENT') spawnFailed = true;
      console.error(`[tunnel] cannot start "${tunnelCfg.binary}": ${e.message} -- install cloudflared or fix tunnel.binary; proxy keeps serving`);
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
```

在 `module.exports` 中加入 `startTunnel`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test tests/proxy.test.js`
预期：全部 PASS（56 旧 + 5 新 = 61）。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js tests/proxy.test.js
git commit -m "feat: 新增隧道管理器(自动拉起/崩溃重启/退出清理/缺失降级)"
```

---

## 任务 6：main() 接线、配置模板与 README

**文件：**
- 修改：`cursor-opencode-proxy.js:249-286`（`main()`）
- 修改：`config.example.json`
- 修改：`README.md`

- [ ] **步骤 1：修改 main() 接线隧道与退出清理**

在 `main()` 中，`srv.listen(...)` 回调内追加鉴权/隧道状态打印，并在 listen 之后接入隧道与退出处理：

```js
  srv.listen(cfg.port, '127.0.0.1', () => {
    console.log(`cursor-opencode-proxy listening on http://127.0.0.1:${cfg.port} (Cursor Base URL: http://127.0.0.1:${cfg.port}/v1)`);
    console.log(`upstream: ${cfg.baseUrl} | session: ${cfg.session.strategy} via header "${cfg.session.header}"`);
    console.log(cfg.auth.enabled
      ? `auth: enabled via header "${cfg.auth.header}"`
      : 'auth: disabled (anyone who can reach this port can use your upstream key)');
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
```

- [ ] **步骤 2：更新 config.example.json**

写入完整内容：

```json
{
  "port": 8787,
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "your-api-key",
  "auth": {
    "enabled": false,
    "header": "authorization",
    "token": ""
  },
  "tunnel": {
    "enabled": false,
    "binary": "cloudflared",
    "name": "cursor-proxy",
    "configFile": "",
    "restartDelayMs": 5000
  },
  "session": {
    "strategy": "auto",
    "header": "x-opencode-session",
    "staticId": "00000000-0000-4000-8000-000000000000",
    "ttlMs": 7200000
  },
  "log": { "headers": true, "body": false, "tunnel": false }
}
```

- [ ] **步骤 3：更新 README**

修订「使用」章节中过时的 `127.0.0.1` 直连说法，并新增公网接入章节：

````markdown
## 使用

1. 复制 `config.example.json` 为 `config.json`,填入 `baseUrl` 与 `apiKey`
2. `node cursor-opencode-proxy.js`
3. 见下方「Cursor 接入」

> **重要:Cursor 无法直连 `127.0.0.1`。** Cursor 的 BYOK 请求由 **Cursor 服务器**代为发起
> (prompt building、context、Tab、Agent 均在服务端),因此 `127.0.0.1` 在 Cursor 服务器视角
> 指向它自己,会被其 SSRF 防护拦截并返回 `403 Access to private networks is forbidden`。
> Base URL 必须是**公网可达的 HTTPS 端点**,详见「公网接入」。

## 公网接入(cloudflared 命名隧道)

### 一次性准备(需域名 DNS 已托管在 Cloudflare)

```
cloudflared tunnel login
cloudflared tunnel create cursor-proxy
cloudflared tunnel route dns cursor-proxy proxy.example.com
```

准备 `config.yml`(Windows 路径示例):

```yaml
tunnel: cursor-proxy
credentials-file: C:\Users\<用户名>\.cloudflared\<隧道UUID>.json
ingress:
  - hostname: proxy.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

> `ingress[0].service` 的端口必须与代理 `port` 一致。

### 启用

在 `config.json` 中设置:

```json
"auth":   { "enabled": true, "header": "authorization", "token": "<自定义访问令牌>" },
"tunnel": { "enabled": true, "binary": "cloudflared", "name": "cursor-proxy", "configFile": "C:/Users/<用户名>/.cloudflared/config.yml" }
```

重启代理,它会自动拉起 cloudflared。二进制缺失或拉起失败时**代理仍照常对外服务**,仅打印报错。

### 为何不用快速隧道(TryCloudflare)

Cloudflare 官方文档明确 `Quick Tunnels do not support Server-Sent Events (SSE)`,且限制 200 并发;
cloudflared 贡献者也证实 SSE 仅在**命名隧道**下工作。SSE 流式透传是本项目第一目标,故只支持命名隧道。

## Cursor 接入

| Cursor 设置项 | 值 |
|---|---|
| Override OpenAI Base URL | `https://proxy.example.com/v1` |
| OpenAI API Key | `auth.token` 的值(**不是**上游 `apiKey`) |
```

在「配置」表格中追加：

```markdown
| auth.enabled | false | 是否启用访问令牌鉴权 |
| auth.header | authorization | 承载令牌的请求头名 |
| auth.token | (空) | 访问令牌;enabled=true 时不可为空 |
| tunnel.enabled | false | 是否自动拉起 cloudflared |
| tunnel.binary | cloudflared | 可执行文件名或绝对路径 |
| tunnel.name | cursor-proxy | 命名隧道名 |
| tunnel.configFile | (空) | cloudflared 配置文件路径;空则用默认位置 |
| tunnel.restartDelayMs | 5000 | 异常退出后的重启延迟 |
| log.tunnel | false | 是否把 cloudflared 输出透传到代理 stdout |
```

并在环境变量说明处补上 `COP_AUTH_TOKEN`。

- [ ] **步骤 4：运行完整测试套件验证**

运行：`node --test tests/*.js`
预期：全部 PASS（61 个），无 FAIL。

- [ ] **步骤 5：Commit**

```bash
git add cursor-opencode-proxy.js config.example.json README.md
git commit -m "feat: main 接线隧道启停与退出清理;更新配置模板与 README"
```

---

## 验收检查

- [ ] **全量测试通过**：`node --test tests/*.js` → 61 passed / 0 failed
- [ ] **向后兼容**：`config.json` 不含 `auth` / `tunnel` 时，代理行为与改动前一致（覆盖于任务 1、3 的测试）
- [ ] **鉴权隔离**：Cursor 侧令牌与上游 `apiKey` 不同，验证于任务 3 的 `seenAuth === 'Bearer up-key'` 断言
- [ ] **降级安全**：隧道二进制缺失时代理仍返回 200，验证于任务 5 的 ENOENT 测试
- [ ] **手工验收（需真实 cloudflared 与域名，不入自动化）**：
  1. 启动代理，确认 cloudflared 子进程被拉起
  2. Cursor 填公网 Base URL + 访问令牌，完成一轮流式对话，确认 SSE 逐字输出且代理日志有记录
  3. `curl` 不带令牌访问公网地址 → 401
  4. 关闭代理，确认 cloudflared 子进程一并退出
