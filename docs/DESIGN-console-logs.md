# 设计:cdp.js 读控制台日志(页面注入监控 + 注入守护 daemon)

日期:2026-08-07(初版 CDP 事件缓冲方案 → 重构为页面注入方案)

## 背景与两次方案迭代

### 为什么最初走 CDP 事件
读控制台日志本质是"推式 + 长连接":要收到 `Runtime.consoleAPICalled`/`Runtime.exceptionThrown`,必须有一条活着的 WS 连 target 且发过 `Runtime.enable`。每次 `node cdp.js xxx` 是独立进程、跑完即退,所以第一版用一个常驻 daemon 持有 WS、缓冲事件、暴露 `/logs` HTTP 读取。

**局限(实测暴露)**:CDP 事件把 console 参数给的是 `RemoteObject.description`(拍平的文本),异常也只给格式化堆栈字符串——**对象嵌套结构丢了,调用链只是文本**。用户要能看镶嵌结构和调用链。

### 为什么改为页面注入
用户提出:daemon 不做"缓冲+读",改成"**注入守护**"——监听所有 tab,确保每个 tab 都有页面注入的监控器,刷新后自动补。往页面 hook `console.*`/`onerror`/`unhandledrejection` 存进 `window.__cdpLogs`,读时拿到的就是**活的嵌套对象 + 调用链**,比 CDP preview 结构保真度高(无任意深度上限)。

关键机制 **`Page.addScriptToEvaluateOnNewDocument`**:注册在该 tab 的 debugger session 上,之后**每次 document 创建(含刷新)自动先跑这段脚本** → 刷新自动补装,**不需要 daemon 探测刷新**。daemon 只需轮询 `/json/list` 发现新 tab 去注册。

## 架构

```
daemon(listen)= 注入守护:轮询 /json/list → 每个 tab attach WS
                 → Page.enable + Page.addScriptToEvaluateOnNewDocument(MONITOR_JS)
                 → 刷新自动重跑,无需探测;立即对已加载页 Runtime.evaluate 注入一次
                 （不做日志缓冲、没有 /logs HTTP 读;只有 /health + /shutdown）

页面 MONITOR_JS: hook console.*/onerror/unhandledrejection → window.__cdpLogs
                 [{ts,type:console|exception|rejection,level,args(活对象),stack}]
                 window.__cdpMon 哨兵防重复;封顶 2000 条 FIFO

logs 命令: 幂等注入(MONITOR_JS)+ 读取 window.__cdpLogs 并结构化序列化
           → 保留嵌套对象结构 + stack 调用链,level/since 在页面侧过滤
```

## 组件

### `MONITOR_JS`(注入到每个页面的监控脚本)
- hook `console.log/info/warn/error/debug`:记录 `args`(**活的引用**,读时再序列化)+ `new Error().stack`(调用链)。
- `window.addEventListener('error')`:未捕获异常 → message/source/line/col/reason/stack。
- `window.addEventListener('unhandledrejection')`:Promise 拒绝 → reason/stack。
- `window.__cdpMon` 哨兵保证幂等(重复注入、每次 document 重建只装一次)。
- 注意:脚本内不含模板反引号,因为要作为字符串注入/读到页面里。

### `buildReadExpr(levelSet, since)`(读表达式)
= `MONITOR_JS` + 结构化序列化器。序列化保留普通对象/数组嵌套结构,并处理:
- 循环引用 → `[循环]`(`WeakSet` 追踪,每个条目独立 `seen` 防共享引用误判)
- DOM 节点 → `<DIV#id>`
- Error → `{name, message}`
- 深度 >8 → `[深]`;数组 >50 项、对象 >30 键截断(防爆炸)
- 在页面侧完成 level 过滤 + since 时间戳过滤

### daemon(`cmdListen`,注入守护)
- `inject(target)`:attach WS → `Page.enable` → `Page.addScriptToEvaluateOnNewDocument(MONITOR_JS)`(注册给未来所有 document)→ `Runtime.evaluate(MONITOR_JS)`(立即注入当前已加载页,幂等)。
- `sync()`:每 500ms 轮询 `/json/list`,对未 attach 的 tab 注入(覆盖手动新开)。WS 断开 → 移除,下轮重连重注册。
- HTTP:仅 `/health`(存活探测)+ `/shutdown`。`/health` 返回 daemon identity
  (`CDP_HOME` + CDP host/port),PID 存当前 `CDP_HOME/cdp-listen.pid`,不与其它 home 共享状态。
