# cdp-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `skills/cdp-control/SKILL.md`**。
> 运行入口:`cdp-control`(全局命令,`npm link` 后任意目录可调;等效 `node dist/cdp.js`)。
> 数据默认归 `~/.cdp-control`(`CDP_HOME` 可整体覆盖):`rulesDir()`→`<CDP_HOME>/rules`(本机默认路径是指向 `rules/` 的符号链接),浏览器用户数据→`<CDP_HOME>/user-data`。

## 构建

`dist/` 不提交 git,改源码后重建:

开发与 CI 的最低 Node.js 版本为 22.6.0(测试入口使用 `--experimental-strip-types`):

```bash
npm install      # 首次:Biome/esbuild/typescript/@types/node/commander(运行时仅 commander)
npm run lint     # Biome lint+格式校验、依赖边界检查、Node/集成 harness 类型检查
npm run docs:check      # 从 Commander 真实注册项单向校验 SKILL.md 的 CLI 命令/long flag
npm run build    # tsc --noEmit + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
npm run test:pack        # npm pack → 精确白名单 → 临时安装 → 真跑已安装 CLI
npm run publish:dry-run  # 隔离 stage 翻 private 后只做 npm publish --dry-run,绝不发布
```

### 本地提交门禁

干净 clone 在 `npm install` 后执行一步安装:

```bash
npm run hooks:install
```

此命令只为**当前仓库**设置 `core.hooksPath=.githooks`,不改全局 Git 配置,也不挂到 `prepare`/`npm install` 自动执行。之后普通 `git commit` 会由 `.githooks/pre-commit` 依次运行快速档 `npm run typecheck` + `npm test`;紧急逃生使用 Git 原生 `git commit --no-verify`。

hook 是 LF 的 `#!/bin/sh` POSIX 脚本,索引权限为 `100755`;`.gitattributes` 锁定 LF,兼容 macOS/Linux 及 Git for Windows 自带的 sh。安装器还会回读 local 配置并在 POSIX 工作树补 executable bit。

实时规则目录 = `<CDP_HOME>/rules`(默认 `~/.cdp-control/rules`):本机默认路径是**符号链接指向 `rules/`**(用户规则=根本规则,运行时读写直接落 git 工作树的 rules,**无覆盖问题**);干净环境是真目录,`rules-store.ts` seed-once 缺文件时从 `rules/` 拷默认。**build 不清不覆盖**(修 clobber)。

产物:
```
dist/cdp.js          入口 bundle(commander+全部 src,自包含;首行 shebang,经 package.json `bin` → 全局 `cdp-control`)
dist/*.js            其余 Node 侧(api/transport/monitor/browser/inject-loader/keys)
dist/inject/*.js     注入浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
```

**规则是数据非代码,不住 dist**:fold/ignore-links 运行时可写数据住 `<CDP_HOME>/rules`(默认 `~/.cdp-control/rules`;本机默认路径符号链接到 `rules/`),内置默认在 `rules/`(入库,publish 随包),干净环境由 `rules-store.ts` seed-once 拷贝;recipe 作者代码则直接读包/仓库 `rules/recipes/`,不做数据 home 镜像(见「规则存储」)。

**全局 CLI(`npm link`)**:`package.json` 的 `bin.cdp-control` → `dist/cdp.js`(首行 shebang 由 `build.mjs` 给 cdp bundle 加 banner,只加这一次、勿配到 standalone/inject 产物)。`npm link` 后任意目录可敲 `cdp-control`;SKILL.md 全用此命令。`private:true` 不影响 npm link;发布范围由 `files:["dist","rules","skills"]` 与 npm 自动纳入的 package.json/README/LICENSE 共同决定,并由 pack 冒烟锁死。

## 版本与发布

当前 `1.0.0` 仍是 `private:true` 的未发布开发版本:仓库没有已发布版本或 tag,不得把版本号本身当作已发布证据。`CHANGELOG.md` 的 `[Unreleased]` 是待发布事实源。

**SemVer 判断范围**:CLI 命令/位置参数/flag(名称、类型、默认值、语义)、stdout/stderr 与退出码;注入侧 `__CDP_ARG__`、`globalThis.__cdpResult`、footer 及既有参数/结果形态;`fold.csv` 五列、`ignore-links.csv` 三列与 recipe 导出/API;`bin` 名、最低 Node 版本和安装包布局,都属于公共契约。

- **patch**:不改变公共契约的 bugfix、性能优化、内部重构、测试/文档/CI/构建/pack 修正,以及现有格式内的 selector/规则数据纠错。注入实现可改,但既有参数与结果契约必须不变。
- **minor**:向后兼容的新能力,如新增命令、默认不改变旧行为的可选 flag/参数、可选结果字段、新注入入口、新站点 recipe,或旧规则仍可原样解析的可选格式扩展。
- **major**:删除/改名命令或 flag,改变 flag 类型/默认值/语义、位置参数语法、机器可读输出或退出码;破坏 `__CDP_ARG__`/`__cdpResult`/footer 或既有字段语义;改变规则路径、分隔符、必填列/列序/glob 语义或 recipe API 使旧文件失效;提高最低 Node、改变 bin 名或安装布局。允许激进重构,但已有发布后的不兼容契约变更必须 major。

