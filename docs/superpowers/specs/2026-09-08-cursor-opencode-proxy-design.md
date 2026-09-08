# cursor-opencode-proxy 设计文档

- 日期:2026-09-08
- 状态:已批准(设计阶段)
- 技术栈:Node.js 22 单文件,零第三方依赖

## 1. 背景与动机

OpenCode 的 Go 后端在 2025-09-05 左右启用了**强制 session routing**:请求必须携带 `x-opencode-session` 请求头,否则无法正常路由。而 Cursor 的自定义 OpenAI 端点配置中**没有提供任何自定义请求头的入口**,导致 Cursor 无法直接接入 OpenCode 端点。

本项目在本地运行一个小型代理,替 Cursor 注入 `x-opencode-session`,使 Cursor 能继续通过 OpenAI 兼容端点使用目标模型。

## 2. 目标与非目标

### 目标

- Windows 下运行:`node cursor-opencode-proxy.js` 即可启动,无需 `npm install`
- 支持 SSE streaming:响应逐字节透传,不缓冲、不解析、不重组
- 自动 session 管理:同一 Cursor 会话复用同一个注入的 `x-opencode-session`,新会话生成新 UUID
- Cursor 侧只需把 Base URL 改为 `http://127.0.0.1:<port>/v1`,零其他配置
- 上游可配置:任意 OpenAI 兼容端点(baseUrl + apiKey),换供应商不改代码
- 配置热重载:修改 `config.json` 保存即生效,无需重启进程

### 非目标

- 不做模型名映射:请求 body 中的 `model` 字段原样转发,模型名需上游原样支持
- 不解析/改写响应内容:包括 SSE chunk 内的任何字段
- 不做多用户/鉴权:仅监听 `127.0.0.1`,只服务本机 Cursor
- 不持久化 session 映射:内存 Map + TTL,重启后映射重建(对上游仅表现为新会话)

## 3. 总体架构

```
Cursor (Base URL = http://127.0.0.1:8787/v1)
   │  POST /v1/chat/completions(含 SSE streaming)
   ▼
本地代理(仅监听 127.0.0.1:8787)
   │  1. 打印请求日志(时间/方法/路径/探测到的会话头/注入的 session id)
   │  2. 换头:移除客户端 Authorization,设置 Authorization: Bearer <config.apiKey>
   │  3. 注入 x-opencode-session(按 session 策略)
   │  4. 路径拼接:/v1/xxx → <baseUrl>/xxx
   │  5. 请求 body 整体缓冲后转发(上限 10MB,不解析)
   ▼
上游 OpenAI 兼容 API(config.baseUrl)
   │  响应字节流原样 pipe 回 Cursor(不解析、不缓冲、不重组)
   ▼
Cursor
```

处理深度:**纯透传只换头**——只在请求侧做头改写,body 与响应内容一律不碰。这是有意为之的取舍:放弃模型名映射能力,换取 SSE 转发的最大可靠性(解析 bug 不可能导致流中断)。

## 4. 组件划分

单文件 `cursor-opencode-proxy.js` 内四个单元,各自职责单一:

| 单元 | 职责 | 接口 |
|---|---|---|
| 配置加载器 | 读 `config.json` + 环境变量覆盖;文件不存在时生成模板后退出并提示 | `loadConfig() → config` |
| 热重载器 | `fs.watch` 监听 `config.json`,300ms 防抖;新配置 JSON 非法或字段非法时保留旧配置并告警,服务不中断 | `watchConfig(onChange)` |
| Session 管理器 | 按 `auto` 策略探测 Cursor 会话头并映射到注入的 UUID;内存 Map,2h TTL 定期清理 | `resolveSession(headers) → sessionId` |
| 转发器 | 按协议选 `http`/`https` 模块;过滤 hop-by-hop 头;转发请求并 pipe 响应;客户端断开立即中止上游 | `proxyRequest(req, res, config)` |

## 5. 关键设计细节

### 5.1 路径拼接

- 本地请求路径以 `/v1/` 开头:截取 `/v1` 后的资源段拼到 `baseUrl`(去尾斜杠)后。例:baseUrl 为 `https://api.example.com/v4` 时,`/v1/chat/completions` → `https://api.example.com/v4/chat/completions`
- 不以 `/v1` 开头:原样拼到 `baseUrl` 后(兼容 baseUrl 已含 `/v1` 的写法)

