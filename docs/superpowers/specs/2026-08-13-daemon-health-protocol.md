# Daemon identity / health / takeover 协议

日期：2026-08-13

## 问题

当前 CLI 把 `/health` 的精确 JSON key 集合同时当作服务标识、协议版本、逻辑身份和健康状态。
这能挡住长得相似的本地服务，却让新版 daemon 的任何新增字段都被旧 CLI 判成 `foreign`。daemon 是持久进程，
升级期间新旧 CLI 会并存，因此 additive schema 演进不能要求所有进程同时升级。

## 不变量

### 1. Wire protocol 与兼容

- `GET /health` 是已经发布给旧 CLI 的 **frozen v0 compatibility view**。它永久保持
  `{ok:true,identity:{home,cdpHost,cdpPort},targets}`，不得新增字段。
- 新 CLI 优先探测 `GET /health/v1`；只有明确 `404` 才回退 `/health`。两个请求都禁止跟随 redirect。
- `/health/v1` 必须带稳定 discriminator `service: "cdp-control.monitor"` 和
  `protocol: {major, minor}`。
- 本 CLI 支持 `major === 1`。同 major 的更高 minor 只能增加可选字段；解析器只校验必需字段及类型，
  并忽略顶层及所有 nested object 的未知字段。
- 未知 major、已识别 service 的畸形 v1 payload 或未知必需枚举值都归为 `incompatible`；不得回退 v0、
  不得接管。新增必需字段、删除/改义既有字段或新增必需枚举值必须提升 major。
- 无 discriminator 的 pre-v1 响应只接受两种冻结的精确 schema：当前 v0 identity view，以及更早的
  `{ok:true,targets}`。除此以外都不是可接管 daemon。

### 2. 身份不是接管权限

- daemon 的**逻辑身份**仅由三项组成：规范化 `CDP_HOME`、已经 pin 的 CDP host、权威 CDP port 的稳定 wire 表示。
  它回答“这个 watcher 服务哪个用户状态目录和哪个浏览器 endpoint”。targets、PID、版本和健康阶段都不属于身份。
- “已经 pin”是硬前提而非描述：端点尚未与 `browser.json` 的权威 port 同步时，**身份计算本身必须 fail closed**，
  不得退回进程启动时的 env 猜测。CLI 侧由 `ensureBrowser()` 建立该前提（`logs` 与其它 target 命令同样前置它）；
  daemon 侧认领父进程 pin 后经 env 传下的端点，缺失则拒绝启动。理由见「已知残余与边界」F1。
- v0 identity 的 wire 表示已经发布，必须与 frozen `/health` 一起保持逐字段兼容；不能在引入 v1 时顺手改写
  host/port 表示。v1 可在下一次 major 升级显式改变 identity 编码，但同一 major 内只能新增可选字段。
- `home + host + port` 全等才是 `same identity`；只有 home 相同而 endpoint 不同是 `owned-stale`；
  home 不同是 `foreign`。
- `same identity` 只允许复用兼容且 `ready` 的 daemon，不授予 signal 权限。
- **接管权限**绑定到具体进程实例：v1 health 发布 `{pid, birth}`；退出前必须让 health 中的实例、
  home-scoped PID file、唯一 loopback listener、CLI `__daemon` command line 和 signal 前同步读取的 birth identity
  全部一致。检查结束到 `kill` 之间不得再 `await`。
- pre-v1 daemon 没有实例字段，只能走冻结的 legacy/v0 迁移路径；仍需 PID/listener/command/birth 双读全部通过，
  任一证据缺失或变化都 fail closed。

### 3. 健康与状态分类

| 状态 | 判定 | 动作 |
| --- | --- | --- |
| `current` | 支持的协议、逻辑身份全等、phase=`ready`；或冻结 v0 身份全等 | 复用，不退出、不 spawn |
| `transition` | 支持的 v1、同 home、phase=`starting\|stopping` | 只等待有界状态变化；超时显式报错 |
| `owned-stale` | 支持的 ready daemon 或冻结 v0，home 相同、endpoint 不同 | 二次确认同一候选，再按进程实例门禁退出 |
| `legacy` | 精确 pre-identity schema | 二次确认，再按 legacy 进程门禁退出 |
| `foreign` | 其它 service、不同 home、redirect 或不属于冻结 schema 的响应 | 永不退出、永不覆盖、显式报占用 |
| `incompatible` | discriminator 属于本服务，但 major 未知或 v1 契约畸形 | 永不退出、永不降级回退、显式报告版本/原因 |
| `unreachable` | 独立 TCP probe 明确得到 `ECONNREFUSED`，确认无 loopback listener | spawn 前再 probe；仍不可达才 spawn |

