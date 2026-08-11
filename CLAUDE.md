# cdp-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `skills/cdp-control/SKILL.md`**。
> 运行入口:`cdp-control`(全局命令,`npm link` 后任意目录可调;等效 `node dist/cdp.js`)。
> 数据归用户目录:`rulesDir()`→`~/.cdp-control/rules`(本机符号链接指向 `rules/`),浏览器用户数据→`~/.cdp-control/user-data`。

## 构建

`dist/` 不提交 git,改源码后重建:

```bash
npm install      # 首次:esbuild/typescript/@types/node/commander(运行时仅 commander)
npm run build    # tsc --noEmit + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
```

实时规则目录 = `~/.cdp-control/rules`(数据 home):本机它是**符号链接指向 `rules/`**(用户规则=根本规则,运行时读写直接落 git 工作树的 rules,**无覆盖问题**);干净环境是真目录,`rules-store.ts` seed-once 缺文件时从 `rules/` 拷默认。**build 不清不覆盖**(修 clobber)。

产物:
```
dist/cdp.js          入口 bundle(commander+全部 src,自包含;首行 shebang,经 package.json `bin` → 全局 `cdp-control`)
dist/*.js            其余 Node 侧(api/transport/monitor/browser/inject-loader/keys)
dist/inject/*.js     注入浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
```

**规则是数据非代码,不住 dist**:统一住 `~/.cdp-control/rules`(用户本机符号链接到 `rules/`,规则即根本、运行时读写直接入库),内置默认在 `rules/`(入库,publish 随包),干净环境由 `rules-store.ts` seed-once 拷贝。fold/ignore-links/recipe 全部经此(见「规则存储」)。

**全局 CLI(`npm link`)**:`package.json` 的 `bin.cdp-control` → `dist/cdp.js`(首行 shebang 由 `build.mjs` 给 cdp bundle 加 banner,只加这一次、勿配到 standalone/inject 产物)。`npm link` 后任意目录可敲 `cdp-control`;SKILL.md 全用此命令。`private:true` 不影响 npm link;publish 前翻 private + `files:["dist","rules","skills"]`。

## 源码结构(两层分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(CDP/CLI/api/纯函数;`folds.ts` 读写 fold 规则) | Node | 入口 `cdp.ts` bundle → `dist/cdp.js`;其余转译 CJS |
| `src/inject/*.ts` | 注入浏览器执行的 JS(入口) | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块 | 浏览器 | 打进各入口 |
| `skills/cdp-control/SKILL.md` | agent 用法文档(极薄,只教调 `cdp-control`);`~/.claude/skills/cdp-control` 符号链接指向它 | — | 不动 |

依赖单向无环:`transport ← inject-loader/browser-discover/browser-config ← monitor/browser ← api ← cdp`(browser 不再依赖 api,故 api 可前置 ensureBrowser)。定位收敛为两套:**ref(前台索引)+ selector(后台匹配)**。

## 浏览器连接(ensureBrowser / kill)

