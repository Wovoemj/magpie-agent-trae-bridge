# magpie-agent-trae-bridge

让 **Trae**（Trae CN / Trae Global）直接使用 **Magpie** 里配置的全部模型与路由组。
模型菜单返回 Magpie 的模型目录，聊天仍由 Trae 自己的自定义模型（BYOK）通道直连本机 Magpie 网关。
**Trae 原有登录、账号、网络代理设置全部不动。**

## 它做了什么

| 组件 | 作用 |
| --- | --- |
| 本机目录守护进程（`trae-magpie serve`） | 读 `~/.config/magpie-trae-bridge/connection.json` / Magpie 网关 `/v1/models`，在 `http://127.0.0.1:<port>/catalog` 暴露模型目录，15s 热更新；同时开一条回环 WebSocket `/ws` 主动推送目录；**每 3s 看一眼开关**，Magpie 打开就补丁、关掉就还原 |
| 注入到 Trae 聊天包的 prelude | 在模型列表写入 picker store 的**唯一收口**处合并 Magpie 模型：`provider=custom_openai_compatible`、`base_url=<Magpie 网关>`、`sk=<Magpie key>`、`config_source=Personal` |
| Magpie 插件入口 `agent.js` | 只导出纯数据（`agent` 描述符 + 同步 `connect()`）：告诉 Magpie 这个 agent 叫什么、配置写哪、模型字段是哪个 |
| Magpie 插件入口 `plugin.js` | OpenCode 侧（Bun，完整 Node API）：被 Magpie 宿主加载时确保守护进程在线，并盯着开关变化 |

### 为什么要两个入口文件

Magpie 的 agent 插件（`magpie.agent`）在一个**受限的 ECMAScript 沙箱**里求值：没有 `process`、没有 `fetch`、没有 `setTimeout`，
连 `import('node:fs')` 都会拒绝——它只允许导出纯数据和一个同步的 `connect()`。
所以 `agent.js` 里不能有任何 I/O；真正干活的代码放在 `plugin.js`，由 Magpie 的 OpenCode 宿主（Bun）加载，那里有完整的 Node API。

`package.json` 里 `main` 指向 `plugin.js`、`magpie.agent` 指向 `agent.js`。
（反过来，如果 `main` 指向 `agent.js`，OpenCode 宿主会把它当 OpenCode 插件去 `import` 并报 `exports no OpenCode plugin function`。）

抓的是 `resources/app/node_modules/@byted-icube/ai-modules-chat/dist/index.mjs` 里
`this._modelStore.actions.setOriginModelListMap(<map>)` 这一处（seed 与 refresh 两条路径的共同出口），
所以模型菜单、会话选择、落库缓存三处同时生效，且 **不需要碰 `state.vscdb`**。

### 为什么走 WebSocket 而不是 HTTP

Trae 的 workbench 页面带着一条很紧的 CSP：

```
connect-src 'self' solo-remote-file: https: ws:;
```

里面**没有 `http:`**，所以从渲染进程 `fetch('http://127.0.0.1:3417/catalog')` 会被浏览器直接拒绝。
`ws:` 在白名单里，于是 prelude 改用 `ws://127.0.0.1:<port>/ws` 拉目录——同一份数据，换一条浏览器允许的通道。
`/catalog`、`/health`、`/status` 这些 HTTP 端点保留给命令行自检用。

### 安装期内联快照

`install` 会先读一次 Magpie 目录，把裁剪后的快照写进 prelude 的 `var SEED = {...}`。
这样即使守护进程没起来（或 Magpie 暂时不可达），**重启 Trae 后菜单里照样有全部模型**，
等 WebSocket 连上后再热更新成最新目录。

## 安装

### 从 Magpie 安装（推荐）

在 Magpie → Plugins 的「添加」框里填包名：

```text
magpie-agent-trae-bridge
```

或者直接用仓库地址：

```text
github:Wovoemj/magpie-agent-trae-bridge
```

命令行等价写法：

```powershell
magpie plugin add magpie-agent-trae-bridge
```

本地开发时也可以直接指向目录（`magpie plugin add .`），但这条路径依赖你自己的目录位置，
换台机器就失效，且插件卡片会因为查不到 npm 元数据而显示「npm 没有响应」。

然后在 Magpie 的 Agents 列表里打开 `Trae · Magpie Bridge` 的开关。
打开开关 = Magpie 调用 `connect()`，把 `enabled:true`、网关、key 和全部模型写进 `connection.json`；
守护进程在 3s 内看到就自动打补丁、起 WS 目录；关掉开关 Magpie 把 `connection.json` 清空，守护进程 3s 内字节还原 Trae 的包。

