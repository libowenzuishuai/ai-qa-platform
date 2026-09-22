#!/usr/bin/env python3
"""Explicit, versioned pilot import and evidence evaluation. Ground truth stays local."""
import argparse,hashlib,json,os,re,time,urllib.request,urllib.parse,urllib.error
from pathlib import Path

def digest(data):return hashlib.sha256(data).hexdigest()
def load_manifest(path):
 path=Path(path).resolve();m=json.loads(path.read_text());root=path.parent
 if m.get('schemaVersion')!='pilot-v1' or m.get('kind') not in ['synthetic','real']:raise ValueError('Invalid pilot manifest version/kind')
 for key in ['projectId','baselineId','authorizedBy','authorizationScope','approvalRecord']:
  if not isinstance(m.get(key),str) or not m[key].strip():raise ValueError('Missing '+key)
 if not m.get('documents'):raise ValueError('Complete approved requirements are required')
 seen=set()
 for item in m['documents']:
  rel=item.get('path','');file=(root/rel).resolve()
  if not rel or Path(rel).is_absolute() or not file.is_relative_to(root) or rel in seen:raise ValueError('Invalid/duplicate document path')
  seen.add(rel);data=file.read_bytes()
  if len(data)>20*1024*1024 or not data or digest(data)!=item.get('sha256'):raise ValueError('Document checksum/size mismatch')
  if item.get('format') not in ['MARKDOWN','TXT','DOCX','PDF_TEXT','PDF_SCANNED','PNG','JPEG'] or not item.get('title'):raise ValueError('Document metadata incomplete')
 if {x.get('name') for x in m.get('builds',[])}!={'healthy','defect','repaired'} or len(m['builds'])!=3:raise ValueError('Exactly three frozen build variants required')
 for b in m['builds']:
  if not all(b.get(k) for k in ['environmentId','buildId','caseVersionIds']) or not re.fullmatch('[a-f0-9]{40}',b.get('commitSha','')):raise ValueError('Build identity/approved cases missing')
 if len({b['buildId'] for b in m['builds']})!=3:raise ValueError('Build identities must differ')
 if len({json.dumps(sorted(b['caseVersionIds'])) for b in m['builds']})!=1:raise ValueError('Repair must use the same case versions')
 dimensions=m.get('dimensions',{})
 if set(dimensions)!={'normal','boundary','permission','multiRole','state','persistence'}:raise ValueError('Six business dimensions must be accounted for')
 for d in dimensions.values():
  if d.get('status') not in ['COVERED','BLOCKED','NOT_APPLICABLE'] or not d.get('reason'):raise ValueError('Dimension status needs its basis')
  if d['status']=='COVERED' and (not d.get('caseVersionIds') or not set(d['caseVersionIds']).issubset(set(m['builds'][0]['caseVersionIds']))):raise ValueError('Covered dimension needs approved cases')
  if d['status']=='NOT_APPLICABLE' and not d.get('approvedBy'):raise ValueError('Not-applicable requires business confirmation')
 return m,root

class Client:
 def __init__(self,base,cookie):
  url=urllib.parse.urlsplit(base)
  if url.scheme!='https' and not(url.scheme=='http' and url.hostname in ['localhost','127.0.0.1','::1']):raise ValueError('Use HTTPS or loopback API')
  if url.username or url.password or url.query or url.fragment:raise ValueError('Invalid platform URL')
  self.base=base.rstrip('/');self.cookie=cookie
 def request(self,path,body=None,content_type='application/json'):
  if not path.startswith('/api/') or path.startswith('//'):raise ValueError('Invalid API path')
  raw=body if isinstance(body,bytes) else None if body is None else json.dumps(body).encode()
  req=urllib.request.Request(self.base+path,data=raw,headers={'Cookie':self.cookie,'Content-Type':content_type})
  class NoRedirect(urllib.request.HTTPRedirectHandler):
   def redirect_request(self,*args,**kwargs):raise ValueError('API redirect refused')
  with urllib.request.build_opener(*([urllib.request.ProxyHandler({})] if urllib.parse.urlsplit(self.base).hostname in ['localhost','127.0.0.1','::1'] else []),NoRedirect).open(req,timeout=30) as response:
   data=response.read(8*1024*1024+1)
   if len(data)>8*1024*1024:raise ValueError('API response too large')
   return json.loads(data)

