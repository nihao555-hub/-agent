"""SmartResume 简历解析微服务（FastAPI）。

封装 alibaba/SmartResume（Apache-2.0）的版式感知 + OCR + LLM 解析能力，
对外暴露一个 HTTP 接口供 hr-screening 的 TypeScript 后端调用：

    POST /parse   multipart/form-data，字段名 file（PDF/图片/Word/纯文本）
                  → 返回 SmartResume 结构化结果（basicInfo/education/workExperience/rawText）
                  → 解析失败返回 {"error": "...", "error_details": "..."}
    GET  /health  健康检查

TS 后端通过 RESUME_SERVICE_URL 指向本服务；调用契约见 src/resume/parser.ts。
"""

from __future__ import annotations

import os
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

# 优先使用国内 HuggingFace 镜像，避免模型下载超时（与 SmartResume demo 保持一致）。
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

# 允许通过环境变量指定 SmartResume 源码与配置位置。
SMARTRESUME_HOME = os.environ.get("SMARTRESUME_HOME", "/home/ubuntu/SmartResume")
if SMARTRESUME_HOME and SMARTRESUME_HOME not in sys.path:
    sys.path.insert(0, SMARTRESUME_HOME)

# SmartResume 内部大量使用相对路径（configs/、model 缓存等），需切到其工程根目录。
if SMARTRESUME_HOME and os.path.isdir(SMARTRESUME_HOME):
    os.chdir(SMARTRESUME_HOME)

ALLOWED_EXTENSIONS = {
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".tiff",
    ".webp",
    ".docx",
    ".doc",
    ".txt",
}

app = FastAPI(title="hr-screening resume-service", version="0.1.0")

# 解析器较重（OCR + LLM 初始化），进程内懒加载并复用单例。
_analyzer: Any = None


def get_analyzer() -> Any:
    global _analyzer
    if _analyzer is not None:
        return _analyzer
    from smartresume.backend.resume_analyzer import ResumeAnalyzer  # 延迟导入

    try:
        _analyzer = ResumeAnalyzer(init_ocr=True, init_llm=True)
    except Exception as exc:  # noqa: BLE001 - OCR 初始化失败则降级为无 OCR
        print(f"[resume-service] OCR 初始化失败，降级为无 OCR：{exc}", flush=True)
        _analyzer = ResumeAnalyzer(init_ocr=False, init_llm=True)
    return _analyzer


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "resume-service",
        "smartResumeHome": SMARTRESUME_HOME,
        "analyzerLoaded": _analyzer is not None,
    }


@app.post("/parse")
async def parse(file: UploadFile = File(...)) -> JSONResponse:
    filename = file.filename or "resume.pdf"
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        return JSONResponse(
            status_code=400,
            content={
                "error": f"不支持的文件类型：{ext}",
                "error_details": f"支持的类型：{', '.join(sorted(ALLOWED_EXTENSIONS))}",
            },
        )

    tmp_path: str | None = None
    try:
        data = await file.read()
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            tmp.write(data)
            tmp_path = tmp.name

        analyzer = get_analyzer()
        result = analyzer.pipeline(
            cv_path=tmp_path,
            resume_id="hr_screening",
            extract_types=["basic_info", "work_experience", "education"],
        )

        if result is None:
            return JSONResponse(
                status_code=502,
                content={"error": "解析失败", "error_details": "pipeline 返回空结果"},
            )
        if isinstance(result, dict) and "error" in result:
            return JSONResponse(status_code=502, content=result)

        # 直接透传 SmartResume 的结构化结果，键名与 TS 端 smartResumeSchema 对齐。
        return JSONResponse(status_code=200, content=result)
    except Exception as exc:  # noqa: BLE001 - 兜底，避免单份简历异常拖垮服务
        traceback.print_exc()
        return JSONResponse(
            status_code=502,
            content={"error": "简历解析异常", "error_details": str(exc)},
        )
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8001"))
    uvicorn.run(app, host="0.0.0.0", port=port)