也可以直接命令行切：

```powershell
magpie trae-bridge auto/gpt-6-luna   # 打开开关，并把 Magpie 侧记录的默认模型设成它
magpie trae-bridge default           # 关掉开关（connection.json 清空 → 还原 Trae）
```

### 手动安装

```powershell
node bin/trae-magpie.js install
```

可选参数：`--trae <Trae 安装目录>`、`--port <端口>`、`--all`（所有找到的 Trae）、`--no-autostart`。

安装会：

1. 备份原包到 `index.mjs.magpie-orig`（一次性，卸载时字节还原）；
2. 在包首部写入带起止标记的 prelude，并把那一处 store 写入改成走 `merge()`；
3. 起守护进程，并写开机自启项（Windows：当前用户 Startup 下的隐藏 `magpie-trae-bridge.vbs`）；
4. **重启 Trae** 后模型菜单出现 Magpie 的模型与路由组。

## 命令

```powershell
node bin/trae-magpie.js install     # 打补丁 + 起守护进程 + 开机自启
node bin/trae-magpie.js status      # 哪些 Trae 被打过、端口、自启状态
node bin/trae-magpie.js doctor      # 端到端自检（含 Magpie 可达性、路由组数量）
node bin/trae-magpie.js uninstall   # 字节还原原包 + 停守护进程 + 删自启
node bin/trae-magpie.js serve       # 前台跑目录守护进程
node bin/trae-magpie.js stop        # 停守护进程
node bin/trae-magpie.js autostart on|off|status
node bin/trae-magpie.js checkin [status|on|off|at HH:MM|now]   # 每日自动签到
node bin/trae-magpie.js login      # 浏览器登录 Trae CN（本插件自己保管凭据）
node bin/trae-magpie.js whoami      # 签到会用哪个账号、哪个设备号
node bin/trae-magpie.js logout     # 忘掉这份凭据
```

自检示例：

```
PASS  node             22.23.2
PASS  trae install     trae-cn 3.4.16
PASS  bundle patched   ...\@byted-icube\ai-modules-chat\dist\index.mjs
PASS  backup present   yes
PASS  daemon           up on 3417
PASS  ws channel       ws://127.0.0.1:3417/ws
PASS  autostart        ...\Startup\magpie-trae-bridge.vbs
PASS  catalog          173 models, 61 groups from http://127.0.0.1:3425/v1
PASS  ws payload       173 models over ws
PASS  checkin          on, daily 09:00 (Beijing), last day —
PASS  magpie gateway   173 models @ http://127.0.0.1:3425/v1
PASS  routing groups   61 prefixes
```

## 目录协议

`GET http://127.0.0.1:<port>/catalog`（命令行 / 调试用）

```json
{
  "ok": true,
  "gateway": "http://127.0.0.1:3425/v1",
  "key": "magpie-trae-bridge",
  "count": 166,
  "groups": ["agent-router", "api", "auto", "imported", "nextapi", "trae-cn", "trae-global"],
  "models": [
    {
      "id": "auto/gpt-6-luna",
      "label": "GPT-6 Luna · routing group",
      "group": "auto",
      "context": 922000,
      "output": 128000,
      "reasoning": true,
      "levels": ["none", "low", "medium", "high", "xhigh", "max"],
      "vision": true,
      "owner": "easydata"
    }
  ]
}
```

`WS ws://127.0.0.1:<port>/ws`（Trae 渲染进程实际使用的通道）：连上即收到一帧同结构的 JSON；
目录变化时守护进程主动再推一帧；客户端发 `{"type":"refresh"}` 可要求立刻重推。
帧里还带 `checkin`（`{ enabled, at, atMinutes, lastDay, lastResult, due }`），渲染侧据此排签到；
守护进程到点会单独推一帧 `{"type":"checkin","action":"auto"}`，渲染侧签完回 `{"type":"checkin-report", …}`。

其他端点：`GET /health`（含 `ws`、`clients` 字段）、`GET /status`、`GET /catalog?refresh=1`、
`GET /checkin`（签到开关 / 时间 / 今天签没签）、`POST /checkin/run`（让已连上的窗口立刻去签）。
只监听回环地址，只读，不代理任何流量。

## 配置

`~/.config/magpie-trae-bridge/connection.json`（Magpie 插件写出，或手动放）：

