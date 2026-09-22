import importlib.util,json,hashlib,copy
from pathlib import Path
import pytest
spec=importlib.util.spec_from_file_location('pilot',Path(__file__).parents[1]/'pilot.py');pilot=importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)
def fixture(tmp_path):
 raw=b'# Synthetic PRD\n';(tmp_path/'prd.md').write_bytes(raw)
 m={'schemaVersion':'pilot-v1','kind':'synthetic','projectId':'p','baselineId':'b','authorizedBy':'fixture','authorizationScope':'synthetic isolated target only','approvalRecord':'fixture-not-business-approval','documents':[{'path':'prd.md','title':'PRD','format':'MARKDOWN','sha256':hashlib.sha256(raw).hexdigest()}],'builds':[{'name':n,'environmentId':'e-'+n,'buildId':n,'commitSha':str(i)*40,'caseVersionIds':['case']} for i,n in enumerate(['healthy','defect','repaired'])],'dimensions':{n:{'status':'COVERED','reason':'synthetic fixture','caseVersionIds':['case']} for n in ['normal','boundary','permission','multiRole','state','persistence']},'defectCaseVersionIds':['case']}
 path=tmp_path/'manifest.json';path.write_text(json.dumps(m));return path,m
@pytest.mark.parametrize('kind',['hash','traversal','cases','approval','dimension'])
def test_manifest_refuses_untrusted_or_incomplete_input(tmp_path,kind):
 path,m=fixture(tmp_path)
 if kind=='hash':m['documents'][0]['sha256']='0'*64
 if kind=='traversal':m['documents'][0]['path']='../secret'
 if kind=='cases':m['builds'][2]['caseVersionIds']=['new-weakened-case']
 if kind=='approval':m['approvalRecord']=''
 if kind=='dimension':m['dimensions']['permission']={'status':'NOT_APPLICABLE','reason':'unknown'}
 path.write_text(json.dumps(m))
 with pytest.raises(ValueError):pilot.load_manifest(path)
def test_synthetic_never_release_pass_and_failed_build_keeps_exact_case(tmp_path):
 path,m=fixture(tmp_path);pilot.load_manifest(path)
 reports={n:{'run':{'lifecycle':'FINISHED','buildVerified':True,'buildId':n,'acceptanceStatus':'FAIL' if n=='defect' else 'PASS'},'cases':[{'caseVersionId':'case','verdict':'FAIL' if n=='defect' else 'PASS'}]} for n in ['healthy','defect','repaired']}
 good=pilot.evaluate(m,reports);assert good['syntheticChecksPass'];assert not good['releaseEvidencePass']
 m['kind']='real';assert pilot.evaluate(m,reports)['releaseEvidencePass']
 reports['repaired']['run']['buildVerified']=False;assert not pilot.evaluate(m,reports)['releaseEvidencePass']
 reports['repaired']['run']['buildVerified']=True;reports['defect']['cases'][0]['caseVersionId']='other';assert not pilot.evaluate(m,reports)['releaseEvidencePass']
def test_ground_truth_not_sent_in_import(tmp_path):
 path,m=fixture(tmp_path);seen=[]
 class Client:
  def request(self,path,body,content_type):seen.append(body);return {'jobId':'parse-job'}
 pilot.import_documents(m,tmp_path,Client());assert b'defectCaseVersionIds' not in seen[0];assert b'fixture-not-business-approval' not in seen[0];assert b'# Synthetic PRD' in seen[0]
