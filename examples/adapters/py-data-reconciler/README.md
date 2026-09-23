# Python 数据核对器（v2 能力 SDK 远程样例）

实现 `aiqa.capability-rpc/2`：`GET /capability/describe`、`POST /capability/execute`、
`POST /capability/cancel`、`GET /health`。能力 `example.data-reconcile@1.0.0`（READ，纯对账计算）。

```sh
services/intelligence/.venv/bin/python -m pip install fastapi uvicorn   # 或复用 intelligence venv（已含）
services/intelligence/.venv/bin/python examples/adapters/py-data-reconciler/app.py --port 9100
```

输入：`{expectedRecords, actualRecords, keyField, delayMs?}`（delayMs 演示协作取消）。
输出：`{matched, missing[], extra[], mismatched[]}`。
