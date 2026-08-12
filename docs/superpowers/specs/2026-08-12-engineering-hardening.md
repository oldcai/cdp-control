# 2026-08-12 工程化加固(engineering hardening)——评估与分拆

> 跟踪 PR:oldcai/cdp-control 的 `chore/engineering-hardening` → `dev`。
> 执行模式:任务**串行**,每个任务由 codex(`gpt-5.6-sol`,ultra effort)在独立子分支实现,
> m2 侧管理 agent 验收后 merge 进跟踪分支并勾掉 PR checklist 对应项。

## 差距评估(为什么做)

已经有的(不用重做):strict TypeScript + `tsc --noEmit` 门禁、esbuild 双世界构建、23 个纯函数单测文件(`node:test` 零依赖)、跨平台测试入口(`test.mjs` 修 cmd glob)、开发者/agent/设计三层文档、原子写配置、seed-once 规则存储。

缺的(按风险排序):

1. **零 CI**——没有 `.github/workflows`。三平台(尤其 Windows,见"改动别弄坏 Windows"约定)回归全靠人肉真机验证。
2. **核心路径零自动化测试**——注入侧(buildView/fold/find-entry/feedback/recoverRef/click 坐标链)在 CLAUDE.md 里明说"靠浏览器实测"。这是本工具最大、最核心的一块逻辑,没有任何回归网。
3. **规范未机器化**——无 lint/format;"禁 any"与依赖方向(`transport ← inject-loader/browser-* ← monitor/browser ← api ← cdp`、inject 不得 import Node 侧)只写在文档里,靠 reviewer 记忆。
4. **交付未验证**——`files` 白名单没有 pack 冒烟;`npm link` 全局命令没有安装冒烟;version 恒 1.0.0、无 CHANGELOG、publish 流程只是文档里一句话。
5. **文档防漂缺失**——SKILL.md 教 agent 的命令/flags 与 commander 真实注册项之间无一致性检查,改 CLI 忘改 SKILL.md 无人拦。
6. **提交链无门禁**——无 pre-commit,坏提交要等(将来的)CI 才发现。

## 全局约束(每个任务都适用)

- **Windows 可用性不许破坏**:优先无平台分支实现;确需平台分支,把逻辑抽纯函数并配可在任意平台跑的单测;报告里说清哪些是代码层论证、哪些是真机验证。
- **零新运行时依赖**:`dependencies` 保持只有 commander;devDependencies 允许但克制,能用 node 内置就用内置。
- **遵守注入契约**(CLAUDE.md「注入脚本契约」):动注入侧必读。
- **测试隔离**:任何测试**绝不碰**真实 `~/.cdp-control`(browser.json/rules/user-data)与用户日常浏览器端口(9222/9223);自建临时 home + 高位端口;结束必须杀掉自己拉起的浏览器进程、删临时目录(清场是任务的一部分,不是可选项)。
- **git 纪律**:动手前 `git fetch` 对齐真实 head;push 被拒就 rebase,**绝不 force-push**;发现别人已做过就叠加缺的部分(如补测试),不重复提交。
- **文档同步**:流程/命令有变,回写 CLAUDE.md 对应小节(增量,不重写)。

## 任务分拆(串行执行,T1 → T6)

### T1 CI:三平台矩阵(构建+类型+单测)

**目标**:每次 push/PR 自动在 ubuntu/macos/windows 三平台跑 `npm ci && npm run build && npm test`。

**交付**:
- `.github/workflows/ci.yml`:matrix 三 OS;Node 版本与 engines 一致(注意 `--experimental-strip-types` 需要 Node ≥ 22.6,`engines` 现为 `>=21` 是错的,顺手修正为实测最低可用版本);缓存 npm。
- README 加 CI badge。

**验收**:fork 上 Actions 三平台全绿;故意引入一个类型错误的临时 commit 能让 CI 变红(验完 revert)。

### T2 浏览器集成测试 harness(本地 fixture,headless,真 CDP 链路)

**目标**:把"靠浏览器实测"的核心路径变成一条命令可回归:`npm run test:integration`。

