import asyncio
import importlib.util
import json
from pathlib import Path
import pytest
from aiqa_intelligence.doc_ingestion.bundle import Bundle
from aiqa_intelligence.errors import ServiceError

FIX=Path(__file__).parent/'fixtures'
spec=importlib.util.spec_from_file_location('b3_verify',FIX/'verify_b3_09_mixed_kimi_real.py')
evaluator=importlib.util.module_from_spec(spec);spec.loader.exec_module(evaluator)
EXPECTED=json.loads((FIX/'b3-records/b3-mixed-prd-sample.expected.json').read_text())


def body(texts):
    b=Bundle('test','PDF_TEXT')
    for page,text in enumerate(texts,1): b.add(text,{'kind':'pdf-page','page':page},page=page,quality='LOW')
    return b.finish()

TEXTS=['THRESHOLD > 500000 fen\nKeep punctuation: ,} ,]\nTEXT_LAYER page-1',
       '【扫描页-2】审批规则\n申请人单笔 <=500000 分\n主管审批 >500000 分\n,} ,]',
       '角色 上限\n申请人 <=500000分\n主管 >500000分']


def test_correct_pages_and_rows_pass():
    result=evaluator.evaluate(body(TEXTS),EXPECTED)
    assert result['passed'] and len(result['pageTextChecks'])==14
    assert result['manualReviewPerformed'] is False


def test_wrong_page_cannot_borrow_other_pages_keywords():
    assert not evaluator.evaluate(body([TEXTS[1],TEXTS[0],TEXTS[2]]),EXPECTED)['passed']


def test_swapped_roles_fail_even_when_all_words_present():
    texts=TEXTS[:2]+['角色 上限\n主管 <=500000分\n申请人 >500000分']
    result=evaluator.evaluate(body(texts),EXPECTED)
    assert all(c['found'] for c in result['pageTextChecks'])
    assert not result['passed']


def test_model_error_is_archived_and_existing_file_never_overwritten(tmp_path,monkeypatch):
    class FailingParser:
        async def parse_document(self,*args): raise ServiceError('MODEL_TIMEOUT','test timeout')
    monkeypatch.setattr(evaluator,'DocumentParser',FailingParser)
    output=tmp_path/'failure.json'
    with pytest.raises(ServiceError): asyncio.run(evaluator.run(output))
    original=output.read_bytes()
    assert json.loads(original)['errorCode']=='MODEL_TIMEOUT'
    with pytest.raises(FileExistsError): asyncio.run(evaluator.run(output))
    assert output.read_bytes()==original
