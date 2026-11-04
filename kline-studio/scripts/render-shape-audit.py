"""Render immutable question prefixes only; never pass future bars to plotting."""
import json, hashlib
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

ROOT=Path(__file__).resolve().parents[1]
OUT=Path('D:/codex/V6/research/shape-all-audit-20260909')
OUT.mkdir(exist_ok=True)
questions=[]
for name in ['xauusd-5m-strong22.json','xauusd-5m-supplemental.json','causal-range-confirmations.json']:
    questions += json.loads((ROOT/'public/data/shape-practice'/name).read_bytes())['questions']
excluded=set(json.loads((ROOT/'src/data/shape-curation.json').read_bytes())['excluded_ids'])
questions.sort(key=lambda q:(q['id'] in excluded, q['id']))
manifest=[]
for page in range(0,len(questions),3):
    fig,axes=plt.subplots(3,1,figsize=(16,13.5),facecolor='#101620')
    for ax,q in zip(axes,questions[page:page+3]):
        end=q['startIndex']; bars=q['bars'][:end+1]
        offset=q.get('sourceIndex',end)-end
        # Full visible prefix, without old arrows or model phase labels.
        ax.set_facecolor('#101620')
        for i,b in enumerate(bars):
            color='#e5e7eb' if b['close']>=b['open'] else '#3978ff'
            ax.vlines(i,b['low'],b['high'],color=color,lw=.65)
            ax.add_patch(Rectangle((i-.34,min(b['open'],b['close'])),.68,max(abs(b['close']-b['open']),.025),color=color))
        ax.axvline(end,color='#facc15',ls='--',lw=1)
        ax.grid(alpha=.1); ax.tick_params(colors='#cbd5e1',labelsize=9)
        ax.set_xlim(-2,end+3)
        ax.set_xticks(list(range(0,end+1,10)))
        ax.set_title(f"{q['id']} | local 0..{end} | source offset {offset} | {'EXCLUDED' if q['id'] in excluded else 'ACTIVE'}",color='white',fontsize=10)
        record={'id':q['id'],'endIndex':end,'sourceOffset':offset,'previouslyExcluded':q['id'] in excluded,'prefixSha256':hashlib.sha256(json.dumps(bars,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'sheet':f'sheet-{page//3+1:02}.png'}
        manifest.append(record)
        (OUT/(q['id']+'-prefix.json')).write_text(json.dumps(bars,separators=(',',':')))
    fig.tight_layout(); fig.savefig(OUT/f'sheet-{page//3+1:02}.png',dpi=110);plt.close(fig)
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'questions':len(manifest),'sheets':13,'output':str(OUT)}))
