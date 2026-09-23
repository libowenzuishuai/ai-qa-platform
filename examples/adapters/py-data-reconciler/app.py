"""W02 独立样例 2：Python 远程数据核对器（example.data-reconcile）。

实现 aiqa.capability-rpc/2 协议：describe / execute / cancel / reconcile。
纯计算（对账两组记录的差异）；作为 remote-http 能力由 TS 执行器经真实 HTTP 调用。

运行：pip install fastapi uvicorn && python app.py --port 9100
"""
import argparse
import hashlib
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="aiqa data-reconcile adapter")

# 活动调用登记（cancel 用；单进程演示，不落库）
_active: dict[str, threading.Event] = {}
_cancelled: set[str] = set()


class Envelope(BaseModel):
    protocolVersion: str = "aiqa.capability-rpc/2"
    invocationId: str
    deadline: str
    idempotencyKey: str


class ExecuteRequest(BaseModel):
    envelope: Envelope
    input: dict


class Result(BaseModel):
    status: str
    output: object | None = None
    resourceKeys: list[str] = Field(default_factory=list)
    retryable: bool = False
    error: dict | None = None


MANIFEST = {
    "id": "example.data-reconcile",
    "version": "1.0.0",
    "protocolVersion": "aiqa.capability/2",
    "protocol": "remote-http",
    "entrypointRef": "installation.endpoint",
    "inputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["expectedRecords", "actualRecords", "keyField"],
        "properties": {
            "expectedRecords": {"type": "array", "items": {"type": "object"}},
            "actualRecords": {"type": "array", "items": {"type": "object"}},
            "keyField": {"type": "string", "minLength": 1, "maxLength": 100},
        },
    },
    "outputSchema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["matched", "missing", "extra", "mismatched"],
        "properties": {
            "matched": {"type": "integer", "minimum": 0},
            "missing": {"type": "array", "items": {"type": "string"}},
            "extra": {"type": "array", "items": {"type": "string"}},
            "mismatched": {"type": "array", "items": {"type": "string"}},
        },
    },
    "effectClass": "READ",
    "permissions": {"network": "environment-allowlist", "declaredOrigins": [], "secrets": "none", "secretRefs": []},
    "idempotency": "read_only",
    "recovery": "read_only",
    "cancel": "cooperative",
    "timeoutMsMax": 30000,
    "humanName": "数据核对器（Python SDK 样例）",
    "description": "对账期望与实际记录集合，报告缺失/多余/不一致。",
}


@app.get("/capability/describe")
def describe():
    return MANIFEST


def _reconcile(expected: list[dict], actual: list[dict], key_field: str) -> dict:
    expected_by_key = {str(r.get(key_field)): r for r in expected}
    actual_by_key = {str(r.get(key_field)): r for r in actual}
    missing = sorted(set(expected_by_key) - set(actual_by_key))
    extra = sorted(set(actual_by_key) - set(expected_by_key))
    mismatched = sorted(
        k for k in set(expected_by_key) & set(actual_by_key)
        if {a: b for a, b in expected_by_key[k].items() if a != key_field}
        != {a: b for a, b in actual_by_key[k].items() if a != key_field}
    )
    return {
        "matched": len(set(expected_by_key) & set(actual_by_key)) - len(mismatched),
        "missing": missing,
        "extra": extra,
        "mismatched": mismatched,
    }


@app.post("/capability/execute")
def execute(request: ExecuteRequest):
    invocation_id = request.envelope.invocationId
    if invocation_id in _cancelled:
        return Result(status="CANCELLED", error={"code": "CANCELLED", "message": "调用已被取消"})
    stop = threading.Event()
    _active[invocation_id] = stop
    try:
        data = request.input
        # 演示协作取消：可选 delayMs 让取消可观察。
        delay_ms = int(data.get("delayMs", 0) or 0)
        if delay_ms > 0:
            for _ in range(delay_ms):
                if stop.is_set() or invocation_id in _cancelled:
                    return Result(status="CANCELLED", error={"code": "CANCELLED", "message": "调用已取消"})
                time.sleep(0.001)
        output = _reconcile(
            data["expectedRecords"], data["actualRecords"], data["keyField"]
        )
        return Result(status="SUCCEEDED", output=output)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=f"缺少输入字段：{exc}") from exc
    finally:
        _active.pop(invocation_id, None)


@app.post("/capability/cancel")
def cancel(body: dict):
    invocation_id = str(body.get("invocationId", ""))
    if not invocation_id:
        raise HTTPException(status_code=422, detail="缺少 invocationId")
    _cancelled.add(invocation_id)
    event = _active.get(invocation_id)
    if event:
        event.set()
    return {"cancelled": invocation_id}


@app.get("/health")
def health():
    return {"ok": True, "capability": MANIFEST["id"], "version": MANIFEST["version"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9100)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")