- **端口与用户数据路径入配置**:`browser.json` 的 `port`(默认 9222)与 `userData`(默认 `~/.cdp-control/user-data`)用户可改。`ensureBrowser()` 读配置后 `transport.setPort(cfg.port)` 同步端口,所有命令连该端口。`CDP_PORT` env 仅无配置时兜底默认。语义:**已就绪**(配置端口有响应)→ 直接用,就绪零开销(读配置 + 1 次 GET `/json/version`,顺带拿浏览器名);**未就绪** → 读 `~/.cdp-control/browser.json` 拉起(缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
- **启动配置 `~/.cdp-control/browser.json`**(用户可编辑,权威):`{ exe, kind, args, port, userData }`。`args` 存稳定参数(remote-allow-origins/no-first-run/window-size 等);`--remote-debugging-port` 与 `--user-data-dir` 由工具据 `port`/`userData` 生成。缺失时 bootstrap 用 `browser-discover.ts` 跨平台候选(Edge 优先)首个能拉起者原子写配置;损坏(JSON 非法/exe 不存在/args 非数组/显式 port 非法)打印清晰错误、**不 fallback**,用户改文件。原子写(tmp+rename)。
- **跨平台发现 `browser-discover.ts`**(纯函数):win env 路径表(Edge/Chrome 各通道)+`where`;mac 硬编码精确 `.app`+`Contents/MacOS/<bin>`(Safari 排除);linux `command -v` + `.desktop`。
- **配置解析 `browser-config.ts`**(纯函数):`parseBrowserConfig`(port/userData 缺省取默认,损坏抛清晰错)/`defaultArgs`(linux 加 `--disable-dev-shm-usage`)/`browserConfigPath`/`DEFAULT_PORT`/`DEFAULT_USER_DATA`。
- **冷启动**:`spawn(exe, [...args, --remote-debugging-port=<cfg.port>, --user-data-dir=<cfg.userData>], {detached:true, stdio:'ignore'}).unref()` → 轮询 `/json/version` 就绪(20s)→ `maybeSpawnDaemon`。浏览器不随父进程死(持久)。
- **"一切命令自愈"**:`api.resolve/list/open` 前置 `ensureBrowser()`(幂等)→ 所有 target 命令与 list/open 未起自动启动;`transport.evaluate` 由 api 的 `connectTarget` 包一层——连接失败(浏览器死/target stale)→ ensure + 按 url 重 resolve + 重试一次(堵 run 脚本直传 stale target);daemon(走 `pageWs`/`send`)天然豁免,不会死循环拉起浏览器。
- **`kill` 命令**:`cdp-control kill` 从 `browser.json` 读 `port`(**不**用默认 9222);**无配置 → kill 不生效**。找监听进程(netstat/lsof → pid)→ taskkill `/F /T`/SIGKILL → 等端口释放(Edge 崩溃自启会重绑,等待确认)。daemon 经 `spawnDaemon` 以 `env.CDP_PORT = transport.PORT` 拉起,端口由 ensureBrowser 从配置同步。

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
**核心索引**:内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 即下标。表存 **`{el, parentRef}`**(parentRef=最近已登记祖先,O(1) 跳表)。
- **分配**:view 重建**先清空再重排**;反馈/自愈/find **只追加**(增量号,不顶旧 ref)。
- **解析**:`lib/find-root.ts` 的 `refElement`(ref→元素,兼容两种形态)+ `climbAncestors`(`--ancestor` 用)。
- **回显**:操作成功回显唯一 selector(优先 selector 而非 ref);light 用 `genSel`;shadow 内回 `{ok,tag,shadow:true,selector:null}`,CLI 提示"用 ref";超长截断。统一走 `actionSelector(el)`。
- **失效自愈**:ref 路径返回 `{ok:false,refInvalid:true,recovered:recoverRef(ref)}`,selector 路径普通 err。`recoverRef` 三态(`classifyRef`):`none`/`never{maxRef}`/`live{start,maxRef}`;`live` 沿 `parentRef` 跳表找首个 `isConnected` 祖先,以它为根 `buildView`(增量 ref)返回 `{rootRef,lines}`,整链 detached 返回 null。Node `invoke` 对 `refInvalid` 透传不抛,`runWithFeedback` 短路,`cdp.ts` `printRefInvalid` 打三态。

### view-core(buildView)
**生成树 + ref**:内容/交互元素的紧凑树(view/feedback-collect/recoverRef/find 共用)。`buildView(root,{visibleOnly,viewport,folds})`。
- **两遍先序**:遍一(`simplify`)只建树 + 打标记(`wantRef`/`wantHidden`)+ 暂存 `node.el`,不登记 `__cdpRefs`;遍二(`assign`)按先序 DFS 一次性分配 `ref = __cdpRefs.length` + `{el,parentRef}`,号随树位置单调增。
- **标记**:`wantRef`(内容/交互/折叠/shadow 宿主)→ 设 `node.ref` 并打印 `[ref=N]`;`wantHidden`(纯包装含内容)→ 登记但不设 `node.ref`(view 不打印,info 反查可用)。
- **只追加不重置**:整页 `view` 才从 0 清空;其余只追加。
- **`viewport:true`**:算 `isInViewport` 存 `node.view`,输出 `[ref=i·屏]`/`[ref=i]`。
- **fold 折叠**:持久规则(`folds`)+ 会话临时(`__cdpFolds`)合并,`el.matches(selector)` 判定。命中**非根**元素(depth>0)标 `wantRef`、`node.fold=备注`、`kids=[]` 不递归;**根不折叠**(否则 `view <ref>` 展开折叠容器时根本身又被折叠);嵌套折叠自然支持。
- **shadow host 占位**:带 `shadowRoot` 的 Element 标 `wantRef`+`isContent=true`。`view-format.walk` 对 `depth>0 && shadow && ref` 输出 `<tag>[shadow] [ref=N]` 不展开子树,根正常走子树。
- **图标按钮兜底(`elLabel`)**:交互元素无直接文本时按 `aria-label → title → 直接文本` 取标。view 显示功能、article 降级 `[label]`,而非裸 `button [ref=N]`。
- **表单采集**:simplify 对 INPUT/TEXTAREA 设 `inputInfo={type,value,placeholder}`(value 截 40),输出 `input[type=text value="..." placeholder="..."]`,agent 不必 eval。
- **导出**:`strip`/`ownElText`(元素自身直接文本)/`subtreeText`(穿透 shadow)/`childrenOf`(穿透 shadow 取子)/`isInViewport`/`elLabel`/`buildView`。
- **滚动加载**:整页完整 `view` 首次自动 `scrollToLoad()`(置 `__cdpFullViewDone`,同页只滚一次;局部/`--visible-only`/显式滚动参数不触发),滚动后默认等 `scrollWait`(默认 1000ms,`--scroll-wait 0` 关)才建树。`api.fetchPage` 靠它一次抓全,等待条件="body 有非空文本"。

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
- **运行时可写数据**(fold.csv/ignore-links.csv):住 `~/.cdp-control/rules`(数据 home)。本机是符号链接指向 `rules/`(规则=根本,读写直落 git 工作树,无覆盖);干净环境是真目录,`rules-store.ts` **seed-once** 缺文件时从 `rules/` 拷默认(已存在不覆盖,修旧 clobber bug)。
- **作者代码(recipe)**:`rules/recipes/*.js` **直接读 git 权威**、不做 gitignored 镜像(曾 seed 到 `rules/recipes/` 双份手动同步必然漂移,2026-08 实测 `_lib.js` 差 22 字节)。recipe-runner 扫 `srcRecipesDir()`(经 `CDP_RULES_DEFAULT_DIR` 覆盖)。
`rulesDir()` 默认 `join(homedir(), '.cdp-control', 'rules')`;测试用 `CDP_RULES_DIR`/`CDP_RULES_DEFAULT_DIR` 覆盖(recipe 测试用后者指临时目录)。
**共享工具 `src/url-scope.ts`**(纯函数零依赖):`globToRegExp`(唯一实现,消 3 份重复)+ `hostOf`/`pathOf` + `urlMatches`。fold 用 hostOf/pathOf 拆两维正交;ignore-links 用拼接串单 glob;recipe 作用域用 urlMatches。

### recipe(站点抽取配方)
**聚焦站点摘要**:URL 命中的过程式摘要(文本 + 内嵌 `[ref=N]`),供 agent 聚焦读已知站点(如知乎问题页:标题/被浏览/逐回答/更多回答 ref),其余噪声隐去。
- **文件形态(L0 站点聚合)**:`rules/recipes/<site>.js`(**纯 JS 不接 build**,作者代码直接读 git 权威、无镜像)导出**规则数组** `module.exports = [{name, scope: string|string[], extract}, ...]`。`scope` 数组=一抽取逻辑服务多 URL 形态(同布局多地址);数组元素=同站点多布局(不同 extract)。文件名只是聚合标签、与 scope 正交。
- **执行模型**:`extract(cdp, ctx)` 复用完整 `cdp` api(view/article/read/find/locate/eval/click)编排,返回 `{lines}`。信任边界:作者信任的本地代码(等同 run 脚本),非沙箱。
- **抽取/呈现分层(L1)**:eval 字符串只做 DOM 读(返回 raw 文本 + ref),归一化与 ref 呈现归 Node 侧共享 `rules/recipes/_lib.js`(`clean`/`refstr`/`opHint`/`abridge`/`entry`,纯函数可单测)。**不要**在 eval 里手抄 clean/refstr、不要硬编码操作提示。
- **只读探针(引擎原语)**:`lib/probe.ts` 随 view 注入装 `window.__cdpProbe`(recipe 必先 `cdp.view` 建树,故保证可用)。`refOf(el)` 反查已建树 ref、`refOfSelector(sel)`(穿透 shadow)、`text(el)`。**只查已建树、绝不按需注册**(否则平移 ref 全局号、断 parentRef 自愈链),未命中返回 `null`。recipe eval 里 `const { refOf, text } = window.__cdpProbe`,不再手抄样板。
- **展开再读(引擎原语)**:`cdp.read(target, {container, expand?, wait?})`(Node 侧 api,杀折叠状态机痛点)。三步顺序 await——`expand` 则完成一次 trusted 坐标 `click` → Node `sleep` → `read-content` 注入(`src/inject/read-content.ts`)按 `container` selector 重查容器、展开重渲染替换元素则**末尾追加**登记(append 不平移既有号,同 find-entry),返回 ref → 复用 `article` 取完整 Markdown。**article 保持纯读不动**。折叠判定(哪个按钮=展开)留 recipe 按站点语义决定。
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
- **`--text`**:整页 DFS(`childrenOf` 穿透 shadow + `ownElText` 取**自身直接文本**)搜关键词,深度上限 `MAX_DEPTH=14`,命中即止。命中元素追加进 `__cdpRefs`(`{el,parentRef:null}`),`buildView(el,{viewport:true})` 取根行标 ref。
- **`--ancestor`** 爬父;**`--all`** 收集全部。
- **Args**:`FindCmdArgs{text?,selector?,ancestor?,all?}`。

### feedback
**变更感知**:`feedback-start/collect` 分两次 eval 协作,observer 存全局 `__cdpFeedback`。`startFeedback()` 装 MutationObserver 记 childList 新增+文本变化(前后值);`collectFeedback()` 断开后取**顶层新增元素**逐块 `buildView`,返回 `{blocks, changes}`。
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
- 纯函数单测:`view-utils.ts`、`view-format.ts`(formatView/markText)、`genSel.ts`、`find-root.ts`(refElement/climbAncestors/classifyRef)、`click-position.ts`(中心可用性/跨 shadow 命中链)、`click-events.ts`(moved/pressed/released 顺序与参数)、`folds.ts`(parseRules/domainMatch/pathMatch/matchFolds/loadFolds,临时 CDP_FOLD_FILE)、`ignore-links.ts`(hrefForMatch/globToRegExp/linkRuleMatch/parseLinkRules + 浏览器侧 linkIgnored)、`target-arg.ts`(normArg 防呆)、`keys.ts`(parseKeySpec)、`transport.ts`(resolveTarget)。
- 注入侧 DOM 相关(buildView/fold/inputInfo、find-entry 穿透 shadow、feedback observer/子树黑名单、recoverRef live 分支)依赖真实 DOM,靠浏览器实测(见 SKILL.md),不写单测。纯函数分支(`formatView` 的 `·屏`/shadow 占位/fold 优先/`inputAttr`、`feedback` 的 `foldTimestampRun`)有单测。

## 文档分工

- `skills/cdp-control/SKILL.md`:面向 **agent**(极薄),只教怎么调 `cdp-control`,不含构建/源码结构。`~/.claude/skills/cdp-control` 符号链接指向它。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。


---

以上为 Agent 自动生成，从此以下为用户所写。

上面的所有约定仅表示开发的历史路径，不代表未来约束。

重构、加新功能，在新的 branch 做，以迭代的方式分阶段提交，最后 merge 到 main。

这个项目是为服务 Agent 更好地读网页写的，一切以服务 Agent 为目标，所有的不合理通通可被扔，一切的重构要激进，要以最优为先，无需背负兼容性顾虑。

临时路径用项目根目录里的 `./tmp`
