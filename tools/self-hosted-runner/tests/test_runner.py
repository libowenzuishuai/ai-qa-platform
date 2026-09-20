import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import pytest

spec=importlib.util.spec_from_file_location('aiqa_runner',Path(__file__).parents[1]/'runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)


def test_archive_path_traversal_and_symlinks_rejected(tmp_path):
    for name,kind in [('repo/../../escape',tarfile.REGTYPE),('repo/link',tarfile.SYMTYPE)]:
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
            item=tarfile.TarInfo(name);item.type=kind;item.linkname='/etc/passwd';archive.addfile(item)
        with pytest.raises(ValueError):runner.extract_archive(buffer.getvalue(),tmp_path)


def test_junit_failure_skip_and_empty_are_preserved():
    cases=runner.parse_junit(b'<testsuite><testcase name="a"/><testcase name="b"><failure/></testcase><testcase name="c"><skipped/></testcase></testsuite>')
    assert [c['status'] for c in cases]==['PASS','FAIL','SKIP']
    assert runner.parse_junit(b'<testsuite/>')==[]
    with pytest.raises(ValueError):runner.parse_junit(b'<!DOCTYPE test [<!ENTITY x SYSTEM "file:///etc/passwd">]><testsuite/>')


@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Explicit local Docker opt-in')
@pytest.mark.parametrize('kind,broken',[('NODE_TEST',False),('NODE_TEST',True),('PYTHON_TEST',False),('PYTHON_TEST',True),('NODE_BUILD',False)])
def test_real_isolated_process_and_report(tmp_path,kind,broken):
    if kind=='NODE_TEST':
        (tmp_path/'main.test.js').write_text("const {test}=require('node:test');const assert=require('node:assert');test('business calculation',()=>assert.equal(2+2,"+('5' if broken else '4')+"));")
    elif kind=='PYTHON_TEST':
        (tmp_path/'test_main.py').write_text('def test_business_calculation():\n    assert 2+2 == '+('5' if broken else '4')+'\n')
    else:
        (tmp_path/'package.json').write_text(json.dumps({'scripts':{'build':"node -e \"require('fs').writeFileSync('built.txt','built')\""}}))
    request={'repositoryUrl':'https://github.com/test/test','commitSha':'a'*40,'subdirectory':'','kind':kind,'timeoutSeconds':60,'installDependencies':False}
    result=runner.execute(request,source_directory=tmp_path)
    assert not result.get('platformError'),result
    assert result['cases'],result
    assert any(c['status']=='FAIL' for c in result['cases'])==broken,result
    assert (result['exitCode']!=0)==broken,result
