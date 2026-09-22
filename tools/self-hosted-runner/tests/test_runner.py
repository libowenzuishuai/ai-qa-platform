import importlib.util
import io
import json
import os
import subprocess
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


# ============ R05：适配器注册与反例 ============

def _manifest(tmp_path,**package_json):
    (tmp_path/'package.json').write_text(json.dumps(package_json))
    return tmp_path

def test_adapter_registry_commands_are_fixed_arrays(tmp_path):
    (tmp_path/'package-lock.json').write_text('{}')
    manifest=_manifest(tmp_path,name='x',devDependencies={'vitest':'^3','jest':'^29','eslint':'^9','typescript':'^5'})
    assert runner.adapter_for({'kind':'NODE_VITEST'},manifest)[0][0].endswith('/vitest')
    assert runner.adapter_for({'kind':'NODE_LINT'},manifest)[0][0].endswith('/eslint')
    assert runner.adapter_for({'kind':'NODE_TYPECHECK'},manifest)[0][0].endswith('/tsc')
    with pytest.raises(ValueError,match='未知作业类型'):
        runner.adapter_for({'kind':'FREE_SHELL'},manifest)

def test_lockfile_conflicts_and_missing_tool_rejected(tmp_path):
    manifest=_manifest(tmp_path,name='x',devDependencies={'vitest':'^3'})
    (tmp_path/'pnpm-lock.yaml').write_text('')
    with pytest.raises(ValueError,match='仅支持 package-lock'):
        runner.adapter_for({'kind':'NODE_VITEST'},manifest)
    (tmp_path/'package-lock.json').write_text('{}')
    with pytest.raises(ValueError,match='冲突锁文件'):
        runner.adapter_for({'kind':'NODE_VITEST'},manifest)

    only_pnpm=Path(str(tmp_path)+'-b');only_pnpm.mkdir()
    _manifest(only_pnpm,name='x',devDependencies={'vitest':'^3'})
    (only_pnpm/'pnpm-lock.yaml').write_text('')
    with pytest.raises(ValueError,match='package-lock'):
        runner.adapter_for({'kind':'NODE_VITEST'},only_pnpm)

    undeclared=Path(str(tmp_path)+'-c');undeclared.mkdir()
    _manifest(undeclared,name='x',devDependencies={})
    with pytest.raises(ValueError,match='未在 package.json 声明'):
        runner.adapter_for({'kind':'NODE_JEST'},undeclared)

def test_playwright_requires_operator_image(monkeypatch):
    monkeypatch.delenv('AIQA_RUNNER_PLAYWRIGHT_IMAGE',raising=False)
    with pytest.raises(ValueError,match='预置带浏览器'):
        runner.image_for({'kind':'NODE_PLAYWRIGHT'})
    monkeypatch.setenv('AIQA_RUNNER_PLAYWRIGHT_IMAGE','mcr.local/playwright:v1')
    assert runner.image_for({'kind':'NODE_PLAYWRIGHT'})=='mcr.local/playwright:v1'

def test_report_consistency_contradictions_and_zero_tests():
    with pytest.raises(ValueError,match='矛盾'):
        runner.validate_report_consistency('NODE_TEST',0,[{'name':'a','status':'FAIL'}])
    with pytest.raises(ValueError,match='矛盾'):
        runner.validate_report_consistency('NODE_TEST',1,[{'name':'a','status':'PASS'}])
    zero=runner.validate_report_consistency('NODE_TEST',0,[])
    assert zero[0]['status']=='FAIL' and '零测试' in zero[0]['name']
    lint=runner.validate_report_consistency('NODE_LINT',1,[])
    assert lint[0]['status']=='FAIL' and '不代表业务验收' in lint[0]['name']