def import_documents(m,root,client):
 # Only the original document bytes and parse metadata reach the platform; never evaluation truth.
 records=[]
 for d in m['documents']:
  data=(root/d['path']).read_bytes();boundary='aiqa-'+os.urandom(16).hex()
  metadata={'title':d['title'],'declaredFormat':d['format'],'fileSizeBytes':len(data),'mode':'real'}
  body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'.encode()+json.dumps(metadata).encode()+f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="source"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+data+f'\r\n--{boundary}--\r\n'.encode())
  result=client.request('/api/projects/'+urllib.parse.quote(m['projectId'],safe='')+'/documents',body,'multipart/form-data; boundary='+boundary)
  records.append({'path':d['path'],'sha256':d['sha256'],'job':result})
 return records

def evaluate(m,reports):
 checks=[]
 by_name={b['name']:b for b in m['builds']}
 for name in ['healthy','defect','repaired']:
  report=reports[name];build=by_name[name];run=report.get('run',{})
  valid=run.get('lifecycle')=='FINISHED' and run.get('buildVerified') is True and run.get('buildId')==build['buildId']
  valid=valid and {c['caseVersionId'] for c in report.get('cases',[])}==set(build['caseVersionIds'])
  expected='FAIL' if name=='defect' else 'PASS'
  checks.append({'variant':name,'passed':bool(valid and run.get('acceptanceStatus')==expected),'expected':expected,'actual':run.get('acceptanceStatus'),'reportSha256':digest(json.dumps(report,sort_keys=True,ensure_ascii=False).encode())})
 blocked=[k for k,d in m['dimensions'].items() if d['status']=='BLOCKED']
 # A FAIL somewhere is insufficient: require the evaluator's exact affected cases.
 expected_defects=set(m.get('defectCaseVersionIds',[]));actual_defects={c['caseVersionId'] for c in reports['defect'].get('cases',[]) if c.get('verdict')=='FAIL'}
 defect_match=bool(expected_defects) and actual_defects==expected_defects
 return {'kind':m['kind'],'checks':checks,'blockedDimensions':blocked,'defectCasesMatched':defect_match,'releaseEvidencePass':m['kind']=='real' and all(c['passed'] for c in checks) and not blocked and defect_match,'syntheticChecksPass':all(c['passed'] for c in checks) and not blocked and defect_match,'humanReview':'NOT_PERFORMED_BY_SCRIPT'}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('manifest');parser.add_argument('--action',choices=['validate','import','run','evaluate'],default='validate');parser.add_argument('--execute',action='store_true');parser.add_argument('--reports');parser.add_argument('--output',required=True);args=parser.parse_args()
 m,root=load_manifest(args.manifest);result={'manifestSha256':digest(Path(args.manifest).read_bytes()),'kind':m['kind'],'authorizationScope':m['authorizationScope'],'approvalRecord':m['approvalRecord'],'createdAt':time.time(),'action':args.action}
 if args.action in ['import','run']:
  if not args.execute:raise ValueError('Explicit --execute required; import can invoke configured vision models')
  cookie=os.environ.get('AIQA_PILOT_SESSION_COOKIE','')
  if not cookie:raise ValueError('Set AIQA_PILOT_SESSION_COOKIE securely')
  client=Client(os.environ.get('AIQA_PLATFORM_URL','http://127.0.0.1:7300'),cookie)
  if args.action=='import':result['documents']=import_documents(m,root,client)
  else:
   result['runs']=[]
   for b in m['builds']:
    request={k:b[k] for k in ['environmentId','buildId','caseVersionIds']};request.update({'projectId':m['projectId'],'baselineId':m['baselineId'],'mode':'real','idempotencyKey':'pilot-'+result['manifestSha256'][:32]+'-'+b['name']})
    result['runs'].append({'variant':b['name'],'response':client.request('/api/runs',request)})
 elif args.action=='evaluate':
  if not args.reports:raise ValueError('Provide directory with healthy.json / defect.json / repaired.json')
  reports={n:json.loads((Path(args.reports)/(n+'.json')).read_text()) for n in ['healthy','defect','repaired']};result['evaluation']=evaluate(m,reports)
 output=Path(args.output)
 # Never overwrite the first failure or earlier attempt.
 with output.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
 print('Pilot record saved; kind='+m['kind']+'; action='+args.action)
if __name__=='__main__':main()
