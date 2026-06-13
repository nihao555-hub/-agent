# resume-service（SmartResume 简历解析微服务）

封装 [alibaba/SmartResume](https://github.com/alibaba/SmartResume)（Apache-2.0，版式感知 + OCR + LLM）的简历解析能力，对外暴露 HTTP 接口，供 hr-screening 的 TypeScript 后端解析 **PDF / 图片 / Word** 简历。

> 纯文本简历不需要本服务——TS 后端会直接用大模型/正则解析。本服务只在需要解析二进制简历文件时启用。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/parse` | `multipart/form-data`，字段名 `file`。返回 SmartResume 结构化结果 `{basicInfo, education[], workExperience[], rawText}`；失败返回 `{error, error_details}`。 |
| `GET` | `/health` | 健康检查。 |

返回字段的键名与 TS 端 `src/resume/parser.ts` 的 `smartResumeSchema` 完全对齐，TS 端会再做一次归一化。

## 安装

```bash
# 1) 安装 SmartResume 本体（约定克隆在 $SMARTRESUME_HOME，默认 /home/ubuntu/SmartResume）
git clone https://github.com/alibaba/SmartResume.git
cd SmartResume
pip install -r requirements.txt
pip install -e .

# 2) 配置：复制本目录的 config.yaml.example 到 SmartResume/configs/config.yaml，填入 grsai key
cp /path/to/hr-screening/resume-service/config.yaml.example configs/config.yaml
# 编辑 config.yaml，把 api_key 改为你的 grsai key

# 3) 安装本微服务依赖
cd /path/to/hr-screening/resume-service
pip install -r requirements.txt
```

## 运行

```bash
export SMARTRESUME_HOME=/home/ubuntu/SmartResume   # SmartResume 源码位置
export PORT=8001
python app.py
# 或：uvicorn app:app --host 0.0.0.0 --port 8001
```

然后在 TS 后端 `.env` 中设置：

```
RESUME_SERVICE_URL=http://localhost:8001
```

## 说明 / 取舍

- **首次解析会下载版式检测等模型**，耗时较长；服务内对解析器做了进程内单例缓存。
- `config.yaml.example` 已把抽取渠道全部指向远程 grsai（`use_direct_models: false`、`ocr.use_cuda: false`），CPU 机器也能跑，不需要本地 GPU/大模型权重。
- 单份简历解析异常不会拖垮服务，会返回 `{error, error_details}`，TS 端据此回退或报 502。
