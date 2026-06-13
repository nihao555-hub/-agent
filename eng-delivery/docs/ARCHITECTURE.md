# AI 工程交付大脑 · 架构设计（eng-delivery）

> 本文是 `eng-delivery` 服务从「行走骨架」演进为「工程交付智能事实底座」的设计基线。
> 先对齐**目的 / 端到端流程 / 数据模型 / OSS 选型 / 落地路线**，再分层增量实现。

---

## 1. 定位与目的

**它不是"标书生成器"，而是工程交付的「智能事实底座 / Agentic System of Record」。**

把招标文件、合同、图纸、规范、工程量清单(BOQ)、变更签证、往来函件这些**极度非结构化**的文档，解析成一个**可追溯、带原文出处、可被 AI 推理**的统一事实库；并在其上全流程实时回答四个要命的问题：

| 问题 | 对应能力 | 数据支撑 |
| --- | --- | --- |
| 我们**承诺了什么** | 要求基线 ↔ 承诺 抽取与对齐 | `requirement` / `commitment` + `responds_to` 边 |
| 现在**偏离了什么** | 偏离检测（缺失/部分/冲突/超承诺） | `deviation` + `evidenced_by` 边 |
| **风险在哪** | 废标项/合同义务/节点/保函 预警 | `requirement.kind` + `status` + 时间节点 |
| 该**索赔什么** | 变更定性 → 索赔组卷（带合同依据） | `change` → `claim` + 证据链 |

**为什么是蓝海**：建筑业占全球 GDP ~13%，却 30 年零软件生产力增长。根因——信息散在 PDF/图纸/Excel/邮件里，没人能实时、可信地回答"合同到底要求了什么"。大模型对非结构化文本增益最大，且几乎无主导玩家。本产品的壁垒不在"生成一篇标书"，而在**把全生命周期的事实沉淀成可推理、可溯源的底座**——越用越厚，迁移成本越高。

**设计原则（延续既有约定）**：AI 优先、不硬编码领域规则；提示词只"激活专家知识、描述要解决什么"。规则引擎仅为无 key/失败时的薄兜底，语义判断一律标注「需人工确认」。所有 AI 结论必须能溯源到 `chunk`（原文出处），不可溯源的结论降级为建议。

---

## 2. 端到端生命周期流程

```
[0 商机决策] 招标公告 → 投不投(资质门槛/保证金/地域/利润测算)
      │
      ▼
[1 投标准备]
   ingest(招标文件/合同/技术规范/BOQ/图纸)
        → chunk 化(带页码/条款)  ── 文档理解层(C: MinerU/IfcOpenShell)
        → 抽 requirement(要求基线: 资质/评分/废标项/节点/技术/商务/合同条款)
        → 抽 commitment(我方投标/方案中的承诺)  ─┐
        → detect deviation(缺口/废标风险/响应偏离) ◄┘  ── 带引用RAG(B) 提供证据
        → 投标策略(评分办法拆解) + 技术标组装(检索历史标书库, 带引用)
        → 投标文件合规自检(响应偏离表/签章密封/废标项终检)
      │ 中标
      ▼
[2 合同基线] 合同风险评审 → 把招标承诺+合同义务固化为"要求基线" (system of record)
      │
      ▼
[3 施工交付]
   进度计划 vs 实际(关键路径预警)
   现场变更 → change(是否超合同范围? 合同依据出处) → 计量计价
   索赔 → claim(工期/费用, 按合同条款+证据链自动组卷) ── 长流程编排(D)
   资料报验/隐蔽验收留痕; 履约保函到期/合同节点 风险预警
      │
      ▼
[4 结算竣工] 工程量复核 + 变更签证汇总 + 争议项 → 结算 → 竣工归档
        → 项目知识回流企业知识库(供下个项目 RAG 复用)
```

每个阶段产生的结论都落到事实底座，并通过 `edge` 表连成图谱，形成**可追溯的事实链**：
`requirement —responds_to→ commitment —evidenced_by→ chunk`，`change —derived_from→ requirement`，`claim —supports→ evidence`。

---

## 3. 事实底座数据模型（A · 壁垒地基）

### 3.1 实体

| 表 | 含义 | 关键列 |
| --- | --- | --- |
| `projects` | 工程项目/标的 | id, name, status(bidding/awarded/delivering/settled), tenderer, client, data(JSON), created_at |
| `documents` | 任意来源文档 | id, project_id, type(tender/contract/spec/boq/drawing/bim/change_order/letter), title, source, page_count, parsed, created_at |
| `chunks` | 文档解析后的**可检索片段（带定位）** = 原文出处最小单元 | id, document_id, project_id, ordinal, page, clause, text, embedding(JSON, 可空), created_at |
| `requirements` | **要求基线**：招标/合同"要求我们什么" | id, project_id, source_chunk_id, kind(qualification/scoring/disqualification/milestone/technical/commercial/contract_clause), category, text, mandatory, status(open/met/at_risk/breached), severity, created_at |
| `commitments` | **承诺**：我方投标/方案/合同中"承诺了什么" | id, project_id, source_chunk_id, requirement_id?, kind, text, created_at |
| `deviations` | **偏离**：要求↔承诺↔现状 | id, project_id, requirement_id, commitment_id?, type(missing/partial/conflict/over_commit), severity, status, description, detected_by(llm/rule/human), created_at |
| `evidences` | **证据**：支撑判断/偏离/索赔的片段引用 | id, project_id, chunk_id, note, created_at |
| `changes` | **变更/签证** | id, project_id, title, description, in_scope(yes/no/uncertain), basis_chunk_id, cost_impact, time_impact, status, created_at |
| `claims` | **索赔** | id, project_id, change_id?, type(time/cost), basis, amount, days, narrative, status, created_at |
| `links` | **关联图谱边**（构建事实图） | id, project_id, from_type, from_id, to_type, to_id, relation, created_at |
| `events` | 事件流留痕（已有，扩展到 project 维度） | id, project_id, type, detail(JSON), created_at |

