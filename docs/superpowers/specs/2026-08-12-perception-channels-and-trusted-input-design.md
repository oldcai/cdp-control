# 感知多通道 + 真实输入通道 —— 对照 chrome-devtools-mcp 的设计重构

> 2026-08-12。依据：m2 上同一页面、同一任务（知乎回答 → 评论区 → 展开楼中楼 → 给楼中楼点赞）、
> 三个模型（gpt-5.6-luna / deepseek-v4-flash / Claude Sonnet 5）各跑 cdp-control 与
> chrome-devtools-mcp 两组，共 10 次运行的日志（`tmp/m2-zhihu/m2logs/`）。
> 本文只提设计，不含实现。**DESIGN.md 不在本文改动范围内**（那份文件的改动需人单独审核），
> 本文第六节给出往 DESIGN.md 树上的嫁接点，由人决定是否嫁接。

---

## 0. 结论先行

chrome-devtools-mcp 有 60+ 工具，真正值得拿的只有 6 个方向；其中 4 个是**我们自己的运行数据里
输掉或差点输掉**的，2 个是这几次没考到但母项目（linkbuilding 自动提交外链）一定会考的。

这次对照暴露的根因只有一句话：

- **指认（ref）这一枝是健康的** —— 我们赢在这里，别动。
- **感知这一枝是单通道的** —— 只有"结构文本树"一条。两次失分的共同根因。
- **操作这一枝是半吊子的** —— 键盘/hover 已走 CDP 真实输入，鼠标点击和填值还在页面里合成。

---

## 1. Tier 1：自己的数据里输掉/差点输掉的四项

### 1.1 元素状态没有进入感知通道

**证据**。Sonnet + cdp-control 那轮，为了判断"这条楼中楼我赞过没有"，连做两次 `info` 查
class（`Button--grey` = 未赞 / `Button--red` = 已赞）。因为 view 里只有：

```
button "回复" [ref=472, visible]
button "喜欢" [ref=473, visible]     ← 0 赞
button "回复" [ref=453, visible]
button "10"  [ref=454, visible]      ← 10 赞，但"我"赞没赞过？看不出来
```

文本相同、状态不同，树里无从区分。8 步命令里有 3 步（两次 `info` + 一次复核）纯粹在猜状态。

**别高估 MCP**。它的 a11y 树**同样没有**这个状态——知乎压根没设 `aria-pressed`。
Sonnet + MCP 是靠**截图看到实心红心** + "0 赞 ⇒ 没人赞过 ⇒ 肯定不是我赞的"这条推断赢的。
所以该学的是"多一条取证通道"，不是"换一棵树"。

**更该反省的是我们自己**。真正的状态证明（class 从 grey 变 red）**被我们自己的反馈通道丢了**：
MutationObserver 只记 `childList` 新增与 `characterData` 文本变化，**不观察属性**。
那次运行里状态是从 `genSel` 回显意外漏出来的一行：

```
已点击: ref=969 (button) ，该元素的 selector 为: .Button--red
```

**设计动作**（两处，都在现有机制内，不新增抽象）：

1. **感知侧**：view 的元素标注从"文本 + 可交互"扩到"文本 + 可交互 + **语义状态**"。
   收 `aria-pressed / aria-expanded / aria-checked / aria-selected / aria-current / aria-disabled`
   与原生 `checked / selected / disabled / open`。这不是新通道，是 view-core 现有
   `inputInfo`（目前只有 `{type,value,placeholder}`）的自然扩张——**对一个要在陌生站点填表提交的
   母项目来说，`checked`/`disabled` 缺失本身就是 Tier 1，且几乎免费**。
2. **反馈侧**：MutationObserver 加 `attributes: true`，但**只观察动作目标所在子树**
   （全页属性变化会淹没），且只报进入语义白名单的属性。`class` 特殊处理：只报差集
   （`+Button--red -Button--grey`），不回整串。

