# cursor-opencode-proxy

OpenCode Go 后端启用强制 session routing(要求 `x-opencode-session` 头)后,Cursor 因无法配置自定义请求头而无法直连。本代理在本地替 Cursor 注入该头,SSE 流式原样透传,并通过 cloudflared 命名隧道把本地端口暴露为公网 HTTPS 端点供 Cursor 接入。

## 使用

1. 复制 `config.example.json` 为 `config.json`,填入 `baseUrl` 与 `apiKey`
2. `node cursor-opencode-proxy.js`
3. 通过 cloudflared 命名隧道把本地端口暴露为公网 HTTPS 端点(见「公网接入」),把该 HTTPS 地址(而非 `127.0.0.1`)作为 Cursor 的 Base URL
4. 对话;`log.headers: true` 时控制台可见 Cursor 实际发送的会话头

> **重要:Cursor 无法直连 127.0.0.1。** Cursor 的 BYOK 请求由 Cursor 服务器代为发起(prompt building、context、Tab、Agent 均在服务端),因此 127.0.0.1 在 Cursor 服务器视角指向它自己,会被其 SSRF 防护拦截并返回 `403 Access to private networks is forbidden`。Base URL 必须是公网可达的 HTTPS 端点。

## 公网接入(cloudflared 命名隧道)

### 一次性准备(需域名 DNS 已托管在 Cloudflare)

```
cloudflared tunnel login
cloudflared tunnel create cursor-proxy
cloudflared tunnel route dns cursor-proxy proxy.example.com
```

### config.yml 示例(Windows 路径)

```yaml
tunnel: cursor-proxy
credentials-file: C:\Users\<用户名>\.cloudflared\<隧道UUID>.json
ingress:
  - hostname: proxy.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

> `ingress[0].service` 的端口必须与代理 `port` 一致(上例为 8787)。

### 启用方式

在 `config.json` 中设置鉴权与隧道:

- `auth.enabled: true` 并填写 `auth.token`(或设置环境变量 `COP_AUTH_TOKEN`)
- `tunnel.enabled: true`,并让 `tunnel.configFile` 指向上面的 `config.yml`

启动代理后会自动拉起 cloudflared;隧道崩溃会自动重启,`cloudflared` 缺失等不可恢复错误只告警不重启,且不影响代理本身对外服务。

### 为何不用快速隧道(TryCloudflare)

官方文档明确 Quick Tunnels do not support Server-Sent Events (SSE) 且限 200 并发;cloudflared 贡献者也证实 SSE 仅在命名隧道下工作。SSE 流式透传是本项目第一目标,故只支持命名隧道。

## Cursor 接入

| Cursor 设置项 | 值 |
|---|---|
| Override OpenAI Base URL | https://proxy.example.com/v1 |
| OpenAI API Key | auth.token 的值(不是上游 apiKey) |

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| port | 8787 | 监听端口(仅 127.0.0.1) |
| baseUrl | (必填) | 上游 OpenAI 兼容端点(http/https) |
| apiKey | (必填) | 上游 API key |
| auth.enabled | false | 是否要求访问令牌才能经本代理调用上游 |
| auth.header | authorization | 携带访问令牌的请求头名 |
| auth.token | "" | 访问令牌(auth.enabled=true 时必填) |
| tunnel.enabled | false | 是否自动拉起 cloudflared 命名隧道 |
| tunnel.binary | cloudflared | cloudflared 可执行文件路径/命令名 |
| tunnel.name | cursor-proxy | 命名隧道名称 |
| tunnel.configFile | "" | cloudflared 配置(config.yml)路径 |
| tunnel.restartDelayMs | 5000 | 隧道崩溃后重启延迟(毫秒) |
| session.strategy | auto | auto / per-request / static |
| session.header | x-opencode-session | 注入的请求头名 |
| session.staticId | 00000000-… | strategy=static 时注入的固定值 |
| session.ttlMs | 7200000 | Cursor 会话 → 注入 UUID 映射的 TTL |
| log.headers | true | 打印收到的请求头(Authorization 脱敏) |
| log.body | false | 打印请求 body 前 2KB |
| log.tunnel | false | 透传 cloudflared 子进程输出(stdio inherit) |

- 环境变量 `COP_PORT` / `COP_BASE_URL` / `COP_API_KEY` / `COP_AUTH_TOKEN` 可覆盖对应字段,热重载后依然生效
- `auth.header` 与 `session.header` 不能相同(同名会覆盖上游 Authorization 头导致上游 401),无论鉴权是否开启都会在启动时拒绝
- 修改 `config.json` 保存即热重载;非法配置保留旧配置并告警;端口变更与 `tunnel.*` 变更需重启进程
- 首次启动若无 `config.json`,自动从模板复制后退出

## 测试

```
node --test tests/*.js
```
