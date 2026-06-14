# AI 超级销售 · 后端（FastAPI + LangGraph）

住在中国企业微信/私域里的「多智能体销售大脑」。贴一段客户聊天进来，9 个销售智能体依次工作，产出：客户画像、商机阶段、异议拆解、（按需）流失挽回、可直接发的话术、三档报价、跟进计划、CRM 建档——每条结论都用销售方法论片段（RAG）做溯源。

## 多智能体流水线（LangGraph 状态图）

```
检索官 → 画像官 → 阶段官 → 异议官 ─┬─(高流失风险)→ 挽回官 ─┐
                                  └─(否则)──────→ 跳过挽回 ─┴→ 话术官 → 报价官 → 跟进官 → CRM官
```

阶段官判定的 `churn_risk` 决定是否触发「挽回官」——这是**状态驱动的条件分支**，而不是固定顺序链。

## 运行

```bash
cd super-sales/backend
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
cp .env.example .env   # 填入 LLM_API_KEY；留空则走纯离线规则兜底
uvicorn app.main:app --reload --port 8099
```

- 配了 `LLM_API_KEY` → 走大模型（默认 grsai `gpt-5.5`），检索用本地 `fastembed`（BGE small zh）向量召回。
- 没配 key → 整套流程仍可跑，所有智能体走确定性规则兜底，检索退化为本地 TF-IDF 余弦。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 引擎 / 检索后端 / 流水线节点 |
| GET | `/api/sample` | 示例聊天，用于前端预填 |
| POST | `/api/run` | 跑完整流程，返回最终状态(JSON) |
| POST | `/api/run/stream` | 跑流程，SSE 流式推送每个智能体的进度与结果 |

`/api/run/stream` 的 SSE 事件：`start`（计划+引擎）→ 多个 `step`（每个节点的结构化结果）→ `done`（完整状态）。