做完这两条，1.1 的三步猜状态归零，且不需要动用像素。

### 1.2 网络是取证通道，我们完全没有

**证据**。4 次 MCP 运行里有 2 次（R2 luna、R4 deepseek 官方）用
`list_network_requests` + `get_network_request` **读那条点赞 XHR 的响应体来证明操作落库**。
我们这边只能靠"文本 喜欢→1"和 class 推断。

第二个证据来自我自己：写随机选题脚本时手写了三个知乎接口
（`/api/v4/comment_v5/answers/<aid>/root_comment` 等）——**那是看网络面板才知道的，
我们的工具给不了**。

**设计动作**。`logs` 的 daemon 已经在每个 tab 上 `Page.enable` +
`Page.addScriptToEvaluateOnNewDocument`。**同一个 daemon 加一路 `Network.enable` 订阅**，
缓存 `requestWillBeSent / responseReceived / loadingFinished` 摘要
（method / url / status / type / 耗时 / 大小），body 按需拉。
新增 `network` 命令与 `cdp.network()`，形状对齐现有 `logs`（`--since` / `--filter` / `--json`）。
**不新增架构，只是 daemon 的第二种订阅。**

对母项目的价值大于对本次任务：提交表单到底成没成，看返回码远比看页面文案可靠。

### 1.3 像素是最后一道取证，我们的 screenshot 是残废的

**现状**：`screenshot` 只能整页、只能落盘、**模型看不到**（只回一个文件路径）。
后果——5 次 cdp-control 运行里**一次都没人用过**。

**MCP**：`take_screenshot(uid)` 能截**单个元素**并把图**内联回给模型**。
Sonnet + MCP 靠它确认红心；deepseek 本地那轮也去截了图（被 32k 网关拒了）。

**设计动作**：`screenshot [<ref>]` 支持以 ref 为范围
（`getBoundingClientRect` → `Page.captureScreenshot` 的 `clip`），默认**内联返回**而非落盘。
定位成"**状态说不清时的最后一问**"：一个按钮的截图几百 token，比整页树便宜一个量级。

与 1.1 联动：1.1 做好后绝大多数状态问题不该走到像素。**像素是兜底，不是主路。**

### 1.4 view 没有 token 预算，会把 agent 撑死

**证据**：R3（deepseek 本地，32k 上下文）唯一死因是一次
`view --tree --scroll-to-load` 把上下文顶到 **33,407 > 32,768**——差 639 token。
不是模型能力问题，是我们**无节制地吐**。

MCP 的 snapshot 同样没预算（同一页 23,399 字符）。**这不是抄它，是两边都欠的账**；
而我们已经有更好的武器：recipe 把同一页压到 **2,557 字符**（1/9）。

**设计动作**：把**预算**升为 view 的一等概念。

- 默认软上限（`--budget` 可调）。超预算不是截断了事，而是**主动降级并声明**：
  先折更深层级 → 再合并同构兄弟（`(同类 12 条，已折叠) [ref=…]`）→ 最后按屏分页并告知
  "还有 N 屏，`view --page 2`"。
- 输出头部报 `预算 X / 实际 Y / 已折叠 Z 处`，让 agent 知道自己看到的是不是全部。

这条兑现 DESIGN.md 里"承诺完整页面"那句：现状是"完整但可能撑死"，应改为
**"要么完整，要么明确告诉你哪里不完整"**。

---

## 2. Tier 2：这几次没考到，但母项目一定会考

### 2.1 click / fill 是页面内合成事件，不可信

**事实核对**（`src/api.ts`、`src/inject/click.ts`、`src/inject/fill.ts`）：

| 动作 | 通道 | isTrusted |
|---|---|---|
| `press-key` | `Input.dispatchKeyEvent` | ✅ 真 |
| `hover` | `Input.dispatchMouseEvent`（mouseMoved） | ✅ 真 |
| `click` | 注入脚本里 `el.click()` | ❌ 假 |
| `fill` | `value` setter + 手派 `input`/`change` | ❌ 假，且无任何 key 事件 |

