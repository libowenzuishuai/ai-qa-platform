"""Opt-in real mixed-PDF evaluation. Each invocation writes a new, immutable record.
Keyword checks are automated, not human verification. No default CI model calls.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from aiqa_intelligence.context import RequestContext
from aiqa_intelligence.contracts.generated import DocumentParseInput
from aiqa_intelligence.contracts.validation import validate_bundle
from aiqa_intelligence.doc_ingestion.service import DocumentParser
from aiqa_intelligence.models import Gateway
from aiqa_intelligence.storage import ArtifactReader

_RECORDS=Path(__file__).resolve().parent/'b3-records'
_PDF=_RECORDS/'b3-mixed-prd-sample.pdf'
_EXPECTED=_RECORDS/'b3-mixed-prd-sample.expected.json'


def evaluate(body: dict, expected: dict) -> dict:
    validate_bundle(body)
    pages={}
    for block in body['blocks']:
        pages.setdefault(block.get('page'),[]).append(block['text'])
    pages={p:'\n'.join(text) for p,text in pages.items()}
    checks=[dict(page=p['page'],text=t,found=t in pages.get(p['page'],''))
            for p in expected['pages'] for t in p['humanCheck']]
    # Check row associations too: globally present numbers can belong to the wrong role.
    rows=[]
    for page in (2,3):
        for role,amount in [('申请人','<=500000'),('主管','>500000')]:
            found=any(role in line and amount in re.sub(r'\s+','',line)
                      for line in pages.get(page,'').splitlines())
            rows.append(dict(page=page,role=role,amount=amount,found=found))
    complete=(body['parseStatus']=='PARSED' and body['coverageSummary']['unparsedSpans']==0
              and set(pages)=={p['page'] for p in expected['pages']})
    return dict(passed=complete and all(c['found'] for c in checks+rows),
                pageTextChecks=checks,rowAssociationChecks=rows,completePages=complete,
                manualReviewPerformed=False)


async def run(output: Path):
    # Exclusive reservation happens before spending tokens; never overwrite an earlier attempt.
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('x',encoding='utf-8') as archive:
        records=[]
        record=dict(caseId='b3-09-mixed-prd-sample',mode='real',evaluationVersion='b3-mixed-v2',
                    ranAt=datetime.now(timezone.utc).isoformat(),status='ERROR',
                    manualReviewPerformed=False)
        failure=None
        try:
            data=_PDF.read_bytes(); expected_data=_EXPECTED.read_bytes()
            record.update(fixtureSha256=hashlib.sha256(data).hexdigest(),expectedSha256=hashlib.sha256(expected_data).hexdigest())
            with TemporaryDirectory(prefix='aiqa-b3-09-') as root:
                Path(root,'mixed.pdf').write_bytes(data)
                request=DocumentParseInput(documentVersionId='b3-09-'+uuid4().hex,format='PDF_TEXT',
                    storageKey='mixed.pdf',checksum=record['fixtureSha256'],fileSizeBytes=len(data))
                reader=ArtifactReader(Path(root))
                gateway=Gateway('real',reader,'document-vision-1.2',records)
                result=await DocumentParser().parse_document(request,RequestContext('b3-09','real',reader,gateway,records))
                body=result.model_dump(mode='json',exclude_unset=True)
                record['bundle']=body
                record['evaluation']=evaluate(body,json.loads(expected_data))
                real_invocations=len(records)==len(json.loads(expected_data)['pages']) and all(r.response.provider!='mock' for r in records)
                record['status']='PASS' if record['evaluation']['passed'] and real_invocations else 'FAIL'
        except BaseException as exc:
            record['errorCode']=getattr(exc,'code',type(exc).__name__)
            failure=exc
        finally:
            record['invocations']=[dict(provider=r.response.provider,model=r.response.model,
                requestId=r.response.requestId,usage=r.response.usage.model_dump(),latencyMs=r.response.latencyMs) for r in records]
            json.dump(record,archive,ensure_ascii=False,indent=2);archive.write('\n');archive.flush();os.fsync(archive.fileno())
        if failure: raise failure
        if record['status']!='PASS': raise AssertionError(f'Evaluation failed; preserved at {output}')
    print(json.dumps(dict(status=record['status'],record=str(output)),ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file',type=Path)
    parser.add_argument('--output',type=Path,default=None)
    args=parser.parse_args()
    if args.env_file:
        for line in args.env_file.read_text(encoding='utf-8').splitlines():
            if line.startswith('AIQA_VISION_') and '=' in line:
                key,value=line.split('=',1);os.environ[key.strip()]=value.strip().strip('"')
    output=args.output or _RECORDS/'runs'/('b3-mixed-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')+'-'+uuid4().hex[:8]+'.real.json')
    asyncio.run(run(output))