> 沿用既有持久化范式：整对象存 JSON `data` 列 + 冗余列便于列表；`randomUUID()` 主键；`now()` = ISO 字符串；`:memory:` 供测试；外键 `ON`。

### 3.2 关联图谱（`links.relation` 取值）

```
requirement --responds_to-->   commitment      (这条承诺响应了哪条要求)
deviation   --evidenced_by-->  chunk/evidence  (偏离的原文证据)
deviation   --about-->         requirement
change      --derived_from-->  requirement     (变更涉及哪条基线)
change      --basis-->         chunk            (合同依据出处)
claim       --supports-->      evidence         (索赔的证据链)
claim       --basis-->         chunk            (合同条款依据)
* 任意结论 --cited_from--> chunk                (统一的"带原文出处")
```

图谱让我们能做到："点开任意一条偏离/索赔，逐级看到它依据的合同条款原文（页码+条款号）"——这是企业敢信、敢用的前提。

---

## 4. 引擎与编排

- **引擎抽象**（已有）：`createEngine(config)` → 有 key 走 `LlmEngine`（激活专家知识、失败 degrade 回退），否则 `RuleBasedEngine`（薄兜底）。
- **图谱填充式算子**（A/扩展）：`ingestDocument` → `extractRequirements` → `extractCommitments` → `detectDeviations`，每步把结点+边写入事实底座并带 `source_chunk_id`。
- **带引用检索**（B）：`EmbeddingClient`（OpenAI 兼容 `/embeddings`；**无 key 时确定性 hash 向量兜底**，保证离线可测）→ 余弦检索 `chunks` → 返回 `{text, page, clause, score}` 作为证据，供抽取/偏离/索赔引用。规模化升级：`sqlite-vec` / 外部向量库。
- **文档理解**（C）：`DOC_SERVICE_URL`(MinerU 风格) 把 PDF/图纸/扫描件/BOQ 解析成**带页码/条款的结构化块**；`BIM_SERVICE_URL`(IfcOpenShell) 读 IFC 取空间/构件/工程量。均**无服务时纯文本兜底**。
- **长流程编排**（D）：变更→索赔组卷是多步骤长任务（定性→检索合同依据→量化工期/费用→起草→组册）。采用**可断点续跑的步骤编排**：run/step 状态落 `events`/专表，失败可恢复。框架升级路径：Mastra（TS 原生、迁移最省）或 LangGraph（独立编排微服务，对大客户讲可靠性）。

---

## 5. OSS 选型（复用高星项目，避免重复造轮子）

| 能力 | 选型 | 接入方式 |
| --- | --- | --- |
| 文档/图纸/扫描件解析 | **MinerU**(~66k★) | 独立微服务，`DOC_SERVICE_URL` POST 文件→带页码块 |
| 带引用 RAG | **RAGFlow** 思路；本地先用 embeddings+余弦，规模上 **sqlite-vec** | OpenAI 兼容 `/embeddings`（grsai 即可） |
| BIM/IFC | **IfcOpenShell**(~2.5k★) | 独立微服务，`BIM_SERVICE_URL` |
| 长流程编排 | **Mastra**(TS) / **LangGraph**(Py 微服务) | 先内置轻量可恢复 runner，按需升级 |
| 评测 + 可观测 | **Langfuse**(~28k★) | trace 抽取/检索/索赔；建回归评测集 |

所有大模型与向量调用走 **OpenAI 兼容接口**，grsai 直接作后端。

---

## 6. API 演进（在现有 `/api` 之上增量）

```
POST /api/projects                      建项目
POST /api/projects/:id/documents        上传/登记文档(text 或 fileBase64) → ingest+chunk
POST /api/projects/:id/extract          抽 requirement/commitment(写入图谱, 带出处)
POST /api/projects/:id/deviations       检测偏离(带证据引用)
GET  /api/projects/:id/graph            读事实图谱(结点+边, 可溯源)
POST /api/projects/:id/search           带引用检索(返回 page/clause/score)
POST /api/projects/:id/changes          登记变更 → 定性(是否超范围, 合同依据)
POST /api/changes/:id/claim             触发索赔组卷长流程(可查进度/续跑)
```
保留现有 `/api/tenders/*`、`/api/analyze` 作为"轻量单文档"入口；项目级接口承载"事实底座"。

---

## 7. 测试与评测

- **离线单测**（vitest，无 key）：schema、仓储 round-trip + 外键、规则兜底、API（断言无 key 时 `engine==='rule-based'`）、嵌入兜底的确定性、检索 top-k、长流程可恢复。
- **评测集**（Langfuse/本地）：标注招标样本的"应抽要求/废标项"，回归抽取/偏离的准确率，防止越改越退化——这是能卖企业的前提。

---

## 8. 落地路线（分层增量，逐层提交到 PR #5）

1. **E（本文）** 架构对齐。
2. **A** 事实底座数据模型 + 仓储 + 图谱算子 + 项目级 API + 离线测试。
3. **B** 带引用 RAG（embeddings 兜底 + 余弦检索 + 证据溯源）。
4. **C** 文档理解（MinerU + IfcOpenShell 客户端 + 纯文本兜底）。
5. **D** 变更/索赔自动组卷长流程（可断点续跑编排）。
6. 贯穿：评测集 + tracing；逐层补测试，保持 lint/typecheck/build 全绿。