**键盘已经是真的，鼠标还是假的**——同一层里两套机制，正是设计律第 2 条要停下来重审的信号。

这也正是 SKILL.md「常见错误」里那两条的根因：
"click 没生效 → `el.click()` 是合成事件，组件不吃"、"fill 富文本框无效 → React 需额外 setter"。
**我们把自己的架构缺陷写成了给 agent 的注意事项**——按设计律第 1 条，
"只为修补另一个抽象的副作用而生"的东西该砍。

**设计动作**：动作层统一到 CDP `Input.*`。

- `click` = scrollIntoView → 取 rect 中心 → `mousePressed` / `mouseReleased`。
  附带解决"被遮挡"：命中测试能发现点到的不是目标，正好兑现 DESIGN.md
  "结果诚实：要么生效，要么说清为何没生效（未命中 / 被遮挡 / 世代切换）"。
- 新增 `type <ref> <文本>`：`Input.insertText` 或逐字符 key 事件。对 contenteditable /
  富文本 / 受控组件才靠谱。`fill` 保留为快速路径（简单 input 一次到位、省往返）。

附带红利：真实 `mousedown` 让"必须 hover 才出现的菜单""长按""拖拽"成为可能。

### 2.2 缺 `drag`

滑块验证码、排序控件。母项目自动提交外链必然遇到。
`Input.dispatchMouseEvent` 三段式，做在 2.1 的同一层里几乎免费。

### 2.3 缺 `upload_file`

文件选择框一点会弹**系统对话框**，那在 CDP 之外，只能靠 `DOM.setFileInputFiles`。
提交目录站要传 logo / 截图，这是硬需求，且**现在完全无解**（`eval` 也做不到）。

### 2.4 缺 `handle_dialog`

DESIGN.md 已把它写进"操作 > 反馈 > 对话框：alert / confirm 弹出即感知、可处置，
不许卡死整条管线"，但**没实现**。native dialog 会**卡死整条 CDP 管线**。
`Page.javascriptDialogOpening` 事件 + `Page.handleJavaScriptDialog`，daemon 顺手就监听了。

### 2.5 缺 CLI 层的 `wait`

R1 luna + MCP 用了 `wait_for`。我们脚本 API 里有 `waitFor` / `waitForFn`，
但**CLI 没有**，所以 CLI 用户只能吃 feedback 的固定 1s。
建议 `wait --text <文本> | --ref-gone <n> | --idle`（网络空闲靠 1.2 的 Network 订阅顺带做出来）。

---

## 3. 明确不抄的，附理由

| 它有的 | 不抄的理由 |
|---|---|
| 整棵 a11y 树（`take_snapshot`） | 同一页 **23,399 字符 vs 我们 recipe 的 2,557**。且 `link "关注" url=…` 下面必挂一个 `StaticText "关注"`，文本重复一遍。最关键：它**并没有**解决我们真正缺的那个状态。该拿的是 role/state 这类**语义属性**（见 1.1），不是换一棵树。 |
| `uid = <snapshotId>_<序号>` | 每照一次快照全表作废，agent 必须重照。我们的 ref **同世代内单调只增、永不清零**，反馈还给增量 ref 即拿即用。这是我们赢的地方。 |
| `click(includeSnapshot: true)` | 动作后回**整张新快照**。我们回**增量 diff**（新增块 + 文本变化）。R2 里 MCP 的缓存 input 是我们的 8 倍，这是主因之一。 |
| performance / lighthouse / heapsnapshot（12 个）/ extension / PWA / WebMCP / 第三方工具 | 那是"给前端工程师做性能与内存调试"的产品，不是"给 agent 读网页"的。60+ 工具里一大半是这些。 |
| `emulate` / `resize_page` | 边缘。唯一值得记的用途是"切移动版 UA 拿更小的 DOM"；真要省 token，recipe 比它准。放 TODO，不进主干。 |