`/health/v1` 的 phase 只有 `starting | ready | stopping`。listener bind 后可以进入 `starting`，但只有 PID 已发布且
initial sync 完成后才进入 `ready`。因此“端口能响应”不再等于“watcher 已就绪”。

### 4. 状态机与可观察性

- 任一破坏性动作前必须二次 probe，并确认仍是同一个 retirable candidate；v1 candidate 比较逻辑身份及
  `{pid,birth}`，不能只比较状态字符串。
- birth 双读之间“不得 await”只约束 JS 层；真实窗口是**最后一次 birth 读取所依赖的子进程 teardown 延迟**，
  见「已知残余与边界」F3。
- 初始 `unreachable` 不能直接 spawn；必须二次 probe，避免并发 ensure 已经启动合法 daemon 时制造冲突。
- spawn 后只把 `current` 当成功；`unreachable`/`transition` 可在有界窗口内继续等待，任何
  `foreign`/`incompatible`/retirable 响应立即失败。
- 自动拉起保持不阻塞主命令，但 `maybeSpawnDaemon` 不得吞掉错误；至少向 stderr 输出稳定前缀和具体分类原因。
- 所有 wait 都有次数上限；超时错误必须区分“transition 未完成”“owned daemon 无法退出”和“新 daemon 未就绪”。
- target attach 按最多 8 个的公平轮转批次执行；同批并行、批次不重叠，避免大量 tabs 造成 FD/command storm。
  initial sync 完成第一批，剩余 target 由后续 500ms sync 继续覆盖。其共享上界为 target list 5s +
  最慢 target 的 WS 8s + 三个 CDP 命令各 5s。
  spawn-to-ready 还包含 bind 前最多 10s 的 process birth 读取，默认等待 40s，必须完整覆盖该 38s 上界，
  不能让合法 detached daemon 稍后 ready 而调用者先假失败。

## 已知残余与边界

第三方对抗性复审（2026-08-13，27 项 wire 边界攻击 + 6 项变异验证 + 隔离真进程冒烟）确认协议核心成立，
并留下以下**已知且有意接受**的残余。列在这里是为了它们不被后续复审当成新发现，也不被误当成已闭合。

- **F1 未 pin 端点的身份（已闭合，保留说明）**：`logs` 曾绕过 api 层直接挂在 CLI 入口上，于是
  `cdp.logs()` 作为首个调用时端点仍是 env 猜测，健康 daemon 被判 `owned-stale` 并遭合法但错误的接管。
  现修法为双层：`logs` 与其它命令一样前置 `ensureBrowser()`（恢复功能），身份计算在未 pin 时 fail closed
  （把前提变成结构约束）。**代价**：未 pin 时 autostart 不再静默尝试，而是留下诊断并放弃本轮。
- **F2 v0/legacy 接管无实例绑定**：pre-v1 health 不发布 `{pid,birth}`，接管门禁只能验证“这个 home 在这个
  端口的 cdp-control daemon”，不绑定被确认的那个实例。滚动升级期两个 CLI 并发 ensure 时存在毫秒级窗口：
  A 已 retire 旧 v0 并把新 daemon 拉到发布 pidfile，B 在自己的 confirm probe 之后才读 pidfile，四项证据
  对 A 的**全新 current daemon** 全部为真 → 误 SIGTERM。v1 因 `{pid,birth}` 绑定免疫；事后收敛（B 会重新
  spawn 或复用）。这是“v0 无实例数据只能走冻结迁移路径”的量化残余，不另加补丁。
- **F3 “signal 前不得 await”的实际强度**：JS 层确实无 await，但最后一次 birth 读取依赖子进程——
  darwin 走 `osascript` JXA（实测数十 ms）、win32 走 powershell `Get-Process`（冷启动可达数百 ms），
  只有 Linux 读 `/proc` 是微秒级。真实窗口 = **该子进程的 teardown 延迟**，其间目标进程仍可能死亡且 PID
  被复用（Windows 复用更激进且 `process.kill` 是 TerminateProcess 语义）。这是纯 Node 无 pidfd/进程句柄下的
  平台地板，不是实现失误；不要按“零窗口”理解这条保证。
