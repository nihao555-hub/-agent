# HR 初筛 Agent 后端（hr-screening-agent）

面向招聘方的「简历自动归集 + 简历初筛 + 对话式初筛 + 候选人状态机/实时反馈 + 授权式合规背调」后端。覆盖 HR 初筛从 **多渠道归集 → JD 结构化 → 简历解析 → 硬性过滤 → 多维打分排序 → AI 对话式深筛 → 状态流转/实时反馈通知 → 初步触达 → 授权式背调** 的完整闭环，并把岗位/候选人/对话会话/投递/事件/通知持久化到本地 SQLite。

与「AI 店小二」同仓库、同一套架构：**双引擎**——配置了大模型 key 走 LLM（grsai，OpenAI 兼容），任何失败/限流自动回退**规则引擎**；不配 key 也能离线确定性运行。所有结果带 `engine: "llm" | "rule-based"` 标注来源。

## HR 初筛 7 步与本后端的对应

| 初筛步骤 | 对应接口 |
|---|---|
| 1. 建岗 & JD 结构化 | `POST /api/jobs/parse` |
| 2. 收简历 & 归集（解析） | `POST /api/resume/parse` |
| 3. 硬性条件过滤（学历/年限/城市/技能） | 内置于打分（`hardFilter`，不过则压分+建议淘汰） |
| 4-5. 简历内容评估 + 打分/排序 | `POST /api/screening/score`、`POST /api/screening/batch` |
| 5b. AI 对话式深筛（顶级 HR 专家、多轮上下文持久化） | `POST /api/chat/sessions`、`/messages`、`/summary` |
| 5c. 候选人状态机 + 实时反馈（投递→初筛中→约面/淘汰/人才库 + AI 拒信/约面通知） | `POST /api/pipeline/*`（见下） |
| 6. 初步触达（电话/短信/微信） | `POST /api/outreach` |
| 7. 推进/淘汰 + 背调 | `POST /api/background-check/*`、`POST /api/analyze` |

简历来源不限手工：可通过**批量上传 / 企业邮箱 IMAP 收件 / 文件夹监听**自动归集（`POST /api/intake/*`），自动解析→硬筛→打分→入库→按硬性条件自动流转。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查，返回引擎、模型、解析/OSINT 服务是否就绪 |
| `POST` | `/api/jobs/parse` | JD 文本 → 结构化岗位（学历/年限/技能/地点等） |
| `POST` | `/api/resume/parse` | 简历 → 结构化档案。`text` 走 LLM/正则；`fileBase64`(PDF/图片/Word) 走 SmartResume 微服务 |
| `POST` | `/api/screening/score` | 单份简历：硬性过滤 + 5 维打分 + 风险点 + 建议追问 + 推进建议 |
| `POST` | `/api/screening/batch` | 批量打分并按推荐等级/分数排序（带 `rank`） |
| `POST` | `/api/outreach` | 生成电话/短信/微信初筛话术 + 电话初筛问题 |
| `POST` | `/api/background-check/plan` | **授权式**背调核验计划（consent 闸门：未授权只返回授权指引） |
| `POST` | `/api/background-check/osint` | **授权式** OSINT 公开信息收集（maigret/sherlock/spiderfoot，强制 consent + 本人标识） |
| `POST` | `/api/background-check/profile` | 基于已授权核验结论（+可选 OSINT 线索）整合候选人画像 |
| `POST` | `/api/analyze` | 端到端：打分 + 触达 + 背调计划（授权且有结论时附画像） |
| `POST` | `/api/chat/sessions` | 新建对话式初筛会话（绑定岗位+候选人，返回 AI 开场白），数据落库 |
| `GET` | `/api/chat/sessions` | 列出全部会话（元信息 + 消息计数） |
| `GET` | `/api/chat/sessions/:id` | 取会话上下文（岗位 + 简历 + 完整历史 + 小结） |
| `POST` | `/api/chat/sessions/:id/messages` | 候选人发一条消息 → 返回 AI 回复并累积持久化历史 |
| `POST` | `/api/chat/sessions/:id/summary` | 出结构化初筛小结（已确认/待确认/风险/建议），回填会话并标记完成 |
| `POST` | `/api/pipeline/jobs` | 持久化岗位（设硬性条件），返回 `jobId` |
| `GET` | `/api/pipeline/jobs` | 列出岗位 |
| `POST` | `/api/pipeline/applications` | 新建投递（建档：候选人 + 投递记录 `applied`） |
| `GET` | `/api/pipeline/applications?jobId=&status=` | 看板列表（可按岗位/状态过滤） |
| `GET` | `/api/pipeline/applications/:id` | 投递详情（岗位 + 候选人 + 事件历史 + 通知历史） |
| `GET` | `/api/pipeline/applications/:id/events` | 事件留痕（created/screened/status_changed/notified） |
| `POST` | `/api/pipeline/applications/:id/screen` | 自动初筛打分（硬筛 + 多维打分写回投递） |
| `POST` | `/api/pipeline/applications/:id/transition` | 受控状态流转（非法迁移返回 409），可选 `notify` 发反馈 |
| `POST` | `/api/pipeline/applications/:id/feedback` | 生成并发送/预览 AI 反馈通知（拒信/约面通知） |
| `GET` | `/api/pipeline/stats?jobId=` | 流程漏斗统计（按状态计数） |
| `POST` | `/api/intake/batch` | 批量上传多份简历 → 解析→建档→自动硬筛+打分→入库 |
| `POST` | `/api/intake/email/poll` | 企业邮箱 IMAP 收件归集（未配置凭据时 400 安全禁用） |
| `POST` | `/api/intake/folder/scan` | 扫描归集目录中的简历入库（未配置 `INTAKE_WATCH_DIR` 时 400） |

