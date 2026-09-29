import asyncio
from types import SimpleNamespace
import pytest
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader
from aiqa_intelligence.contracts.generated import TextModelRequest
from aiqa_intelligence.errors import ServiceError

def test_decision_route_is_explicit_and_pins_reject_drift(monkeypatch,tmp_path):
    import httpx
    calls=[]
    class Client:
        def __init__(self,**kw):assert kw['follow_redirects'] is False
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def post(self,url,**kw):
            calls.append((url,kw['json']))
            return httpx.Response(200,json={'id':'fixture','choices':[{'finish_reason':'stop','message':{'content':'{"ok":true}'}}],'usage':{'prompt_tokens':1,'completion_tokens':2}})
    monkeypatch.setattr(httpx,'AsyncClient',Client)
    for k,v in {'PROVIDER':'openai-compatible','BASE_URL':'http://fixture.invalid/v1','MODEL':'decision-version-1','API_KEY':'fixture-only'}.items():monkeypatch.setenv('AIQA_DECISION_'+k,v)
    gateway=Gateway('real',ArtifactReader(tmp_path),'route-test',[])
    gateway.set_route('decision',{'provider':'openai-compatible','model':'decision-version-1'})
    request=TextModelRequest(purpose='PLAN_PROPOSAL',system='test',user='test',maxOutputTokens=64,timeoutMs=1000)
    result=asyncio.run(gateway.complete_text(request));assert result.provider=='openai-compatible' and calls[0][1]['model']=='decision-version-1' and calls[0][1]['max_tokens']==64
    monkeypatch.setenv('AIQA_DECISION_MODEL','changed-version')
    with pytest.raises(ServiceError,match='冻结版本'):asyncio.run(gateway.complete_text(request))
    assert len(calls)==1

def test_exploration_proposal_cannot_invent_input_or_role():
    from aiqa_intelligence.agents.browser_agent import validate_proposal
    data={'observationId':'now','completed':[],'operations':[],'elements':[{'ref':'now:1','role':'user','enabled':True,'name':'Name'}], 'exploration':{'roles':['user'],'kinds':['fill'],'values':[{'id':'approved','value':'test'}]}}
    out={'observationId':'now','status':'act','actionId':None,'elementRef':'now:1','proposed':{'role':'user','kind':'fill','valueRef':'approved'}}
    validate_proposal(data,out)
    for change in [{'valueRef':'secret'},{'role':'admin'},{'kind':'click'}]:
        with pytest.raises(ServiceError):validate_proposal(data,{**out,'proposed':{**out['proposed'],**change}})
