# 固定端口、占用即杀：浏览器启动端口语义重设计

日期：2026-08-12
状态：已批准并实现（上游 PR #8 进一步收紧失败关闭与并发安全）

## 背景与动机

旧实现（`src/browser.ts`）采用「端口避让」：`ensureBrowser` 发现配置端口被占且不就绪时，
会换一个空闲端口拉起浏览器，并把漂移后的端口回写 `browser.json`。这带来几个问题：

- 用户配置的端口被静默改掉，`kill` 从配置读端口却找不到刚漂移的实例，两者不一致。
- 9222 是 CDP 业界共识端口；本工具被设计成「电脑上只有一个 CDP 浏览器实例、大家协作」。
  端口避让违背这个心智模型，反而掩盖了「占着 9222 却不应答」的坏实例。

本设计把语义改为：**配置哪个端口，就用哪个端口，绝不避让**。

## 核心语义

```
ensureBrowser():
  cfg = loadConfigOrNull()
  port = cfg?.port ?? 9222; setPort(port)          // 配置和无配置 bootstrap 都有权威端口
  if GET /json/version 返回有效 ws/wss URL: return ready

  state = connect + exclusive bind 探测
  if unknown: fail closed
  if busy:
    有界轮询探活 3s；任一轮健康则复用
    枚举真正服务 HOST:port 的全部 TCP LISTEN PID
    探活与 listener 快照交替复核；健康则复用，身份变化则重启判断
    kill 全部稳定快照 PID；任一失败仍复查并最终报错
    等端口确认释放；unknown/超时都 fail closed

  启动前再跑一轮探活与端口判断
  coldStart(port)                                  // 只在同一个权威端口启动
  return started
```

四个分支覆盖全部状态：

1. **端口就绪** → 直接复用（就绪零开销，1 次 GET）。
2. **端口绑定但 3s 宽限或后续复探期间变成健康 CDP**（另一个并发 `cdp-control` 正在拉起）→ 复用，绝不 kill。
3. **端口绑定且持续不健康**（坏实例或其他 listener）→ 在 PID 快照稳定后杀全部监听者，并确认释放。
4. **端口空闲**（或杀完后）→ 启动前复核一次，再固定在配置端口拉起。

**关键点：永远用 `cfg.port`，不换端口、不回写漂移。**

## 删除 vs 保留（对 PR#1/#2 的处置）

### 删除（违背「不避让」）

- `port.ts` 的 `portFree` / `findFreePort`（端口避让探测）。
- `launchReady` 的「换空闲口重试」逻辑。
- 端口漂移后自动回写 `browser.json` 的行为。

### 保留并归位（按新语义）

| 项 | 处置 |
|---|---|
| PR#1 #2 kill 检测升级（只认 TCP `LISTENING`、精确端口、杀全部监听 PID）| 收进 `browser-port.ts` 的纯解析与状态机；`kill` 和 `ensureBrowser` 共用同一组副作用原语 |
| PR#2 启动中等待/复探 | 保留明确的 3s 就绪宽限，再以端口状态和 listener 快照交替复核；任一轮变健康都直接复用 |
| PR#2 `writeConfigAtomic` pid 后缀 | 保留（并发回写互踩修复，与本改动正交） |
| PR#1 #3 错误提示 | 保留并扩充枚举、状态、kill、释放和启动真因；不再把未知状态当空闲 |

## 已拍板的边界

1. **并发启动守卫**：忙端口先给 3s 有界就绪宽限；破坏性操作前重复探活，并在最后一次探活后重新核对 listener PID；
   启动前也重新走完整判断。A 拉起期间只要变健康，B 就复用而不会误杀或重复 spawn。
2. **非浏览器进程占 9222 的边界**：如果 9222 被非浏览器服务（恰好 LISTEN、永不答
   `/json/version`）占着，本流程会杀掉它。这是「9222 是 CDP 共识端口、占用不应答即坏」的
   直接推论，用户确认接受，不做进程名防护。

## 实现要点

- `src/browser-port.ts`：纯状态机 `prepareFixedPort`，以及 Windows `netstat` / POSIX `lsof`
  解析；支持多 PID、地址族、双栈 wildcard、精确端口，过滤 ESTABLISHED/UDP/近似端口。
- `src/browser.ts`：注入单次探活、3s 就绪宽限、connect/bind 状态、listener 枚举、kill、launch、sleep；所有未知
  和失败分支 fail closed。无配置时显式把 transport 恢复到 9222，不继承 `CDP_PORT` 漂移。
- `killBrowser` 复用同一 listener 枚举、kill 和端口状态原语；不再把工具失败误报成已释放。
- `tests/browser-port.test.ts`：覆盖健康复用、3s 并发冷启动宽限、同端口启动、多 PID、解析过滤、双栈 wildcard、
  listener 换代、启动前并发、枚举/状态/kill/释放失败；真机 smoke 覆盖进程回收和配置不变。

## 测试

- 单测：纯状态机与 listener 解析跨平台运行。
- 真机：只用隔离 HOME/TMPDIR、临时高端口、临时 fake listener 和独立 user-data；不得碰用户
  `~/.cdp-control`、9222 或现有 Chrome。