打分维度：`岗位匹配 / 技能匹配 / 经验深度 / 稳定性 / 教育背景`。风险点：`跳槽频繁 / 空窗期 / 经历存疑 / 学历存疑 / 资历过高 / 信息缺失`。

> **反歧视**：打分与画像在系统提示词中强约束——不得因性别/年龄/籍贯/户籍/民族/婚育/外貌/院校出身/健康等与岗位无关因素做区别对待。

### AI 对话式初筛（代替 HR 初聊）

`POST /api/chat/*` 提供一个「顶级 HR 专家」对话 Agent，代替 HR 做电话/微信初筛初聊：

- **system prompt** = 资深招聘官人设 + 目标岗位 JD + 候选人简历画像 + 初筛纪律（一次一问、紧扣上一句自然追问、优先确认求职状态/到岗时间/期望薪资/关键经历真实性/硬性条件接受度）。
- **多轮上下文持久化**：每条消息按会话自增 `seq` 存入 SQLite，下一轮回复带完整历史。
- **双引擎**：配 key 走 grsai 多轮对话，任何失败自动回退脚本化追问（规则引擎）；响应带 `engine` 标注。
- **结构化小结**：`/summary` 基于完整对话产出 `{fitAssessment, confirmedInfo[], pendingInfo[], risks[], recommendation, reason, nextQuestions[]}`，回填会话并标记 `completed`（之后不可再发消息，返回 409）。
- **合规约束**：不得询问婚育/家庭/健康/籍贯等与岗位无关的隐私，不承诺录用结果，不索取身份证/银行卡等敏感信息。

### 候选人状态机 + 实时反馈通知（投递→初筛中→约面/淘汰/人才库）

`POST /api/pipeline/*` 把候选人在流程中的位置建成一台**受控状态机**，每次流转都校验合法性并留痕，可审计、可解释：

- **状态**：`applied 已投递 → screening 初筛中 → interview 约面 / rejected 未通过 / talent_pool 人才库`。非法迁移（如 `screening → applied`）返回 **409**。
- **自动流转**：归集层自动初筛后，硬性条件通过 → `screening`，不通过 → `rejected`（不自动外发，留待 HR 复核触发）。
- **事件历史**：`created / screened / status_changed / notified` 全程留痕。
- **实时反馈通知**：状态流转可携带 `notify:true`，或单独调 `/feedback` 生成并发送。文案**双引擎**（LLM 拒信/约面通知，失败回退规则模板），**专业有温度、严禁歧视性理由、不承诺结果**。`preview:true` 仅预览不落库不外发。
- **可插拔渠道**：默认 `none`（dry-run，仅落库不外发，可离线测试）；配置 SMTP 后 `email` 渠道真实发送（短信/企业微信渠道接口已留好，配置凭据后接入）。

### 简历自动归集层（企业邮箱 / 批量上传 / 文件夹监听）

国内主流招聘平台无面向第三方拉取候选人简历的开放 API（受 PIPL + 平台 ToS 约束），因此采用**合规归集**路线，HR 实际把各平台简历导出/转发即可：

- **批量上传** `POST /api/intake/batch`：一次提交多份简历（`text` 或 `fileBase64`）→ 解析 → 建档（投递）→ 自动硬筛+打分 → 按硬性条件自动流转 → 入库，返回逐份结果汇总。
- **企业邮箱 IMAP 收件** `POST /api/intake/email/poll`：拉取未读邮件中的简历附件/正文（`imapflow` + `mailparser`），处理后标记已读。**配齐 `IMAP_HOST/USER/PASSWORD` 才启用**，否则 400 安全禁用。
- **文件夹归集** `POST /api/intake/folder/scan` + 实时监听：扫描/监听 `INTAKE_WATCH_DIR` 目录中的简历（`.pdf/.doc/.docx/.txt`）自动入库（已处理文件自动去重）。配齐 `INTAKE_WATCH_DIR` + `INTAKE_WATCH_JOB_ID` 时启动 `fs.watch` 实时监听。

> 归集只接「HR 已合法获得的简历」，**不做爬虫/模拟登录抓取招聘平台**。

## 复用的高 star 开源项目