- 兼容升级:只把精确旧 schema `{ok:true,targets:<非负整数>}`(无 identity/无额外字段) 视为旧版。退出时必须
  同时验证旧 tmp PID file、目标 loopback listener 的唯一 PID 和当前 CLI `__daemon` 命令行，然后对该 PID
  发信号，等 health 不可达再启动新 daemon。不向端口发 destructive HTTP；带 identity 但不匹配的
  foreign daemon 一律拒绝。

### `logs` 命令 / `cdp.logs` API
- `maybeSpawnDaemon()` 确保 daemon 在跑(持续守护注入)。
- `evaluate(target, buildReadExpr(levelSet, since))` → 结构化日志数组。**读时自带幂等注入**,所以任意 tab(含手动开的、daemon 未及装的)读都有效。

### 自动装监听
`open()` / `ensureBrowser()`(url 分支)末尾 `maybeSpawnDaemon()` → daemon 轮询给新 tab 注册。

### `listen-stop`
发起 `POST /shutdown`(daemon 响应前 `process.exit`,response 截断 reject 也算成功)→ 轮询 health 直到不可达;优雅关闭未生效再读 pid 文件 `kill` 兜底。

### 看门狗(自动退出)
浏览器被关掉后 `/json/list` 持续探测失败。`sync()` 统计连续失败次数,达 `WATCHDOG_POLLS=10`(约 5s)即自动 `process.exit(0)`,不留孤儿 daemon。下次 `open`/`ensure`/`logs` 会自动重新拉起。实测:指向死端口约 5s 自退;浏览器在时 7s 不误杀。

## 实测验证(本地 Edge)
- 嵌套对象结构完整:`console.log('nested',{a:1,b:{c:[1,2,3],d:{e:'deep'}}})` → args 保留完整嵌套 ✓
- 调用链:每条 console 记录带 `stack` ✓
- 未捕获异常:`throw new Error('chain-test')` → message + reason{name,message} + stack ✓
- **刷新自动补**:navigate 后新打日志仍捕获(监控经 addScriptToEvaluateOnNewDocument 自动重跑)✓
- 新开 tab 自动装:注入后打日志能捕获 ✓
- `listen-stop` 正确停止 ✓

## 已知限制(诚实记录)
- `window.__cdpLogs` 刷新后清空(缓冲在页面);监控自动补装但历史没了。
- **首屏/加载早期日志可能错过**:daemon 靠轮询注入,页面刚打开的几毫秒内已打的日志在注入前跑了(实测 data 页首屏日志丢失)。agent 打开页→操作→读的场景不受影响;想抓加载早期日志需在导航前注册 `addScriptToEvaluateOnNewDocument`。
- 只覆盖主线程 hook;worker 等跨 context 异常抓不到。

## 不改的部分
- 单命令 `eval`/`snapshot` 等行为不变。
- 读历史日志的限制:监控只在注入之后收;注入前已存在的日志读不到。

## 代码拆分(维护性)
实现代码按职责拆到 `src/`(依赖单向无环,已全 TS + esbuild 重构,见 docs/superpowers/specs/2026-08-08-ts-refactor-design.md):
- `src/transport.ts` 低级连接与 target 级原语
- `src/inject-loader.ts` 注入脚本读取 + `__CDP_ARG__` 参数装配
- `src/inject/monitor.ts` 页面监控脚本(注入侧);`src/inject/lib/monitor-inject.ts` 共享 hook 逻辑
- `src/inject/read.ts` 读日志并结构化序列化(注入侧)
- `src/monitor.ts` 本特性:注入守护 daemon(cmdListen)+ logs 读取
- `src/api.ts` 高层页面操作 API(共用 `invoke()` 统一解包结果契约)
- `src/browser.ts` ensure 浏览器就绪
- `src/cdp.ts` 单入口:组装最终 api + CLI 分发(daemon 靠 process.argv[1] 自启,入口保持单文件)
