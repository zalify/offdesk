# 手机预览：浏览器、认证与域名约束补充

日期：2026-09-05。范围：为 Hub → 开发机 loopback 的预览代理提供设计约束；没有修改应用代码、DNS、证书或部署。下面区分官方行为与本项目建议；配置示例不是现有基础设施事实。

## 建议的浏览器入口

每次预览租约分配独立且不复用的 hostname，例如 `p-<random>.example-preview.net`；端口和机器标识保存在 Hub，不能让 URL 任意指定目的主机。单独的可注册域名比与控制台共用母域隔离更充分。如果暂时用 `p-<random>.offdesk.app`，必须把同站跨来源访问作为显式威胁处理。不要把任意开发网页挂在 Hub 的 `/preview/...` 下，否则脚本、存储、Cookie 与 Service Worker 会共享控制台来源，根路径资源也容易出错。

来源规则：不带 Domain 的 Cookie 只发给设置它的主机；`__Host-` 前缀要求 Secure、Path=/ 且没有 Domain。SameSite 针对 site，不等于不同子域的 origin 隔离。[MDN Set-Cookie](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)

本项目建议：代理凭证使用 `__Host-offdesk-preview=<opaque>; Secure; HttpOnly; Path=/; SameSite=Lax`，服务器绑定 owner、lease、机器、端口、到期时间并支持撤销。只用于当前预览，不能调用 Hub API。对请求中的重复代理 Cookie 拒绝认证；发往开发服务前剔除该 Cookie；禁止上游响应设置这个保留 Cookie 名。开发应用自己的 Cookie 可保留，但上游 Domain 要删除或严格改为当前预览主机；不能让它向母域写 Cookie。HttpOnly 不阻止页面发起已认证请求，因此仍要控制跨预览请求。

## App → 外部浏览器的认证交接

设计前提：App 持有 Hub bearer token，而外部浏览器没有该 token。此部分由主研究核对实际客户端代码；不依赖二者 Cookie 存储共享。

建议流程：

1. App 用现有 Hub 认证创建预览 lease 和 30–60 秒有效、一次性的高熵 launch code。code 只授予此 lease；服务端存哈希、原子消费。这个时长是设计建议。
2. App 打开 `https://p-<random>.example-preview.net/__offdesk_preview__/bootstrap#code=...`。fragment 不作为 HTTP 请求路径；初始页面必须由 Hub 自己提供，不能转给开发应用，不加载第三方脚本、图片或统计。
3. 最小 bootstrap 脚本把 code 保存于内存，立即 `history.replaceState` 清除 fragment，再以同源 `fetch` POST JSON 到保留兑换路由；不能用 GET 消费。返回代理 Cookie 后检查成功，再 `location.replace` 到服务器保存并验证的相对目的路径。拒绝 `//host`、反斜杠或外部 redirect 目标，保留原页面 query/fragment。
4. bootstrap 与兑换响应使用 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、严格 CSP；日志不记录 code、Cookie 或请求体。兑换只接受预期 Origin 和 JSON，禁止 CORS；不以 IP 绑定手机会话，移动网络 IP 会变。

`no-referrer` 会去掉 Referer，但某些表单 POST 的 Origin 会变成 null；同源 fetch 默认 cors 模式仍发真实 Origin。因此此设计选 fetch JSON，不能把表单方案机械套上严格 Origin 检查。[MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy)

新 hostname 必须在 bootstrap 完成前不能返回开发应用，且不能复用给之后的租约；这是为了避免前一应用的 Service Worker 或存储影响下一次凭证交接。会话失效后重新从 App 创建新 hostname，代价是该预览的本地应用登录状态不会自动迁移。稳定 hostname 与长期保留应用存储需要单独设计和浏览器验证。

code 是短期能力凭证，fragment 仍可能被截图、浏览器扩展或尚未清理的历史看到；“不在服务器 URL 日志”不等于完全不泄漏。禁止把长期 Hub token、节点 token 放入 URL。已用过的 launch 链接不等于分享链接；首版只支持本人打开。

## 跨预览请求与代理边界

以下是实施建议，不是浏览器自动提供的保证：