| 用途 | 项目 | star | 许可 | 集成方式 |
|---|---|---|---|---|
| 简历解析（PDF/图片/Word→结构化，版式感知+OCR+LLM） | [alibaba/SmartResume](https://github.com/alibaba/SmartResume) | 360+ | Apache-2.0 | Python 微服务 `resume-service/` |
| OSINT：用户名→3000+ 站点人物档案 | [soxoj/maigret](https://github.com/soxoj/maigret) | 32.9k | MIT | `osint-service/`，作为库 import（主力） |
| OSINT：用户名→400+ 社交站点 | [sherlock-project/sherlock](https://github.com/sherlock-project/sherlock) | 84.9k | MIT | `osint-service/`，子进程 CLI |
| OSINT：邮箱/手机号/域名→200+ 模块 | [smicallef/spiderfoot](https://github.com/smicallef/spiderfoot) | 17.3k | MIT | `osint-service/`，无头 CLI |

基础库：`express` / `zod` / `openai` / `helmet` / `cors` / `pino`。

## 合规：授权式背调（不做无授权全网爬）

依据《个人信息保护法》，背调必须**事先取得候选人书面授权**并告知核查范围。本后端把合规约束做成硬闸门：

- `POST /api/background-check/plan`：`consentObtained!==true` 时只返回授权指引（`gated:true`），**不产出任何核验事项**。授权后才给出按**合法数据源**（学信网/裁判文书网/执行信息公开网/企查查·天眼查/原雇主访谈/社保）的核验计划与证明人问题。
- `POST /api/background-check/osint`：校验层强制 `consentObtained:true` 且至少一个**候选人本人提供/确认**的标识；service 层再次 consent 校验（无授权抛 **403**）。OSINT 仅在此前提下、对本人标识运行——这是「不做无授权全网爬」的落地。
- OSINT 收集到的线索一律标注为「**待人工核实**」，提示词层面**严禁据此对候选人下结论**。

## 本地运行

```bash
cd hr-screening
cp .env.example .env        # 可选：填入 LLM_API_KEY 启用大模型引擎
npm install
npm run dev                 # 开发模式（tsx watch）
# 或
npm run build && npm start  # 生产构建后运行 dist/index.js
```

不配置 `LLM_API_KEY` 也能直接跑（全程规则引擎）。

### 启用文件简历解析 / OSINT 背调（可选）

这两个能力依赖独立的 Python 微服务，按需启动并在 `.env` 指向它们：

- 简历文件解析：见 [`resume-service/`](./resume-service/README.md)，启动后设 `RESUME_SERVICE_URL`
- 授权式 OSINT 收集：见 [`osint-service/`](./osint-service/README.md)，启动后设 `OSINT_SERVICE_URL`

未配置时：文件解析接口返回 503（提示改用纯文本），OSINT 接口安全降级（`available:false`，不做任何收集）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3001` | 监听端口 |
| `LLM_API_KEY` | 空 | grsai key；留空则全程规则引擎 |
| `LLM_BASE_URL` | `https://grsaiapi.com/v1` | OpenAI 兼容代理地址 |
| `LLM_MODEL` | `gemini-2.5-flash` | 模型名 |
| `RESUME_SERVICE_URL` | 空 | SmartResume 解析服务地址 |
| `OSINT_SERVICE_URL` | 空 | OSINT 收集服务地址 |
| `DB_PATH` | `./data/hr.db` | SQLite 文件路径（持久化岗位/候选人/对话/投递/事件/通知）；`:memory:` 为内存库 |
| `INTAKE_AUTO_SCREEN` | `true` | 归集后是否自动硬筛+打分 |
| `INTAKE_WATCH_DIR` | 空 | 文件夹归集目录（扫描/监听）；留空禁用 |
| `INTAKE_WATCH_JOB_ID` | 空 | 实时监听绑定的岗位 ID（配齐目录+此项才启动监听） |
| `IMAP_HOST/PORT/USER/PASSWORD/TLS/MAILBOX` | 空 / `993` / `INBOX` | 企业邮箱 IMAP 收件；配齐 HOST/USER/PASSWORD 才启用 |
| `NOTIFY_DEFAULT_CHANNEL` | `none` | 反馈渠道：`none`=dry-run 落库，`email`=SMTP 发送 |
| `SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM` | 空 / `465` / `true` | SMTP 发件配置（`email` 渠道生效需配齐） |

完整见 [`.env.example`](./.env.example)。

## 开发与校验

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format:check  # prettier --check
npm run build         # tsc -p tsconfig.build.json
npm test              # vitest（86 个用例，规则引擎 + 内存库 + dry-run 通知，离线确定性）
```

## 快速试用（规则引擎，离线）

```bash
curl -s localhost:3001/api/screening/score -H 'content-type: application/json' -d '{
  "job": {"title":"后端工程师","minEducation":"本科","minYears":3,"requiredSkills":["Node.js","TypeScript"],"locations":["上海"]},
  "resume": {"name":"张三","highestEducation":"本科","currentLocation":"上海","skills":["Node.js","TypeScript"],
    "workExperience":[{"companyName":"A","position":"后端工程师","startDate":"2017.07","endDate":"至今"}]}
}'
```