- **F4 命令行门禁绑定当前 `argv[1]`**：`isLegacyDaemonCommand` 用当前 CLI 的 `daemonScriptPath()` 做后缀匹配。
  旧 daemon 若由不同路径启动（npm 升级换了 dist 真实路径，或交替使用全局 bin 与 `node dist/cdp.js`），
  后缀必不匹配 → retire 永远 fail closed。**运维后果**：升级后每条命令都打 `autostart failed` 诊断，
  watcher 直到**手工结束旧 daemon**才恢复。fail closed 的方向是对的（spec 明说 lookalike 必须 fail closed），
  代价是没有自动出口；是否补一个显式的 kill-daemon 命令留待后续独立决定。
- **F5 spawn 失败时 CLI 进程滞留约 40s**：`DEFAULT_POLL_ATTEMPTS` 由 `ceil(40000/300)=134` 决定。
  `maybeSpawnDaemon` 虽不被 await，但 pending 的 timer/fetch 让进程无法退出：daemon 起不来时（CDP_HOME 只读、
  bind 失败等）命令结果早已打印，进程仍要挂满约 40s 才打诊断退出（dev 为约 8s）。这是“40s 窗口必须覆盖
  38s 上界”的直接代价。另注：40s 只约束 sleep 总和，每次 probe 自身最多再花 2s(HTTP)+2s(TCP)，
  极端交错下墙钟可更久——只会更慢，不会提前假失败。
- **F7 `phase='stopping'` 已进 wire 契约但永不发布**：daemon 的 SIGINT/SIGTERM handler 直接 `process.exit(0)`，
  实际只有 `starting → ready`。CLI 侧的等待逻辑有测试覆盖，但真 daemon 不会产生该值。这是无害的前瞻设计，
  留给未来的优雅退出；不要当成状态机漏洞。
- **F8 最低平台支持**：daemon 启动第二步即 `processBirthIdentity(process.pid)`，仅实现 linux/win32/darwin，
  其它平台（BSD 等）直接 throw。相对 dev 是回归——那些平台的 daemon 从“可用”变“永不可用”（有明确诊断）。
  这是“破坏性权限必须绑定进程实例”的必然要求：拿不到 birth 就没有可信身份，宁可不启动。

## 为什么这不是第十个条件补丁

此前修复分别补 namespace、legacy 迁移、schema lookalike、redirect、HTTP TOCTOU、same-home endpoint、PID 发布顺序和
current schema lookalike；它们都在弥补“一个 boolean/精确 JSON 外形同时承担所有语义”的后果。本协议把四个正交问题
拆开并各自给出稳定 authority：wire 兼容由 service+major/minor 决定，逻辑归属由 identity 决定，运行健康由 phase 决定，
破坏性权限由 process instance 证据链决定。今后 additive 字段无需改状态机；新 major 只会进入显式 incompatible；
身份或进程证据不完整时也没有默认破坏性分支。

## TDD 验收矩阵

- v1 顶层、protocol、identity、health、instance 分别增加未知字段仍判 `current`。
- higher minor 仍兼容；unknown major 与 malformed recognized service 判 `incompatible`，且不 fallback、不 retire、不 spawn。
- 新 daemon 同时提供 frozen `/health` 和 evolvable `/health/v1`；旧 v0 CLI 视图不变。
- same identity、same home stale endpoint、different home 分别进入 `current`、`owned-stale`、`foreign`。
- `starting/stopping` 只等待；ready 前不能成功。
- v1 takeover 中 health instance、PID、listener、command、birth 任一不一致或 birth 在检查间变化都不 signal。
- 初始 unreachable 的二次 probe 能复用并发 current；真正持续 unreachable 才 spawn。
- `maybeSpawnDaemon` 对 incompatible/foreign/timeout 失败留下可断言的 stderr 诊断。
- 端点未 pin 时身份计算直接失败：不探 health、不 retire、不 spawn，诊断仍走 autostart 稳定前缀；
  pin 到权威 port 后同 endpoint 的 ready daemon 判 `current` 并复用。
- `logs` 调用后端点必须已同步到 `browser.json` 的权威 port（否则 daemon 判定建立在猜测端点上）。
