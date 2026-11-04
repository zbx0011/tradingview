"""Publish the manually inspected prefix review. Does not read forward outcomes."""
import json, hashlib, shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=Path('D:/codex/V6/research/shape-all-audit-20260909')
manifest=json.loads((OUT/'manifest.json').read_bytes())
# Boundaries below are retrospective explanations of an already visible prefix,
# never a replacement for original per-bar recognition timestamps.
matched={
'M02':([214,242,267,300],'K214—242上行推进较连续；随后两次更深回撤仍伴随抬高的高低点，K267后高点推进停止。'),
'M03':([190,211,252,300],'K190—211快速下跌；随后反弹高度降低、低点小幅续低，至K252以后横向交错。'),
'M05':([214,235,270,300],'K214—235下降较连续；反弹峰值约在K243、K260降低，低点继续下降但净推进变慢，K270后低位往返。'),
'M06':([186,213,264,300],'初段急跌延续至K213；后段反弹峰值降低且低点续低，净斜率明显减小；K264后以横向重叠为主。'),
'M14':([212,226,278,300],'保留你认可的样例。快速下跌后，K226—278反弹变深且高低点总体降低，K278后低位双向往返。'),
'M18':([221,245,265,300],'窄通道应覆盖K221起的完整连续上涨，不只截取末段。K245—265回撤变多且高低点继续抬高，之后顶部往返。'),
'M20':([227,240,282,300],'急跌后的反弹高点逐级降低，后续低点小幅推进；宽幅下降延续至K282附近，不能提前在K266把下降画成平台。'),
'M22':([203,212,261,300],'原K163—172急跌后出现更高反弹高点，不能与末段直接拼接。改核对后一次K203—212下跌及其后的降低高低点；K261后低位往返。'),
'M28':([221,241,277,300],'K221—241连续上涨；中段回撤加深但高低点仍抬升，K277后不再持续向上推进。'),
'M39':([191,206,268,300],'扩大窄通道起点至本次下降起步；中段反弹高点与低点总体降低、下降斜率减小，K268后横盘。'),
'M40':([222,235,256,300],'K222—235快速下降；后续更深反弹的峰值降低，低点小幅续低；K256后低位重叠，不以末端反弹盈利与否取舍。'),
'M45':([194,209,239,300],'K194—209为后一次完整快速下跌；K209—239反弹扩大、高低点降低且推进变慢，随后长时间往返。原K300只是历史候选定位，不能声称首次识别发生在K300。'),
'week2-628':([225,241,283,300],'原K470窄通道确认与K592宽通道确认之间夹着平台和新一轮下跌，不能用两点画阶段。当前前缀可见另一段完整过程：源K553—569较连续下跌，K569—611反弹变深、高低点总体降低、净推进减慢，K611—628低位重叠。原K628事件时间不移动。'),
}
issues={
'july-66':('nonmatch','K30/K32在顶部回落附近，之后K35—59仍发生强下跌并再次加速；K60起是跳空回升后的短暂重叠。不能把一轮更强下跌标成力量持续衰减的宽通道。撤回此前K48—59宽通道候选草图。'),
'july-121':('uncertain','K94—109下降后虽出现反弹和小回撤，宽通道是否形成独立、持续的减弱阶段不够清楚；K110后的回升与首次震荡的分界也不能从原状态标签确定。'),
'july-446':('uncertain','局部K243—259上涨后先深回撤再创新高，宽通道内连续抬高高低点的证据不足；不能将一次大回撤直接认定为完整宽通道。'),
'week2-69':('uncertain','K29—42下跌后反弹扩大，但K42长下影低点仍低于后续多个低点。若按实际高低点而非只看收盘，宽通道的持续降低低点依据有冲突；不强行画三阶段。'),
'week2-193':('nonmatch','K155—160快速上涨后直接进入重叠平台；没有清楚独立的宽通道逐渐减弱阶段，正是你排除的强势后直接横盘。'),
'week2-350':('nonmatch','当前前缀K261—267上行后直接在K268—300反复横盘；先前大段涨跌属于其他过程，不能拿来补齐宽通道。'),
'week2-855':('uncertain','局部K254—289下跌和宽幅往返可见，但范围中仍出现新一轮急跌；末段宽通道到无方向震荡的边界不唯一，不能用源K845单点冒充整个区间。'),
'week2-1310':('uncertain','当前前缀末段有降低高点和双向摆动，但原窄通道确认后的反弹重新抬高高点；无法唯一对应一条连续的窄—宽—震荡过程。'),
'M27':('nonmatch','急跌后K224附近深反弹、K230附近再探低、K240附近反弹；低点没有持续降低，更接近收敛/区间。橙色箭头略向下不构成宽下降通道依据。'),
'M30':('nonmatch','K254附近回抽后K269—277再次加速下跌；不能认定为持续减弱的宽通道，再接平台。'),
'M33':('uncertain','后段虽然下降变慢，但多个推进段仍较紧，独立的宽幅回撤阶段不够清楚。仅凭折线斜率变小不足以通过。'),
'M37':('uncertain','末次急跌后较快转为小幅低位交错；宽通道阶段与平台阶段边界不清，不能确定存在独立的中间阶段。'),
'M41':('uncertain','K196以后先出现较长横向重叠，K246附近再次加速下跌。若缩到最后一段，宽通道证据又不足；不能跨越平台拼接。'),
'M43':('nonmatch','K258附近急跌低点之后，反弹和再探低没有形成清楚的连续降低低点，更接近低位双向区间；短窄通道不能补足中间缺失阶段。'),
'M01':('nonmatch','末段上涨在K210附近重新加速后直接横盘，不能解释为一直逐渐减弱。保留原排除状态。'),
'M11':('nonmatch','信号前最后一段为反弹加速后小平台；更早下跌隔着低位往返与反弹，不能拼接。保留原排除状态。'),
'M15':('uncertain','反弹过程夹有大幅回撤及再次上冲，持续减弱解释不充分；保持原排除，不重新加回。'),
'M17':('uncertain','K242后回撤又在K258附近重新上冲，不能确定中段持续减弱；保持原排除。'),
'M24':('nonmatch','末段K250—269上行重新加速，然后直接回落与横盘，缺少独立的减弱宽通道。'),
'M25':('nonmatch','K250附近急拉后又在K277附近向上加速，随后平台；中段不是连续衰减。'),
'M29':('uncertain','中段夹长反弹及再次下降，单一连续衰减结构存在歧义；保持原排除。'),
'M31':('nonmatch','末段仍是大幅双向摆动，没有清楚独立的末尾无方向平台；不补画缺失阶段。'),
'M36':('nonmatch','K270附近上冲明显扩张，随后反向下跌；中段仍增强，不能当成渐弱。'),
'M38':('nonmatch','末段短跌后直接反弹平台；更早下降与当前之间有完整上行，不能跨趋势拼接。'),
'M48':('nonmatch','上行在K255—267明显加速，之后转为下降，缺少独立宽通道减弱阶段。'),
'M49':('nonmatch','保留你指出的反例：强势上行后直接顶部双向震荡，中间没有清楚独立的渐弱宽通道。'),
}
rows=[]
pivots={
 'week2-628':([252,259,267],[246,261,278]),'M02':([247,259,266],[251,255,260]),
 'M03':([227,244,249],[212,239,251]),'M05':([244,260,265],[235,252,267]),
 'M06':([218,250],[214,236,262]),'M14':([230,246,270],[226,254,277]),
 'M18':([248,258,264],[250,259]),'M20':([248,256,272],[240,263,267]),
 'M22':([219,236,254],[212,239,251]),'M28':([258,270,276],[249,264,273]),
 'M39':([212,241,254],[209,231,266]),'M40':([236,245],[235,241]),
 'M45':([210,220],[212,224,236]),
}
for m in manifest:
    id=m['id']; key=id
    if id.startswith('C-'): key=('week2-' if 'week2' in id else 'july-')+id.split('-')[-2]
    if key in matched:
        bounds,note=matched[key]; verdict='match'
        phases=[dict(kind=k,startIndex=bounds[i],endIndex=bounds[i+1]) for i,k in enumerate(['narrow','wide','range'])]
    else:
        verdict,note=issues[key];phases=[]
    bars=json.loads((OUT/(id+'-prefix.json')).read_bytes())
    evidence=[]
    if key in pivots:
        for kind,indexes in zip(['high','low'],pivots[key]):
            evidence.append(dict(kind=kind,points=[dict(index=i,sourceIndex=i+m['sourceOffset'],price=bars[i][kind]) for i in indexes]))
    rows.append(dict(**m,verdict=verdict,status='reviewed' if verdict=='match' else 'hidden',note=note,phases=phases,pivotEvidence=evidence,
      causalRecognitionVerified=False,reviewMethod='逐题查看截至原事件K的冻结OHLC前缀；区间是视觉复核边界，不是新的逐根识别记录'))
assert len(rows)==39
target=ROOT/'src/data/shape-annotation-reviews.json'
# Audit history stays separate from immutable source events and user answers.
shutil.copy2(target,OUT/'previous-annotation-reviews.json') if not (OUT/'previous-annotation-reviews.json').exists() else None
payload=dict(version=2,scope='39条存档：27条原公共题池，12条原已排除；未扫描未入库行情',futureBarsInspected=False,
   recognitionTimesChanged=False,statisticsFiltered=False,reviews=rows)
target.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({v:sum(r['verdict']==v for r in rows) for v in ['match','uncertain','nonmatch']}))