@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Explicit local Docker opt-in')
@pytest.mark.parametrize('kind,broken',[('NODE_TEST',False),('NODE_TEST',True),('PYTHON_TEST',False),('PYTHON_TEST',True),('NODE_BUILD',False),('NODE_VITEST',False),('NODE_VITEST',True),('NODE_JEST',False),('NODE_LINT',False),('NODE_LINT',True),('NODE_TYPECHECK',False),('NODE_TYPECHECK',True)])
def test_real_isolated_process_and_report(tmp_path,kind,broken):
    expected=5 if broken else 4
    if kind=='NODE_TEST':
        (tmp_path/'main.test.js').write_text(f"const {{test}}=require('node:test');const assert=require('node:assert');test('business calculation',()=>assert.equal(2+2,{expected}));")
    elif kind=='PYTHON_TEST':
        (tmp_path/'test_main.py').write_text(f'def test_business_calculation():\n    assert 2+2 == {expected}\n')
    elif kind=='NODE_VITEST':
        _node_project(tmp_path,{'devDependencies':{'vitest':'3.2.7'}},f'import {{ test, expect }} from "vitest";\ntest("business calculation", () => {{ expect(2 + 2).toBe({expected}); }});\n')
    elif kind=='NODE_JEST':
        _node_project(tmp_path,{'devDependencies':{'jest':'29.7.0','jest-junit':'16.0.0'}},f"test('business calculation',()=>{{expect(2+2).toBe({expected});}});")
    elif kind=='NODE_LINT':
        _node_project(tmp_path,{'devDependencies':{'eslint':'9.14.0'}},None)
        (tmp_path/'eslint.config.mjs').write_text('export default [\n  { rules: { "no-extra-semi": "error", "no-var": "error" } },\n];\n')
        (tmp_path/'good.js').write_text('const answer = 42;\nexport { answer };\n')
        if broken:(tmp_path/'bad.js').write_text('var x = 1;;\n')
    elif kind=='NODE_TYPECHECK':
        _node_project(tmp_path,{'devDependencies':{'typescript':'5.6.3'}},None)
        (tmp_path/'tsconfig.json').write_text('{"compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","moduleResolution":"bundler"}}')
        (tmp_path/'good.ts').write_text('const answer: number = 42;\nexport { answer };\n')
        if broken:(tmp_path/'bad.ts').write_text('const answer: number = "not a number";\nexport { answer };\n')
    else:
        (tmp_path/'package.json').write_text(json.dumps({'scripts':{'build':"node -e \"require('fs').writeFileSync('built.txt','built')\""}}))
    request={'repositoryUrl':'https://github.com/test/test','commitSha':'a'*40,'subdirectory':'','kind':kind,'timeoutSeconds':240,'installDependencies':kind in {'NODE_VITEST','NODE_JEST','NODE_LINT','NODE_TYPECHECK'}}
    result=runner.execute(request,source_directory=tmp_path)
    assert not result.get('platformError'),result
    assert result['cases'],result
    assert any(c['status']=='FAIL' for c in result['cases'])==broken,result
    assert (result['exitCode']!=0)==broken,result


def _node_project(tmp_path,package_json_extras,test_body):
    """最小 npm 项目：package.json + 真实 package-lock.json（--package-lock-only 生成）。"""
    package={'name':'aiqa-adapter-fixture','private':True,**package_json_extras}
    (tmp_path/'package.json').write_text(json.dumps(package))
    subprocess.run(['npm','install','--package-lock-only','--ignore-scripts'],cwd=tmp_path,capture_output=True,timeout=300,check=True)
    if test_body is not None:(tmp_path/'calc.test.js').write_text(test_body)


@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Explicit local Docker opt-in')
def test_cancelled_command_releases_its_containers_and_volume(tmp_path,monkeypatch):
    (tmp_path/'slow.test.cjs').write_text("const {test}=require('node:test');test('slow',async()=>{await new Promise(r=>setTimeout(r,30000));});")
    created=[]
    original=runner.docker
    def observed(args,**kwargs):
        if args[0]=='create':created.append(('container',args[args.index('--name')+1]))
        if args[:2]==['volume','create']:created.append(('volume',args[2]))
        return original(args,**kwargs)
    monkeypatch.setattr(runner,'docker',observed)
    checks=0
    def continue_work():
        nonlocal checks
        checks+=1
        return checks<3
    result=runner.execute({'repositoryUrl':'https://github.com/test/test','commitSha':'a'*40,'kind':'NODE_TEST','timeoutSeconds':60},continue_work,source_directory=tmp_path)
    assert 'cancelled' in result['platformError']
    assert result['cases']==[]
    assert created
    for kind,name in created:
        probe=runner.subprocess.run(['docker',kind,'inspect',name],capture_output=True)
        assert probe.returncode!=0, (kind,name)


def test_deployment_rejects_shell_paths_and_unsupported_configuration(tmp_path):
    for entry in ['../server.js','/tmp/server.js','server.js;touch /tmp/x','-e']:
        with pytest.raises(ValueError):runner.validate_node_http({'deployment':{'entrypoint':entry}},tmp_path)
    with pytest.raises(ValueError,match='missing'):
        runner.validate_node_http({},tmp_path)
    (tmp_path/'server.js').write_text('')
    for cfg in [{'port':80},{'port':True},{'healthPath':'//outside'},{'postgres':'yes'},{'shell':'evil'}]:
        with pytest.raises(ValueError):runner.validate_node_http({'deployment':cfg},tmp_path)


