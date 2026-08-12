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

- daemon 的**逻辑身份**仅由三项组成：规范化 `CDP_HOME`、已经 pin 的 CDP host、规范化十进制 CDP port。
  它回答“这个 watcher 服务哪个用户状态目录和哪个浏览器 endpoint”。targets、PID、版本和健康阶段都不属于身份。
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
| `unreachable` | loopback 连接失败 | spawn 前再 probe；仍不可达才 spawn |

`/health/v1` 的 phase 只有 `starting | ready | stopping`。listener bind 后可以进入 `starting`，但只有 PID 已发布且
initial sync 完成后才进入 `ready`。因此“端口能响应”不再等于“watcher 已就绪”。

### 4. 状态机与可观察性

- 任一破坏性动作前必须二次 probe，并确认仍是同一个 retirable candidate；v1 candidate 比较逻辑身份及
  `{pid,birth}`，不能只比较状态字符串。
- 初始 `unreachable` 不能直接 spawn；必须二次 probe，避免并发 ensure 已经启动合法 daemon 时制造冲突。
- spawn 后只把 `current` 当成功；`unreachable`/`transition` 可在有界窗口内继续等待，任何
  `foreign`/`incompatible`/retirable 响应立即失败。
- 自动拉起保持不阻塞主命令，但 `maybeSpawnDaemon` 不得吞掉错误；至少向 stderr 输出稳定前缀和具体分类原因。
- 所有 wait 都有次数上限；超时错误必须区分“transition 未完成”“owned daemon 无法退出”和“新 daemon 未就绪”。

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
