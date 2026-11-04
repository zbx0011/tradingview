"""Publish every completed causal event, with review status kept separate from inclusion."""
import json, sys, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, 'D:/codex/V6/research/shape-run-monitor-20260909')
import monitor


def main():
    questions, sources = [], []
    for run in json.loads(monitor.REGISTRY.read_bytes()):
        r = Path(run['root'])
        receipt_path = r / ('first-week-completion-receipt.json' if 'causal-shape-june-' in r.name else 'completion_receipt.json')
        if not receipt_path.exists():
            continue
        receipt = json.loads(receipt_path.read_bytes())
        if receipt.get('status') != 'complete' or receipt.get('validation') != 'PASS':
            continue
        mod, identity, bars, rows, events, chain = monitor.load_checked(r, run['total'])
        assert len(rows) == run['total'], 'incomplete run'
        source = dict(id=r.name, label=run['label'], **identity, decisions=len(rows), eventCount=len(events), lastRecordSha256=chain)
        detections={}
        if (r/'review-policy.json').exists():
            if (r/'resilience-policy.json').exists():
                from resilient_observer import summarize
                review_summary=summarize(r,rows,bars)
                source['conflictCount']=review_summary['conflict_count']
                source['unconfirmedConflictCount']=review_summary['unconfirmed_conflict_count']
            else:
                from causal_review import verify_committed
                review_summary=verify_committed(r,rows,bars)
            detections={(item['event']['index'],item['event']['side']):item for item in review_summary['events']}
            source['reviewProtocol']=review_summary['protocol']
            source['reviewActivationIndex']=review_summary['activation_index']
        sources.append(source)
        ema = []
        for bar in bars[:run['total']]:
            ema.append(bar['close'] if not ema else bar['close'] * 2 / 21 + ema[-1] * 19 / 21)
        for event in events:
            i = event['index']
            assert rows[i]['observation'][event['side']]['phase'] == 'range'
            assert rows[i-1]['observation'][event['side']]['phase'] == 'wide'
            # Preserve all events, with up to 96 subsequent bars for manual practice.
            # Record the actual causal phase-confirmation bars, not invented visual boundaries.
            wide = i-1
            while wide > 0 and rows[wide-1]['observation'][event['side']]['phase'] == 'wide':
                wide -= 1
            narrow = wide-1
            assert rows[narrow]['observation'][event['side']]['phase'] == 'narrow'
            while narrow > 0 and rows[narrow-1]['observation'][event['side']]['phase'] == 'narrow':
                narrow -= 1
            lo, hi = min(max(0, i-300), narrow), min(run['total'], i+97)
            confirmations = [dict(kind=kind, startIndex=j-lo, endIndex=j-lo) for kind,j in [('narrow',narrow),('wide',wide),('range',i)]]
            detection=detections.get((i,event['side']),{'review_status':'legacy_not_reviewed_at_detection'})
            review=detection.get('review')
            detection_review=dict(status=detection['review_status'],reason=(str(review.get('reason',''))+' '+str(detection.get('review_validation_error') or '')) if isinstance(review,dict) else '旧事件在首次识别时没有即时复核；不按事后判断移除。',
                phases=[dict(kind=p['kind'],startIndex=p['start_index']-lo,endIndex=p['end_index']-lo) for p in review['phases']] if review and detection['review_status']=='pass' else [],
                receipt=detection.get('review_receipt'),protocol=source.get('reviewProtocol'))
            questions.append(dict(id=f"C-{r.name}-{i}-{event['side']}", sourceId=r.name,
                startIndex=i-lo, signalTime=event['time'], bars=bars[lo:hi], ema20=ema[lo:hi],
                side='long' if event['side']=='bear' else 'short', originalTrend=event['side'],
                sourceIndex=i, recordSha256=rows[i]['record_sha256'], reason=event['reason'], phaseConfirmations=confirmations,
                detectionReview=detection_review,
                sourceLabel=f"{run['label']} · 逐根PNG · 完整校验PASS", futureBarsAvailable=hi-i-1))
    assert questions, 'no completed verified events'
    assert len({q['id'] for q in questions}) == len(questions)
    # These are provenance points ONLY. They must never be rendered as phase intervals.
    # All original events remain eligible regardless of later visual review verdict.
    for q in questions:
        phases = q['phaseConfirmations']
        assert [p['kind'] for p in phases] == ['narrow', 'wide', 'range'], 'missing phase annotations'
        indexes = [p['startIndex'] for p in phases]
        assert 0 <= indexes[0] < indexes[1] < indexes[2] == q['startIndex'], 'invalid confirmation sequence'
        assert all(p['startIndex'] == p['endIndex'] for p in phases), 'confirmation arrows must point to recorded candles'
    payload = dict(version=1, id='causal-range-confirmations-v1', symbol='OANDA:XAUUSD', timeframeMinutes=5,
                   sources=sources, questions=questions)
    target = ROOT/'public/data/shape-practice/causal-range-confirmations.json'
    data = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
    target.write_bytes(data)
    reviews=json.loads((ROOT/'src/data/shape-annotation-reviews.json').read_bytes())['reviews']
    approved={r['id'] for r in reviews if r.get('verdict')=='match' and len(r.get('phases',[]))==3}
    print(json.dumps(dict(archivedEvents=len(questions),practiceEligible=len(questions),practiceReviewed=sum(q['id'] in approved for q in questions),
        pendingVisualReview=sum(q['id'] not in approved for q in questions),sources=len(sources),sha256=hashlib.sha256(data).hexdigest(),path=str(target))))


if __name__ == '__main__':
    main()