@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Explicit local Docker opt-in')
@pytest.mark.parametrize('database',[False,True])
def test_node_http_deployment_build_health_identity_and_cleanup(tmp_path,database):
    # Synthetic Node service; the database case checks an actual TCP connection to
    # its task-only PostgreSQL. It is not presented as a real business pilot.
    (tmp_path/'package.json').write_text(json.dumps({'scripts':{'build':'node build.cjs'}}))
    server="""const http=require('http'),net=require('net');
const respond=r=>{if(!process.env.DATABASE_URL){r.end('ready');return;}const c=net.connect(5432,'task-db',()=>{c.end();r.end('ready-db')});c.on('error',()=>{r.statusCode=503;r.end('db unavailable')});};
http.createServer((q,r)=>{if(q.url!=='/health'){r.statusCode=404;r.end();return;}respond(r)}).listen(Number(process.env.PORT),'0.0.0.0');"""
    (tmp_path/'build.cjs').write_text("require('fs').writeFileSync('server.js',"+json.dumps(server)+");")
    request={'repositoryUrl':'https://github.com/fixture/node-http','commitSha':'d'*40,'kind':'NODE_HTTP','timeoutSeconds':60,'deployment':{'build':'NPM_BUILD','postgres':database}}
    result=runner.execute(request,source_directory=tmp_path)
    assert not result.get('platformError'),result
    assert result['deployment']['healthStatus']==200 and result['deployment']['postgresReady']==database
    assert result['deployment']['artifactSha256']==runner.hashlib.sha256(server.encode()).hexdigest()
    assert result['deployment']['commitSha']=='d'*40
    assert all(r['status']=='CLEANED' for r in result['resources']),result
    for resource in result['resources']:
        assert subprocess.run(['docker',resource['kind'],'inspect',resource['name']],capture_output=True).returncode!=0


@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Explicit local Docker opt-in')
def test_node_http_timeout_and_cancellation_keep_no_resources(tmp_path):
    (tmp_path/'server.js').write_text("require('http').createServer((q,r)=>{r.statusCode=503;r.end('not ready')}).listen(Number(process.env.PORT),'0.0.0.0')")
    request={'repositoryUrl':'https://github.com/fixture/node-http','commitSha':'e'*40,'kind':'NODE_HTTP','timeoutSeconds':15,'deployment':{'readinessSeconds':2}}
    result=runner.execute(request,source_directory=tmp_path)
    assert 'timeout' in result['platformError'].lower(),result
    assert all(r['status']=='CLEANED' for r in result['resources']),result
    result=runner.execute(request,continue_work=lambda:False,source_directory=tmp_path)
    assert 'cancelled' in result['platformError'].lower(),result
    assert all(r['status']=='CLEANED' for r in result['resources']),result

@pytest.mark.parametrize('vector',json.loads((Path(__file__).parents[3]/'packages/contracts/fixtures/lcov-v1.json').read_text()),ids=lambda v:v['name'])
def test_shared_lcov_vectors(vector):
    if vector['valid']:
        result=runner.parse_lcov(vector['raw']);assert result['linesHit']<=result['linesFound']
    else:
        with pytest.raises(ValueError):runner.parse_lcov(vector['raw'])

@pytest.mark.skipif(os.getenv('AIQA_TEST_DOCKER')!='1',reason='Opt-in actual Docker')
def test_actual_node_coverage_freshness_and_cleanup(tmp_path):
    (tmp_path/'a.test.mjs').write_text("import {test} from 'node:test';test('coverage smoke',()=>{if(Date.now()>0)return 1;return 0});")
    (tmp_path/'coverage').mkdir();(tmp_path/'coverage/lcov.info').write_text('stale-invalid-report')
    result=runner.execute({'repositoryUrl':'https://github.com/example/project','commitSha':'a'*40,'kind':'NODE_TEST','timeoutSeconds':40,'coverage':{'format':'LCOV','path':'coverage/lcov.info'}},source_directory=tmp_path)
    assert 'platformError' not in result,result
    assert result['coverage']['linesFound']>0
    assert 'stale-invalid-report' not in result['coverage']['raw']
    assert all(x['status']=='CLEANED' for x in result['resources'])
