# AI 店小二 · 后端 (dianxiaoer-agent)

面向**长尾实体小店**（餐饮 / 咖啡 / 烘焙 / 美业 / 健身 / 零售 / 教培…）的**口碑与复购自动化** Agent 后端。

一句话定位：把"差评回复、老客召回、团购定价、社媒种草"这些原本要请人做的运营动作，做成几个**输入店铺信息即出结果**的 REST 接口。对手（有赞 / 微火等）卖的是给连锁/服务商的全家桶；本项目专攻没有专职运营、要的是"极简单点、即拿即用"的夫妻店、单店老板。

> 本仓库目前是**纯后端 MVP**：TypeScript + Express，提供 5 个 HTTP 接口。

## 核心能力

| 接口 | 能力 | 说明 |
| --- | --- | --- |
| `POST /api/reviews/reply` | 差评/好评**逐条智能回复** | 自动判定情绪，差评先致歉+给补救+引导线下沟通，好评强化招牌+引导复购，并给店主内部跟进建议 |
| `POST /api/recall` | **老顾客召回**话术 | 按客户分层（流失/沉睡/新客转化/生日/常客）生成短信或微信文案 + 发送时机 + 优惠钩子 |
| `POST /api/promotions` | **团购套餐 + 定价**建议 | 围绕人均测算出不同人数/场景的套餐，给原价/团购价/折扣/定价逻辑 |
| `POST /api/content` | **小红书 / 抖音引流文案** | 平台化种草内容：标题、正文、话题标签、拍摄建议 |
| `POST /api/analyze` | **一次性综合分析** | 上面四个模块一次全出（评价可选） |

## 双引擎架构（核心设计）

```
请求 → 路由(zod 校验) → ContentEngine
                              ├── LlmEngine    (配了 LLM_API_KEY 时)
                              │     └── 调用失败/限流/解析异常 ──► 自动回退 ──┐
                              └── RuleBasedEngine (无 Key 兜底 / 离线 / 单测) ◄┘
```

- **`RuleBasedEngine`**：确定性、**无需任何 API Key、无需联网**就能返回可用结果。既是大模型不可用时的兜底，也用于离线演示与单测。
- **`LlmEngine`**：接 OpenAI 协议的大模型（默认 grsai 代理的 `gemini-2.5-flash`）。**任何**网络/限流/JSON 解析失败都会被捕获并自动回退到规则引擎——接口对调用方"永不失败"。
- 每个响应都带 `engine` 字段（`"llm"` / `"rule-based"`），标注本次结果由谁生成。

为什么不用 Vercel AI SDK 的 `generateObject`：其结构化输出依赖 provider 的 tool-calling / json-schema 能力，而 grsai 代理只提供旧版 `chat/completions`，故改用官方 `openai` SDK + 手写 JSON 抽取（去 ``` 代码围栏、截取首个 JSON 块）+ zod 校验，对代理的怪异行为更稳健。

## 快速开始

```bash
npm install
cp .env.example .env        # 可选：不填 LLM_API_KEY 也能跑（走规则引擎）

npm run dev                 # 开发模式 (tsx watch)
# 或
npm run build && npm start  # 生产模式
```

服务默认监听 `http://localhost:3000`，健康检查 `GET /health`。

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `LLM_API_KEY` | *(空)* | **留空即走规则引擎**；填入后启用大模型引擎 |
| `LLM_BASE_URL` | `https://grsaiapi.com/v1` | OpenAI 协议地址 |
| `LLM_MODEL` | `gemini-2.5-flash` | 模型名 |
| `LLM_TIMEOUT_MS` | `30000` | 单次请求超时 |
| `LLM_MAX_RETRIES` | `3` | 瞬时错误（限流/超时）最大重试次数（指数退避） |

> grsai 实测：仅**海外 Host** `https://grsaiapi.com/v1` + `gemini-2.5-flash` 可用；国内直连 Host 与其它模型返回 `apikey error`；高并发偶发限流，已内置重试退避 + 失败回退。

## 接口示例

公共字段：所有接口的 `shop` 对象同构，仅 `name` 与 `category` 必填。
`category` 取值：`餐饮 | 咖啡饮品 | 烘焙甜品 | 美业丽人 | 健身运动 | 零售 | 教育培训 | 休闲娱乐 | 医疗健康 | 酒店民宿 | 其他`。

