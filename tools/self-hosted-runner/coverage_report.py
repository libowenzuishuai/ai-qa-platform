"""Bounded LCOV line coverage import; independently checked again by platform contracts."""
import hashlib,re

def parse_lcov(raw):
 if len(raw.encode('utf8'))>262144 or '\0' in raw:raise ValueError('LCOV report exceeds supported limit')
 files=[];paths=set();current=None
 def integer(v):
  if not re.fullmatch(r'[0-9]+',v) or int(v)>1000000000:raise ValueError('Invalid LCOV count')
  return int(v)
 for line in raw.split('\n'):
  line=line.removesuffix('\r')
  if not line or line.startswith('TN:'):continue
  if line.startswith('SF:'):
   if current is not None:raise ValueError('Unterminated LCOV record')
   path=re.sub(r'^/work/','',line[3:])
   if not path or len(path.encode('utf-16-le'))//2>500 or path.startswith('/') or '\\' in path or '..' in path.split('/') or path in paths:raise ValueError('Invalid or duplicate LCOV source')
   paths.add(path);current={'path':path,'lines':{}};continue
  if line=='end_of_record':
   if current is None:raise ValueError('LCOV source missing')
   found=len(current['lines']);hit=sum(v>0 for v in current['lines'].values())
   if current.get('found')!=found or current.get('hit')!=hit:raise ValueError('LCOV totals contradict line records')
   files.append({'path':current['path'],'linesFound':found,'linesHit':hit});current=None
   if len(files)>2000:raise ValueError('Too many LCOV files')
   continue
  if current is None:raise ValueError('LCOV record outside source')
  if line.startswith('DA:'):
   values=line[3:].split(',')
   if len(values)<2 or len(values)>3:raise ValueError('Invalid LCOV line')
   n=integer(values[0]);hits=integer(values[1])
   if n<1 or n in current['lines']:raise ValueError('Invalid or duplicate LCOV line')
   current['lines'][n]=hits
  elif line.startswith('LF:') or line.startswith('LH:'):
   key='found' if line.startswith('LF:') else 'hit'
   if key in current:raise ValueError('Duplicate LCOV total')
   current[key]=integer(line[3:])
  elif not re.match(r'^(FN|FNDA|FNF|FNH|BRDA|BRF|BRH|VER):',line):raise ValueError('Unsupported LCOV field')
 if current is not None or not files:raise ValueError('Incomplete LCOV report')
 return {'format':'LCOV','sha256':hashlib.sha256(raw.encode('utf8')).hexdigest(),'raw':raw,'files':files,'linesFound':sum(f['linesFound'] for f in files),'linesHit':sum(f['linesHit'] for f in files)}
