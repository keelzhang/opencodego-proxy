[English](README.md) | [简体中文](README.zh-CN.md)

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

该地址与访问令牌都不需要手工查:启动日志会把两项都打印出来,照抄即可。

```
Cursor Base URL: https://proxy.example.com/v1  (ingress hostname "proxy.example.com" from C:\Users\<用户名>\.cloudflared\config.yml)
Cursor API Key:  <config.json 中 auth.token 的值>  (not the upstream apiKey)
```

抽取规则:取 `ingress` 中第一条带 `hostname` 的项;若有多条,优先取 `service` 端口与 `port` 一致的那条(末尾的 catch-all 项没有 hostname,天然被忽略)。读不到文件或没有 hostname 时只打印提示、不中断启动,此时按上表手工填写。仅支持 block style 的 `ingress`(即「公网接入」示例的写法),flow style(`- {hostname: x}`)与多行标量不会被解析。

**`Cursor API Key` 一行是明文打印 `auth.token` 的**,便于直接复制;**上游 `apiKey` 不会被打印到任何日志**,不要把两者混淆。若日志可能被他人看到或截图外传,请自行判断是否接受该明文暴露(`auth.token` 泄露即等于他人可经隧道消耗你的上游额度)。`auth.enabled: false` 时该行照常打印,但不含令牌值,只提示可填任意非空值。

## 会话头与 session 策略

Cursor 的 BYOK 覆盖端点**不带任何会话标识**——这是官方确认的现状,不是本代理的可见性问题:

