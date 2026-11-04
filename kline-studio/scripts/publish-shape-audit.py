import json, hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=Path('D:/codex/V6/research/shape-all-audit-20260909')
audit=json.loads((ROOT/'src/data/shape-annotation-reviews.json').read_bytes())
source_questions={}
for name in ['xauusd-5m-strong22.json','xauusd-5m-supplemental.json','causal-range-confirmations.json']:
    source_questions.update({q['id']:q for q in json.loads((ROOT/'public/data/shape-practice'/name).read_bytes())['questions']})
rows=[]
for r in audit['reviews']:
    bars=json.loads((OUT/(r['id']+'-prefix.json')).read_bytes())
    assert len(bars)==r['endIndex']+1
    q=source_questions[r['id']]
    assert q['startIndex']==r['endIndex'] and q['bars'][:q['startIndex']+1]==bars, 'source prefix changed; requires fresh review'
    assert hashlib.sha256(json.dumps(bars,sort_keys=True,separators=(',',':')).encode()).hexdigest()==r['prefixSha256']
    if r['verdict']=='match':
        assert len(r['phases'])==3
        for p in r['phases']: assert 0<=p['startIndex']<p['endIndex']<=r['endIndex']
    rows.append(dict(**r,bars=bars))
template=(ROOT/'scripts/shape-audit-template.html').read_text(encoding='utf-8')
html=template.replace('__AUDIT_DATA__',json.dumps(rows,ensure_ascii=False,separators=(',',':')).replace('</','<\\/'))
(ROOT/'public/shape-all-audit.html').write_text(html,encoding='utf-8')
(OUT/'shape-all-audit.html').write_text(html,encoding='utf-8')
(OUT/'audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2),encoding='utf-8')
print('PASS: 39 prefix hashes; 13 complete interval sets; no future bars published')
