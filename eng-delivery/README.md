# eng-delivery · AI 工程交付大脑（招投标 MVP）

面向建筑 / 工程（EPC、施工、监理、设计、政府采购）领域的 AI Agent。读招标文件 →
自动抽取「资质要求 / 评分办法 / 废标项 / 关键时间节点」→ 做**范围/资格缺口检测**与
**投标前合规（废标风险）自检**，并尽量回填原文出处，便于人工复核。

与同仓库的 `hr-screening`、店小二同架构（TS 单体 + 双引擎 + SQLite 持久化），可独立部署。

## 设计原则：AI 优先，不硬编码

- **领域判断交给大模型**：提示词只「激活模型作为资深工程招投标专家的专业判断」，告诉它
  要解决什么问题（抽要点 / 查缺口 / 自检废标风险），不在代码里灌关键词清单或行业规则。
- **结构只约束 I/O**：仅对 API 的输入/输出结构做必要的 JSON 字段约束（保证后端稳定），
  不约束模型「怎么想」。
- **规则引擎是薄兜底**：仅在未配 `LLM_API_KEY` 或大模型调用失败时启用，只做最朴素的机械
  抽取与文本相似度粗估，凡需专业判断的一律输出「需人工确认」，并标注 `engine: rule-based`。

## 双引擎

| 场景 | 引擎 | 说明 |
| --- | --- | --- |
| 配了 `LLM_API_KEY` | `llm` | grsai（OpenAI 兼容），激活招投标专家知识做语义判断；任何失败自动回退规则引擎 |
| 没配 / 大模型不可用 | `rule-based` | 离线薄兜底：机械抽取 + 文本相似度粗估，结果可解释、可复现 |

所有响应都带 `engine` 字段，标注本次结果由谁生成。

## 快速开始

```bash
npm install
cp .env.example .env   # 可选：填入 LLM_API_KEY 走大模型；不填则走规则引擎
npm run dev            # 开发模式（tsx watch）
# 或
npm run build && npm start
```

健康检查：

```bash
curl localhost:3002/health
# { "status":"ok", "service":"eng-delivery-agent", "engine":"rule-based"|"llm", ... }
```

## API

| 方法 & 路径 | 作用 |
| --- | --- |
| `POST /api/tenders/parse` | 解析招标文件（`text` 纯文本，或 `fileBase64` 文件）→ 结构化要点并落库 |
| `GET /api/tenders` | 招标文件列表 |
| `GET /api/tenders/:id` | 单份招标要点 |
| `GET /api/tenders/:id/analyses` | 该招标文件的分析结果 + 事件留痕 |
| `POST /api/capabilities` | 登记我方能力档案（资质/业绩/人员/财务/技术） |
| `GET /api/capabilities/:id` | 读取我方能力档案 |
| `POST /api/gap-analysis` | 范围/资格缺口检测（需 tender + capability） |
| `POST /api/compliance-check` | 合规/废标风险自检（需 tender，capability 可选） |
| `POST /api/analyze` | 端到端：解析 + 缺口（有我方资料时）+ 合规，一次完成 |

`tender` / `capability` 都支持两种引用方式：传已落库的 `tenderId` / `capabilityId`，
或直接内联 `tender` / `capability` 对象。

### 示例：端到端分析

```bash
curl -X POST localhost:3002/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{
    "projectName": "某污水处理厂工程",
    "text": "投标人须具备市政公用工程施工总承包二级及以上资质；投标截止时间为2025年7月1日9:30；未按要求提交投标保证金的按废标处理。",
    "capability": {
      "companyName": "示例建工",
      "qualifications": ["市政公用工程施工总承包一级"],
      "pastProjects": ["某市政道路改造工程"]
    }
  }'
```

## 文件解析（可选 MinerU 等微服务）

`text` 字段可直接提交纯文本（**离线可用**）。若要解析 PDF / Word / 扫描件，部署一个
MinerU 风格的解析微服务并设置 `DOC_SERVICE_URL`；服务接收 `multipart/form-data` 的 `file`
字段，返回 `{ "text" | "markdown" | "content": "..." }`。未配置时提交文件会返回明确的 503 提示。

## 持久化

`better-sqlite3`，库文件路径由 `DB_PATH` 指定（目录自动创建）。表：`tenders` / `capabilities`
/ `analyses` / `events`。测试用 `DB_PATH=:memory:` 内存库。

## 测试 / 质量门禁

```bash
npm test          # vitest，全离线（无需 LLM key、内存库）
npm run lint      # eslint
npm run typecheck # tsc --noEmit
```