**谁更新版本**:普通功能/修复 PR 只更新 `[Unreleased]`,不各自 bump。指定发版负责人在独立 release PR 中按该批次最高影响级别统一决定版本;已有正式版本后的发布用 `npm version <patch|minor|major> --no-git-tag-version` 同步 `package.json` 与 `package-lock.json`。CLI 版本不另存一份:build 从 manifest 注入 `__CDP_VERSION__`,pack 冒烟断言安装后的 `--version` 与 tarball 元数据一致。首次正式发布若范围仍为 1.0.0,可沿用这个未发布占位号而不执行递增命令,但必须核对 manifest/lock 一致。负责人同时把条目归档为 `[x.y.z] - YYYY-MM-DD`;只有真实发布完成后才创建匹配的 `vX.Y.Z` tag。

**发布演练**:`npm run publish:dry-run` 先要求源包仍为 `private:true`,再复制最小发布源到隔离 stage、只在 stage 翻成 `private:false`,过滤 npm 凭据并固定无效 registry,最后硬编码执行 `npm publish --dry-run`。脚本没有非 dry-run 分支,不改源 manifest、不读写用户 npmrc;真实发布必须另走显式 release PR。发版前 pack 冒烟与 dry-run 都必须通过。

首次正式发布前仍可按本项目原则激进演进;一旦正式发布,本节 SemVer/CHANGELOG 规则就是发布契约,文件末尾的历史说明不构成豁免。

## 源码结构(两层分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(CDP/CLI/api/纯函数;`folds.ts` 读写 fold 规则) | Node | 入口 `cdp.ts` bundle → `dist/cdp.js`;其余转译 CJS |
| `src/inject/*.ts` | 注入浏览器执行的 JS(入口) | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块 | 浏览器 | 打进各入口 |
| `skills/cdp-control/SKILL.md` | agent 用法文档(极薄,只教调 `cdp-control`);`~/.claude/skills/cdp-control` 符号链接指向它 | — | 不动 |

依赖单向无环:`paths(最底层) ← transport ← inject-loader/browser-discover/browser-config ← monitor/browser ← api ← cdp`(browser 不再依赖 api,故 api 可前置 ensureBrowser)。`npm run lint` 会机器校验 Node 层级/无环、`paths.ts` 零项目依赖以及 `src/inject/**` 不越界到 Node 侧。定位收敛为两套:**ref(前台索引)+ selector(后台匹配)**。

## 浏览器连接(ensureBrowser / kill)

