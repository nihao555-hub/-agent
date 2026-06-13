"""OSINT 收集微服务（FastAPI）。

把 maigret + sherlock + spiderfoot 三个高 star OSINT 工具封装成一个 HTTP 接口，
供 hr-screening 的 TS 后端在「候选人已书面授权」前提下收集公开足迹线索。

    POST /collect  JSON: {"usernames":[],"emails":[],"phones":[],"domains":[]}
                   → {"tools":[...], "accounts":[{tool,site,url,category}], "notes":[...]}
    GET  /health   健康检查

⚠️ 合规：本服务**不**做授权校验。授权（consent）由上游 TS 后端 service 层强制
（src/service.ts 的 collectOsint：无 consentObtained 直接 403）。本服务只应被该后端
在内网调用，且仅针对候选人本人提供/确认的标识运行。收集到的线索一律视为「待人工核实」，
严禁据此直接对候选人下结论。
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel, Field

from runners import collect_all

app = FastAPI(title="hr-screening osint-service", version="0.1.0")

MAX_HANDLES = 20


class CollectRequest(BaseModel):
    usernames: list[str] = Field(default_factory=list)
    emails: list[str] = Field(default_factory=list)
    phones: list[str] = Field(default_factory=list)
    domains: list[str] = Field(default_factory=list)

    def trimmed(self, items: list[str]) -> list[str]:
        out = [s.strip() for s in items if s and s.strip()]
        return out[:MAX_HANDLES]


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "osint-service",
        "maigretHome": os.environ.get("MAIGRET_HOME", "/home/ubuntu/maigret"),
        "spiderfootHome": os.environ.get("SPIDERFOOT_HOME", "/home/ubuntu/spiderfoot"),
    }


@app.post("/collect")
async def collect(req: CollectRequest) -> dict[str, Any]:
    return await collect_all(
        usernames=req.trimmed(req.usernames),
        emails=req.trimmed(req.emails),
        phones=req.trimmed(req.phones),
        domains=req.trimmed(req.domains),
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
