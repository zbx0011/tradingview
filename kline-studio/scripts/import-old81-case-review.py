"""Publish the verified old81 outputs as independent chart-only layers."""
import hashlib,json,shutil
from pathlib import Path
from datetime import datetime,timezone,timedelta

ROOT=Path(__file__).resolve().parents[1]
RUN=Path(r'D:\CodexData\v6-stage00-supervisor\pa-case-learning-v2\signal_filter\runs\old81-v1')
DEST=ROOT/'src/data/research-signal-layers'
ASSETS=ROOT/'public/research/old81'
def read(path):return json.loads(path.read_text(encoding='utf-8'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def asset(value):
 path=Path(value)
 if not path.is_file():raise ValueError('Missing evidence image: '+str(path))
 name=sha(path)+path.suffix;target=ASSETS/name
 if not target.exists():shutil.copy2(path,target)
 return '/research/old81/'+name

def main():
 summary=read(RUN/'final-summary.json')
 if summary['status']!='complete' or summary['complete']!=81 or summary['validation_errors']:raise ValueError('Unverified output')
 rows=[json.loads(line) for line in (RUN/'results.jsonl').read_text(encoding='utf-8').splitlines() if line.strip()]
 signals=read(RUN/'signals.json');bars=read(RUN/'bars.json')
 if len(rows)!=81 or {r['signal']['signal_id'] for r in rows}!={s['signal_id'] for s in signals}:raise ValueError('Signal accounting mismatch')
 original=read(DEST/'round2-baseline.json');lookup={s['id']:s for s in original['signals']}
 ASSETS.mkdir(parents=True,exist_ok=True);DEST.mkdir(exist_ok=True)
 base=[];reviewed=[]
 labels={'keep':'保留','filter':'过滤','uncertain':'证据不足'}
 for r in rows:
  s=r['signal'];raw=lookup[s['signal_id']];idx=s['idx'];answer=r['answer']
  if raw['time']!=s['time'] or raw['side']!=s['side'] or bars[idx]['time']!=s['time']:raise ValueError('Original signal identity changed')
  offset=idx-raw['idx']
  item={**raw,'id':'old81-original-'+s['signal_id'],'originalSignalId':s['signal_id'],'originalWindowId':raw['windowId'],'originalSourceIndex':raw['idx'],'windowId':'OLD81','idx':idx,'price':bars[idx]['close'],'evidenceIndices':[i+offset for i in raw['evidenceIndices']], 'reviewNote':f'本段81个原始信号之一。来源{raw["windowId"]} K{raw["idx"]}，工坊冻结数据K{idx}；方向、时间未改变。'}
  base.append(item)
  comparisons={c['case_id']:c for c in answer['case_comparisons']}
  details={'supportingEvidence':answer['supporting_evidence'],'counterEvidence':answer['counter_evidence'],'decisiveDifference':answer['decisive_difference'],'waitConditions':answer['wait_or_invalidation'],'annotatedImage':asset(r['images']['annotated']),'disputes':[n['explanation'] for n in r.get('case_use_review',[]) if n['status']=='disputed'],'revisionNote':'已定向修正案例证据角色，原答案与修订回执完整保留。' if r.get('revision') else '', 'cases':[]}
  for c in r['cases']:
   cmp=comparisons.get(c['case_id'],{})
   details['cases'].append({'caseId':c['case_id'],'similarities':cmp.get('similarities',''),'differences':cmp.get('differences',''),'basis':cmp.get('basis',''),'effect':cmp.get('effect','not_applicable'),'images':[asset(p) for p in c.get('images',[])],'originalImages':[asset(p) for p in c.get('original_images',[])]})
  reviewed.append({**item,'id':'old81-reviewed-'+s['signal_id'],'reason':answer['reason'],'context':r['context'],'evidenceIndices':sorted({i for st in answer['structures'] for i in [st['start_idx'],st['end_idx']]} or {idx}),'reviewVerdict':answer['verdict'],'filterReview':details,'reviewNote':f'案例复核：{labels[answer["verdict"]]}。原时间和方向保留；仅使用截止信号当时的行情。'+(' 存在案例使用争议，详见下方。' if details['disputes'] else '')})
 window={'id':'OLD81','startTime':signals[0]['time'],'endTime':bars[-1]['time'],'startIdx':signals[0]['idx'],'endIdxExclusive':len(bars),'sourceSha256':sha(RUN/'bars.json'),'bars':bars}
 for key,name,items in [('original','本段原版 · 81个信号',base),('reviewed','本段案例复核 · 55保留 / 18过滤 / 8未决',reviewed)]:
  payload={'schemaVersion':1,'sourceId':'pa-case-filter-old81-'+key,'name':name,'symbol':'XAUUSD','interval':'5m','reviewNote':'2026-09-04 · 仅复核既有81个信号。模型意见，不是准确率或成交记录。','provenance':{'run':'old81-v1','resultsSha256':sha(RUN/'results.jsonl'),'summarySha256':sha(RUN/'final-summary.json'),'requestedConfig':summary['requested_config'],'sourceRecoveryComplete':True},'windows':[window],'signals':items}
  (DEST/('old81-'+key+'.json')).write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print(json.dumps({'original':len(base),'reviewed':len(reviewed),'counts':summary['counts'],'assetFiles':len(list(ASSETS.iterdir()))},ensure_ascii=False))

if __name__=='__main__':main()
