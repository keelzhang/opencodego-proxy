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
| baseUrl | (必填) | 上游 OpenAI 兼容端点(http/https) |
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
node --test tests/*.js
```
