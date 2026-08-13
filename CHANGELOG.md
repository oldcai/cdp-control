# Changelog

本项目的重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **尚未发布**:`package.json` 中的 `1.0.0` 仍是 `private:true` 的开发占位版本;仓库尚无正式版本或发布 tag。以下条目均属于 Unreleased,日期只表示里程碑进入仓库的时间,不是发布日期。

## [Unreleased]

### 2026-08-13

- 把 daemon 逻辑身份的「已 pin 端点」前提变成结构约束:`logs` 与其它 target 命令一样前置 `ensureBrowser()`,端点未同步到 `browser.json` 权威 port 时身份计算直接 fail closed(不探 health、不接管、不 spawn),daemon 侧显式认领父进程 pin 后传下的端点。修复首个 api 调用为 `logs` 且配置端口非 env 默认时,健康 watcher 被判 `owned-stale` 而遭误接管。
- 增加零依赖、显式安装的 `core.hooksPath` pre-commit 快速门禁，以及从 Commander 真实注册项单向校验 agent skill CLI 命令/long flag 的 `docs:check` CI 门禁。
- 将 `browser.json.port` 定为权威 CDP 端口：健康端点直接复用，非健康 listener 经 PID + 进程 birth identity 稳定快照、整组回收和释放确认后仍在原端口启动；不再寻找或回写漂移端口，并覆盖并发 launcher 提前退出后的延迟就绪复用。
- 补上 daemon 侧「端点必须由父进程 pin 后经 env 传下」的回归覆盖:缺 `CDP_HOST`/`CDP_PORT`(含空串)时 `pinEndpointFromEnvironment` 与 daemon 入口一律 fail closed 且不留半 pin 状态,正路径则保证 daemon 发布的身份等于父进程算出的身份。

### 2026-08-12

- 增加交付门禁:`npm pack` 内容精确白名单、临时 consumer 真安装并执行 CLI、三平台 CI pack 冒烟,以及隔离凭据且固定无效 registry 的 `npm publish --dry-run` 演练。
- 建立 ubuntu/macOS/Windows × Node 22.6.0/24.x 构建测试矩阵、隔离的真浏览器集成 harness 与三平台集成门禁,并加入 Biome 和依赖边界静态检查。
- 默认点击改走 CDP 真实坐标输入并保留显式 `--dom` 兜底;ref 登记表改为 WeakRef 稳定句柄,同页复用旧号且只追加;view/feedback 增加语义状态与属性差集。
- 加固跨平台浏览器端口决策、并发冷启动和 kill 归属/结果判定,避免误杀或谎报成功。

### 2026-08-11

- 交付全局 `cdp-control` bin 与极薄 agent skill;发布文件收敛为构建产物、规则和 skill,并以 `prepare` 支持 git/pack 安装前构建。
- 引入跨平台浏览器发现和 `browser.json` 权威配置,统一 `ensureBrowser()` 自愈、端口/user-data 配置及按配置 kill。
- 将可写规则数据统一到 `CDP_HOME/rules`,内置规则随包交付并 seed-once,recipe 继续直接读取包内权威源。

### 2026-08-10

- 增加保序、不截断的 Markdown `article` 提取,并支持 ignore-links 与常见跳转包装 URL 解码。
- 增加站点 recipe 分发、统一规则存储和 URL scope,随后扩展为一文件一站点多规则及共享 probe/read/entry/abridge 原语。
- 完善 view 两遍先序登记、图标按钮语义、默认不截断与按需结构树/站点摘要分发。

### 2026-08-08

- 完成 TypeScript + esbuild 重构:Node CLI bundle 与浏览器侧自包含 IIFE 分离,确立 `__CDP_ARG__`/`__cdpResult` 注入返回契约和 Node 内置测试入口。
- 建立 ref 句柄定位和操作后反馈基础,使 click/fill/focus/hover 能以 ref 穿透定位并回报页面变化。
