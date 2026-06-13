# osint-service（授权式公开信息收集微服务）

把三个高 star OSINT 工具封装成一个 HTTP 接口，作为 hr-screening「授权式 AI 背调」的**公开信息收集层**：

| 工具 | star | 许可 | 在本服务中的角色 |
|---|---|---|---|
| [maigret](https://github.com/soxoj/maigret) | 32.9k | MIT | 主力：用户名 → 3000+ 站点，作为 Python 库 `import` 调用 |
| [sherlock](https://github.com/sherlock-project/sherlock) | 84.9k | MIT | 补充：用户名 → 400+ 社交站点，子进程调 CLI |
| [spiderfoot](https://github.com/smicallef/spiderfoot) | 17.3k | MIT | 扩展：邮箱/手机号/域名/用户名 → 200+ 模块，无头 CLI（`sf.py`） |

## ⚠️ 合规边界（务必先读）

- 本服务**不做授权校验**。授权（consent）由上游 TS 后端强制：`src/service.ts` 的 `collectOsint` 在 `consentObtained !== true` 时直接抛 **403**，`osintCollectRequestSchema` 也要求 `consentObtained: true` 且至少一个候选人标识。
- 因此本服务**只应被 hr-screening 后端在内网调用**，且只针对**候选人本人提供/确认**的用户名/邮箱/手机号/域名运行——这正是「不做无授权全网爬」的落地方式。
- 收集到的线索一律标记为「待人工核实」，**严禁据此直接对候选人下结论**（TS 端 `buildProfilePrompt` 已在提示词中强约束）。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/collect` | JSON：`{usernames?, emails?, phones?, domains?}`（各 ≤20 条）。返回 `{tools:[...], accounts:[{tool,site,url,category}], notes:[...]}`。 |
| `GET` | `/health` | 健康检查。 |

返回结构与 TS 端 `src/osint/collector.ts` 的 `responseSchema` 对齐。任一工具缺失/失败都会被记进 `notes` 并跳过，不会让整个请求失败。

## 安装与运行

```bash
pip install -r requirements.txt              # 本服务 + maigret + sherlock
cd $SPIDERFOOT_HOME && pip install -r requirements.txt   # spiderfoot 本体依赖

export MAIGRET_HOME=/home/ubuntu/maigret
export SPIDERFOOT_HOME=/home/ubuntu/spiderfoot
export PORT=8002
python app.py
```

然后在 TS 后端 `.env` 设置：

```
OSINT_SERVICE_URL=http://localhost:8002
OSINT_SERVICE_TIMEOUT_MS=120000
```

## 可调环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MAIGRET_TOP_SITES` | `300` | maigret 扫描的站点数（按热度排序取前 N） |
| `MAIGRET_TIMEOUT` | `20` | maigret 单次请求超时（秒） |
| `SHERLOCK_TIMEOUT` | `60` | sherlock 单个用户名超时（秒） |
| `SPIDERFOOT_USECASE` | `passive` | spiderfoot 用例：`passive`/`footprint`/`investigate`/`all` |
| `SPIDERFOOT_TIMEOUT` | `180` | spiderfoot 单个目标超时（秒） |
