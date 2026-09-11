# cursor-opencode-proxy 公网隧道 + 鉴权 设计文档

- 日期:2026-09-11
- 状态:已批准(设计阶段)
- 技术栈:Node.js 22 单文件,零第三方依赖
- 关系:本文档是对 `2026-09-08-cursor-opencode-proxy-design.md` 的增补,修订其中"不做鉴权"的非目标与"Base URL 指向 127.0.0.1"的接入方式

## 1. 背景与动机

原设计假设 Cursor 可直连本地 `http://127.0.0.1:8787/v1`。实测与官方答复证实该假设不成立:

- Cursor 的 BYOK(自带 Key + 自定义 Base URL)请求**由 Cursor 服务器代为发起**,不在用户本机发出(prompt building、context、Tab、Agent 均在服务端)
- 因此 `127.0.0.1` 在 Cursor 服务器视角指向它自己,被其 SSRF 防护拦截,返回 `403 Access to private networks is forbidden`
- 请求从未到达本机代理,故代理日志对 Cursor 对话**无任何记录**

结论:Base URL 必须是**公网可达的 HTTPS 端点**。本设计通过 cloudflared **命名隧道**(named tunnel)把本地代理暴露为公网 HTTPS,并新增**访问令牌鉴权**防止公网地址被他人盗用消耗上游额度。

### 1.1 为何不用快速隧道(Quick Tunnel)

**快速隧道不可用于本项目。** 依据:

