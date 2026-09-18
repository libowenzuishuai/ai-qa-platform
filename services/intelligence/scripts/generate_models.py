"""Generate/check Python models from the TS-authored wire schema, without timestamps."""

from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "src/aiqa_intelligence/contracts/schema.v1.json"
TARGET = SCHEMA.parent / "generated.py"
with tempfile.TemporaryDirectory() as directory:
    result = Path(directory) / "generated.py"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "datamodel_code_generator",
            "--input",
            str(SCHEMA),
            "--input-file-type",
            "jsonschema",
            "--output",
            str(result),
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--target-python-version",
            "3.11",
            "--disable-timestamp",
            "--use-standard-collections",
            "--use-union-operator",
            "--use-schema-description",
            "--use-title-as-name",
            "--collapse-root-models",
            "--field-constraints",
            "--enum-field-as-literal",
            "all",
            "--formatters",
            "black",
            "isort",
        ],
        check=True,
    )
    content = result.read_text()
    if "--check" in sys.argv:
        if TARGET.read_text() != content:
            raise SystemExit("Python models out of date; run pnpm contracts:python")
    else:
        TARGET.write_text(content)
