# find --goal 评测数据

- `goals.json`:49 条目标,`gold` 是匹配树行的正则(可对应多个等价 ref),`null` 表示页面上没有这种元素。标注在调用模型之前写好并冻结(搬自 2026-11-05 原型的 `prereg.py`)。**目标和标注都是作者自写**。
- `trees/<page>.txt`:同一时期 `cdp-control fetch` 抓的 10 个公开页面的树。只保留带 ref 的行,并用 `stripInputValues` 去掉了输入框的值(隐藏字段里可能有 token)。

由 `scripts/eval-find-goal.ts` 使用;`tests/find-goal-fixtures.test.ts` 离线校验数据与标注对得上。
