# 知行 Learnflow

一个中文、自助式 AI 学习工具：目标 → 路线 → 课程 → 练习 → 个人 Wiki。提供 Windows 桌面版，也保留 Web 开发模式。

## Windows 桌面版

打包后运行 `release/Learnflow-Setup-0.1.0.exe` 安装。也可直接运行 `release/win-unpacked/Learnflow.exe`（需保留同目录的其他文件，不能只拷贝 exe）。安装后从桌面“知行 Learnflow”快捷方式打开，无需安装 Node.js，也不用手动启动 Web 服务。

源码启动及打包：

```powershell
npm install
npm run desktop
```

调试时可直接启动独立的开发测试版（不打包）：

```powershell
npm run desktop:dev
```

开发测试版会打开模型设置页，使用项目中的 `.desktop-dev/data/` 保存数据，与已安装版本和自动化测试数据分开，可以同时运行。它不会自动导入正式版模型配置或学习记录，需要在测试版填写配置，或手动导入学习备份。

```powershell
npm run desktop:build
```

`desktop:build` 生成 Windows x64 安装包；`desktop:pack` 只生成解包目录。开发/构建需要 Node.js 22.12 或更高版本。首次安装依赖和打包需要联网下载 Electron、NSIS 等工具；应用运行时不需要这些构建工具。当前安装包未做代码签名。

### 在应用内配置模型

进入左侧“设置与数据”，选择模型服务，填写模型名称和地址，然后保存。配置立即生效，不需要 `.env`，也不需要重启。桌面版不会自动读取系统环境变量或 Web 版 `.env`，以避免误用其他项目的云端配置。

- 默认启用“仅使用本机模型”：只允许 `localhost`、`127.0.0.1`、`::1`，阻止云端和局域网地址。
- 本地使用：先在 Ollama、LM Studio 或 vLLM 安装/加载模型并启动模型服务，再填写实际模型 ID。软件不捆绑模型权重，也不会自动安装或启动模型服务。
- 云端使用：关闭“仅使用本机模型”，选择 DeepSeek 或通义千问，选择“设置 / 更换密钥”并填入 API Key。使用云端时，相关课程和笔记会发送给服务商。
- API 地址留空时使用服务预设；自定义兼容服务必须填写。地址不含末尾的 `/chat/completions` 或 `/api/chat`。
- 保存后点击“测试已保存的模型连接”。改动未保存时不能测试；连接测试仅发送固定短提示，云端按服务商规则计费。
- 如果提示远端地址与“仅使用本机模型”冲突，可点击“允许远端连接并保存”，明确允许后应用会取消仅本机选项并保存当前表单。也可保留此选项，将接口地址改为本机服务；冲突时不会改动已保存的配置。
- 填写新 API Key 时会自动选择“设置 / 更换密钥”，避免输入被“保留旧密钥”选项忽略。
- 更换服务或地址时不会自动沿用之前的密钥，需显式填写新密钥。

示例课程、练习、已有 Wiki 的阅读和编辑都可以离线使用。生成新内容需要可用的本地模型服务，或联网使用云端模型。

### 本地数据与备份

Windows 默认保存位置为 `%APPDATA%/Learnflow/data/`，可在设置页点击“打开本地数据目录”查看实际位置。

- `learning.json`：学习路线、课程、成绩、心得与 Wiki。
- `settings.json`：模型配置；API Key 使用 Windows 系统加密机制加密后保存，不以明文写入。
- `*.bak`：上一次成功保存前的版本，不是永久历史记录。后续保存会更新备份，应另行导出长期备份。

数据按顺序写入，先写临时文件再替换。读取异常时保留原文件并停止覆盖；可关闭应用，另行备份整个数据目录后检查或恢复 `.bak`。系统加密不可用时拒绝保存密钥，可继续使用不需要密钥的本地模型。加密密钥绑定当前系统用户，不应依赖复制 `settings.json` 在另一台机器上恢复密钥。

“导出完整 JSON 备份”和“导出 Wiki Markdown”会打开系统保存对话框。可导入旧 Web 版导出的 Learnflow JSON；导入需要确认替换现有学习数据，模型配置不受影响。学习备份不包含密钥。Web 版浏览器数据与桌面版文件彼此独立，不会自动迁移。