- 所有修改请求和 WebSocket Upgrade 校验准确的预览 Origin，拒绝其他 sibling preview；不能只看 SameSite 或 CORS。Cookie 认证代理必须考虑兄弟子域仍是 same-site。
- GET/HEAD 子资源也检查 Fetch Metadata/Origin/Referer 来阻止其他 preview 的 script、图片等读取路径；允许用户主动的顶层导航和下载。缺失这些头时采取明确的兼容策略并测试，不宣称能用单一 header 完成全部隔离。
- Hub API 继续只接受原有控制台认证；预览 hostname 路由不能落回控制台 API，控制台不能信任任意 `*.offdesk.app` 的 CORS/Origin。
- 保留开发应用自身 Authorization 的语义；Hub bearer 只出现在控制面创建请求，不能注入开发服务请求。
- 对未知/过期 hostname 在鉴权前返回封闭错误。租约撤销立即禁止新请求并关闭现存 WS；已下载内容无法撤回。

## HMR、应用兼容与下载

Vite 官方说明反向代理需要转发 WebSocket，否则客户端可能绕过代理直接连接本地 HMR 地址；手机在外面无法使用这个回退。allowedHosts 应列出受控域名，不能设为 true。当前官方版本展示 `server.ws`；老版本可能使用 `server.hmr`，实施必须按目标项目锁定版本选择配置。[Vite Server Options](https://vite.dev/config/server-options)

本项目建议保留公开 Host/Origin，向开发服务传递经 Hub 重建的 Forwarded 信息，并在应用侧配置允许的精确预览 hostname 和 wss/443。如果为兼容把 Host 改为 localhost，也必须先在 Hub 校验外部 Origin；不能无条件伪造 Origin 绕过应用检查。保持 Host、Origin、X-Forwarded-Host/Proto 一致，分别验证 Vite、Next 的实际版本。HMR 子协议、WS 关闭、重连和二进制帧要端到端透传。

首版不承诺任意网页零配置：写死 `http://localhost:...` 的 API、绝对跳转、独立 HMR 端口、OAuth callback、CSP 的 connect-src、WebAuthn 都可能要求开发配置。优先支持单 HTTP 端口、相对资源路径、同源 API/WS。不要通过扫描/替换 HTML 解决所有 URL。

认证 bootstrap 独立于目标资源，因此起始地址是 PDF、JSON 或文件下载也能先认证再跳转。数据路径必须保留 Content-Type、Content-Disposition、Range/206、流式响应和取消；不把任意响应包成 HTML，也不能吞掉多个 Set-Cookie。首版代理与边缘都禁用共享缓存，防止静态扩展名路径绕过私有鉴权。大文件、SSE 与慢下载不能阻塞终端控制流。

## DNS、TLS 与 Cloudflare

Cloudflare full setup 的 Universal SSL 覆盖根域及一级子域，默认不覆盖 `id.preview.example.com`。可选一级 `p-id.example.com`，或给嵌套预览域名准备相应证书/受支持的独立 zone 设置；不要假设 DNS wildcard 自动带来 TLS coverage。[Cloudflare Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)

Tunnel hostname 用 CNAME 指向 `<UUID>.cfargotunnel.com`；DNS 记录和 tunnel 运行状态相互独立，应用会继承对应 hostname 的 cache/WAF 等规则。[Cloudflare Tunnel DNS](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/)

Tunnel ingress 支持 wildcard hostname，规则按顺序匹配且最终需要 catch-all；具体 DNS 与 ingress 都必须覆盖选定域名，保留 Host 到 Hub，未知 hostname 由 Hub 拒绝。[Cloudflare Tunnel configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)

部署前检查现有 Tunnel 路由、实际证书覆盖和缓存规则即可；不是给每台开发机开一个 Cloudflare Tunnel。架构仍然是现有公共 Hub 接收网页请求，再通过节点通道访问 loopback。

## 最小验收场景

按仓库 AGENTS.md 使用容器中的 `pnpm e2e:test` / `pnpm e2e:ci`。实现时至少覆盖：新外部浏览器无 Hub 登录也能一次交接；code 重放失败；代理凭证不进上游；兄弟预览 CSRF/WS 拒绝；Cookie Domain/保留名隔离；过期/撤销关闭；首个 URL 为下载；静态资源与 HMR 成功；原生 Android 外部浏览器实机打开并刷新；断网恢复与节点离线提示。网页源码或浏览器历史中不得出现长期 Hub token。
