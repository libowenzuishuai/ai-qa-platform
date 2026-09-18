"""Read-only artifact access. No arbitrary URLs or database credentials enter Python."""

import hashlib
from pathlib import Path
from .errors import ServiceError


class ArtifactReader:
    def __init__(self, root: Path):
        self.root = root.resolve()

    def read(
        self, key: str, *, size: int | None = None, checksum: str | None = None
    ) -> bytes:
        candidate = (self.root / key).resolve()
        if Path(key).is_absolute() or not candidate.is_relative_to(self.root):
            raise ServiceError("VALIDATION_ERROR", "文件路径超出证据目录")
        try:
            with candidate.open("rb") as file:
                data = file.read(20 * 1024 * 1024 + 1)
        except OSError as exc:
            raise ServiceError("VALIDATION_ERROR", "文件不存在或不可读") from exc
        if len(data) > 20 * 1024 * 1024 or (size is not None and len(data) != size):
            raise ServiceError("VALIDATION_ERROR", "文件大小超限或与登记不符")
        if checksum is not None and hashlib.sha256(data).hexdigest() != checksum:
            raise ServiceError("VALIDATION_ERROR", "文件校验和不符")
        return data
