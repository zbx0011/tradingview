"""Production feed: review every closed 5-minute bar with the source rules.

No ATR, percentage, candle-position, score, or cooldown hard gate is allowed
here.  This module only creates review work; it never creates a signal.
"""
from __future__ import annotations
import argparse, json, sqlite3, tempfile
from pathlib import Path
from typing import Any
from kline_store import DEFAULT_DB, ema

WATCHLIST = (("BYBIT","BTCUSDT.P"),("OANDA","XAGUSD"),("OANDA","XAUUSD"),("ICMARKETS","US500"))
TIMEFRAME = "5"
MEMORY_VERSION = 8

def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=path.parent) as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
        temporary = Path(handle.name)
    temporary.replace(path)

def load_memory(path: Path) -> dict[str, Any]:
    empty = {"version": MEMORY_VERSION, "emissions": {}}
    if not path.exists(): return empty
    try: payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError): return empty
    if payload.get("version") != MEMORY_VERSION: return empty
    payload.setdefault("emissions", {})
    return payload

def load_ranges(conn: sqlite3.Connection, vendor: str, symbol: str, bar_time: int) -> list[dict[str, Any]]:
    try:
        rows = conn.execute("""SELECT entity_id,start_time,end_time,upper,lower,source,locked,status,created_at,updated_at
          FROM chart_ranges WHERE vendor=? AND symbol=? AND timeframe='5' AND status='active'
          AND start_time<=? AND end_time>=? ORDER BY locked DESC,source='manual' DESC,start_time""",
          (vendor,symbol,bar_time,bar_time)).fetchall()
    except sqlite3.OperationalError: return []
    return [dict(row) for row in rows]

def authoritative_range(ranges: list[dict[str, Any]], bar_time: int) -> dict[str, Any]:
    eligible=[]
    for item in ranges:
        try: start,end,upper,lower=int(item["start_time"]),int(item["end_time"]),float(item["upper"]),float(item["lower"])
        except (KeyError,TypeError,ValueError): continue
        if upper>lower and start<=bar_time<=end: eligible.append(dict(item))
    if not eligible: return {"valid":False,"chart_override":False,"reason":"no_authoritative_visible_chart_range","inferred_candidate":None}
    eligible.sort(key=lambda x:(bool(x.get("locked")),str(x.get("source","")).lower()=="manual",int(x.get("start_time",0))),reverse=True)
    x=eligible[0]
    return {"valid":True,"chart_override":True,"reason":"authoritative_visible_chart_range","entity_id":x.get("entity_id"),"source":x.get("source"),"locked":bool(x.get("locked")),"start_time":int(x["start_time"]),"end_time":int(x["end_time"]),"upper":float(x["upper"]),"lower":float(x["lower"])}

def range_position(row: sqlite3.Row, validation: dict[str, Any]) -> dict[str, Any]:
    if not validation.get("valid"): return {"valid":False,"valid_directions":[],"reason":"no_authoritative_visible_chart_range"}
    upper,lower=float(validation["upper"]),float(validation["lower"]); width=upper-lower
    lower_third,upper_third=lower+width/3,upper-width/3
    low,high,close=float(row["low"]),float(row["high"]),float(row["close"]); directions=[]
    if low<=lower and lower<=close<=lower_third: directions.append("long")
    if high>=upper and upper_third<=close<=upper: directions.append("short")
    return {"valid":bool(directions),"valid_directions":directions,"reason":"approved_outer_third_edge_reclaim" if directions else "not_an_outer_third_edge_reclaim","lower":lower,"upper":upper,"lower_third_top":lower_third,"upper_third_bottom":upper_third,"bar_low":low,"bar_high":high,"bar_close":close}