- **数据 home 与测试隔离**:默认数据 home 是 `~/.cdp-control`;受支持的 `CDP_HOME=<dir>` 可把 `browser.json`、默认 `user-data/` 与 `rules/` 整体切到另一目录,供集成测试/多实例完全隔离。`CDP_RULES_DIR` 仍是规则目录的更高优先级单项覆盖。
- **连接专用模式**:`CDP_NO_AUTOSTART=1` 时 `ensureBrowser()` 仍会正常复用已就绪端点,但端点不就绪就清晰报错、不 cold-start detached 浏览器/daemon。集成 harness 依此保证只存在它自己 spawn 并记录 PID 的浏览器。
- **端口与用户数据路径入配置**:`browser.json` 的 `port`(默认 9222)与 `userData`(默认 `<CDP_HOME>/user-data`)用户可改。配置端口是权威值,`ensureBrowser()` 读配置后 `transport.setPort(cfg.port)` 同步端口,所有命令只连/启动这个端口；无配置 bootstrap 固定用 9222,不从 `CDP_PORT` 漂移。语义:**健康 CDP**(`/json/version` 含 websocket)→ 直接复用且不 kill；**端口空闲**→ 在同一配置端口拉起；**端口被非健康端点监听**→ 先给并发冷启动 3s 有界就绪宽限，kill 前最后复探,仍非健康才结束真正服务该 host/port 的 TCP LISTEN listener,确认释放后仍在同一端口拉起。绝不 findFreePort、改写或回写漂移端口；枚举、kill、状态确认或释放失败均 fail closed 且不得 spawn。
- **启动配置 `<CDP_HOME>/browser.json`**(用户可编辑,权威):`{ exe, kind, args, port, userData }`。`args` 存稳定参数(remote-allow-origins/no-first-run/window-size 等);`--remote-debugging-port` 与 `--user-data-dir` 由工具据 `port`/`userData` 生成。缺失时 bootstrap 用 `browser-discover.ts` 跨平台候选(Edge 优先)首个能拉起者原子写配置;损坏(JSON 非法/exe 不存在/args 非数组/显式 port 非法)打印清晰错误、**不 fallback**,用户改文件。原子发布先写同目录 tmp，再用 hard-link 的 `EEXIST` 语义保证不覆盖并发创建的权威配置。
- **跨平台发现 `browser-discover.ts`**(纯函数):win env 路径表(Edge/Chrome 各通道)+`where`;mac 硬编码精确 `.app`+`Contents/MacOS/<bin>`(Safari 排除);linux `command -v` + `.desktop`。
- **配置解析 `browser-config.ts`**(纯函数):`parseBrowserConfig`(port/userData 缺省取默认,损坏抛清晰错)/`defaultArgs`(linux 加 `--disable-dev-shm-usage`)/`browserConfigPath`/`DEFAULT_PORT`/`DEFAULT_USER_DATA`。
- **固定端口门禁(`browser-port.ts`)**:对 `CDP_HOST` 的全部数值地址逐一 connect + exclusive bind 区分空闲/忙/未知；`localhost` 覆盖 IPv4/IPv6 双回环，DNS 用 `all:true`，bracketed IPv6 在 socket 边界去括号，listener 匹配会规范化 IPv6 等价写法。单一解析地址的健康主连接保留一次 GET 快路；多地址则无论主连接是否健康都逐数值地址复核，pin 低级传输到具体健康地址并复用，绝不回收多地址 listener 并集或让后续连接漂移。忙端口先给并发冷启动 3s 就绪宽限，再用精确 TCP LISTEN 快照归属全部 PID。破坏性操作前会复探健康状态并核对 listener 身份，回收会尝试整组 PID、聚合失败并确认端口释放；任何枚举、状态、回收或释放异常都 fail closed。此模块只返回复用或允许在原端口启动，不提供端口避让能力。
- **冷启动**:`spawn(exe, [...args, --remote-debugging-port=<cfg.port>, --user-data-dir=<cfg.userData>], {detached:true, stdio:'ignore'}).unref()` → 轮询 `/json/version` 就绪(20s)→ `maybeSpawnDaemon`。浏览器不随父进程死(持久)。启动器提前退出后仍会在 3s 窗口内持续复探（即使端口一度空闲），以复用 Chrome 单例竞态中稍后就绪的并发 CDP；宽限结束后会重进不含 spawn 的固定端口状态机，否则保留原始启动失败且不换端口重试。bootstrap 全候选失败时区分两种错:**一个候选都不存在**(未装浏览器)vs **存在但没在端口上就绪**(列出试过谁)。
- **"一切命令自愈"**:`api.resolve/list/open` 前置 `ensureBrowser()`(幂等)→ 所有 target 命令与 list/open 未起自动启动;`transport.evaluate` 由 api 的 `connectTarget` 包一层——连接失败(浏览器死/target stale)→ ensure + 按 url 重 resolve + 重试一次(堵 run 脚本直传 stale target);daemon(走 `pageWs`/`send`)天然豁免,不会死循环拉起浏览器。
- **monitor daemon 隔离**:PID 存 `<CDP_HOME>/cdp-listen.pid`;health identity 由规范化 home、当前 pin 后 `CONNECTION_HOST` 与权威 port 组成。默认 home 的日志端口为 9333，自定义 `CDP_HOME` 在未显式设置 `CDP_LOGS_PORT` 时稳定派生隔离高位端口。ensure 与 spawn 共用同一端点快照，避免并发 pin/端口变化让父子 identity 分裂。
- **`kill` 命令**:`cdp-control kill` 从 `<CDP_HOME>/browser.json` 读 `port`(**不**用默认 9222);**无配置 → kill 不生效**。先证明端点持续 busy，再精确枚举服务目标 host/port 的全部 TCP LISTEN 进程(netstat/lsof → pid)并复核稳定 PID 快照，才 taskkill `/F /T`/SIGKILL → connect+bind 确认端口释放(Edge 崩溃自启会重绑,等待确认)。枚举/状态/释放每个异步步骤后以及每个 kill 前都重读并确认完整权威配置未变；变化即在破坏性操作前 fail closed。整组 PID 都会尝试；即使端口最终释放，任一 kill 调用失败也单独报 `killFailed`，枚举、结束或状态确认失败均不得谎报成功。daemon 经 `spawnDaemon` 继承当前 pin 的 `CDP_HOST` 和权威 `CDP_PORT` 拉起，避免后台连回多地址 hostname 中的非 CDP 端点。

## 注入脚本契约(改动注入脚本必读)

注入脚本 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。esbuild 会吞掉返回值,故:

1. **结果写入**:写到全局 `globalThis.__cdpResult`(用 `lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口追加 footer `;(async()=>{const r=await globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`,整体完成值即结果,读完即删。同步入口传普通值;异步入口(如 `view --scroll-to-load`)可 `setResult(<promise>)`。`Runtime.evaluate` 开 `awaitPromise`。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS `declare const __CDP_ARG__: XxxArgs`),Node 侧 `inject-loader.ts` 注入前拼 `var __CDP_ARG__ = <json>;`。
4. **入参类型**在 `lib/arg.ts`(FindArgs——含 click 专用可选 `dom`/FillArgs/ViewArgs(含 FoldItem)/LocateArgs/FindCmdArgs/InfoArgs/ReadArgs/FoldArgs)。

**新增注入入口**:在 `src/inject/` 加顶层 `.ts`,用 `setResult` + 可选 `__CDP_ARG__`,重建自动打包成 `dist/inject/<名>.js`。注入侧跑浏览器,不能用 Node API。

## 注入模块速查

每模块统一:**一句作用 → 机制 → 不变量/坑 → 入口**。模块按依赖序排列:ref 索引 → 生成树(view)→ 转 selector(locate)→ 过滤规则(fold/ignore-links)→ 内容消费(article/find/feedback/info)。

### ref 登记表 + 自愈
**核心索引**:内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 即下标。表存 **`{elRef:WeakRef<Element>, parentRef}`**(parentRef=最近已登记祖先,O(1) 跳表),`window.__cdpRefIndex` 用 `WeakMap<Element,number>` 反查已印发号码。
- **分配**:统一走 `registerRef`:已登记元素复用旧号,首次见到的元素只在表尾追加；整页/局部 view、反馈、自愈、find/read/info 都不清空旧表。号码不回收,但 detached 元素不被表强引用、可 GC；导航/刷新换 document 时自然得到新表。
- **解析**:`lib/find-root.ts` 的 `refElement` 统一 `deref()`(兼容裸 Element / `{el}` / `{elRef}`),目标不存在或 `!isConnected` 即 stale；`climbAncestors` 供 `--ancestor`。
- **回显**:操作成功回显唯一 selector(优先 selector 而非 ref);light 用 `genSel`;shadow 内回 `{ok,tag,shadow:true,selector:null}`,CLI 提示"用 ref";超长截断。统一走 `actionSelector(el)`。
- **失效自愈**:ref 路径返回 `{ok:false,refInvalid:true,recovered:recoverRef(ref)}`,selector 路径普通 err。`recoverRef` 三态(`classifyRef`):`none`/`never{maxRef}`/`live{start,maxRef}`;`live` 沿 `parentRef` 跳表找首个 `isConnected` 祖先,途中 `deref()` 失败视同 detached 继续向上,以存活祖先为根 `buildView` 返回 `{rootRef,lines}`,整链失效返回 null。Node `invoke` 对 `refInvalid` 透传不抛,`runWithFeedback` 短路,`cdp.ts` `printRefInvalid` 打三态。

### view-core(buildView)
**生成树 + ref**:内容/交互元素的紧凑树(view/feedback-collect/recoverRef/find 共用)。`buildView(root,{visibleOnly,viewport,folds})`。
- **两遍先序**:遍一(`simplify`)只建树 + 打标记(`wantRef`/`wantHidden`)+ 暂存 `node.el`,不登记 `__cdpRefs`;遍二(`assign`)按先序 DFS 调 `registerRef` 复用或追加。输出仍按树序,ref 数字可乱序；复用节点会按本次树位置刷新 `parentRef`。
- **预算句柄不另分配**:`assign` 把 `registerRef` 返回的同一个稳定号码记到 `node.budgetRef`(含默认不打印 ref 的 `wantHidden` 包装节点);自动折叠只引用既有号,绝不二次登记/重排,所以开关 `--budget` 不会让 ref 漂移。
- **标记**:`wantRef`(内容/交互/折叠/shadow 宿主)→ 设 `node.ref` 并打印 `[ref=N]`;`wantHidden`(纯包装含内容)→ 登记但不设 `node.ref`(view 不打印,info 反查可用)。
- **只追加不重置**:同一 document 内所有路径都不清空登记表；旧号永不换指向,新元素只追加。
- **`viewport:true`**:算 `isInViewport` 存 `node.view`,输出 `[ref=i·屏]`/`[ref=i]`。
- **fold 折叠**:持久规则(`folds`)+ 会话临时(`__cdpFolds`)合并,`el.matches(selector)` 判定。命中**非根**元素(depth>0)标 `wantRef`、`node.fold=备注`、`kids=[]` 不递归;**根不折叠**(否则 `view <ref>` 展开折叠容器时根本身又被折叠);嵌套折叠自然支持。
- **shadow host 占位**:带 `shadowRoot` 的 Element 标 `wantRef`+`isContent=true`。`view-format.walk` 对 `depth>0 && shadow && ref` 输出 `<tag>[shadow] [ref=N]` 不展开子树,根正常走子树。
- **图标按钮兜底(`elLabel`)**:交互元素无直接文本时按 `aria-label → title → 直接文本` 取标。view 显示功能、article 降级 `[label]`,而非裸 `button [ref=N]`。
- **表单采集**:simplify 对 INPUT/TEXTAREA 设 `inputInfo={type,value,placeholder}`(value 截 40),输出 `input[type=text value="..." placeholder="..."]`,agent 不必 eval。
- **语义状态**:simplify 只读 DOM/ARIA 补 `node.state`(`pressed/checked/expanded/selected/disabled/open`,`mixed` 保留为 `name=mixed`);状态跟 ref 同括号输出，checkbox/radio 的 checked 并入 `input[...]`，无状态零额外字符。
- **导出**:`strip`/`ownElText`(元素自身直接文本)/`subtreeText`(穿透 shadow)/`childrenOf`(穿透 shadow 取子)/`isInViewport`/`elLabel`/`buildView`。
- **滚动加载**:整页完整 `view` 首次自动 `scrollToLoad()`(置 `__cdpFullViewDone`,同页只滚一次;局部/`--visible-only`/显式滚动参数不触发),滚动后默认等 `scrollWait`(默认 1000ms,`--scroll-wait 0` 关)才建树。`api.fetchPage` 靠它一次抓全,等待条件="body 有非空文本"。

### view-format + budget
**纯渲染 + 总量折叠**:`view-format.ts` 的 `markText/formatView` 完全脱离 DOM;`view-budget.ts` 在树和 ref 全部完成后才做预算决策。
- **体量与规划**:`formatViewWithSpans(maxLen)` 在整页的一次真实渲染中记录每个可见候选的连续行区间,直接得到「换成占位能省多少」。规划器优先用多个更细的后代逼近预算,后代总压缩能力不够时才退到祖先;最后最多 8 次整树实渲染校正结构/账单开销。这既避免深链/大页逐候选重渲染的平方退化,也避免最外层包装一次吃掉几乎全部可用预算。
- **折叠占位**:预算折叠不删 `kids`、不改 ref,只给 formatter 一张 `budgetRef → summary` 映射。输出 `▸ [ref=N] tag (M 个元素 · 约 X 字) ~"首句…"`;根节点永不入选,故 `view <ref> --budget N` 会保留该区域根并只在内部继续折叠。
- **focus**:`view --focus R --budget N` 先把既有 `R` 解析成 Element,整页重建时放开该元素的 composed 祖先路径(不应用持久/临时 fold),再按 Element 身份找回树节点。纯函数先折焦点路径之外「占位确实更短」的首个可登记区域,保留祖先骨架并完整展开焦点子树;若仍超预算,只在焦点子树内部继续规划折叠。`focus` 与位置 ref/selector 互斥且必须带预算。
- **账单与下界**:显式预算时末行是 `# 预算 N 字 · 已用 U · 折叠 K 处(view <ref> 展开)`,`已用`包含树、换行和账单自身。若骨架+账单本身已经超过极小预算,骨架优先且账单如实报告超额。
- **兼容性**:`budget` 缺省时入口仍直接走原 `formatView`,不加账单、输出逐字节不变。`maxLen` 先约束单条文本,`budget` 再约束总渲染量,两者正交叠加。

### locate(ref→selector)
**转 selector**:`inject/ref.ts` 把 ref 翻译成稳定 CSS selector,供回显与 selector-file 复用。
- `genSel` 按 `id > data-testid/test/cy/qa > 语义 data-* > aria-label > 唯一 class > nth-of-type 位置链` 选锚点(命中即停、向上补位置链,`matchesEl` 校验,仅 light DOM)。
- **shadow**:`inShadow` 检测;shadow 内 selector 退化最外层 host 锚定,另生成 `shadowChain`(`hostSel >>> seg1 >>> seg2`);`findRoot` 按 `>>>` 分段逐层 `shadowRoot.querySelector` 穿透。

### fold 折叠规则
**折叠页面元素**:基于 selector 规则折叠(保留 ref、可展开、跨会话持久)。注入入口 `inject/fold.ts`(临时折叠/list/clear),CLI `fold`。
- **文件**:Node `src/folds.ts` 读写 `~/.cdp-control/rules/fold.csv`(`rules-store.ts` seed-once 保证存在;测试 `CDP_FOLD_FILE` 覆盖)。tab 分隔(selector 含空格),行首 `#` 注释。
- **五列**:`<id>\t<域名>\t<path>\t<selector>\t<备注>`;id 单调递增不重排;域名通配(精确/`*.suffix`/`suffix.*`);path 为 glob(`*` 含 `/`,空=不限,修同域名跨页错位)。`parseRules` 只认首列为数字的行。
- **函数**:`loadFolds/matchFolds(hostOf/pathOf/domainMatch/pathMatch)` 纯读;`api.view` 按 hostOf+pathOf 过滤注入 `__CDP_ARG__.folds`。**写入口已移除,持久规则手动编辑 fold.csv**。
- **会话临时折叠**:存页面全局 `__cdpFolds`(`lib/fold.ts`),刷新清空。持久折叠无命令写入口,手动编辑 fold.csv。

### ignore-links(链接黑名单)
**链接去 URL**:命中模式的链接只留文本、去 URL(如知乎 `zhida.zhihu.com/search*` 内部链接,URL 是超长 search 串)。**view 与 article 共用**。规则文件 `~/.cdp-control/rules/ignore-links.csv` **手动编辑**。
- **文件**:Node `src/ignore-links.ts` 持久化 `~/.cdp-control/rules/ignore-links.csv`(3 列 `id\tpattern\tnote`,pattern 为 glob 匹配 `hrefForMatch`=hostname+pathname,与 folds 同构)。
- **纯函数**:`hrefForMatch`/`linkRuleMatch`/`parseLinkRules`/`loadLinkRules`(单测 `tests/ignore-links.test.ts`;写操作 addLinkRule/removeLinkRule 已随管理命令移除)。`globToRegExp` 共享自 `src/url-scope.ts`。
- **注入侧匹配**:`src/inject/lib/ignore-links.ts` 的 `linkIgnored(patterns, href)`(浏览器);`api.view`/`api.article` 读 `loadLinkRules()` 的 pattern 数组,经 `__CDP_ARG__.ignoreLinks` 传入。
- **view 内联合并**:命中黑名单的 `<a>`(含 `span>a` 包装)内联成纯文本并与相邻文本段合并成一句,取**末段文本的 el(ref)**。两种 DOM 编码:① 兄弟 span,由 `mergeTextRuns` + `inlineTextOf`(穿透单子节点 span 包装)合并;② 父自身文本,由 `ordered` 保序 childNodes 组装成片段再合并。粗斜(b/strong)里的 ignore 链接只去 URL。
- **article**:命中 `linkIgnored` 即 `inlineSeg` 只回文本。

### 规则存储(rules-store)+ url-scope
**规则分两种生命周期、两处存储**:
- **运行时可写数据**(fold.csv/ignore-links.csv):住 `<CDP_HOME>/rules`(数据 home;默认 `~/.cdp-control/rules`)。本机默认 home 中它是符号链接指向 `rules/`(规则=根本,读写直落 git 工作树,无覆盖);干净环境是真目录,`rules-store.ts` **seed-once** 缺文件时从 `rules/` 拷默认(已存在不覆盖,修旧 clobber bug)。
- **作者代码(recipe)**:`rules/recipes/*.js` **直接读 git 权威**、不做 gitignored 镜像(曾 seed 到 `rules/recipes/` 双份手动同步必然漂移,2026-08 实测 `_lib.js` 差 22 字节)。recipe-runner 扫 `srcRecipesDir()`(经 `CDP_RULES_DEFAULT_DIR` 覆盖)。
`rulesDir()` 默认 `<CDP_HOME>/rules`(`CDP_HOME` 未设时即 `~/.cdp-control/rules`);`CDP_RULES_DIR` 仍可单独高优先级覆盖,测试另可用 `CDP_RULES_DEFAULT_DIR` 覆盖默认规则源(recipe 测试用后者指临时目录)。
**共享工具 `src/url-scope.ts`**(纯函数零依赖):`globToRegExp`(唯一实现,消 3 份重复)+ `hostOf`/`pathOf` + `urlMatches`。fold 用 hostOf/pathOf 拆两维正交;ignore-links 用拼接串单 glob;recipe 作用域用 urlMatches。

### recipe(站点抽取配方)
**聚焦站点摘要**:URL 命中的过程式摘要(文本 + 内嵌 `[ref=N]`),供 agent 聚焦读已知站点(如知乎问题页:标题/被浏览/逐回答/更多回答 ref),其余噪声隐去。
- **文件形态(L0 站点聚合)**:`rules/recipes/<site>.js`(**纯 JS 不接 build**,作者代码直接读 git 权威、无镜像)导出**规则数组** `module.exports = [{name, scope: string|string[], extract}, ...]`。`scope` 数组=一抽取逻辑服务多 URL 形态(同布局多地址);数组元素=同站点多布局(不同 extract)。文件名只是聚合标签、与 scope 正交。
- **执行模型**:`extract(cdp, ctx)` 复用完整 `cdp` api(view/article/read/find/locate/eval/click)编排,返回 `{lines}`。信任边界:作者信任的本地代码(等同 run 脚本),非沙箱。
- **抽取/呈现分层(L1)**:eval 字符串只做 DOM 读(返回 raw 文本 + ref),归一化与 ref 呈现归 Node 侧共享 `rules/recipes/_lib.js`(`clean`/`refstr`/`opHint`/`abridge`/`entry`,纯函数可单测)。**不要**在 eval 里手抄 clean/refstr、不要硬编码操作提示。
- **只读探针(引擎原语)**:`lib/probe.ts` 随 view 注入装 `window.__cdpProbe`(recipe 必先 `cdp.view` 建树,故保证可用)。`refOf(el)` 通过 `__cdpRefIndex` O(1) 反查已建树 ref、`refOfSelector(sel)`(穿透 shadow)、`text(el)`。**只查已建树、绝不按需注册**,未命中返回 `null`。recipe eval 里 `const { refOf, text } = window.__cdpProbe`,不再手抄样板。
- **展开再读(引擎原语)**:`cdp.read(target, {container, expand?, wait?})`(Node 侧 api,杀折叠状态机痛点)。三步顺序 await——`expand` 则完成一次 trusted 坐标 `click` → Node `sleep` → `read-content` 注入(`src/inject/read-content.ts`)按 `container` selector 重查容器,统一 helper 对旧元素复号、重渲染替换的新元素追加,返回 ref → 复用 `article` 取完整 Markdown。**article 保持纯读不动**。折叠判定(哪个按钮=展开)留 recipe 按站点语义决定。
- **refOf(L2)**:只查已建树节点、**绝不按需注册**,未命中返回 `null` 而非 `-1`(语义「断言未建树」)。
- **分发**:`view`/`fetch`(CLI action 顶层)调共享 `dispatchView`:无建树意图且命中 recipe → 输出摘要(带 RECIPE_LEGEND);未命中或**建树意图**(`--tree`/位置 ref/`--selector-file`/`--visible-only`/`--scroll-*`)→ 纯结构树。`api.view` 保持纯结构(fetchPage/操作反馈内部照旧,无递归)。run 脚本显式要摘要调 `cdp.recipe`。
- **多规则命中**:匹配在跨文件×跨规则上做全序(每条规则取其与 URL 最匹配的 scope:通配最少 → 更长 → 声明顺序)。异常/返回 null → 安全回落树。
- **示例**:`rules/recipes/zhihu.js`(问题页首答全文 + 专栏文章全文,共用探针/read/abridge)。

### article
**Markdown 文章**:`inject/article.ts` 以 ref 为根提取格式友好的 Markdown。**专用保序 DOM 遍历**(不用 buildView),沿 `childNodes` 逐节点(Text 节点 + 元素)。
- **格式**:标题 `#`、段落空行分隔、链接 `[文本](href)`、粗斜 `**`/`*`、代码 `\`\`\``、列表 `-`/`1.`、引用 `>`、图片 `![alt](src)`;无文本交互元素降级 `[label]`(复用 `elLabel`);`BLOCK_TAGS` 遇块即停交 `walkEl` 单独成块。**不截断**,直接读完整文本。
- **链接跳转解码**:未命中黑名单的合法链接,输出前经 `lib/redirect.ts` 的 `decodeRedirectUrl` 把跳转包装(`link.zhihu.com/?target=…`)解回真实 URL。白名单表格只解明文承载(zhihu/juejin `target`、facebook `u`、google `/url?q`),百度密文/t.co/weixin 不碰,解不出原样保留;黑名单匹配仍用**原始 href**(先判黑名单、后解码输出,两语义不打架)。
- **Args**:`ArticleArgs{ref,ancestor?,ignoreLinks?}`。
- **限制**:仅遍历 light childNodes,shadow 文章不穿透。

### find
**按文本/selector 找元素**:`inject/find-entry.ts`(类 uBlock `:has-text()`)登记新 ref,不必整页重 tree。
- **`--text`**:整页 DFS(`childrenOf` 穿透 shadow + `ownElText` 取**自身直接文本**)搜关键词,命中即止。命中元素通过统一 helper 复用或追加进 `__cdpRefs`,`buildView(el,{viewport:true})` 取根行标 ref。
- **`--ancestor`** 爬父;**`--all`** 收集全部。
- **Args**:`FindCmdArgs{text?,selector?,ancestor?,all?}`。

### feedback
**变更感知**:`feedback-start/collect` 分两次 eval 协作,observer 存全局 `__cdpFeedback`。`startFeedback()` 装 MutationObserver 记 childList 新增+文本变化，以及白名单属性(`aria-*` 状态、checked/disabled/open/selected/class);`collectFeedback()` 断开后取**顶层新增元素**逐块 `buildView`,返回 `{blocks, changes, attrs}`。class 只报 token 差集，属性条目去重后限 20 条并回报溢出数。
- **编排**:Node `runWithFeedback` = 动作 + `sleep(feedbackDelay)` + diff tab;`noFeedback` 不观察/不等待/不 diff。
- **refInvalid 短路**:doAction 返回 `{refInvalid:true}` 则跳过 sleep/collect/tabdiff,透传 `recovered`。
- **shadow 穿透**:`observeAll` 递归 document+所有 shadowRoot 各起共享 callback 的 observer(`MAX_SHADOW_DEPTH=3`),动态 host 用 `observeShadowTree` 补装。
- **噪声过滤**:`inIgnoredSubtree` 跳过 VIDEO/AUDIO/CANVAS 子树;`foldTimestampRun`(已加单测)折叠连续 ≥3 条播放时间戳,纯数字计数不折叠;`hasAncestorInSet` 穿透 shadow。

### info(祖先链)
**祖先链全貌**:`inject/info.ts` 列目标从 `<html>` 到自身的祖先链,每层紧凑描述 `tag/id/class/语义 data-*/aria-label/role` + `genSel` 建议。与 locate 差别:locate 回一个 genSel(工具帮我定);info 回祖先链全貌(我自己挑)。
- **入口**:CLI `info <n> [--ancestor <k>]`;`api.info(target, ref, ancestor?)`;`cdp.ts` `printInfoChain` 格式化输出。

### click/hover(坐标输入)
**真实点击**:`inject/click.ts` 默认 `scrollIntoView(center/instant)` 后取元素中心 CSS 视口坐标;零尺寸/中心出视口直接报错。`document.elementFromPoint` 命中链会逐层进入 open `shadowRoot`,只有命中目标自身、后代或跨 shadow 的宿主组合包含关系才放行,否则报紧凑遮挡者 `<tag.class>`。
- **Node 事件链**:`api.click` 收到 `{x,y,tag,shadow,selector}` 后在同一连接中依次发 `Input.dispatchMouseEvent`:mouseMoved → mousePressed(left/buttons=1/clickCount=1) → mouseReleased(left/buttons=0/clickCount=1)。默认不调用 `el.click()`,所以事件走浏览器输入管线并有完整 pointer/mouse/focus/click 链。
- **显式兜底**:CLI `click --dom` / API `{dom:true}` 才走旧 `el.click()` 合成路径(`isTrusted:false`),供 fixed 布局滚不进视口时使用;遮挡/零尺寸绝不自动 fallback,保证语义稳定。
- **不变量**:坐标准备返回 `refInvalid` 时 api 直接透传且不 dispatch;动作仍完整包在 `runWithFeedback`,tag/actionSelector 回显与 ref 自愈契约不变。`hover` 继续复用同类“注入算中心 → Node dispatch mouseMoved”边界。
- **纯函数**:`inject/lib/click-position.ts` 提供中心视口判断和逐层命中链组合判定;`src/click-events.ts` 生成固定三段事件序列,均有零 DOM/运行时依赖单测。

### target-arg
**目标归一化**:`src/target-arg.ts`(纯函数零依赖)`normArg(a)` 把 click/fill/focus/hover 目标(selector 字符串或 `{ref,ancestor?}` 对象)归一化为 `{sel?}/{ref?}`。
- **防呆**:字符串 `/^\{[\s\S]*ref[\s\S]*\}$/`(对象字面量当 selector 误用)抛"CLI 直接传数字,脚本 API 才用 `{ref:N}`"。

## 返回契约(api.ts 的 `invoke`)

Node 侧统一 `invoke(target, expr)` 执行注入脚本并解包:成功返回任意值(可含 `{ok:true}`),失败返回 `{ok:false, err}`;`invoke` 统一把 `{ok:false}` 抛成异常,调用方无需各自判 ok。数据类入口(view 等裸对象)自然通过。改 api 方法统一走 `invoke`,别散落 `r?.ok`。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test`+`node:assert/strict`,零运行时依赖。
- `npm run test:integration` 先重建 `dist/` 并用 `tsconfig.integration.json` 类型检查 harness,再用 `tests/integration/*.test.ts` 启动 `node:http` 本地 fixture 与隔离的 `--headless=new` 真浏览器;所有驱动命令均是 `node dist/cdp.js <args>`。harness 用项目 `tmp/` 下的临时 `CDP_HOME`、`CDP_NO_AUTOSTART=1`、≥40000 的动态 CDP 端口和随机 fixture 端口,只按自己记录的 PID/进程组清理;本地无可用浏览器时显式打印 `SKIPPED` 并退出 0。CI 另设 `CDP_INTEGRATION_REQUIRE_BROWSER=1`,使 hosted runner 发现不到浏览器时硬失败,禁止静默假绿。
- `npm run test:pack` 在项目 `tmp/` 下建临时目录,执行真实 `npm pack`,校验 tarball 顶层恰为 LICENSE/README.md/dist/package.json/rules/skills,再由临时 consumer 执行 `npm install <tarball>` 和安装后的 `cdp-control --help`/`cdp-control kill`。`kill` 在隔离 `CDP_HOME` 无 browser.json 时直接短路,同时设 `CDP_NO_AUTOSTART=1` 与高位端口兜底;finally 删除安装目录与 tarball。CI 在 ubuntu/windows/macOS 各跑一遍。
- CI 的独立 `integration` job 在 ubuntu/windows/macOS hosted runner 上用最低支持版本 Node 22.6.0 跑完整链路;三平台镜像均有现有 `browser-discover.ts` 通用候选可发现的 Chrome/Edge,故 macOS 也纳入必须绿,workflow 不指定 runner 浏览器路径。CI 同时设 `CDP_INTEGRATION_DIAGNOSTICS=1`,逐条输出带 `①`…`⑧` 场景名、退出状态及 stdout/stderr 的命令记录。
- 集成覆盖:`view` 的 ref/value/语义状态、`find --text` 追加 ref、坐标 `click`+变更反馈、`fill` value 回显、持久 fold、DOM 删除后 refInvalid/recovered、`article` Markdown、selector 未命中的非零错误路径。
- 纯函数单测:`view-utils.ts`、`view-format.ts`(formatView/markText)、`view-budget.ts`(排序/削减/账单/骨架下界/maxLen 叠加/候选不重叠/3000 节点性能回归)、`genSel.ts`、`find-root.ts`(refElement/climbAncestors/classifyRef)、`ref-registry.test.ts`(WeakRef 形态/复号追加/parentRef 刷新/WeakMap 只查)、`click-position.ts`(中心可用性/跨 shadow 命中链)、`click-events.ts`(moved/pressed/released 顺序与参数)、`folds.ts`(parseRules/domainMatch/pathMatch/matchFolds/loadFolds,临时 CDP_FOLD_FILE)、`ignore-links.ts`(hrefForMatch/globToRegExp/linkRuleMatch/parseLinkRules + 浏览器侧 linkIgnored)、`target-arg.ts`(normArg 防呆)、`keys.ts`(parseKeySpec)、`transport.ts`(resolveTarget)、`browser-port.ts`(固定端口状态机/listener 归属与回收,副作用注入)。
- 注入侧复杂 DOM 行为(buildView/fold/inputInfo/state、find-entry 穿透 shadow、feedback observer/子树黑名单、recoverRef live 分支)主要靠浏览器实测(见 SKILL.md);预算链路另用最小假 DOM 锁定 `buildView` 两遍分配/复号 → 自动折叠不改 ref。纯函数分支(`formatView` 的 `·屏`/状态/shadow 占位/fold 优先/`inputAttr`、`feedback` 的 `foldTimestampRun`/class 差集/属性限量)有单测。

## 文档分工

- `skills/cdp-control/SKILL.md`:面向 **agent**(极薄),只教怎么调 `cdp-control`,不含构建/源码结构。`~/.claude/skills/cdp-control` 符号链接指向它。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。

### CLI 文档防漂

`npm run docs:check` 不维护第二份命令清单:它用现有 esbuild 从**当前** `src/cdp.ts` 生成隔离的临时 bundle,externalize `commander`,在不执行 `parseAsync`/action 的子进程里直接读取 Commander 的 `program.commands`、每个 command 的 `options[].long` 及 `required/optional` 值形态。临时进程固定 `CDP_NO_AUTOSTART=1`、隔离 `HOME`/`CDP_HOME` 并使用高位端口;结束删除项目 `tmp/` 下的工作目录。

校验严格单向——只要求 SKILL 已声明的 CLI 项真实存在,不要求文档穷举 Commander。受检范围是 Quick Reference 命令/共用参数表、命令参数表、标题明确列出适用命令的共享 option 段、bash/sh fence 中以 `cdp-control` 或文档别名 `cdp` 开头的调用、命令形态 inline code,以及非代码 fence 中出现的精确 long flag;有命令上下文时校验 flag 归属,显式写出值时同时校验是否带值。非 shell fence、`cdp.xxx()`/`window.__cdpProbe` 等脚本 API、fold/recipe 概念和 `--scroll-*` 通配说明不当成 CLI 声明。

盲区:不验证 short flag、位置参数、默认值、描述/业务语义与 flag 组合约束;无命令上下文的散文 flag 只能验证其在某个真实命令存在;未分组 shell 示例中 flag 后的字面量也可能是位置参数,故该写法只校验存在性,值形态由参数/签名表负责。Commander 当前所有注册均为同步初始化;未来若改成 action 后动态注册,需同步扩展提取方式。CI 的 lint job 在静态检查后独立运行 `npm run docs:check`。


---

以上为 Agent 自动生成，从此以下为用户所写。

上面的所有约定仅表示开发的历史路径，不代表未来约束。

重构、加新功能，在新的 branch 做，以迭代的方式分阶段提交，最后 merge 到 main。

这个项目是为服务 Agent 更好地读网页写的，一切以服务 Agent 为目标，所有的不合理通通可被扔，一切的重构要激进，要以最优为先，无需背负兼容性顾虑。

临时路径用项目根目录里的 `./tmp`
