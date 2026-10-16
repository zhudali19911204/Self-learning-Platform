# 课程大纲生成失败诊断

诊断日期：2026-10-15。

## 复现范围

按用户要求使用已保存的付费模型 `qwen3.8-max`，沿用现有 `llm.mjs`、`server.mjs`、大纲提示词和校验逻辑。由于本地课程数据出站被自动审批拒绝，最终使用用户截图提供的“危险行动规则与胜负条件解析”标题及目标，补充现场编写的学习目标、零基础、25分钟参数测试；未读取课程数据库、真实 learningBrief、笔记或聊天。因此这是同主题、同错误的复现，不是历史请求逐字重放。

诊断入口：`test-support/outline-live.cjs`，需显式传入 `--confirm-paid --public-sample`。Key只用于向原配置服务认证，不输出。只有一次生成请求预算，禁止搜索和自动重试，不保存返回大纲。

## 真实调用结果

- 目的地：`token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`。
- 实际生成请求：1次；搜索：0次；自动重试：0次。
- 上游HTTP：200；`finish_reason`：`stop`，没有输出截断。
- 服务商用量：输入628 tokens、输出635 tokens、总计1263 tokens。具体费用以服务商账单为准。
- 根字段：`intro`、`blocks`，共8个模块。
- `validOutline`：通过。
- `validGeneratedOutline`：未通过。
- 应用接口：HTTP 502，返回“模型返回的内容不完整或格式不符合要求，请重试生成。”。
- 课程保存/覆盖：无。

## 明确触发原因

模型返回的模块顺序：

1. reading：核心目标与胜负判定。
2. example：成功撤离流程。
3. reading：死亡惩罚机制。
4. example：贪心搜刮与安全撤离对比。
5. reading：单局时间限制。
6. practice：当前该继续搜刮还是立刻撤离？
7. quiz：核心规则与决策逻辑检验。
8. summary：生存法则提炼。

`course-generation.mjs` 的 `validGeneratedOutline` 对每个 reading 要求下一项类型必须为 example。第5项后是 practice，触发 `block_5_reading_not_followed_by_example`。其他结构、必填字段、长度、重复项及测验前是否有讲解的检查均通过。

该次报错是教学模块顺序规则未满足，不是Key鉴权失败、网络失败、JSON解析失败或联网引用问题。提示词要求讲解后有案例，但真实模型没有完全遵守；布尔校验将具体原因合并成了通用格式错误。

## 后续可选修复

先把大纲校验改为返回明确的问题位置，让界面说明“第5个知识讲解后缺少配套案例”。如保留严格的讲解/案例配对，则需要在生成流程中明确处理缺失案例；不能仅把practice类型强行重命名为example，二者教学目的不同。是否放宽为讲解后允许实践检验属于教学策略调整，应单独决定。本次仅诊断，没有修改应用生成规则，也没有追加付费重试。