def recent_signals(conn: sqlite3.Connection,vendor: str,symbol: str,bar_time: int) -> list[dict[str, Any]]:
    rows=conn.execute("""SELECT id,bar_time,signal_price,direction,setup_type,grade,reasons_json,context_json,created_at
      FROM signals WHERE vendor=? AND symbol=? AND timeframe='5' AND bar_time<?
      AND setup_type NOT IN ('震荡下八分之一触碰','震荡上八分之一触碰') ORDER BY bar_time DESC,id DESC LIMIT 3""",(vendor,symbol,bar_time)).fetchall()
    output=[]
    for row in rows:
        try: reasons=json.loads(row["reasons_json"] or "[]"); context=json.loads(row["context_json"] or "{}")
        except json.JSONDecodeError: reasons,context=[],{}
        output.append({"id":int(row["id"]),"bar_time":int(row["bar_time"]),"signal_price":float(row["signal_price"]),"direction":str(row["direction"]),"setup_type":str(row["setup_type"]),"grade":str(row["grade"]),"reasons":reasons,"confirmation_price":context.get("confirmation_price"),"invalidation_price":context.get("invalidation_price"),"created_at":row["created_at"]})
    return output

def build_candidate(rows: list[sqlite3.Row],vendor: str,symbol: str,ranges: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not rows: return None
    current=rows[-1]; closes=[float(row["close"]) for row in rows]; validation=authoritative_range(ranges,int(current["open_time"])); reversal=range_position(current,validation)
    return {"vendor":vendor,"symbol":symbol,"timeframe":"5","bar_time":int(current["open_time"]),"close":float(current["close"]),"ema20":round(float(ema(closes,20)[-1]),8),"ema50":round(float(ema(closes,50)[-1]),8),"direction_hint":"neutral","setup_hint":"apply_complete_authorized_source_rules","reason":"closed_bar_full_rules_review","reason_codes":["closed_bar_full_rules_review"],"reason_families":["full_rules_review"],"candidate_score":0,"candidate_score_usage":"disabled_not_a_signal_gate","candidate_lifecycle":"closed_bar","hypotheses":[],"wide_channel_validation":{"valid":None,"reason":"visual_original_rule_review_only"},"narrow_channel_validation":{"valid":None,"valid_directions":[],"reason":"visual_original_rule_review_only"},"narrow_pullback_validation":{"valid":None,"valid_directions":[],"reason":"visual_original_rule_review_only"},"range_validation":validation,"range_reversal_validation":reversal,"chart_ranges":ranges,"active_memories":[],"needs_sol":True,"recent_ohlc":[[int(r["open_time"]),float(r["open"]),float(r["high"]),float(r["low"]),float(r["close"]),None if r["volume"] is None else float(r["volume"])] for r in rows[-120:]]}

def main() -> int:
    parser=argparse.ArgumentParser(); parser.add_argument("--db",type=Path,default=DEFAULT_DB); parser.add_argument("--output",type=Path,default=DEFAULT_DB.parent/"candidate_queue.json"); parser.add_argument("--memory",type=Path,default=DEFAULT_DB.parent/"candidate_memory.json"); args=parser.parse_args()
    conn=sqlite3.connect(args.db); conn.row_factory=sqlite3.Row; memory=load_memory(args.memory); candidates=[]
    for vendor,symbol in WATCHLIST:
        rows=list(reversed(conn.execute("""SELECT open_time,open,high,low,close,volume FROM candles WHERE vendor=? AND symbol=? AND timeframe='5' AND is_final=1 ORDER BY open_time DESC LIMIT 120""",(vendor,symbol)).fetchall()))
        if not rows: continue
        key=f"{vendor}:{symbol}:5"; candidate=build_candidate(rows,vendor,symbol,load_ranges(conn,vendor,symbol,int(rows[-1]["open_time"])))
        if candidate is None or int((memory["emissions"].get(key) or {}).get("bar_time",0))==int(candidate["bar_time"]): continue
        candidate["recent_signals"]=recent_signals(conn,vendor,symbol,int(candidate["bar_time"])); candidates.append(candidate); memory["emissions"][key]={"bar_time":candidate["bar_time"]}
    conn.close(); payload={"version":5,"policy":"every_closed_bar_original_rules_no_unapproved_hard_gate","markets":[f"{v}:{s}:5" for v,s in WATCHLIST],"candidates":candidates}; atomic_json(args.output,payload); atomic_json(args.memory,memory); print(json.dumps(payload,ensure_ascii=False,separators=(",",":"))); return 0

if __name__=="__main__": raise SystemExit(main())
