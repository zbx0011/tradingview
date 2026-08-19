from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


OUTPUT_ROOT = Path(r"C:\Users\diffzhou\Documents\tradingview-checkpoint-20260809\outputs")
REPORT_ROOT = Path(r"C:\Users\diffzhou\Documents\tradingview-checkpoint-20260809\reports")
REPLAY_ROOTS = [
    OUTPUT_ROOT / "v4_v5_structural_trailing_recalculation_20260816",
    OUTPUT_ROOT / "v4_v5_structural_trailing_recalculation_fast_20260816",
]

BYBIT_MAKER = 0.0002
BYBIT_TAKER = 0.00055
IC_RAW_ROUND_TURN_USD_PER_LOT = 7.0
IC_CONTRACT_SIZE = {"OANDA:XAUUSD": 100.0, "OANDA:XAGUSD": 1000.0}
TICK_SIZE = {
    "BYBIT:BTCUSDT.P": 0.1,
    "OANDA:XAUUSD": 0.01,
    "OANDA:XAGUSD": 0.001,
    "ICMARKETS:US500": 0.01,
}


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def date_label(value: str) -> str:
    return f"{value[:4]}-{value[4:6]}-{value[6:8]}"


def parse_window(name: str) -> str:
    full = re.search(r"(20\d{6})-(20\d{6})", name)
    if full:
        label = f"{date_label(full.group(1))}~{date_label(full.group(2))}"
    else:
        short = re.search(r"(20\d{6})-(\d{2})(?!\d)", name)
        if short:
            label = f"{date_label(short.group(1))}~{date_label(short.group(1)[:6] + short.group(2))}"
        else:
            label = "unknown"
    if "append" in name.lower():
        label += " append"
    return label


def system_from_rule(rule_id: str) -> str:
    return "V5" if "_v5_" in rule_id or rule_id.endswith("_v5_20260816") else "V4"


def mode_from_path(path: Path) -> str:
    text = str(path).lower()
    return "快速" if "_fast" in text or "luna-max-fast" in text or "luna_max_fast" in text else "普通"


