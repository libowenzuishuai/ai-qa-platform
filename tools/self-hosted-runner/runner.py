#!/usr/bin/env python3
"""Authenticated pull runner. Repository code executes only in disposable Docker containers."""
import argparse
import io
import json
import os
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
    def run_phase(image, command, network='none'):
        name = 'aiqa-' + uuid.uuid4().hex
        containers.append(name)
        docker(['create','--name',name,'--network',network,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges',
                '--log-opt','max-size=2m','--log-opt','max-file=1','--pids-limit=128','--memory=512m','--cpus=1','--tmpfs','/tmp:rw,nosuid,size=128m',
                '-v',volume+':/work','-w','/work/'+spec.get('subdirectory',''),'-e','HOME=/tmp',image,*command],timeout=remaining())
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
        with tempfile.TemporaryDirectory(prefix='aiqa-source-') as temporary:
            source=Path(temporary)/'source';source.mkdir()
            if source_directory:
                shutil.copytree(source_directory,source,dirs_exist_ok=True)
            else:
                repo=spec['repositoryUrl'].removeprefix('https://github.com/').removesuffix('/').removesuffix('.git')
                archive=request('https://codeload.github.com/'+repo+'/tar.gz/'+spec['commitSha'],maximum=MAX_ARCHIVE)
                extract_archive(archive,source)
            # Existing images are operator configuration; never download an arbitrary image from a task.
            image=os.getenv('AIQA_RUNNER_PYTHON_IMAGE','python:3.13-slim') if spec['kind']=='PYTHON_TEST' else os.getenv('AIQA_RUNNER_NODE_IMAGE','node:22-alpine')
            docker(['image','inspect',image],timeout=10)
            docker(['volume','create',volume],timeout=10)
            seed='aiqa-seed-'+identity;containers.append(seed)
            docker(['create','--name',seed,'--network','none','--cap-drop=ALL','-v',volume+':/work',image,'true'],timeout=10)
            docker(['cp',str(source)+'/.',seed+':/work'],timeout=remaining())
            if spec.get('installDependencies'):
                manifest=source/spec.get('subdirectory','')
                if spec['kind']=='PYTHON_TEST':
                    if not (manifest/'requirements.txt').is_file():
                        raise ValueError('requirements.txt is required for dependency installation')
                    command=['python','-m','pip','install','--no-cache-dir','--target','/work/.deps','-r','requirements.txt','pytest']
                else:
                    if not (manifest/'package-lock.json').is_file():
                        raise ValueError('package-lock.json is required')
                    command=['npm','ci','--ignore-scripts','--cache','/tmp/npm']
                _, code=run_phase(image,command,'bridge')
                if code:
                    raise RuntimeError('Dependency installation failed')
            if spec['kind']=='NODE_TEST':
                command=['node','--test','--test-reporter=junit','--test-reporter-destination=/work/report.xml']
            elif spec['kind']=='PYTHON_TEST':
                command=['python','-c',"import sys;sys.path.insert(0,'/work/.deps');import pytest;raise SystemExit(pytest.main(['--junitxml=/work/report.xml','-q']))"]
            else:
                command=['npm','run','build']
            name,code=run_phase(image,command)
            # Docker CLI output is bounded on disk, then read at a bounded size.
            log_path=Path(temporary)/'output.log'
            with log_path.open('wb') as log:
                subprocess.run(['docker','logs','--tail','1000',name],stdout=log,stderr=log,timeout=10)
            with log_path.open('rb') as log:
                result['output']=log.read(200000).decode('utf8','replace')[:200000]
            result['exitCode']=code
            if spec['kind']=='NODE_BUILD':
                result['cases']=[{'name':'npm run build（工程构建，不代表业务验收）','status':'PASS' if code==0 else 'FAIL'}]
            else:
                report=Path(temporary)/'report.xml'
                docker(['cp',name+':/work/report.xml',str(report)],timeout=10)
                with report.open('rb') as source_report:
                    result['cases']=parse_junit(source_report.read(2*1024*1024+1))
    except Exception as error:
        result['platformError']=str(error)[:2000]
    finally:
        stopped.set()
        for name in containers:
            subprocess.run(['docker','rm','-f',name],capture_output=True,timeout=10)
        subprocess.run(['docker','volume','rm',volume],capture_output=True,timeout=10)
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--once',action='store_true');args=parser.parse_args()
    base=os.environ['AIQA_PLATFORM_URL'].rstrip('/');token=os.environ['AIQA_RUNNER_TOKEN']
    if not base.startswith('https://') and not base.startswith('http://127.0.0.1:'):
        raise ValueError('Use HTTPS or local loopback')
    while True:
        task=json.loads(request(base+'/api/runner/claim',token,{}))['task']
        if task:
            last_heartbeat=0;active=True
            def heartbeat():
                nonlocal last_heartbeat,active
                if time.monotonic()-last_heartbeat > 10:
                    try:
                        active=json.loads(request(base+'/api/runner/tasks/'+task['id']+'/heartbeat',token,{'leaseToken':task['leaseToken']}))['continue']
                    except Exception:
                        active=False
                    last_heartbeat=time.monotonic()
                return active
            result=execute(task['request'],heartbeat)
            request(base+'/api/runner/tasks/'+task['id']+'/result',token,{'leaseToken':task['leaseToken'],'result':result})
        if args.once:
            break
        time.sleep(3)

if __name__=='__main__':
    main()
