# AI 超级销售 · 私域跟单大脑

住在中国企业微信/私域里的「多智能体销售大脑」。贴一段客户聊天，9 个销售智能体（LangGraph 编排）依次工作，产出客户画像、商机阶段、异议拆解、（按需）流失挽回、可直接发的话术、三档报价、跟进计划与 CRM 建档——每条结论都用销售方法论片段（RAG）做溯源。

> 蓝海切口：西方的 SDR 工具做冷邮件群发，进不了中国「微信私域成交」的场景；现有 CRM 只负责记录，不替你干活。这套替销售把「想说什么、何时追、报什么价」都干完。

## 结构

```
super-sales/
├── backend/   FastAPI + LangGraph 多智能体后端（SSE 流式）
└── web/       React + Vite + Tailwind 生产级工作台（minimalist-ui 设计语言）
```

## 多智能体流水线

```
检索官 → 画像官 → 阶段官 → 异议官 ─┬─(高流失风险)→ 挽回官 ─┐
                                  └─(否则)──────→ 跳过挽回 ─┴→ 话术官 → 报价官 → 跟进官 → CRM官
```

阶段官判定的流失风险驱动「挽回官」的条件分支——状态驱动路由，不是固定顺序链。

## 本地运行

后端（:8099）：

```bash
cd super-sales/backend
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install -r requirements.txt
export LLM_API_KEY=...        # 留空则走纯离线规则兜底
uvicorn app.main:app --reload --port 8099
```

前端（:5174，dev 代理 /api → 后端）：

```bash
cd super-sales/web
npm install
npm run dev
```

打开 http://localhost:5174 ，点「让 AI 超级销售接管」。

## 设计语言

前端遵循 taste skill 的 `minimalist-ui` 协议：暖色单色画布、编辑体衬线大标题、1px 细边框、低圆角、克制的语义色（红=高流失风险、绿=已完成、蓝=进行中），无渐变、无重阴影。
