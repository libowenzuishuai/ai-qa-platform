import hashlib
import json
import subprocess
import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from aiqa_intelligence.agents.candidate_tests import generate
from aiqa_intelligence.app import create_app


def data(language):
    return {'language': language, 'modulePath': 'subject.mjs' if language=='node' else 'subject.py', 'functionName':'threshold',
            'rules':[{'id':'approved-rule','reviewStatus':'APPROVED','expectation':'金额超过 500000 分才需审批'}],
            'examples':[{'id':'below','ruleVersionId':'approved-rule','args':[499999],'expected':False},
                        {'id':'boundary','ruleVersionId':'approved-rule','args':[500000],'expected':False},
                        {'id':'above','ruleVersionId':'approved-rule','args':[500001],'expected':True}]}


@pytest.mark.parametrize('language', ['node', 'python'])
def test_generated_candidates_detect_threshold_mutation_with_independent_expected(language, tmp_path):
    source=data(language);result=generate(source);file=result['files'][0]
    assert hashlib.sha256(file['content'].encode()).hexdigest()==file['contentHash']
    path=tmp_path/file['path'];path.parent.mkdir();path.write_text(file['content'])
    for operator, should_pass in [('>',True),('>=',False),('>',True)]:
        code=f'export function threshold(amount) {{ return amount {operator} 500000; }}' if language=='node' else f'def threshold(amount):\n    return amount {operator} 500000\n'
        (tmp_path/source['modulePath']).write_text(code)
        args=['node','--test',str(path)] if language=='node' else [sys.executable,'-m','pytest',str(path),'-q','-p','no:cacheprovider']
        completed=subprocess.run(args,cwd=tmp_path,text=True,capture_output=True,timeout=15,env={**__import__('os').environ,'PYTHONPATH':str(tmp_path),'PYTHONDONTWRITEBYTECODE':'1'})
        assert (completed.returncode==0)==should_pass,completed.stdout+completed.stderr
    # These modules are authored synthetic fixtures; arbitrary repository tests use the container runner.


def test_unapproved_and_invented_rule_never_generate():
    body=data('node');body['rules'][0]['reviewStatus']='DRAFT'
    with pytest.raises(Exception):generate(body)
    body=data('python');body['examples'][0]['ruleVersionId']='invented'
    with pytest.raises(Exception):generate(body)


def test_business_text_and_commas_are_preserved_and_cannot_inject_source(tmp_path):
    body=data('node');body['examples']=[{'id':'text','ruleVersionId':'approved-rule','args':['x, y; "); process.exit(0); //'],'expected':'a,b'}]
    generated=generate(body);assert '"a,b"' in generated['files'][0]['content']
    body['modulePath']='../../outside.mjs'
    with pytest.raises(Exception):generate(body)


def test_real_http_entry_zero_model_calls(tmp_path):
    def forbidden_gateway(*args):
        from aiqa_intelligence.models import Gateway
        return Gateway(*args)
    with TestClient(create_app(token='fixture',artifact_root=tmp_path,gateway_factory=forbidden_gateway)) as client:
        response=client.post('/v2/tests/propose',headers={'authorization':'Bearer fixture','x-aiqa-model-calls':'0','x-aiqa-model-tokens':'0'},json={'schemaVersion':'1.0','requestId':'candidate-1','mode':'real','timeoutMs':1000,'input':data('node')})
        assert response.status_code==200,response.text
        assert response.json()['invocations']==[]
        assert response.json()['output']['exampleIds']==['below','boundary','above']


def test_python_boolean_is_not_a_numeric_success(tmp_path):
    body=data('python');body['examples']=[{'id':'bool','ruleVersionId':'approved-rule','args':[],'expected':True}]
    file=generate(body)['files'][0];path=tmp_path/file['path'];path.parent.mkdir();path.write_text(file['content'])
    (tmp_path/'subject.py').write_text('def threshold():\n    return 1\n')
    completed=subprocess.run([sys.executable,'-m','pytest',str(path),'-q','-p','no:cacheprovider'],cwd=tmp_path,capture_output=True,text=True,timeout=15,env={**__import__('os').environ,'PYTHONPATH':str(tmp_path),'PYTHONDONTWRITEBYTECODE':'1'})
    assert completed.returncode==1,completed.stdout+completed.stderr
    assert 'AIQA_ASSERTION:bool' in completed.stdout