顺带：Google 自己给了 `--slim`，只留 3 个工具（导航 / 执行脚本 / 截图）。
**它们也知道 60 个工具是负担。**我们的小命令面是对的，别因为对比就去堆工具。

---

## 4. 悬而未决的权衡：链接要不要带 href

MCP 树里每个 link 都挂 `url="…"`；我们的树里只有 `a "冒险者2484" [ref=420]`
——**agent 不知道点下去会去哪**，要么点了看反馈，要么 `article` 取正文。

- 带上：agent 能判断"这链接值不值得点"，`fetch` 之前先筛。
- 不带：知乎一页几百个链接，href 常比锚文本长一个数量级；
  ignore-links 规则的存在本身就说明"URL 是噪声"这个判断成立过。

三个选项：

1. 不带（现状）。
2. 只带**跨域 / 跨路径**的，站内路径缩写（`→/question/…`）。
3. `--links` 开关，按需。

倾向 2——URL 的信息量集中在"去不去别的地方"，而 ignore-links 已证明我们能做这种规则化裁剪。
**但这是人的决定，本文不擅自定。**

---

## 5. 已经赢的，别动

- **ref = 世代内单调句柄 + 父链自愈**：MCP 的 uid 每 snapshot 作废；我们跨 view 有效，
  失效还能沿 `parentRef` 局部重建。
- **增量反馈**：动作后只回 diff，不回整页。
- **recipe 压缩**：同一页 2,557 vs 23,399 字符。这是 R2 里
  cdp-control **7 次工具调用**（含 1 次 `cat SKILL.md`，真正浏览器命令 6 次、其中 3 次点击）
  打完，而 MCP 用了 **17 次**的根本原因——MCP 有大量 `evaluate_script` 在**猜 DOM 结构**
  （deepseek 官方那轮 30 次调用里 17 次是 `evaluate_script`），
  而我们的 agent **一次 DOM 探查都没写**。

---

## 6. 往 DESIGN.md 树上的嫁接点（供人审核后手动嫁接）

- **感知**
  - `view 压缩页面` → `用标识代表元素状态` 下补：**语义状态标注**（aria-*/checked/disabled/expanded）。
  - `聚焦` 下与 `主动聚焦` 平级补：**像素聚焦**（`screenshot <ref>`，内联回传，兜底用）。
  - `感知` 下与"页面感知"并列补：**网络感知**（请求/响应摘要，取证与接口发现）。
  - `承诺"完整页面"` 改为：**预算内完整；超预算必须显式声明降级方式与剩余量**。
- **指认**：不动。
- **操作**
  - `动作` 下 click/fill 归入**真实输入通道**（与 press-key / hover 归一），补 `type` / `drag` / `upload`。
  - `反馈` 的观察维度补**属性变化**（限动作目标子树 + 白名单）。
  - `对话框` 从设计条目落成实现。
- **配套**：补 `wait`。
- **已知盲区**：`iframe`、`遮挡/弹窗` 两条仍然有效；真实点击的命中测试能部分兑现"遮挡"那条。

---

## 7. 建议的落地顺序（每步可独立提交、独立验证）

1. **1.1 状态标注 + 属性反馈** —— 收益最直接（消掉 Sonnet 那轮 3 步猜状态），改动面最小。
2. **2.1 真实输入通道（click/fill→Input.\*，新增 type）** —— 消掉 SKILL.md 两条"常见错误"。
3. **1.2 网络订阅（daemon 加一路）+ 2.5 wait --idle** —— 一套机制出两个能力。
4. **1.3 screenshot 支持 ref + 内联返回**。
5. **1.4 view 预算与降级声明**。
6. **2.2 drag / 2.3 upload / 2.4 dialog** —— 母项目驱动，按需。
