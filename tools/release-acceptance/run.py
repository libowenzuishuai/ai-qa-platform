#!/usr/bin/env python3
"""Disposable production-image install / real browser / upgrade / restore acceptance.
Requires reviewed local old and new images; never reads development .env or reuses DB volumes.
"""
import hashlib,json,os,secrets,subprocess,tempfile,time,urllib.request,http.cookiejar
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PROJECT='aiqa-release-'+secrets.token_hex(4)
OLD_API=os.getenv('AIQA_RELEASE_OLD_API','aiqa-prod-r04-api:latest')
OLD_SEED=os.getenv('AIQA_RELEASE_OLD_SEED','aiqa-prod-r04-seed:latest')
OLD_WORKER=os.getenv('AIQA_RELEASE_OLD_WORKER','aiqa-prod-r04-worker:latest')
NEW={k:'aiqa-'+k+':v1-review' for k in ['api','worker','web','intelligence']}
RECORD={'project':PROJECT,'synthetic':True,'date':time.strftime('%Y-%m-%d'),'steps':[],'images':{},'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'sourceDiffHash':hashlib.sha256(subprocess.check_output(['git','diff','HEAD'],cwd=ROOT)).hexdigest()}
secrets_to_mask=[]
def command(args,input=None):
 r=subprocess.run(args,cwd=ROOT,input=input,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=600)
 if r.returncode:
  msg=r.stdout.decode(errors='replace')[-5000:]
  for secret in secrets_to_mask:msg=msg.replace(secret,'[REDACTED]')
  raise RuntimeError('Command failed: '+str(args[:3])+': '+msg)
 return r.stdout

def done(step,**details):
 RECORD['steps'].append({'step':step,**details});print(step,flush=True)

with tempfile.TemporaryDirectory(prefix=PROJECT+'-') as temp:
 folder=Path(temp);password=secrets.token_hex(20);session=secrets.token_hex(32);token=secrets.token_hex(32);admin=secrets.token_hex(20);secrets_to_mask.extend([password,session,token,admin])
 values={'POSTGRES_USER':'release_test','POSTGRES_DB':'release_test','POSTGRES_PASSWORD':password,'SESSION_SECRET':session,'AIQA_INTELLIGENCE_TOKEN':token,'SEED_ADMIN_USERNAME':'release_admin','SEED_ADMIN_PASSWORD':admin,'API_PORT_PUBLISHED':'0','WORKER_PORT_PUBLISHED':'0','WEB_PORT_PUBLISHED':'0'}
 envfile=folder/'stack.env';envfile.write_text('\n'.join(k+'='+v for k,v in values.items()));envfile.chmod(0o600)
 runtime={'DATABASE_URL':f'postgresql://release_test:{password}@postgres:5432/release_test?schema=public','REDIS_URL':'redis://redis:6379/0','AIQA_ARTIFACT_DIR':'/data/artifacts','SEED_ADMIN_USERNAME':'release_admin','SEED_ADMIN_PASSWORD':admin,'SESSION_SECRET':session,'API_HOST':'0.0.0.0','API_PORT':'7300'}
 runtimefile=folder/'runtime.env';runtimefile.write_text('\n'.join(k+'='+v for k,v in runtime.items()));runtimefile.chmod(0o600)
 override=folder/'images.json'
 def select(old=False):
  images={**NEW,'migrate':OLD_API if old else NEW['api'],'seed':OLD_SEED if old else NEW['api']}
  override.write_text(json.dumps({'services':{k:{'image':v} for k,v in images.items()}}))
 def compose(*args):return command(['docker','compose','-p',PROJECT,'-f',str(ROOT/'deploy/compose.production.yaml'),'-f',str(override),'--env-file',str(envfile),*args])
 def container(service):return compose('ps','-q',service).decode().strip()
 def endpoint(service,port):
  data=json.loads(command(['docker','inspect',container(service)]))[0];return 'http://127.0.0.1:'+data['NetworkSettings']['Ports'][str(port)+'/tcp'][0]['HostPort']
 leftovers=[]
 try:
  for image in [OLD_API,OLD_SEED,OLD_WORKER,*NEW.values()]:RECORD['images'][image]=command(['docker','image','inspect','--format','{{.Id}}',image]).decode().strip()
  select(True);compose('up','-d','--wait','postgres','redis');compose('run','--rm','migrate');compose('run','--rm','seed');done('Old image clean install and initial administrator')
  fixture=PROJECT+'-old-browser';leftovers.append(fixture)
  command(['docker','create','--name',fixture,'--network',PROJECT+'_default','--env-file',str(runtimefile),'-v',PROJECT+'_artifacts-prod:/data/artifacts',OLD_WORKER,'node','--import','tsx','release-fixture.ts'])
  command(['docker','cp',str(ROOT/'tools/release-acceptance/container-fixture.ts'),fixture+':/app/apps/worker/release-fixture.ts'])
  log=command(['docker','start','-a',fixture]).decode();state=command(['docker','inspect','--format','{{.State.ExitCode}}',fixture]).decode().strip()
  if state!='0':raise RuntimeError('Old browser fixture failed: '+log[-4000:])
  record=json.loads(log.strip().splitlines()[-1]);RECORD['run']=record;done('Old production worker: actual Chromium PASS with stored evidence',runId=record['runId'])
  backup=command(['docker','exec',container('postgres'),'pg_dump','-U','release_test','-Fc','release_test']);(folder/'old.dump').write_bytes(backup)
  artifactTar=command(['docker','run','--rm','-v',PROJECT+'_artifacts-prod:/data:ro','node:22-bookworm-slim','tar','-C','/data','-cf','-','.']);done('Database and evidence backup',databaseBytes=len(backup),artifactBytes=len(artifactTar),databaseSha256=hashlib.sha256(backup).hexdigest(),artifactSha256=hashlib.sha256(artifactTar).hexdigest())
  select();compose('run','--rm','migrate');compose('up','-d','--no-build','--wait','--wait-timeout','180','api','worker','web','intelligence');done('Upgrade: six production services healthy')
  def verify(base):
   jar=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
   req=urllib.request.Request(base+'/api/auth/login',data=json.dumps({'username':'release_admin','password':admin}).encode(),headers={'Content-Type':'application/json'})
   with client.open(req,timeout=10) as r:assert r.status==200
   with client.open(base+'/api/runs/'+record['runId']+'/report',timeout=30) as r:report=json.load(r)
   report=report.get('data',report)
   assert report['run']['acceptanceStatus']=='PASS',report
   return report
  upgraded=verify(endpoint('api',7300));done('Upgraded API: old run and evidence still PASS')
  command(['docker','exec',container('postgres'),'createdb','-U','release_test','release_fresh'])
  runtime['DATABASE_URL']=runtime['DATABASE_URL'].replace('/release_test?','/release_fresh?');runtimefile.write_text('\n'.join(k+'='+v for k,v in runtime.items()))
  command(['docker','run','--rm','--network',PROJECT+'_default','--env-file',str(runtimefile),NEW['api'],'./node_modules/.bin/prisma','migrate','deploy'])
  command(['docker','run','--rm','--network',PROJECT+'_default','--env-file',str(runtimefile),NEW['api'],'node','--import','tsx','prisma/seed.ts'])
  done('Final API image: independent empty database migration and administrator initialization')
  runtime['DATABASE_URL']=runtime['DATABASE_URL'].replace('/release_fresh?','/release_test?')
  # Restore pre-upgrade backup into a separate database and evidence volume, then apply real new migrations.
  command(['docker','exec',container('postgres'),'createdb','-U','release_test','release_restored'])
  command(['docker','exec','-i',container('postgres'),'pg_restore','-U','release_test','--no-owner','-d','release_restored'],backup)
  restoredVolume=PROJECT+'-restored-artifacts';command(['docker','volume','create',restoredVolume]);leftovers.append('volume:'+restoredVolume)
  command(['docker','run','--rm','-i','-v',restoredVolume+':/data','node:22-bookworm-slim','tar','-C','/data','-xf','-'],artifactTar)
  runtime['DATABASE_URL']=runtime['DATABASE_URL'].replace('/release_test?','/release_restored?');runtimefile.write_text('\n'.join(k+'='+v for k,v in runtime.items()))
  command(['docker','run','--rm','--network',PROJECT+'_default','--env-file',str(runtimefile),NEW['api'],'./node_modules/.bin/prisma','migrate','deploy'])
  restoreApi=PROJECT+'-restored-api';leftovers.append(restoreApi)
  command(['docker','run','-d','--name',restoreApi,'--network',PROJECT+'_default','--env-file',str(runtimefile),'-v',restoredVolume+':/data/artifacts','-p','127.0.0.1::7300',NEW['api']])
  base='http://127.0.0.1:'+json.loads(command(['docker','inspect',restoreApi]))[0]['NetworkSettings']['Ports']['7300/tcp'][0]['HostPort']
  for i in range(40):
   try:
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base+'/api/health',timeout=2) as r:
     if r.status==200:break
   except Exception:time.sleep(.5)
  restored=verify(base);assert restored==upgraded,'Restored report differs from upgraded report';done('Restored isolated database and evidence: complete report identical')
  # New worker image also executes a new real Chromium run, not merely the old retained one.
  current=PROJECT+'-new-browser';leftovers.append(current)
  command(['docker','create','--name',current,'--network',PROJECT+'_default','--env-file',str(runtimefile),'-v',restoredVolume+':/data/artifacts',NEW['worker'],'node','--import','tsx','release-fixture.ts'])
  command(['docker','cp',str(ROOT/'tools/release-acceptance/container-fixture.ts'),current+':/app/apps/worker/release-fixture.ts'])
  out=command(['docker','start','-a',current]).decode();assert command(['docker','inspect','--format','{{.State.ExitCode}}',current]).decode().strip()=='0',out[-4000:]
  done('Final production worker: new actual Chromium run PASS',run=json.loads(out.strip().splitlines()[-1]))
  RECORD['passed']=True
 finally:
  for item in reversed(leftovers):
   try:command(['docker','volume','rm',item[7:]] if item.startswith('volume:') else ['docker','rm','-f',item])
   except Exception:RECORD.setdefault('cleanupErrors',[]).append(item)
  try:compose('down','-v','--remove-orphans')
  except Exception:RECORD.setdefault('cleanupErrors',[]).append('compose')
  (ROOT/'data/pilot-evidence').mkdir(parents=True,exist_ok=True)
  (ROOT/('data/pilot-evidence/production-release-'+PROJECT+'.json')).write_text(json.dumps(RECORD,ensure_ascii=False,indent=2))
  (ROOT/'data/pilot-evidence/production-release.json').write_text(json.dumps(RECORD,ensure_ascii=False,indent=2))
