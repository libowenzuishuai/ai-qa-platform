import pytest
from conftest import VECTORS
from aiqa_intelligence.contracts.validation import validate_rules, validate_cases
from aiqa_intelligence.errors import ServiceError


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_shared_vectors(vector):
    validate = validate_rules if vector["kind"] == "rules" else validate_cases
    if vector["valid"]:
        validate(vector["input"], vector["output"])
    else:
        with pytest.raises(ServiceError):
            validate(vector["input"], vector["output"])
