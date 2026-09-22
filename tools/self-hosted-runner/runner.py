#!/usr/bin/env python3
"""Authenticated pull runner. Repository code executes only in disposable Docker containers."""
import argparse
import io
import json
import os
import re
import sys
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from xml.etree import ElementTree

MAX_ARCHIVE = 25 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('Redirect refused')


def request(url, token=None, data=None, maximum=2*1024*1024):
    headers = {'content-type': 'application/json', 'user-agent': 'aiqa-runner'}
    if token:
        headers['authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers)
    with urllib.request.build_opener(NoRedirect).open(req, timeout=15) as res:
        content = res.read(maximum+1)
        if len(content) > maximum:
            raise ValueError('Response exceeds limit')
        return content


def extract_archive(data, destination):
    """Never extract links/devices or executable repository metadata on the host."""
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        for i, member in enumerate(archive):
            if i > 20000:
                raise ValueError('Archive file count limit')
            parts = Path(member.name).parts
            if '..' in parts or member.name.startswith('/') or len(parts) < 2:
                if member.isdir() and len(parts) == 1:
                    continue
                raise ValueError('Invalid archive path')
            relative = Path(*parts[1:])
            if any(p in {'.git','.env','.venv','node_modules'} or p.startswith('.env.') for p in relative.parts):
                continue
            if not member.isfile() and not member.isdir():
                raise ValueError('Archive links/devices are not supported')
            total += member.size
            if total > MAX_EXPANDED:
                raise ValueError('Archive expanded size limit')
            path = destination / relative
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, path.open('wb') as output:
                    shutil.copyfileobj(source, output)
                path.chmod(0o644)


def parse_junit(content):
    if len(content) > 2*1024*1024 or b'<!DOCTYPE' in content.upper() or b'<!ENTITY' in content.upper():
        raise ValueError('Unsafe or oversized JUnit report')
    root = ElementTree.fromstring(content)
    cases = []
    for node in root.iter('testcase'):
        failure = node.find('failure')
        error = node.find('error')
        skipped = node.find('skipped')
        state = 'FAIL' if failure is not None or error is not None else 'SKIP' if skipped is not None else 'PASS'
        cases.append({'name': (node.get('classname','')+' '+node.get('name','')).strip()[:500] or 'test', 'status': state})
    if len(cases)>10000:
        raise ValueError('Too many test results')
    return cases


# ============ R05：注册适配器（命令为固定数组，不接受自由 shell） ============

def _node_binary(manifest,binary,package):
    """工具必须由项目锁文件固定（npm ci 安装），绝不 npx 现场下载。"""
    try:
        package_json=json.loads((manifest/'package.json').read_text('utf8'))
    except (OSError, ValueError):
        raise ValueError('package.json 缺失或不可解析，无法注册 Node 适配器')
    declared={**package_json.get('dependencies',{}),**package_json.get('devDependencies',{})}
    if package not in declared:
        raise ValueError(f'{package} 未在 package.json 声明；适配器只运行锁文件固定的工具，不用 npx 下载')
    return binary

NODE_ADAPTERS={
    'NODE_TEST':lambda manifest:['node','--test','--test-reporter=junit','--test-reporter-destination=/work/report.xml'],
    'NODE_VITEST':lambda manifest:['node_modules/.bin/'+_node_binary(manifest,'vitest','vitest'),'run','--reporter=junit','--outputFile=/work/report.xml'],
    'NODE_JEST':lambda manifest:['node_modules/.bin/'+_node_binary(manifest,'jest','jest'),'--reporters=default','--reporters=jest-junit'],
    'NODE_PLAYWRIGHT':lambda manifest:['node_modules/.bin/'+_node_binary(manifest,'playwright','@playwright/test'),'test','--reporter=junit'],
    'NODE_LINT':lambda manifest:['node_modules/.bin/'+_node_binary(manifest,'eslint','eslint'),'.'],
    'NODE_TYPECHECK':lambda manifest:['node_modules/.bin/'+_node_binary(manifest,'tsc','typescript'),'--noEmit'],
    'NODE_BUILD':lambda manifest:['npm','run','build'],
}
PY_ADAPTERS={'PYTHON_TEST'}

# 命令型适配器：无 JUnit 产物，结论就是退出码本身（单条合成结果）。
COMMAND_ONLY={
    'NODE_BUILD':'npm run build（工程构建，不代表业务验收）',
    'NODE_LINT':'eslint .（代码检查，不代表业务验收）',
    'NODE_TYPECHECK':'tsc --noEmit（类型检查，不代表业务验收）',
}

KIND_ENV={
    'NODE_JEST':{'JEST_JUNIT_OUTPUT_DIR':'/work','JEST_JUNIT_OUTPUT_NAME':'report.xml'},
    'NODE_PLAYWRIGHT':{'PLAYWRIGHT_JUNIT_OUTPUT_NAME':'/work/report.xml'},
}

def adapter_for(spec,manifest):
    kind=spec['kind']
    if kind in NODE_ADAPTERS:
        if (manifest/'pnpm-lock.yaml').is_file():
            if (manifest/'package-lock.json').is_file():
                raise ValueError('同时存在 package-lock.json 与 pnpm-lock.yaml（冲突锁文件），请先统一包管理器')
            raise ValueError('仅支持 package-lock.json（npm ci）；pnpm-lock.yaml 项目暂不支持')
        return NODE_ADAPTERS[kind](manifest),KIND_ENV.get(kind,{})
    if kind in PY_ADAPTERS:
        return None,{}
    raise ValueError(f'未知作业类型：{kind}（受支持：{", ".join(sorted([*NODE_ADAPTERS,*PY_ADAPTERS]))}）')

def image_for(spec):
    if spec['kind']=='PYTHON_TEST':
        return os.getenv('AIQA_RUNNER_PYTHON_IMAGE','python:3.13-slim')
    if spec['kind']=='NODE_PLAYWRIGHT':
        image=os.getenv('AIQA_RUNNER_PLAYWRIGHT_IMAGE')
        if not image:
            raise ValueError('Playwright 适配器需要操作员预置带浏览器的镜像（AIQA_RUNNER_PLAYWRIGHT_IMAGE）；不从任务下载镜像')
        return image
    return os.getenv('AIQA_RUNNER_NODE_IMAGE','node:22-alpine')

def validate_report_consistency(kind,exit_code,cases):
    """exit code 与 JUnit 报告矛盾、零测试都显式暴露，不产生误导性结果。"""
    if kind in COMMAND_ONLY:
        return [{'name':COMMAND_ONLY[kind],'status':'PASS' if exit_code==0 else 'FAIL'}]
    failures=[c for c in cases if c['status']=='FAIL']
    if exit_code==0 and failures:
        raise ValueError('Exit code 为 0 但报告包含失败用例（矛盾报告，拒绝采信）')
    if exit_code!=0 and cases and not failures:
        raise ValueError('Exit code 非 0 但报告全部通过（矛盾报告，拒绝采信）')
    if not cases:
        return [{'name':'（工程检查）零测试：未发现任何测试用例','status':'FAIL'}]
    return cases


def docker(args, **kwargs):
    return subprocess.run(['docker', *args], check=True, capture_output=True, **kwargs)


def execute(spec, continue_work=lambda: True, source_directory=None):
    identity = uuid.uuid4().hex
    volume = 'aiqa-work-' + identity
    containers = []
    started = time.monotonic()
    stopped = threading.Event()
    result = {'commitSha': spec['commitSha'], 'exitCode': -1, 'cases': [], 'output': ''}
    def remaining():
        return max(1, spec['timeoutSeconds']-(time.monotonic()-started))
    def run_phase(image, command, network='none', env=None):
        if time.monotonic()-started >= spec['timeoutSeconds'] or not continue_work():
            raise TimeoutError('Task cancelled, lease lost or budget exhausted before command')
        name = 'aiqa-' + uuid.uuid4().hex
        containers.append(name)
        env_flags=[]
        for key,value in (env or {}).items():
            env_flags += ['-e',f'{key}={value}']
        docker(['create','--name',name,'--network',network,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                '--log-opt','max-size=2m','--log-opt','max-file=1','--pids-limit=128','--memory=512m','--cpus=1','--tmpfs','/tmp:rw,nosuid,size=128m',
                '-v',volume+':/work','-w','/work/'+spec.get('subdirectory',''),'-e','HOME=/tmp',*env_flags,image,*command],timeout=remaining())
        docker(['start',name],timeout=remaining())
        while True:
            state=json.loads(docker(['inspect','--format','{{json .State}}',name],timeout=5).stdout)
            if not state['Running']:
                return name, state['ExitCode']
            if time.monotonic()-started >= spec['timeoutSeconds'] or not continue_work():
                docker(['kill',name],timeout=5)
                raise TimeoutError('Task cancelled, lease lost or budget exhausted')
            time.sleep(.5)
    try:
        if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?',spec['repositoryUrl']) or not re.fullmatch(r'[a-f0-9]{40}',spec['commitSha']):
            raise ValueError('Invalid repository or immutable commit')
        subdirectory=spec.get('subdirectory','')
        if subdirectory.startswith('/') or '..' in Path(subdirectory).parts or '\\' in subdirectory:
            raise ValueError('Invalid repository subdirectory')
        with tempfile.TemporaryDirectory(prefix='aiqa-source-') as temporary:
            source=Path(temporary)/'source';source.mkdir()
            if source_directory:
                shutil.copytree(source_directory,source,dirs_exist_ok=True)
            else:
                repo=spec['repositoryUrl'].removeprefix('https://github.com/').removesuffix('/').removesuffix('.git')
                archive=request('https://codeload.github.com/'+repo+'/tar.gz/'+spec['commitSha'],maximum=MAX_ARCHIVE)
                extract_archive(archive,source)
            # Existing images are operator configuration; never download an arbitrary image from a task.
            image=image_for(spec)
            docker(['image','inspect',image],timeout=10)
            docker(['volume','create',volume],timeout=10)
            seed='aiqa-seed-'+identity;containers.append(seed)
            docker(['create','--name',seed,'--network','none','--cap-drop=ALL','-v',volume+':/work',image,'true'],timeout=10)
            docker(['cp',str(source)+'/.',seed+':/work'],timeout=remaining())
            manifest=source/spec.get('subdirectory','')
            command,kind_env=adapter_for(spec,manifest)
            if spec.get('installDependencies'):
                if spec['kind']=='PYTHON_TEST':
                    if not (manifest/'requirements.txt').is_file():
                        raise ValueError('requirements.txt is required for dependency installation')
                    install=['python','-m','pip','install','--no-cache-dir','--target','/work/.deps','-r','requirements.txt','pytest']
                else:
                    if not (manifest/'package-lock.json').is_file():
                        raise ValueError('package-lock.json is required')
                    install=['npm','ci','--ignore-scripts','--cache','/tmp/npm']
                _, code=run_phase(image,install,'bridge')
                if code:
                    raise RuntimeError('Dependency installation failed')
            if command is None:
                command=['python','-c',"import sys;sys.path.insert(0,'/work/.deps');import pytest;raise SystemExit(pytest.main(['--junitxml=/work/report.xml','-q']))"]
            name,code=run_phase(image,command,env=kind_env)
            # Docker CLI output is bounded on disk, then read at a bounded size.
            log_path=Path(temporary)/'output.log'
            with log_path.open('wb') as log:
                subprocess.run(['docker','logs','--tail','1000',name],stdout=log,stderr=log,timeout=10)
            with log_path.open('rb') as log:
                result['output']=log.read(200000).decode('utf8','replace')[:200000]
            result['exitCode']=code
            if spec['kind'] in COMMAND_ONLY:
                result['cases']=[{'name':COMMAND_ONLY[spec['kind']],'status':'PASS' if code==0 else 'FAIL'}]
            else:
                report=Path(temporary)/'report.xml'
                docker(['cp',name+':/work/report.xml',str(report)],timeout=10)
                with report.open('rb') as source_report:
                    result['cases']=validate_report_consistency(spec['kind'],code,parse_junit(source_report.read(2*1024*1024+1)))
    except Exception as error:
        result['platformError']=str(error)[:2000]
    finally:
        stopped.set()
        cleanup_failed=False
        for command in ([['docker','rm','-f',name] for name in containers]+[['docker','volume','rm',volume]]):
            try:
                cleaned=subprocess.run(command,capture_output=True,timeout=10)
                if cleaned.returncode and b'no such' not in cleaned.stderr.lower():cleanup_failed=True
            except (OSError,subprocess.TimeoutExpired):cleanup_failed=True
        if cleanup_failed:result['platformError']='Cleanup incomplete; operator inspection required'
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');args=parser.parse_args()
    base=os.environ['AIQA_PLATFORM_URL'].rstrip('/');token=os.environ['AIQA_RUNNER_TOKEN']
    if not base.startswith('https://') and not base.startswith('http://127.0.0.1:'):
        raise ValueError('Use HTTPS or local loopback')
    while True:
        task=json.loads(request(base+'/api/runner/claim',token,{}))['task']
        if task:
            stop=threading.Event(); active=threading.Event(); active.set()
            def renew():
                while not stop.is_set():
                    try:
                        allowed=json.loads(request(base+'/api/runner/tasks/'+task['id']+'/heartbeat',token,{'leaseToken':task['leaseToken']}))['continue']
                        if not allowed:
                            active.clear();return
                    except Exception:
                        active.clear();return
                    stop.wait(10)
            monitor=threading.Thread(target=renew,daemon=True);monitor.start()
            try:
                result=execute(task['request'],active.is_set)
                try:
                    request(base+'/api/runner/tasks/'+task['id']+'/result',token,{'leaseToken':task['leaseToken'],'result':result})
                except Exception:
                    # Late/revoked leases must never retry the business command or stop the daemon.
                    print('Result delivery failed; no task replay. Platform lease reconciliation will resolve the task.',file=sys.stderr)
            finally:
                stop.set();monitor.join(timeout=16)
        if args.once:
            break
        time.sleep(3)

if __name__=='__main__':
    main()