```json
{
  "gateway": "http://127.0.0.1:3425/v1",
  "key": "magpie-trae-bridge",
  "enabled": true,
  "model": "auto/gpt-6-luna",
  "models": [{ "id": "auto/gpt-6-luna", "name": "GPT-6 Luna · routing group", "context": 922000 }]
}
```

打开开关时由 Magpie 按 `connect()` 的返回值写入；关掉开关时被清成 `{}`。

这里的 `models` 只是**兜底**：Magpie 只存下 `{id,name,context}`，`output` / `reasoning` / 推理档位 /
视觉能力都会丢。所以守护进程优先拿文件里的 `gateway` + `key` 去问 `/v1/models`，只有网关连不上时才
退回这份精简目录（并在 `/status` 的 `notes` 里注明 `probe failed`）。

兼容读取 `~/.config/magpie-cursor-bridge/connection.json`（Cursor 桥的同一份目录）。

本项目自己的状态文件（`daemon.json` / `state.json` / `checkin.json` / `checkin.log`，以及侧栏页用的
`page-request.json`、`hooks-alive.json`）都放在这个目录下，
可以用环境变量 `MAGPIE_TRAE_CONFIG_DIR` 整体改到别处（`connection.json` 除外——那个文件由 Magpie 写，
始终在真实家目录下）。写探针脚本时用它，别碰真实状态。
两者都没有时回落到 `http://127.0.0.1:3425/v1` 并直接探网关 `/v1/models`。

`~/.config/magpie-trae-bridge/checkin.json`（签到开关与当天记录，由 `checkin` 子命令或守护进程写）：

```json
{
  "enabled": true,
  "at": "09:00",
  "lastDay": "2026-11-09",
  "lastResult": { "action": "claim", "ok": true, "claimed": true, "credits": 120 }
}
```

`at` 与 `lastDay` 都按北京时间：Trae 后端的签到日也是北京时间 0 点切。

## 浏览器登录（不需要 Trae、也不需要 Magpie 先登录过）

签到要的只是一个 Trae CN 账号的令牌和一个设备号。这份令牌可以来自 Magpie 的
`~/.config/magpie/plugin-auth.json`（`trae-cn` 那一项），也可以由本插件自己在浏览器里登录拿到：

```powershell
node bin/trae-magpie.js login
```

它会起一个只监听 `127.0.0.1` 的临时回调服务，把 Trae 的授权页 `https://www.trae.cn/authorization`
在你的默认浏览器里打开；你在浏览器里登录完成后，页面会带着 `userJwt` / `userInfo` 回到那个回调地址，
令牌存进 `~/.config/magpie-trae-bridge/trae-auth.json`（权限 0600）。

授权页会先自己确认浏览器里有没有 trae.cn 的网页登录态。没登过的话页面会一直停在「认证中…」，
控制台里是 `GetUserToken 401 / 20310 The user is not logged in` —— 它根本不会去碰 `127.0.0.1`。
所以第一次用，先在浏览器里登一次 trae.cn，再点登录。

登录完成后插件会顺手把令牌和设备绑到一起（P-256 的 DeviceProof 签名，和 Trae 客户端自己续期时发的一样）。
这一步是尽力而为：Trae 有时回 20403 `Token device not match`，那就按网页给的令牌存下来、标记
`deviceBound: false`，原因留在 `bindError` 里，签到改用 15 位的派生设备号。只有绑上了才用本机 16 位设备号 ——
Trae CN 按设备结算，没绑设备的令牌去 claim 只会拿到 9074（页面上写着「当前参与用户太多」，其实是被拒）。

Magpie 侧栏页上的「浏览器登录」按的是同一个流程（走 `/login`），两条路共用同一份凭据。
装给别人用时，对方只要装了 Magpie（或自己跑 `node bin/trae-magpie.js login`），
不需要装着 Trae，也不需要 Magpie 里登过 Trae —— 凭据在本插件自己手里。

第一顺位是自签的 `trae-auth.json`，没有它才退回 Magpie 的 `plugin-auth.json`；
`whoami` 会告诉你现在用的是哪一个（`source: bridge` 或 `source: magpie`）。

## 每日自动签到

Trae CN 的签到接口是 `POST https://api.trae.cn/trae/api/v2/ug/checkin_credits/status` 与 `.../claim`，
本来只有 Trae 主进程会调；桥自己拿磁盘上的临时令牌去发，一律回 `code=1001`（令牌是设备绑定的）。
现在桥直接读 Magpie 存的那份 OAuth 令牌和本机 Trae 的 device id，所以**不用打开 Trae**：