桌面窗口使用隔离和沙箱，页面没有 Node.js 权限。内置服务仅绑定回环地址、使用随机端口和会话令牌，随应用关闭；不会提供局域网服务。软件本身没有云同步或遥测。

## Web 开发模式

需要 Node.js 22.12 或更高版本。Web 服务本身没有第三方运行依赖；桌面开发需要执行 `npm install` 安装开发依赖。

```powershell
npm run dev
```

打开 http://localhost:3000。服务仅监听本机 `127.0.0.1`，请通过 `localhost` 或 `127.0.0.1` 访问。

未配置模型时，可直接体验 Python 入门示例：6 节完整课程、12 道测验题、成绩反馈、课程笔记、Wiki 卡片编辑、标签关联、关键词检索和 Markdown 导出。示例模式不把预设内容伪装成 AI 生成，不支持自定义主题生成。

## 连接真实 AI

本节 `.env` 配置仅用于 **Web 模式**。桌面版请在应用内设置相同的服务、模型和地址。

已支持国产云端模型和本地部署模型，所有调用由服务端发出。无需安装服务商 SDK。

| 接入方式 | `LLM_PROVIDER` | 默认接口根地址 | 密钥 |
| --- | --- | --- | --- |
| DeepSeek 云端 | `deepseek` | `https://api.deepseek.com` | 必填 |
| 通义千问 / 百炼（北京） | `qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 必填 |
| Ollama 本地 | `ollama` | `http://127.0.0.1:11434` | 默认不需要 |
| LM Studio 本地 | `lmstudio` | `http://127.0.0.1:1234/v1` | 按服务配置 |
| vLLM 自部署 | `vllm` | `http://127.0.0.1:8000/v1` | 按服务配置 |
| 其他 Chat Completions 兼容服务 | `compatible` | 必须手动填写 | 按服务配置 |

模型名称不写死在程序中，请使用服务商控制台中有权限调用的模型 ID，或本地实际安装/加载的模型 ID。不同模型对结构化输出的支持不同；选择支持指令跟随与 JSON 输出的对话模型。预设支持按官方接口实现，真实可用性请用页面连接测试验证。

1. 复制 `.env.example` 为 `.env`（已有 `.env` 时直接编辑，不要覆盖现有密钥）。
2. 从下面选一套配置，填写自己的模型名称；云端还需填写 API Key。不要把密钥写进前端文件、Git 或聊天消息。
3. 停止旧服务，再运行 `npm run dev`。配置仅在启动时读取。
4. 打开“设置与数据”，点击“测试模型连接”。成功表示鉴权、模型调用和 JSON 输出均通过测试；连接测试不保证完整课程生成质量。

连接测试仅发送固定短提示，不发送学习记录；云端测试会产生少量模型调用费用。页面加载和查询状态不会调用模型。

### 国产云端：DeepSeek

```dotenv
LLM_PROVIDER=deepseek
LLM_MODEL=填写控制台中可用的对话模型ID
LLM_API_KEY=填写你的DeepSeek密钥
LLM_BASE_URL=
```

程序自动使用 DeepSeek 根地址、Bearer 鉴权和 JSON Object 输出，并关闭思考模式。模型 ID 请以[官方 API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)为准。

### 国产云端：通义千问 / 百炼