**交付**:
- `tests/integration/`:用 `node:http` 起本地 fixture 服务(固定 HTML,零外网依赖);headless 拉起真浏览器走完整 CDP 链路(启动→注入→断言),驱动层用构建产物 `dist/cdp.js`(测的是用户真正跑的东西)。
- **隔离机制**:给源码加一个受支持的测试隔离入口(建议 `CDP_HOME` env,或等效方案),让 browser.json/rules/user-data 全部落临时目录;harness 自己生成带 `--headless=new` args 的 browser.json、自挑高位空闲端口。
- 最小场景集:①`view` 建树含 ref/输入框 value/语义状态;②`find --text` 登记新 ref;③`click`(坐标链)成功 + feedback 感知 DOM 变更;④`fill` 后 value 回显;⑤fold 规则命中折叠;⑥DOM 删除后 ref 自愈(`refInvalid` + recovered);⑦`article` 输出 Markdown;⑧一条错误路径(selector 不存在→非零退出码+清晰 stderr)。
- 无可用浏览器时显式 skip(打印原因,退出 0),不假绿。

**验收**:m2 真机全绿;跑完 `ps` 查无残留浏览器进程、临时目录已删;连续跑两遍都绿(幂等);单测(`npm test`)不受影响。

### T3 集成测试进 CI

**目标**:T2 的 harness 在 GitHub Actions 上跑起来,浏览器回归从"m2 真机"升级为"每次 push 自动"。

**交付**:CI 增加 integration job:ubuntu(自带 Chrome)+ windows(自带 Edge)必须绿;macos 尽力而为,搞不定就在 workflow 里注明原因并跳过(不许静默)。浏览器发现走现有 `browser-discover.ts`,不许 hardcode runner 路径(发现逻辑缺口就补进 discover 并配单测)。

**验收**:fork Actions 上 ubuntu+windows 集成 job 全绿,连跑 3 次无 flaky;失败时日志能看出挂在哪个场景。

### T4 静态检查:lint + format + 依赖边界

**目标**:把文档里的规范变成机器门禁。

**交付**:
- lint(eslint flat config 或 biome,实现者选型,选型理由写进 commit message):`no-explicit-any` = error;未用变量/隐式返回等基础规则与现有 tsconfig 不冲突。
- format:全仓格式化一次性落地,后续 `npm run lint` 一并校验。
- **依赖边界机器化**:`src/inject/**` 禁止 import Node 侧;Node 侧依赖方向 `transport ← inject-loader/browser-config/browser-discover ← monitor/browser ← api ← cdp` 违反即报错(dependency-cruiser 或 eslint 规则,实现者选)。
- 现有代码清理到全绿;CI 加 lint job。

**验收**:`npm run lint` 零告警;故意写一个 `any` 和一个反向 import 各能被拦下(验完删);CI 绿。

### T5 交付工程:pack 冒烟 + 版本/CHANGELOG

**目标**:"发布"从文档里的一句话变成被测试的脚本。

**交付**:
- pack 冒烟测试:`npm pack` → 校验 tarball 内容恰为 `dist/rules/skills/package.json/README`(白名单漂移即红)→ 装进临时目录 → 跑 `cdp-control --help` 与一个无浏览器命令;进 CI。
- `CHANGELOG.md` 起头(倒叙补上已有里程碑的粗粒度条目即可);版本号规则(何时 bump、谁 bump)写进 CLAUDE.md。
- publish 演练脚本(dry-run,翻 private 的 checklist 脚本化,**不真发布**)。

**验收**:pack 冒烟在三平台 CI 绿;人工审阅 CHANGELOG 与版本规则条目。

### T6 提交链与文档防漂

**目标**:坏提交在本地就被拦;SKILL.md 不再无声漂移。

**交付**:
- pre-commit(注意 `prepare` 已被 build 占用,husky 不可用其默认位;用 `core.hooksPath` 或 lefthook):快速档 `typecheck + npm test`,可 `--no-verify` 逃生;安装方式写进 CLAUDE.md。
- `npm run docs:check`:提取 commander 真实命令/flags,校验 SKILL.md 中出现的每个命令/flag 真实存在(单向:文档提到的必须真;不要求全列),进 CI。

**验收**:改 CLI 删一个 flag 而不改 SKILL.md,`docs:check` 变红(验完 revert);pre-commit 在干净仓库 clone 后按文档一步装好。

## 验收通则(m2 管理 agent 执行)

每任务:codex 子分支实现 → 管理 agent 依次跑 `npm run build`、`npm test`、(T2 起)`npm run test:integration`、(T4 起)`npm run lint` → 对照该任务「验收」逐条核 → 全过才 merge 进 `chore/engineering-hardening` 并 push → 勾 PR checklist → **清场**(杀残留进程、关 Orca 终端、删临时目录)→ 下一任务。任何一条不过,把差距写清楚发回 codex 重做,不许"差不多就合"。