### 差评/好评回复

```bash
curl -X POST http://localhost:3000/api/reviews/reply \
  -H 'Content-Type: application/json' \
  -d '{
    "shop": { "name": "巷子咖啡", "category": "咖啡饮品", "city": "成都",
              "perCapita": 30, "highlights": ["手冲单品"], "contact": "微信 xiangzi-coffee" },
    "reviews": [
      { "rating": 1, "content": "等了20分钟才出餐，店员态度也很冷漠", "channel": "大众点评" },
      { "rating": 5, "content": "手冲很惊艳，环境安静适合办公" }
    ]
  }'
```

响应（节选）：

```json
{
  "engine": "llm",
  "replies": [
    {
      "reviewId": "r1", "rating": 1, "sentiment": "negative",
      "reply": "实在对不起，让您在巷子咖啡有了不愉快的体验……加下微信 xiangzi-coffee 让我补偿您一杯。",
      "actions": ["复盘高峰期出餐流程", "对当班员工进行服务态度培训", "建立超时提醒机制"]
    }
  ]
}
```

### 老客召回

```bash
curl -X POST http://localhost:3000/api/recall \
  -H 'Content-Type: application/json' \
  -d '{ "shop": {"name":"巷子咖啡","category":"咖啡饮品"},
        "segments": ["lapsed","vip"], "channel": "微信" }'
```

`segments` 取值：`lapsed`(流失老客) `sleeping`(沉睡会员) `new_to_repeat`(新客二次转化) `birthday`(生日关怀) `vip`(高价值常客)；缺省时默认 `lapsed/sleeping/new_to_repeat`。`channel`：`短信 | 微信`。

### 团购套餐

```bash
curl -X POST http://localhost:3000/api/promotions \
  -H 'Content-Type: application/json' \
  -d '{ "shop": {"name":"巷子咖啡","category":"咖啡饮品","perCapita":30}, "count": 2 }'
```

### 社媒文案

```bash
curl -X POST http://localhost:3000/api/content \
  -H 'Content-Type: application/json' \
  -d '{ "shop": {"name":"巷子咖啡","category":"咖啡饮品","city":"成都"},
        "platforms": ["小红书","抖音"], "topic": "自家烘焙手冲" }'
```

### 综合分析（一次全出）

```bash
curl -X POST http://localhost:3000/api/analyze \
  -H 'Content-Type: application/json' \
  -d '{ "shop": {"name":"巷子咖啡","category":"咖啡饮品"},
        "reviews": [{"rating":5,"content":"好喝"}] }'
```

返回 `{ engine, replies, recall, promotions, content }`。`reviews` 可省略（则 `replies` 为空数组）。

### 错误格式

校验失败返回 `400`，带字段级错误：

```json
{ "error": { "status": 400, "message": "请求参数校验失败",
             "details": [{ "path": "shop.category", "message": "Required" }] } }
```

## 项目结构

```
src/
  index.ts              # 入口：加载配置、起服务、优雅退出
  app.ts                # Express 应用工厂（helmet/cors/json/pino-http + 路由 + 错误处理）
  routes.ts             # 5 个业务路由
  service.ts            # analyze 综合分析的编排
  config.ts             # 环境变量校验 (zod)
  schemas.ts            # 请求体 zod schema
  types.ts              # 领域类型
  logger.ts             # pino 日志
  errors.ts             # HttpError
  middleware/
    errorHandler.ts     # 统一错误处理 + 404
  utils/
    asyncHandler.ts     # async 路由包装
    validate.ts         # parseBody：校验并抛 400
  engine/
    types.ts            # ContentEngine 抽象
    ruleBased.ts        # 规则引擎（兜底/离线）
    llm.ts              # 大模型引擎（失败自动回退）
    index.ts            # createEngine 工厂
  llm/
    client.ts           # OpenAI 兼容客户端 + JSON 抽取 + 重试退避
    prompts.ts          # 中文 prompts
test/                   # vitest 单测 + supertest 接口测试
```

## 开发脚本

```bash
npm run dev          # 开发热重载
npm run build        # 编译到 dist/
npm start            # 运行编译产物
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format       # prettier --write
npm test             # vitest（默认走规则引擎，离线、确定性）
```

## License

MIT
