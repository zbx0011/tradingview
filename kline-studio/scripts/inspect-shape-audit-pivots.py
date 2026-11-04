import json
from pathlib import Path
root=Path(__file__).resolve().parents[1]
for a in json.loads((root/'src/data/shape-annotation-reviews.json').read_bytes())['reviews']:
    if a['verdict']!='match': continue
    b=json.loads((Path('D:/codex/V6/research/shape-all-audit-20260909')/(a['id']+'-prefix.json')).read_bytes())
    w=a['phases'][1];lo,hi=w['startIndex'],w['endIndex']
    print(a['id'],lo,hi)
    for t,f in [('high',max),('low',min)]:
        print(t,[(i,b[i][t]) for i in range(max(2,lo),min(hi,len(b)-3)+1) if b[i][t]==f(x[t] for x in b[i-2:i+3])])
