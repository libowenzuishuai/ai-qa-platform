"""Compatibility name for the canonical snapshot comparator.

Unscoped oldFiles/newFiles cannot attest enumeration and are deliberately rejected.
There is one production pairing algorithm: snapshot_compare.compare_snapshots.
"""
from .snapshot_compare import compare_snapshots

class MultiFileLimit(ValueError):
    pass

def compare_files(input_data: dict) -> dict:
    if set(input_data) != {"oldSnapshot", "newSnapshot", "bundles"}:
        raise MultiFileLimit("需要冻结的仓库快照清单；旧文件列表不能证明扫描完整性")
    return compare_snapshots(input_data["oldSnapshot"], input_data["newSnapshot"], bundles=input_data["bundles"])