def number(value, default=0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def trade_pnl(trade: dict) -> float:
    fixed = trade.get("fixed_risk_usd") or trade.get("fixed_risk_sizing") or {}
    return number(fixed.get("pnl_usd"))


def round_trip_notional(trade: dict) -> float:
    units = abs(number(trade.get("normalized_position_units")))
    entry = abs(number(trade.get("entry_price")))
    exit_price = abs(number(trade.get("exit_price")))
    return units * (entry + exit_price)


def units(trade: dict) -> float:
    return abs(number(trade.get("normalized_position_units")))


def cost_metrics(trades: list[dict], fee_fn, slip_tick: float | None = None) -> dict:
    values = cost_values(trades, fee_fn, slip_tick)
    total_fee = 0.0
    total_slippage = 0.0
    for trade in trades:
        fee = fee_fn(trade)
        slip = 0.0 if slip_tick is None else units(trade) * slip_tick * 2.0
        total_fee += fee
        total_slippage += slip

    equity = 0.0
    peak = 0.0
    max_dd = 0.0
    for pnl in values:
        equity += pnl
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
    gross_profit = sum(pnl for pnl in values if pnl > 0)
    gross_loss = sum(pnl for pnl in values if pnl < 0)
    wins = sum(1 for pnl in values if pnl > 0)
    return {
        "net_pnl_usd": round(sum(values), 6),
        "trade_count": len(values),
        "win_rate_percent": round(100.0 * wins / len(values), 6) if values else 0.0,
        "profit_factor": round(gross_profit / abs(gross_loss), 6) if gross_loss else None,
        "max_drawdown_usd": round(max_dd, 6),
        "average_pnl_usd": round(sum(values) / len(values), 6) if values else 0.0,
        "fee_usd": round(total_fee, 6),
        "slippage_usd": round(total_slippage, 6),
    }


def cost_values(trades: list[dict], fee_fn, slip_tick: float | None = None) -> list[float]:
    values = []
    for trade in trades:
        fee = fee_fn(trade)
        slip = 0.0 if slip_tick is None else units(trade) * slip_tick * 2.0
        values.append(trade_pnl(trade) - fee - slip)
    return values


def scenario_definitions(symbol: str):
    tick = TICK_SIZE[symbol]
    if symbol == "BYBIT:BTCUSDT.P":
        return {
            "maker_fee_only": ("Bybit VIP0 Maker", lambda t: round_trip_notional(t) * BYBIT_MAKER, None),
            "taker_fee_only": ("Bybit VIP0 Taker", lambda t: round_trip_notional(t) * BYBIT_TAKER, None),
            "maker_plus_1tick": ("Bybit VIP0 Maker + 1 tick/side", lambda t: round_trip_notional(t) * BYBIT_MAKER, tick),
            "taker_plus_1tick": ("Bybit VIP0 Taker + 1 tick/side", lambda t: round_trip_notional(t) * BYBIT_TAKER, tick),
        }

    def standard_fee(_trade):
        return 0.0

    def raw_fee(trade):
        if symbol in IC_CONTRACT_SIZE:
            return units(trade) / IC_CONTRACT_SIZE[symbol] * IC_RAW_ROUND_TURN_USD_PER_LOT
        return 0.0

    return {
        "ic_standard_commission_only": ("IC Standard commission only", standard_fee, None),
        "ic_raw_commission_only": ("IC Raw commission only", raw_fee, None),
        "ic_standard_plus_1tick": ("IC Standard + 1 tick/side", standard_fee, tick),
        "ic_raw_plus_1tick": ("IC Raw + 1 tick/side", raw_fee, tick),
    }


def make_batch(backtest_path: Path, metadata_path: Path, root: Path) -> dict:
    backtest = load_json(backtest_path)
    metadata = load_json(metadata_path)
    scenario = backtest["scenarios"]["conservative_stop_first"]
    trades = scenario.get("trades", [])
    symbol = backtest["symbol"]
    rule_id = metadata.get("rule_set_id", "")
    name = backtest_path.parent.name
    parent_name = Path(metadata.get("parent_output", name)).name
    gross = cost_metrics(trades, lambda _t: 0.0)
    scenarios = {}
    trade_values = {"gross": cost_values(trades, lambda _t: 0.0)}
    for key, (label, fee_fn, slip_tick) in scenario_definitions(symbol).items():
        metrics = cost_metrics(trades, fee_fn, slip_tick)
        metrics["label"] = label
        scenarios[key] = metrics
        trade_values[key] = cost_values(trades, fee_fn, slip_tick)
    return {
        "batch": name,
        "parent_batch": parent_name,
        "symbol": symbol,
        "timeframe_minutes": int(number(backtest.get("timeframe_minutes"))),
        "window": parse_window(parent_name),
        "system": system_from_rule(rule_id),
        "mode": mode_from_path(root),
        "recalculation_mode": metadata.get("mode"),
        "rule_set_id": rule_id,
        "rule_set_sha256": metadata.get("rule_set_sha256"),
        "source_data_sha256": backtest.get("source_data_sha256") or metadata.get("source_data_sha256"),
        "gross": gross,
        "scenarios": scenarios,
        "source_path": str(backtest_path.parent),
        "_trade_values": trade_values,
    }


def aggregate(rows: list[dict]) -> list[dict]:
    groups = defaultdict(list)
    for row in rows:
        groups[(row["symbol"], row["timeframe_minutes"], row["system"], row["mode"])].append(row)
    out = []
    scenario_keys = sorted({key for row in rows for key in row["scenarios"]})
    for (symbol, tf, system, mode), items in sorted(groups.items()):
        def sum_metrics(key: str | None):
            values = []
            fee = slip = 0.0
            for item in items:
                metric = item["gross"] if key is None else item["scenarios"].get(key)
                if metric:
                    values.extend(item["_trade_values"].get("gross" if key is None else key, []))
                    fee += metric.get("fee_usd", 0.0)
                    slip += metric.get("slippage_usd", 0.0)
            equity = peak = dd = 0.0
            for value in values:
                equity += value
                peak = max(peak, equity)
                dd = max(dd, peak - equity)
            positives = sum(v for v in values if v > 0)
            negatives = sum(v for v in values if v < 0)
            return {
                "net_pnl_usd": round(sum(values), 6),
                "trade_count": len(values),
                "win_rate_percent": round(100.0 * sum(1 for v in values if v > 0) / len(values), 6) if values else 0.0,
                "profit_factor": round(positives / abs(negatives), 6) if negatives else None,
                "max_drawdown_usd": round(dd, 6),
                "average_pnl_usd": round(sum(values) / len(values), 6) if values else 0.0,
                "fee_usd": round(fee, 6),
                "slippage_usd": round(slip, 6),
            }

        row = {
            "symbol": symbol,
            "timeframe_minutes": tf,
            "system": system,
            "mode": mode,
            "batch_count": len(items),
            "gross": sum_metrics(None),
            "scenarios": {key: sum_metrics(key) for key in scenario_keys if any(key in item["scenarios"] for item in items)},
        }
        out.append(row)

    def overall_row(items: list[dict], label: str):
        fake = defaultdict(list)
        for item in items:
            fake["all"].append(item)
        group_items = fake["all"]
        def sum_metrics(key: str | None):
            values = []
            fee = slip = 0.0
            for item in group_items:
                metric = item["gross"] if key is None else item["scenarios"].get(key)
                if metric:
                    values.extend(item["_trade_values"].get("gross" if key is None else key, []))
                    fee += metric.get("fee_usd", 0.0)
                    slip += metric.get("slippage_usd", 0.0)
            equity = peak = dd = 0.0
            for value in values:
                equity += value
                peak = max(peak, equity)
                dd = max(dd, peak - equity)
            positives = sum(v for v in values if v > 0)
            negatives = sum(v for v in values if v < 0)
            trades = len(values)
            return {
                "net_pnl_usd": round(sum(values), 6),
                "trade_count": trades,
                "win_rate_percent": round(100.0 * sum(1 for v in values if v > 0) / len(values), 6) if values else 0.0,
                "profit_factor": round(positives / abs(negatives), 6) if negatives else None,
                "max_drawdown_usd": round(dd, 6),
                "average_pnl_usd": round(sum(values) / len(values), 6) if values else 0.0,
                "fee_usd": round(fee, 6),
                "slippage_usd": round(slip, 6),
            }
        scenario_keys = sorted({key for item in group_items for key in item["scenarios"]})
        return {
            "symbol": label,
            "timeframe_minutes": None,
            "system": "all",
            "mode": "all",
            "batch_count": len(group_items),
            "gross": sum_metrics(None),
            "scenarios": {key: sum_metrics(key) for key in scenario_keys},
        }

    out.append(overall_row(rows, "ALL"))
    for system in ("V4", "V5"):
        subset = [row for row in rows if row["system"] == system]
        if subset:
            out.append(overall_row(subset, system))
    return out


def money(value):
    if value is None:
        return "—"
    sign = "+" if value >= 0 else ""
    return f"{sign}${value:,.2f}"


def pct(value):
    return f"{value:.2f}%"


def pf(value):
    return "—" if value is None else f"{value:.3f}"


def main():
    rows = []
    excluded = []
    for root in REPLAY_ROOTS:
        if not root.exists():
            excluded.append({"path": str(root), "reason": "root_missing"})
            continue
        for backtest_path in sorted(root.rglob("backtest.json")):
            metadata_path = backtest_path.with_name("recalculation_metadata.json")
            if not metadata_path.exists():
                excluded.append({"path": str(backtest_path), "reason": "metadata_missing"})
                continue
            try:
                metadata = load_json(metadata_path)
                if metadata.get("status") != "valid" or metadata.get("parent_validation_valid") is False:
                    excluded.append({"path": str(backtest_path), "reason": "metadata_not_valid"})
                    continue
                row = make_batch(backtest_path, metadata_path, root)
                if row["system"] not in {"V4", "V5"}:
                    excluded.append({"path": str(backtest_path), "reason": "unknown_rule_set"})
                    continue
                rows.append(row)
            except Exception as exc:  # keep report generation auditable
                excluded.append({"path": str(backtest_path), "reason": f"read_error:{exc}"})

    rows.sort(key=lambda row: (row["symbol"], row["timeframe_minutes"], row["window"], row["system"], row["mode"], row["batch"]))
    aggregates = aggregate(rows)
    platform_aggregates = []
    for symbol in sorted({row["symbol"] for row in rows}):
        subset = [row for row in rows if row["symbol"] == symbol]
        platform_aggregates.append({
            "symbol": symbol,
            "batch_count": len(subset),
            "gross": {
                "net_pnl_usd": round(sum(row["gross"]["net_pnl_usd"] for row in subset), 6),
                "trade_count": sum(row["gross"]["trade_count"] for row in subset),
            },
            "scenarios": {},
        })
        current = platform_aggregates[-1]
        scenario_keys = sorted({key for row in subset for key in row["scenarios"]})
        for key in scenario_keys:
            values = []
            fee = slip = 0.0
            for row in subset:
                metric = row["scenarios"].get(key)
                if metric:
                    values.extend(row["_trade_values"].get(key, []))
                    fee += metric.get("fee_usd", 0.0)
                    slip += metric.get("slippage_usd", 0.0)
            equity = peak = dd = 0.0
            for value in values:
                equity += value
                peak = max(peak, equity)
                dd = max(dd, peak - equity)
            positives = sum(value for value in values if value > 0)
            negatives = sum(value for value in values if value < 0)
            current["scenarios"][key] = {
                "net_pnl_usd": round(sum(values), 6),
                "trade_count": len(values),
                "win_rate_percent": round(100.0 * sum(1 for value in values if value > 0) / len(values), 6) if values else 0.0,
                "profit_factor": round(positives / abs(negatives), 6) if negatives else None,
                "max_drawdown_usd": round(dd, 6),
                "average_pnl_usd": round(sum(values) / len(values), 6) if values else 0.0,
                "fee_usd": round(fee, 6),
                "slippage_usd": round(slip, 6),
            }
    assumptions = {
        "scope": "当前 structural-trailing V4/V5 exit-only recalculation outputs only; historical rule identities excluded",
        "primary_scenario": "conservative_stop_first",
        "bybit": {
            "maker_rate": BYBIT_MAKER,
            "taker_rate": BYBIT_TAKER,
            "funding_fee": "excluded; no historical funding ledger in replay artifacts",
            "usdt_usd": "treated as 1:1 for reporting",
        },
        "ic_markets": {
            "account_identified_from_image": "ICMarketsSC-MT5 server; Standard vs Raw account not visible",
            "standard_commission": 0.0,
            "raw_metals_round_turn_usd_per_standard_lot": IC_RAW_ROUND_TURN_USD_PER_LOT,
            "contract_sizes_oz": {"XAUUSD": 100, "XAGUSD": 1000},
            "us500_commission": 0.0,
            "floating_spread": "excluded; screenshot and replay artifacts do not contain historical bid/ask per fill",
        },
        "slippage": {
            "definition": "one adverse minimum price increment at entry plus one at exit",
            "tick_size_assumptions": TICK_SIZE,
            "note": "tick assumptions are sensitivity inputs, not reconstructed historical fills",
        },
        "official_references": {
            "bybit_fee_table": "https://www.bybit.com/en/help-center/article/?id=000001634&language=en_US",
            "bybit_order_cost": "https://www.bybit.com/en/help-center/article/Order-Cost-USDT-Contract",
            "icmarkets_help_centre": "https://www.icmarkets.com/global/jp/help-resources/help-centre",
            "icmarkets_spreads": "https://www.icmarkets.com/global/en/trading-pricing/spreads",
        },
    }
    public_rows = []
    for row in rows:
        public = {key: value for key, value in row.items() if key != "_trade_values"}
        public_rows.append(public)
    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "scope": assumptions["scope"],
        "assumptions": assumptions,
        "included_count": len(rows),
        "excluded_count": len(excluded),
        "excluded": excluded,
        "batches": public_rows,
        "aggregates": aggregates,
        "platform_aggregates": platform_aggregates,
    }
    REPORT_ROOT.mkdir(parents=True, exist_ok=True)
    json_path = REPORT_ROOT / "cost_adjusted_structural_v4_v5_20260817.json"
    md_path = REPORT_ROOT / "cost_adjusted_structural_v4_v5_20260817.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = [
        "# Structural V4/V5 成本与滑点敏感性汇总",
        "",
        f"生成时间（UTC）：{report['generated_at_utc']}",
        f"纳入：{len(rows)} 个有效回放批次；排除：{len(excluded)} 个。主场景：`conservative_stop_first`。",
        "",
        "## 口径",
        "",
        "- 现有 `backtest.json` 的结果是毛收益：未扣点差、佣金、滑点和资金费。",
        "- BTCUSDT.P：分别按 Bybit VIP0 Maker 0.02% 和 Taker 0.055% 计算进出场手续费；另提供各自加 1 个最小跳动/边的敏感性。",
        "- XAUUSD/XAGUSD/US500：按 IC Markets Standard（佣金 0）和 Raw（贵金属每标准手往返 7 美元；XAU 100 oz/手、XAG 1000 oz/手）分别计算；另提供各自加 1 个最小跳动/边的敏感性。",
        "- IC Markets 的历史逐笔浮动点差、BTC 资金费及真实成交滑点没有在回放文件中记录，因此没有冒充精确净收益；IC 部分应视为“佣金 + 滑点敏感性”，未含浮动点差。",
        "- 1 tick/side 的敏感性输入：BTC 0.1、XAU 0.01、XAG 0.001、US500 0.01。",
        "",
        "## 总体结果（全部 43 批次）",
        "",
        "|范围|批次|交易数|毛收益|Maker/IC Standard 佣金后|Taker/IC Raw 佣金后|Maker/IC Standard + 1 tick/边|Taker/IC Raw + 1 tick/边|",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    overall = next(item for item in aggregates if item["symbol"] == "ALL")
    def agg_value(agg, *keys):
        cur = agg
        for key in keys:
            cur = cur.get(key) if isinstance(cur, dict) else None
        return cur
    # For the mixed-symbol ALL row, show the corresponding cost family totals separately below.
    lines.append(
        f"|全部|{overall['batch_count']}|{overall['gross']['trade_count']}|{money(overall['gross']['net_pnl_usd'])}|—|—|—|—|"
    )
    lines += [
        "",
        "总体混合了不同平台费率，不能把 Maker 与 IC Standard 直接相加成一个实际账户结果；下面按标的列出对应情景。",
        "",
        "## 按标的 / 周期 / 系统 / 速度",
        "",
        "|标的|周期|系统|速度|批次|交易数|毛收益|适用成本后收益|胜率|利润因子|最大回撤|",
        "|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in aggregates:
        if item["symbol"] in {"ALL", "V4", "V5"}:
            continue
        symbol = item["symbol"].replace("BYBIT:", "").replace("OANDA:", "").replace("ICMARKETS:", "")
        if item["symbol"] == "BYBIT:BTCUSDT.P":
            key = "taker_plus_1tick"
            label = "Taker + 1 tick/边"
        elif item["symbol"] == "ICMARKETS:US500":
            key = "ic_standard_plus_1tick"
            label = "Standard + 1 tick/边"
        else:
            key = "ic_raw_plus_1tick"
            label = "Raw + 1 tick/边"
        metric = item["scenarios"].get(key)
        lines.append(
            f"|{symbol}|{item['timeframe_minutes']}m|{item['system']}|{item['mode']}|{item['batch_count']}|{item['gross']['trade_count']}|{money(item['gross']['net_pnl_usd'])}|{money(metric['net_pnl_usd'])} ({label})|{pct(metric['win_rate_percent'])}|{pf(metric['profit_factor'])}|{money(metric['max_drawdown_usd'])}|"
        )
    lines += [
        "",
        "## 逐批次结果",
        "",
        "|标的|窗口|周期|系统|速度|交易数|毛收益|Maker/标准佣金后|Taker/Raw佣金后|Maker/标准+1tick|Taker/Raw+1tick|",
        "|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        if row["symbol"] == "BYBIT:BTCUSDT.P":
            keys = ("maker_fee_only", "taker_fee_only", "maker_plus_1tick", "taker_plus_1tick")
        elif row["symbol"] == "ICMARKETS:US500":
            keys = ("ic_standard_commission_only", "ic_standard_commission_only", "ic_standard_plus_1tick", "ic_standard_plus_1tick")
        else:
            keys = ("ic_standard_commission_only", "ic_raw_commission_only", "ic_standard_plus_1tick", "ic_raw_plus_1tick")
        metrics = [row["scenarios"].get(key) for key in keys]
        lines.append(
            f"|{row['symbol'].replace('BYBIT:','').replace('OANDA:','').replace('ICMARKETS:','')}|{row['window']}|{row['timeframe_minutes']}m|{row['system']}|{row['mode']}|{row['gross']['trade_count']}|{money(row['gross']['net_pnl_usd'])}|{money(metrics[0]['net_pnl_usd'])}|{money(metrics[1]['net_pnl_usd'])}|{money(metrics[2]['net_pnl_usd'])}|{money(metrics[3]['net_pnl_usd'])}|"
        )
    lines += [
        "",
        "## 数据可追溯性",
        "",
        "每批次 JSON 保留了 source_data_sha256、rule_set_id、rule_set_sha256 和源 backtest 路径；本报告只读计算，不改写原始回放。",
        "",
        "官方费率参考：",
        "- [Bybit 费率表](https://www.bybit.com/en/help-center/article/?id=000001634&language=en_US)",
        "- [Bybit USDT 合约订单成本公式](https://www.bybit.com/en/help-center/article/Order-Cost-USDT-Contract)",
        "- [IC Markets Help Centre](https://www.icmarkets.com/global/jp/help-resources/help-centre)",
        "- [IC Markets Spreads](https://www.icmarkets.com/global/en/trading-pricing/spreads)",
        "",
        "> 这是一份历史回放的成本敏感性研究，不是实盘收益保证。若要得到 IC Markets 的真正净收益，需要补充 MT5 账户类型（Standard/Raw）、三个品种在对应时段的逐笔 Bid/Ask 或点差，以及 BTC 的实际 VIP 费率和资金费记录。",
    ]
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"included": len(rows), "excluded": len(excluded), "json": str(json_path), "markdown": str(md_path)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