> "Cursor does not currently send conversation or agent identity headers (or equivalent metadata) on requests to a custom OpenAI-compatible base URL. Outbound calls to that override path effectively only carry the provider auth you'd expect, so a gateway sees anonymous completions and has to reassemble sessions after the fact."
>
> —— Cursor Staff,[forum.cursor.com topic 166994](https://forum.cursor.com/t/grouping-requests-into-conversations-using-an-api-gateway/166994)

该功能请求处于 tracking 状态、无时间表(同帖 post #7);论坛亦无「用户自配自定义请求头」的支持项。而上游 OpenCode Go 明确要求客户端 `Send a stable session ID in x-opencode-session for each conversation so we can optimize routing and prompt caching`([opencode.ai/docs/go](https://opencode.ai/docs/go/))。

因此 `auto` 策略的实际行为是:

1. 按顺序探测 `x-session-id` → `x-client-session-id` → `x-request-id`(Cursor 目前一个都不发);
2. **一个都探测不到时**回落到设备级兜底头 `cf-warp-tag-id`(Cloudflare 注入,跨请求稳定);
3. 连兜底头也没有(例如不经 Cloudflare 直连)才降级为每请求新 UUID。

代价与边界: 同一设备的所有 Cursor 对话会共用同一个上游 session——这是**过渡妥协**(换取 routing 与 prompt caching 的复用,代价是对话之间不再区分)。一旦请求中出现任何真实会话头,兜底头立即不参与,不会污染更精确的映射。日志中设备级兜底标注为 `cf-warp-tag-id(device)=…`。

更精确的做法(同一对话复用、不同对话区分)需按请求体 `messages` 前缀指纹生成会话键,这要求解析 body,与当前「原样透传、不解析」的设计冲突,尚未实现。

### 映射表的生命周期(为什么隔一晚 session 就变了)

即使 `cf-warp-tag-id` 一直没变,注入的 `x-opencode-session` 也可能换新。有两种成因,都与设备标识无关:

1. **TTL 到期(`session.ttlMs`,滑动窗口)。** 判定与续期在 `resolveSession`:`now - createdAt < ttlMs` 才算命中,而每次命中都会把 `createdAt` 刷新为当前时间。因此**相邻两次请求间隔小于 `ttlMs` 就持续续期、永不换新;一旦停用超过 `ttlMs`,下一条请求即生成新 UUID**。代码内置默认 2 小时对"隔夜使用"必然失效,故 `config.example.json` 与本地 `config.json` 均取 7 天(`604800000`)。
2. **代理进程重启。** 映射表是纯内存 `Map`(`createSessionManager`),不落盘。重启进程或重启机器后,同一个 `cf-warp-tag-id` 也会拿到新 UUID——这一条**调大 `ttlMs` 解决不了**。

区分方法:看日志里有没有新的启动横幅(`cursor-opencode-proxy listening on …`)。没有横幅、只有 `-> x-opencode-session=` 变了,是 TTL 到期;有横幅,则是进程重启。另外 `cleanupSessionMap` 每小时回收过期条目,其删除条件与判定条件相同,只释放内存,不改变上述行为。

> `session.*` 支持热重载:改 `ttlMs` 保存即生效,无需重启;映射表中按新 `ttlMs` 仍算未过期的旧条目会继续复用。

### DeepSeek thinking 与 reasoning_content(长会话 400 的处置)

若上游是 DeepSeek 系模型,会出现一种**长会话才触发**的 400:

```
Error from provider (Console Go): Upstream request failed:
[invalid_request_error] The `reasoning_content` in the thinking mode must be passed back to the API.
```

原因(见 DeepSeek 官方 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)):

- thinking 模式**默认开启**(默认 effort `high`),客户端无需也无法在 Cursor 里配置;
- 只要请求**带 `tools` 参数**,历史每一轮 assistant 消息都必须回传 `reasoning_content`,否则返回 400;
- 而 Cursor 走标准 OpenAI 协议,**不认识也不保留**这个非标准字段,故多轮工具调用累积到一定规模后必然触发(短会话可能一直正常)。

代理提供两级处置(默认都开):

| 配置 | 默认 | 作用 |
|---|---|---|
| reasoning.replay | true | **A**:透传响应时旁路提取 `reasoning_content` 并按 assistant 消息指纹缓存,下次请求回填。Cursor 侧无感,代价是代理需解析 body(解析失败自动原样透传)。 |
| reasoning.fallbackDisabled | true | **B**:若仍收到 400 且错误体提及 `reasoning_content`,自动注入 `thinking:{"type":"disabled"}` 重发一次,成功后客户端无感。代价是该轮起失去 thinking。 |
| reasoning.cacheTtlMs | 7200000 | 缓存存续期(毫秒)。 |
| reasoning.maxEntries | 2000 | 缓存条目上限,超出淘汰最旧。 |

日志会打印 `[reasoning] replayed …`(回填成功)、`[reasoning] cached …`(缓存成功)、`[reasoning] N assistant message(s) … lack cached`(未命中,A 失效)与 `[reasoning] … retrying once with thinking=disabled`(降级 B)。**未命中告警频繁出现**说明会话历史被客户端压缩(compaction)、指纹对不上——此时 A 失效而由 B 兜底,该会话会失去 thinking。

> 想彻底避开:在 Cursor 里换用非 DeepSeek 模型(如 `glm-5.3-flash`)。B 的注入仅在上述 400 出现时发生,不影响其它模型。

**A 的两个固有局限**:

1. **对启用前的历史无效。** A 只能缓存「代理运行期间捕获到的上游响应」。若某会话在启用本功能前就已积累大量工具调用轮次(例如日志中的 `[reasoning] 106 assistant message(s) ... lack cached`),这些轮的 `reasoning_content` 从未被捕获过,A 补不上——**必须从新会话开始才有效**。
2. **客户端压缩(compaction)会使指纹失配**,见上。

两种情况都有 B 兜底,代价是该会话失去 thinking。

### 上游 401 / 其它错误如何确诊

`log.upstreamErrors`(默认开)会把上游返回的 4xx/5xx 响应体写进日志:

```
[upstream] 401 body: {"error":{"message":"..."}}
```

这很关键:代理对错误响应**只透传、不解析**,错误体原本只流向 Cursor;而日志里那行 `[hint] upstream 401: check ... session routing` 只是按状态码给出的**通用猜测,未必是真实原因**(401 更常与鉴权或配额有关,而非 session)。请以 `[upstream] ... body:` 的实际内容为准。

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
| session.ttlMs | 7200000 | 会话 key → 注入 UUID 映射的存续期(毫秒)。滑动窗口:命中即续期,停用超过该值则下次换新(见「映射表的生命周期」);`config.example.json` 已取 604800000(7 天)以适配隔夜使用 |
| log.headers | true | 打印收到的请求头(Authorization 脱敏) |
| log.body | false | 打印请求 body 前 2KB |
| log.tunnel | false | 透传 cloudflared 子进程输出(stdio inherit) |
| log.upstreamErrors | true | 上游返回 4xx/5xx 时把错误体写入日志(截断 1000 字符),便于确诊 401/400 等 |
| reasoning.replay | true | 回填缓存的 `reasoning_content`(方案 A,见「DeepSeek thinking 与 reasoning_content」) |
| reasoning.fallbackDisabled | true | 400 时注入 `thinking=disabled` 重发一次(方案 B) |
| reasoning.cacheTtlMs | 7200000 | reasoning 缓存存续期(毫秒) |
| reasoning.maxEntries | 2000 | reasoning 缓存条目上限 |

- 环境变量 `COP_PORT` / `COP_BASE_URL` / `COP_API_KEY` / `COP_AUTH_TOKEN` 可覆盖对应字段,热重载后依然生效
- `auth.header` 与 `session.header` 不能相同(同名会覆盖上游 Authorization 头导致上游 401),无论鉴权是否开启都会在启动时拒绝
- 修改 `config.json` 保存即热重载;非法配置保留旧配置并告警;端口变更与 `tunnel.*` 变更需重启进程
- 首次启动若无 `config.json`,自动从模板复制后退出

## 升级注意

本版本有四处行为变化值得注意:

1. **`auto` 策略新增设备级兜底头。** 当一个会话头都探测不到时(正是 Cursor 的实况),改用 `cf-warp-tag-id` 作为会话键,于是同一设备的请求不再每请求新 UUID,而是复用同一个上游 session;连该头也没有时仍降级为每请求新 UUID。语义与出处见「会话头与 session 策略」。
2. **`session.ttlMs` 的取值由 2 小时改为 7 天(`604800000`)。** 该值是滑动窗口的存续期,停用超过它就会换新注入的 session;原 2 小时意味着隔夜后必然换新,使上游的 session routing / prompt caching 归零。代码内置默认未变(仍为 `7200000`),改的是 `config.example.json` 模板与本地 `config.json`;需要更长或更短可自行调整,`session.*` 保存即热重载。注意它**解决不了进程重启导致的换新**(映射表在内存中),详见「映射表的生命周期」。
3. **`auth.header` 与 `session.header` 不能同名。** 若旧配置把两者配成同一个字段(例如都为 `x-opencode-session`),启动会被拒绝并报 `config: auth.header and session.header must differ`。原因是 `proxyRequest` 会无条件写入 `headers['authorization'] = Bearer <上游 apiKey>`,随后 `headers[session.header] = <sessionId>` 若与之同名会覆盖上游鉴权头,导致上游 401。请把 `session.header` 改回 `x-opencode-session`(默认值)或另选一个不冲突的名字。
4. **Cursor 的 Base URL 不能再填 `http://127.0.0.1:8787/v1`。** 该做法经查实不可用:Cursor 的 BYOK 请求由 Cursor 服务端代发,其 SSRF 防护会拒绝私有网段并返回 `403 Access to private networks is forbidden`。须改用 cloudflared 命名隧道暴露的公网 HTTPS 地址,见「公网接入」。

## 测试

```
node --test tests/*.js
```