- 令牌：`~/.config/magpie/plugin-auth.json` 里 `trae-cn` 那条的 `access`（Magpie 用
  opencode-trae-auth 登录后就有）；设备号：`%APPDATA%\Trae CN\User\globalStorage\storage.json`
  里键名 `iCubeAuthInfo://icube-dc:<16 位数字>`。桥只读这两处，不写，也不自己续期
  （续期要走 P-256 的 DeviceProof，做不了也不必做）。
- 顺序固定是 status -> 需要才 claim：`checked_in` 已经是 true 就不再 claim，免得把「换设备重签」
  当刷分。额度按设备维度结算，同一天重复 claim 不报错，但桥不这么做。
- 守护进程只管时钟：到点（默认北京时间 09:00）且当天没签就发 HTTP，结果写 `checkin.json` +
  `checkin.log`；十分钟内不重复催，催完 90 秒内不再动。
- 有 Trae 窗口连着时仍然优先交给窗口：注入的 prelude 用 `vscode.ipcRenderer.invoke` 调主进程的
  `vscode:sandbox::main-invoke-fetchCheckinCreditsStatus` 与 `...claimCheckinCredits`，签名的是
  Trae 自己。没有窗口才走接口。两条路写同样的 `lastResult`，日志里用 `via=trae` / `via=api` 区分。

```powershell
node bin/trae-magpie.js checkin           # 开关 / 时间 / 今天签没签 / due
node bin/trae-magpie.js checkin on|off    # 开关
node bin/trae-magpie.js checkin at 08:30  # 改时间（北京时间）
node bin/trae-magpie.js checkin now       # 立刻签一次（Trae 不开也行）
```

`doctor` 里的 `checkin api` 一行会说明用的是哪个账号、以及发的是客户端设备号还是虚拟设备号。

## Magpie 侧栏页

Magpie 重启后会读 `package.json` 里的 `magpie.page`，在左侧导航的 Plugins 分组下多出一页
「Trae 签到」。这一页显示今天签没签、上次结果（时间 · 动作 · 积分 · 已领取/失败）、连着几个
Trae 窗口，以及 Magpie 自带的 opencode-trae-auth 插件今天签到的记录；可以关掉自动签到、改时间、
按「立即签到」。

页面自己碰不到网络：Magpie 把插件页跑在只允许脚本的 iframe 里，既连不上 127.0.0.1:3417，也调不到
Magpie 的接口。所以数据是 `checkin.hooks.mjs` 在 Magpie 的插件宿主（有完整 Node 的 Bun 进程）里
每 2 秒从守护进程取一次，变了才写 `page/live.js`；页面每 2 秒重新加载这个文件。按钮走反向：页面
调 `magpie.options.set({ checkinRequest })`，Magpie 写进 `plugins.json` 并重载插件宿主，宿主处理
一次并把已处理的时间戳记在 `page-request.json` 里，之后的重载不会重放。

想看「页面那边的宿主起来没有」：看同目录的 `hooks-alive.json` —— 里面有宿主的 pid 和启动时间。

等价的两条路（不打开页面也能用）：

- 命令行：`trae-magpie checkin status | on | off | at HH:MM | now`
- HTTP：`GET /checkin`、`POST /checkin/run`、`POST /checkin/config`（`{ "enabled": true }` 或
  `{ "at": "08:00" }`）

签到由守护进程直接发起（Trae 窗口开着时也可以交给窗口）—— 页面只是看得见、按得动。
## 注意

- 只改本机 Trae 安装目录里的一个明文 JS 包；不写 Trae 服务端账号、不装证书、不改 `state.vscdb`。
- Trae 升级会覆盖该包：守护进程每 3s 对齐一次开关，开关还开着就自动重新注入；`doctor` 会报 `bundle patched FAIL` 提醒。
- Trae 运行中也能打补丁，但**必须重启 Trae** 才会重新加载包。
- 卸载走 `.magpie-orig` 字节还原；若期间 Trae 自己更新过该包（sha 不符），则改为外科式剥除 prelude 并保留 Trae 的新版本。
- 想看 Magpie 记下了什么：`~/.config/magpie-trae-bridge/plugin.log`；签到历史在同目录 `checkin.log`。
- 签到不改 Trae 的任何账号数据：它只是替你在 Trae 自带的签到面板上按了一下按钮。

## 环境

- Node.js ≥ 20（`fetch`、`node:test`）。
- Windows x64 / macOS / Linux 均可；路径自动发现 `Trae CN`、`Trae`、`/Applications/Trae.app` 等。

## 授权

MIT。思路参考 [magpie-agent-cursor-bridge](https://github.com/932633145/magpie-agent-cursor-bridge)。
