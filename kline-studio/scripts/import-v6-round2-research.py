"""Export frozen raw decisions for chart inspection; never manufacture trades."""
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r'D:\CodexData\v6-stage00-supervisor\round2')
OUT = ROOT / 'src/data/research-signal-layers'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    manifest_path = SOURCE / 'replay/manifest.json'
    manifest = read(manifest_path)
    audit_root = SOURCE / 'followup-v1/targeted-validation-v5-schemafix-recovery-v1'
    audits = {}
    for case in sorted((audit_root / 'cases').iterdir()):
        if not (case / 'result.json').exists():
            continue
        result = read(case / 'result.json')
        response = read(case / 'standard-worker-call/response.json')
        current = response['current_signal']
        extra = response.get('experimental_augmented') or {}
        errors = result.get('validation', {}).get('errors', [])
        note = ('本轮复核：技术校验通过，不代表语义正确。' if result['status'] == 'complete'
                else '本轮复核未通过：' + '、'.join(errors) + '。')
        note += f"原版复核状态 {current['state']} / {current['direction']}；补充判断 {extra.get('candidate_effect', '未提供')}。复核不是重算本次历史信号，补充判断没有完整交易方向。"
        if case.name == 'XAU-01-327':
            note += '专项问题：使用当前之后未出现的跟随支持抑制，不应据此证明当前信号无效。'
        if case.name in ('XAU-02-300', 'XAU-02-301', 'XAU-03-417'):
            note += '专项问题：引用较远历史结构，当前相关性尚未证明。'
        audits[case.name] = {'id': case.name, 'windowId': response['window'], 'idx': response['idx'],
                            'reviewNote': note, 'explanation': current.get('explanation', ''),
                            'resultSha256': sha(case / 'result.json')}
    windows = []
    for spec in manifest['data_manifest']['windows']:
        path = Path(spec['path'])
        assert sha(path) == spec['sha256'], f'Frozen input changed: {path}'
        data = read(path)
        assert data['symbol'] == 'OANDA:XAUUSD' and data['timeframe_minutes'] == 5
        bars = data['bars']
        assert all(bars[i]['time'] < bars[i + 1]['time'] for i in range(len(bars) - 1))
        windows.append({'id': spec['id'], 'startTime': bars[spec['start_idx']]['time'],
                        'endTime': bars[spec['end_idx_exclusive'] - 1]['time'],
                        'startIdx': spec['start_idx'], 'endIdxExclusive': spec['end_idx_exclusive'],
                        'sourceSha256': spec['sha256'], 'bars': bars})
    general = '历史原始信号展示，不是已成交订单。原版为冻结V6提示在隔离比较程序中的输出；补充版为实验候选规则输出。两版均未证明可用于生产升级；完整信号保留、不按盈亏筛选。本轮26点复核20项技术通过、6项未通过，技术通过不代表交易有效。'
    reports = []
    for arm, name, expected in [('baseline', 'V6原版 · 完整信号', 261), ('candidate', 'V6补充版 · 完整信号', 348)]:
        signals, ledger_hashes = [], {}
        for window in windows:
            path = SOURCE / f"replay/{window['id']}-{arm}/decisions.jsonl"
            ledger_hashes[window['id']] = sha(path)
            rows = [json.loads(line) for line in path.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
            assert [r['idx'] for r in rows] == list(range(window['startIdx'], window['endIdxExclusive']))
            for row in rows:
                d, idx = row['decision'], row['idx']
                assert row['manifest_sha256'] == sha(manifest_path)
                assert d['idx'] == idx and d['no_future_data'] and d['max_used_idx'] <= idx
                assert all(0 <= i <= idx for i in d['evidence_indices'])
                if d['action'] != 'SIGNAL':
                    continue
                assert d['direction'] in ('long', 'short')
                bar = window['bars'][idx]
                review = audits.get(f"{window['id']}-{idx}")
                signals.append({'id': f"v6-round2-{arm}-{window['id']}-{idx}", 'windowId': window['id'],
                                'idx': idx, 'time': bar['time'], 'side': d['direction'], 'price': bar['close'],
                                'beijingTime': bar.get('beijing_open_time', ''), 'reason': d['reason'],
                                'context': d['case_context'], 'evidenceIndices': d['evidence_indices'],
                                'reviewNote': review['reviewNote'] if review else '本信号不在本轮26点专项复核中，保留原始输出供人工查看。',
                                'recordSha256': hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                                'chainSha256': row['chain_hash'], 'pngSha256': row['png_sha256']})
        signals.sort(key=lambda s: (s['time'], s['windowId'], s['idx']))
        assert len(signals) == expected and len({s['id'] for s in signals}) == expected
        points = []
        for a in audits.values():
            w = next(w for w in windows if w['id'] == a['windowId'])
            points.append({**a, 'time': w['bars'][a['idx']]['time']})
        payload = {'schemaVersion': 1, 'sourceId': f'v6-round2-{arm}', 'name': name,
                   'symbol': 'XAUUSD', 'interval': '5m', 'reviewNote': general,
                   'signals': signals, 'windows': windows, 'auditPoints': points,
                   'provenance': {'manifestSha256': sha(manifest_path), 'ledgerHashes': ledger_hashes,
                                  'model': manifest['model'], 'effort': manifest['effort'],
                                  'serviceTier': manifest['service_tier'], 'arm': arm},
                   'summary': {'signals': len(signals), **dict(Counter(s['side'] for s in signals)),
                               'decisions': 720, 'windows': len(windows), 'reviewPoints': len(points)}}
        OUT.mkdir(parents=True, exist_ok=True)
        dest = OUT / f'round2-{arm}.json'
        dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        reports.append({'file': str(dest), 'sha256': sha(dest), **payload['summary']})
    print(json.dumps(reports, ensure_ascii=False))

if __name__ == '__main__':
    main()
