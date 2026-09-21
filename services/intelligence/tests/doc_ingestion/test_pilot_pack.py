import hashlib
import json
from pathlib import Path
from aiqa_intelligence.doc_ingestion.runner import parse_bytes
from aiqa_intelligence.storage import ArtifactReader
from aiqa_intelligence.contracts.validation import validate_bundle


def test_dify_sanitized_pack_is_portable_and_preserves_unverified_dimensions():
    root = (
        Path(__file__).resolve().parents[4]
        / "packages/contracts/fixtures/pilot-dify-v1"
    )
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    storage = manifest["storage"]
    data = ArtifactReader(root).read(storage["storageKey"])
    assert hashlib.sha256(data).hexdigest() == storage["checksum"]
    assert len(data) == storage["fileSizeBytes"]
    bundle = parse_bytes(data, storage["documentVersionId"], storage["format"])
    validate_bundle(bundle)
    assert bundle == json.loads((root / "bundle.json").read_text(encoding="utf-8"))
    blocked = {
        x["dimension"] for x in manifest["dimensions"] if x["status"] == "BLOCKED"
    }
    assert blocked == {"PERMISSION", "MULTI_ROLE"}
    assert manifest["officialProductSpecification"] is False
    assert manifest["buildVerified"] is False