- Cloudflare 官方文档(Quick Tunnels 页):`Quick Tunnels do not support Server-Sent Events (SSE)`;并有 200 并发上限(超出返回 429)
- cloudflared 贡献者实测答复(issue #1449,2025-04-22):SSE `works as expected with named tunnels`,快速隧道失败是 demo 产品的 guardrail,官方建议 `just use named tunnels`
- 长期 SSE 缓冲问题 issue #199(2020 创建)与 #1095(2023 创建)均于 2025-05 关闭,与"命名隧道已修复"相符

SSE 流式透传是本项目第一目标,故**只支持命名隧道,不实现快速隧道**。

## 2. 目标与非目标

### 目标

- 代理启动时按配置自动拉起 cloudflared 命名隧道子进程,免手动开第二个终端
- 子进程崩溃自动重启;代理退出时清理子进程
- 隧道拉起失败(如未安装 cloudflared)时,代理**照常对外服务**并给出可操作的报错
- 新增访问令牌鉴权:未携带正确令牌的请求返回 401,不转发上游
- 鉴权令牌与上游 apiKey 隔离:Cursor 侧填访问令牌,代理校验通过后替换为真正的上游 apiKey
- `auth` / `tunnel` 两节配置缺省时,行为与现有版本**完全一致**(向后兼容)

### 非目标

- **不实现快速隧道**(理由见 1.1)
- 不自动生成 cloudflared 配置或管理隧道凭证:`tunnel login` / `create` / `route dns` 为一次性人工准备,文档给出步骤
- 不做多令牌、用户体系、速率限制、路径白名单
- 不解析/改写 body 与响应内容(沿用"纯透传只换头"的既有取舍)
- 不持久化令牌或隧道状态

## 3. 总体架构

```
                    Cursor 服务器(公网)
                          │  POST https://proxy.example.com/v1/chat/completions
                          │       Authorization: Bearer <访问令牌>
                          ▼
                 Cloudflare 边缘(named tunnel)
                          │
                          │  (隧道连接由本机 ③ 出站建立)
                          ▼
   ┌──────────────────────────────────────────────────────┐
   │            本机代理 127.0.0.1:8787                    │
   │   ┌──────────────────────────────────────┐           │
   │   │ ① 鉴权中间件                          │           │
   │   │    校验 Bearer 令牌;不通过 → 401 且不转发│          │
   │   ├──────────────────────────────────────┤           │
   │   │ ② 既有转发器(纯透传只换头)            │           │
   │   │    换 Authorization 为上游 apiKey       │           │
   │   │    注入 x-opencode-session             │           │
   │   └──────────────────────────────────────┘           │
   │   ┌──────────────────────────────────────┐           │
   │   │ ③ 隧道管理器(新增)                    │           │
   │   │    spawn / 监控 / 重启 cloudflared     │           │
   │   └──────────────────────────────────────┘           │
   └──────────────────────┬───────────────────────────────┘
                          │
                          ▼
              上游 OpenAI 兼容 API(config.baseUrl)
```

处理深度不变:仍在请求侧只做头改写,body 与响应内容一律不碰。

## 4. 组件划分

在单文件 `cursor-opencode-proxy.js` 内**新增两个单元**,不改动既有转发器的核心逻辑:

| 单元 | 职责 | 接口 |
|---|---|---|
| 鉴权校验器 | 按配置校验请求携带的访问令牌;令牌比对用常量时间实现 | `checkAuth(authCfg, headers) → boolean` |
| 隧道管理器 | 拼装 cloudflared 参数;拉起子进程;异常退出后按延迟重启;代理退出时终止子进程 | `buildTunnelArgs(cfg) → string[]`、`startTunnel(cfg, deps) → handle`、`stopTunnel(handle)` |

既有单元(配置加载器、热重载器、Session 管理器、转发器)保持不变,仅在以下两处接入:

- 配置加载器:解析并校验新增的 `auth` / `tunnel` 两节
- 转发器:`proxyRequest` 入口处调用 `checkAuth`,不通过则短路返回 401

## 5. 关键设计细节

### 5.1 鉴权

- **位置**:`proxyRequest` 最前部,早于请求 body 缓冲。未通过直接返回 401,**不读取 body、不转发上游**
- **开关**:`auth.enabled: false`(默认)时完全跳过,鉴权逻辑零开销
- **令牌来源**:请求头 `auth.header`(默认 `authorization`),格式 `Bearer <令牌>`(大小写不敏感匹配 `Bearer`)
- **比对**:双方先经 `sha256` 归一化为等长摘要,再以 `crypto.timingSafeEqual` 比较,避免长度与时序泄露
- **失败响应**:401 + OpenAI 错误格式(复用既有 `sendOpenAIError`),`type: "proxy_error"`,便于 Cursor 直接展示
- **配置校验**:`auth.enabled: true` 而 `auth.token` 为空 → 视为配置非法,启动时拒绝(热重载时保留旧配置并告警),避免"以为开了鉴权实则空令牌"的危险状态

### 5.2 隧道管理器

- **参数构造**:纯函数 `buildTunnelArgs(cfg)` 便于单测
  - 指定 `configFile` → `['tunnel', '--config', <configFile>, 'run', <name>]`
  - 未指定 → `['tunnel', 'run', <name>]`(cloudflared 使用默认 `~/.cloudflared/config.yml`)
- **启动**:`child_process.spawn(binary, args)`,不经过 shell(避免 Windows 命令行转义问题)
- **失败降级**:`error` 事件(`ENOENT`,即未安装/路径错误)→ 打印醒目错误(含官方下载链接与"确认 binary 配置"),**代理继续对外服务**;隧道不可用不等于代理不可用
- **自动重启**:非主动停止的 `exit` → 等待 `restartDelayMs`(默认 5000)后重新拉起;重启计数打印到日志便于排查
- **退出清理**:代理进程退出(`SIGINT` / `SIGTERM` / `exit`)时终止子进程,避免遗留孤儿 cloudflared
- **日志**:子进程 stdout/stderr 默认**静音**(cloudflared 日志量大);`log.tunnel: true` 时透传到代理 stdout

### 5.3 一次性人工准备(命名隧道)

代理**不**自动完成以下步骤,文档给出命令(以 `proxy.example.com` 为例):

```
cloudflared tunnel login
cloudflared tunnel create cursor-proxy
cloudflared tunnel route dns cursor-proxy proxy.example.com
```

并准备配置文件(路径填入 `tunnel.configFile`):

```yaml
tunnel: cursor-proxy
credentials-file: C:\Users\<用户名>\.cloudflared\<隧道UUID>.json
ingress:
  - hostname: proxy.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

**注意**:`ingress[0].service` 的端口必须与代理 `port` 一致。

### 5.4 与 Cursor 的对接

| Cursor 设置项 | 值 |
|---|---|
| Override OpenAI Base URL | `https://proxy.example.com/v1` |
| OpenAI API Key | `auth.token` 的值(**不是**上游 apiKey) |

### 5.5 日志

- 启动时打印隧道状态:已启用且已拉起 / 已禁用 / 拉起失败(含原因)
- 鉴权失败打印一行:时间、方法、路径、来源标记、`401 unauthorized`(不回显收到的令牌)
- 令牌在**所有**日志路径中脱敏(复用既有 `redactHeaders` 思路)

### 5.6 安全

- 访问令牌仅存于 `config.json`(已 gitignore)或环境变量 `COP_AUTH_TOKEN`;入库模板 `config.example.json` 中留空
- 令牌比对为常量时间;令牌不回显、不落日志
- 隧道只以**出站**方式连接 Cloudflare 边缘,不开放入站端口
- 代理仍**只监听 `127.0.0.1`**,公网可达性完全由隧道提供

## 6. 配置文件

新增两节,**均可省略**:

```json
{
  "port": 8787,
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "apiKey": "your-upstream-key",
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
  "session": { "strategy": "auto", "header": "x-opencode-session", "staticId": "00000000-0000-4000-8000-000000000000", "ttlMs": 7200000 },
  "log": { "headers": true, "body": false, "tunnel": false }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| auth.enabled | false | 是否启用访问令牌鉴权 |
| auth.header | authorization | 承载令牌的请求头名 |
| auth.token | (空) | 访问令牌;enabled=true 时不可为空 |
| tunnel.enabled | false | 是否自动拉起 cloudflared |
| tunnel.binary | cloudflared | 可执行文件名或绝对路径 |
| tunnel.name | cursor-proxy | 命名隧道名(`tunnel create` 时创建) |
| tunnel.configFile | (空) | cloudflared 配置文件路径;空则用默认位置 |
| tunnel.restartDelayMs | 5000 | 异常退出后的重启延迟 |
| log.tunnel | false | 是否把 cloudflared 子进程输出透传到代理 stdout(默认静音) |

环境变量 `COP_AUTH_TOKEN` 可覆盖 `auth.token`(与其他环境变量一致,每次重载配置时重新读取)。新增配置项仅 `auth.token` 支持环境变量覆盖——它是唯一像密钥的字段。

**热重载边界**:`auth` / `tunnel` 的字段变更随热重载生效;**隧道进程的启停与参数变更需重启进程**(与既有"端口变更需重启"同类)。

## 7. 测试计划

沿用零依赖 `node --test tests/*.js`,现有 37 个测试必须保持全绿。

1. **鉴权纯函数**(`checkAuth`)
   - `enabled: false` → 一律通过
   - 无该头 / 头为空 / 非 `Bearer` 前缀 / 令牌错误 → 拒绝
   - 令牌正确 → 通过;大小写不同的 `bearer` 前缀 → 通过
   - 长度不同的令牌 → 拒绝且不抛异常(验证 `sha256` 归一化路径)
2. **鉴权端到端**
   - 正确令牌 → 请求到达假上游,响应正常透传
   - 错误令牌 → 返回 401 且**假上游未收到任何请求**(断言上游计数器为 0)
   - `enabled: false` → 无令牌亦可正常透传(向后兼容)
3. **隧道参数构造**(`buildTunnelArgs`)
   - 指定 `configFile` → 含 `--config <path>`
   - 未指定 → 不含 `--config`
4. **隧道降级**
   - `binary` 指向不存在的路径 → 代理仍能正常响应请求(隧道报错不影响服务主体)
5. **配置校验**
   - `auth.enabled: true` 且 `token` 为空 → `loadConfig` 抛错,错误信息指明字段
6. **手工验收**(需真实 cloudflared 与域名,不入自动化)
   - 启动代理,确认 cloudflared 子进程被拉起
   - Cursor 填公网 Base URL + 访问令牌,完成一轮流式对话,确认 SSE 逐字输出、代理日志有记录
   - 用 curl 不带令牌访问公网地址 → 401
   - 关闭代理,确认 cloudflared 子进程一并退出