两种 Base URL 写法(`.../v4` 与 `.../v4/v1`)都能正常工作。

### 5.2 Session 管理

**探测顺序**(策略为 `auto` 时):请求头 `x-session-id` → `x-client-session-id` → `x-request-id`,取第一个非空值作为 Cursor 会话 key。

- 命中且 Map 中已有映射:复用已注入的 UUID → 同一 Cursor 会话的所有请求,上游看到同一个 `x-opencode-session`,命中 session routing 的会话亲和
- 命中但无映射:生成新 UUID,存入 Map
- 全部未命中:降级为每请求生成新 UUID,保证功能不中断
- 策略 `per-request`:每请求新 UUID;策略 `static`:所有请求用 `session.staticId`(默认为固定 UUID)

Cursor 版本迭代快,会话头名可能变化;`log.headers: true` 时首次连接即可从日志确认实际头名,如有需要可调整探测列表后热重载。

内存 Map 每小时清理一次,TTL 默认 2h(`session.ttlMs`)。

### 5.3 SSE 流式透传

- 响应侧不做任何缓冲:上游响应到达即通过 `pipe` 回写客户端,Node 默认不缓冲 socket 写入
- 回写上游响应头,但过滤 hop-by-hop 头:`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`(Node 的 `http.request` 已自行管理其中的连接管理类头)
- 客户端断连(Cursor 中断生成):立即 `destroy` 到上游的请求,不悬挂

### 5.4 错误处理

| 场景 | 行为 |
|---|---|
| 上游连接失败/DNS 失败/超时(60s 连接超时) | 返回 502 + OpenAI 错误格式 JSON:`{"error":{"message":"...","type":"proxy_error"}}`,Cursor 能正常显示报错 |
| 上游返回 4xx/5xx | 状态码与 body 原样透传 |
| 上游 4xx 且日志提示疑似缺 session 头 | 醒目日志提示检查 `x-opencode-session` 注入(session routing 拒绝的典型表现) |
| `config.json` 非法 JSON/缺失必填字段 | 热重载时保留旧配置并告警;启动时生成模板后退出 |
| 端口被占用 | 明确报错退出(提示修改 port) |
| 请求 body 超过 10MB | 返回 413 |

### 5.5 日志

- 每请求一行:`时间 方法 路径 探测到的会话头=值(截断) 注入session=uuid 上游状态=code`
- `log.headers: true`(默认):同时打印收到的请求头键值对,用于确认 Cursor 实际发送的头
- `log.body: false`(默认):打开时打印请求 body 前 2KB(仅调试用)
- 日志全部输出到 stdout

### 5.6 安全

- 仅监听 `127.0.0.1`,不对局域网暴露
- `config.json` 含 apiKey,加入 `.gitignore` 不入库;入库模板为 `config.example.json`
- 代理不存储、不回显 apiKey(日志不打印 Authorization)

## 6. 配置文件

`config.json`(与脚本同目录),环境变量 `COP_PORT` / `COP_BASE_URL` / `COP_API_KEY` 可覆盖对应字段:

```json
{
  "port": 8787,
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "apiKey": "your-api-key",
  "session": {
    "strategy": "auto",
    "header": "x-opencode-session",
    "staticId": "00000000-0000-4000-8000-000000000000",
    "ttlMs": 7200000
  },
  "log": { "headers": true, "body": false }
}
```

- `baseUrl` 以上游实际文档为准,示例值仅为格式示意
- `session.header`:注入的请求头名,默认 `x-opencode-session`,可按上游要求调整
- `session.strategy`:`auto`(默认)/ `per-request` / `static`

## 7. 测试计划

1. **端到端假上游**(Python 3.10 标准库脚本,仅用于本地验证,不入库):
   - 返回固定 SSE chunk 流,校验 Cursor 侧收到的流完整、边界正确
   - 回显收到的请求头,校验 `x-opencode-session` 注入正确、同会话复用、新会话新 UUID
   - 修改 config.json 触发热重载,校验新配置生效、非法配置时保留旧配置
   - 客户端中途断连,校验上游侧连接被中止
   - 停掉假上游,校验 502 + OpenAI 错误格式
2. **真实验证**:Cursor Base URL 改为 `http://127.0.0.1:8787/v1`,实际对话一轮,观察日志确认 Cursor 的会话头与 SSE 正常流动