```dotenv
LLM_PROVIDER=qwen
LLM_MODEL=填写百炼控制台中可用的千问模型ID
LLM_API_KEY=填写你的百炼密钥
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

此预设使用北京地域兼容接口，关闭思考模式（`enable_thinking=false`）并开启 JSON Object 输出。若控制台提供的是其他地域或专属工作空间地址，请将 `LLM_BASE_URL` 替换为对应根地址，密钥须与地域/工作空间匹配。参考[百炼接口地址](https://help.aliyun.com/zh/model-studio/model-calling-in-sub-workspace)、[结构化输出](https://help.aliyun.com/zh/model-studio/qwen-structured-output)和[思考模式](https://help.aliyun.com/zh/model-studio/deep-thinking)。

### 本地：Ollama

安装并启动 [Ollama](https://ollama.com/download)，准备模型后用 `ollama list` 查看准确名称。程序不会自动下载模型。

```dotenv
LLM_PROVIDER=ollama
LLM_MODEL=填写ollama-list显示的完整模型名称
LLM_BASE_URL=http://127.0.0.1:11434
LLM_API_KEY=
```

使用原生 `/api/chat`、`format=json` 与非流式输出，关闭思考。参考 [Ollama 官方接口](https://docs.ollama.com/api/chat)。旧的 `OLLAMA_MODEL`、`OLLAMA_BASE_URL` 仍兼容：仅在 provider 为 ollama 且对应的 `LLM_*` 变量为空时回退到旧变量。

### 本地：LM Studio 或 vLLM

LM Studio：加载模型，在 Developer 中启动服务，模型 ID 使用服务显示的 identifier。

```dotenv
LLM_PROVIDER=lmstudio
LLM_MODEL=填写已加载的模型ID
LLM_BASE_URL=http://127.0.0.1:1234/v1
LLM_API_KEY=
```

vLLM：启动模型服务后，填写实际对外暴露的模型名称（例如部署时设置的 served model name）。

```dotenv
LLM_PROVIDER=vllm
LLM_MODEL=填写服务中的模型名称
LLM_BASE_URL=http://127.0.0.1:8000/v1
LLM_API_KEY=
```

本地服务启用了鉴权时填写对应密钥；部署在局域网另一台设备时，将地址替换为该设备地址。参考 [LM Studio 兼容接口](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)和 [vLLM 客户端地址说明](https://docs.vllm.ai/en/stable/cli/chat/)。兼容服务默认通过提示词要求 JSON，不强加 JSON Object 参数；建议加载非思考对话模型。需要关闭本地思考模式时，在本地服务的模型/模板设置中调整。

### 其他国产服务或自建网关

只要支持 `POST /chat/completions`、`messages`、`max_tokens` 和 `choices[0].message.content`，即可尝试使用兼容模式：

```dotenv
LLM_PROVIDER=compatible
LLM_MODEL=填写服务商提供的模型或推理接入点ID
LLM_BASE_URL=https://你的服务地址/对应版本根路径
LLM_API_KEY=填写该服务的密钥
LLM_JSON_MODE=off
```

`LLM_BASE_URL` 不包含末尾的 `/chat/completions`，程序会自动追加。Ollama 根地址不要附加 `/api/chat`。接口若使用其他协议、专有签名或额外必填参数，尚不能直接使用此适配。兼容性需要以该模型的连接测试和实际生成结果确认。

### 输出参数与排错

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `LLM_JSON_MODE` | `auto` | `auto` 对 Ollama、DeepSeek、千问启用 JSON 模式；其他服务仅使用提示词。`on` 强制启用，`off` 不传格式参数，但仍要求返回 JSON |
| `LLM_MAX_TOKENS` | `8192` | 输出上限，允许 128–32768；不得超过实际模型上限。Ollama 映射到 `num_predict` |
| `LLM_TIMEOUT_MS` | `120000` | 单次调用超时，允许 1000–600000 毫秒，前端等待时间同步调整 |

- “鉴权失败”：检查密钥、账号权限、地域与接口是否匹配。
- “模型或接口不存在”：检查模型 ID、根地址、本地模型是否已安装/加载。
- “限流或额度不足”：检查余额与并发/调用额度，稍后手动重试。
- “不接受当前参数”：检查模型支持的 token 上限与输出格式；不支持 JSON 模式时尝试 `LLM_JSON_MODE=off`，仍不支持则使用合适的对话模型。
- “输出被截断”：提高 `LLM_MAX_TOKENS`，并确保模型支持对应输出长度。
- “超时”：确认服务可用；本地机器推理较慢时可适当增大 `LLM_TIMEOUT_MS`。
- “未返回有效 JSON”：模型可能输出了思考过程、额外解释或空正文；切换到非思考模式或更适合结构化输出的模型。

不会自动回退到其他服务，也不会自动重复计费请求。失败时手动重试。API Key 不会通过状态接口返回，上游错误正文也不会直接回显。

配置后可以：

- 输入目标、现有基础、每天学习时间、周期，生成 3–12 节课程的个性化路线。
- 进入课程并点击生成，获得讲解、示例、实践任务、单选测验与关键收获。
- 完成练习后，将课程和个人心得整理为可编辑的 Wiki 卡片。
- 向知识库提问；模型仅依据提供的卡片回答，并列出卡片引用。服务端检查引用 ID 是否存在，但不能保证模型每句话都忠实于来源，请核对重要内容。

模型生成默认等待两分钟，可通过配置调整；失败时保留现有内容并显示可重试的错误。服务器验证模型结果的结构和学习时间预算，不合格的结果不会加入路线。

## 学习闭环

1. 从概览开始第一课，或新建 AI 路线。
2. 阅读讲解与示例，在自己的工具中完成实践任务。页面不会执行用户代码，也不会验证外部动手任务的完成情况。
3. 提交随堂测验，查看得分和解析。全部答对后记录为已掌握，可以反复练习；后续复习出错不会撤销过去的完成记录，练习页面会优先显示最近答错的课程。
4. 在“学习笔记”写下心得，点击“沉淀到我的 Wiki”。每节课最多生成一张卡片，后续可以编辑。已有卡片不会随着课程心得的变动自动重写。
5. 搜索、编辑、关联或导出知识卡片。在示例模式下，知识对话返回关键词检索结果；配置模型后启用 AI 问答。

## 数据与当前边界

- 桌面版数据保存在本机文件；Web 版使用当前浏览器 localStorage。无登录、云同步或多用户服务。
- 设置页可导出完整 JSON 备份，Wiki 可导出 Markdown。桌面版支持备份导入，Web 版尚不支持。清理浏览器网站数据只影响 Web 版记录。
- AI 请求会把相关目标、课程或笔记发给 `.env` 指定的模型服务。云端配置会把这些内容发送到服务商；本地配置发送到对应部署服务。密钥仅保存在服务端配置，前端不持有模型密钥。
- Wiki 问答最多读取最近 30 张卡片，尚未引入向量数据库或全库语义检索；卡片关联基于共同标签。
- 首版未包含代码沙箱、自由作答自动评分、间隔复习算法、联网课程检索或学习进度自动重规划。
- 模型配置和资料存储适合个人本地原型。面向公网部署需要另行设计身份验证、数据库、用量控制与部署策略。

## 项目结构

```text
server.mjs            本地 HTTP 服务、业务校验、静态文件
llm.mjs               云端/本地 LLM 适配、配置校验与连接测试
desktop/main.cjs      Electron 窗口、受限 IPC、系统对话框
desktop/preload.cjs   页面与桌面主进程之间的受限接口
desktop/local-store.mjs 本地配置、数据持久化、备份验证
public/app.js         页面和学习状态管理
public/demo.js        手工编写的示例路线、课程和题目
public/styles.css    桌面与移动端样式
test/server.test.mjs API、模型错误、引用与数据校验测试
test/llm.test.mjs    服务商协议、鉴权、参数、超时与输出校验测试
test/desktop.test.mjs 本地读写、密钥保存、数据校验与仅本机策略测试
test/client.test.mjs 学习状态、练习、Wiki 与保存流程测试
```

## 验证

```powershell
npm test
```

```powershell
npm run desktop -- --smoke-test
```

桌面集成测试使用项目下独立的 `.desktop-test` 目录，不读取日常学习数据；启动隐藏窗口，验证配置保存、系统密钥加密、测验、Wiki 和重新加载，并保存设置页截图。测试数据和构建产物已从 Git 忽略。

接口测试使用模拟模型与本机模拟服务验证协议与错误处理；客户端单元测试通过轻量 DOM 替身验证状态转换。另有真实 Electron 窗口集成测试验证桌面学习流程。尚未使用真实云端密钥或真实本地模型联调，模型连接和生成质量需要按你的配置验收。

建议验收路径：开始第一课 → 阅读 → 答错一次 → 全部答对 → 填写心得 → 生成 Wiki → 编辑保存 → 搜索/导出 → 刷新验证保存。再在窄屏下检查导航与课程表单。
