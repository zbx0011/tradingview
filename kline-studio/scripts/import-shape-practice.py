"""Import the selected 22 research cases as isolated practice data, without answers."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r'D:\codex\V6\research\xauusd-5m-structure-search-20260908-jun')
EXPECTED = '7782f611e355207c378cd77e5eb8aeecf0157f75ae4093676aa1b392b30e117e'


def main():
    raise RuntimeError("Legacy candidate import disabled: no sequential range-confirmation evidence; candidate timestamp is not a verified signal.")
    raw = (SOURCE / 'xauusd-5m-merged.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == EXPECTED, 'Research source hash mismatch'
    data = json.loads(raw)
    manifest = json.loads((SOURCE / 'search/candidate-manifest.json').read_text(encoding='utf-8'))
    review_raw = (SOURCE / 'search/luna-review/review.json').read_bytes()
    reviews = json.loads(review_raw)
    strong = {r['id'] for r in reviews['reviews'] if r['verdict'] == 'strong'}
    assert len(strong) == 22
    assert data['symbol'] == 'OANDA:XAUUSD' and data['resolution'] == '5'
    assert manifest['input_sha256'] == EXPECTED
    bars = data['bars']
    times = [b['time'] for b in bars]
    assert all(a < b for a, b in zip(times, times[1:]))
    indexes = {b['time']: i for i, b in enumerate(bars)}
    ema = []
    for bar in bars:
        ema.append(bar['close'] if not ema else bar['close'] * (2 / 21) + ema[-1] * (19 / 21))
    questions = []
    for c in manifest['candidates']:
        if c['id'] not in strong:
            continue
        i = indexes[c['time']]
        assert i == c['index']
        lo, hi = max(0, i - 300), min(len(bars), i + 97)
        assert hi - i > 48
        questions.append(dict(id=c['id'], startIndex=i-lo, signalTime=c['time'],
                              bars=bars[lo:hi], ema20=ema[lo:hi]))
    payload = dict(version=1, id='xauusd-5m-strong22-20260908', symbol='OANDA:XAUUSD',
                   timeframeMinutes=5, sourceSha256=EXPECTED,
                   reviewSha256=hashlib.sha256(review_raw).hexdigest(), questions=questions)
    target = ROOT / 'public/data/shape-practice/xauusd-5m-strong22.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(json.dumps(dict(questions=len(questions), ids=[q['id'] for q in questions],
                         path=str(target), sha256=hashlib.sha256(target.read_bytes()).hexdigest())))


if __name__ == '__main__':
    main()
