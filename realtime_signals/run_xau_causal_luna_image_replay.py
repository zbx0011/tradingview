#!/usr/bin/env python3
"""Run a strict causal PNG replay with automatic, auditable snapshot budgeting."""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent.parent
VENV_PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
REPO = ROOT / "realtime_signals"
DATA = Path(
    os.environ.get(
        "CAUSAL_DATA",
        str(Path.home() / "AppData" / "Local" / "Temp" / "xauusd_causal_extended_20260807.json"),
    )
)
WORK = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_WORK",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-luna-image-last500-work"),
    )
)
ISOLATED_CODEX_HOME = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_HOME",
        str(Path.home() / "AppData" / "Local" / "Temp" / "codex-xau-causal-luna-image-last500-home"),
    )
)
OUTPUT_DIR = Path(
    os.environ.get(
        "CAUSAL_LUNA_IMAGE_OUTPUT",
        str(ROOT / "outputs" / "xauusd_replay_5m_20260808_luna_image_last500"),
    )
)
LEDGER = WORK / "ledger"
PROGRESS = WORK / "orchestrator_progress.json"
HANDOFF_ROOT = ROOT / "migration" / "codex-handoff"
SOURCE_RULE_ROOT = HANDOFF_ROOT / "source-rules"
V6_SOURCE_IDENTITY = SOURCE_RULE_ROOT / "v6-source-identity.json"
V6_CANONICAL_RULE_SET_SHA256 = (
    "60619931bebe8c8b1c1f1f2554a2632201cb0e44ea60b350849256c362fd02b4"
)

RULE_SET_DEFINITIONS: dict[str, dict[str, Any]] = {
    "louie": {
        "id": "louie_case_enhanced_ema20_no_fixed_target_v3_20260813",
        "display_name": "Louie 案例增强层（EMA20 / 无固定止盈）",
        "runbook": ROOT / "louie-causal-replay-runbook-20260813.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-no-fixed-target-execution-rules-20260813.md",
            SOURCE_RULE_ROOT / "louie-case-enhancement-layer-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
    },
    "louie_course_target": {
        "id": "louie_case_enhanced_ema20_no_fixed_target_v4_20260816",
        "display_name": "Louie V4 案例增强层（EMA20 / 无动态止盈）",
        "runbook": ROOT / "louie-causal-replay-runbook-no-fixed-target-v4-20260816.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-no-fixed-target-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-case-enhancement-layer-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (),
    },
    "louie_course_target_cases": {
        "id": "louie_case_supplemented_ema20_no_fixed_target_v5_20260816",
        "display_name": "Louie V5：V4 执行层 +《价格行为学》案例补充（无动态止盈）",
        "runbook": ROOT / "louie-causal-replay-runbook-price-action-cases-no-fixed-target-20260816.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-no-fixed-target-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-no-fixed-target-20260816.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "louie_structural_trailing_v4": {
        "id": "louie_case_enhanced_ema20_structural_trailing_v4_20260816",
        "display_name": "Louie V4 案例增强层（EMA20 / 强突破—新极值—结构跟踪）",
        "runbook": ROOT / "louie-causal-replay-runbook-structural-trailing-v4-20260816.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-20260816.md",
            SOURCE_RULE_ROOT / "louie-case-enhancement-layer-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (),
    },
    "louie_structural_trailing_v5": {
        "id": "louie_case_supplemented_ema20_structural_trailing_v5_20260816",
        "display_name": "Louie V5：V4 执行层 +《价格行为学》案例补充（结构跟踪）",
        "runbook": ROOT / "louie-causal-replay-runbook-structural-trailing-v5-20260816.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-20260816.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "louie_structural_trailing_v4_higher_high": {
        "id": "louie_case_enhanced_ema20_structural_trailing_v4_higher_high_20260817",
        "display_name": "Louie V4 案例增强层（严格前高突破—结构跟踪）",
        "runbook": ROOT / "louie-causal-replay-runbook-structural-trailing-higher-high-v4-20260817.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "louie-case-enhancement-layer-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (),
    },
    "louie_structural_trailing_v5_higher_high": {
        "id": "louie_case_supplemented_ema20_structural_trailing_v5_higher_high_20260817",
        "display_name": "Louie V5：V4 执行层 +《价格行为学》案例补充（严格前高突破—结构跟踪）",
        "runbook": ROOT / "louie-causal-replay-runbook-structural-trailing-higher-high-v5-20260817.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "louie_structural_trailing_v5_nextbar_opposite": {
        "id": "louie_case_supplemented_ema20_structural_trailing_v5_nextbar_opposite_20260818",
        "display_name": "Louie V5：结构跟踪 + 反向信号下一根确认平仓",
        "runbook": ROOT / "louie-causal-replay-runbook-v5-nextbar-opposite-20260818.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "louie_structural_trailing_v6_nextbar_opposite": {
        "id": "louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830",
        "display_name": "Louie V6：0818 V5 执行 + Al Brooks 全案例解释补充",
        "runbook": ROOT / "louie-causal-replay-runbook-v6-al-brooks-full-corpus-20260830.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "al-brooks-full-corpus-source-identity-20260830.md",
            SOURCE_RULE_ROOT / "louie-al-brooks-full-corpus-case-supplement-v6-20260830.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            SOURCE_RULE_ROOT / "al-brooks-full-corpus-manifest-20260830.json",
        ),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
            Path(r"D:\codex\price-action-course-0126-read\main\all_files.jsonl"),
            Path(r"D:\codex\price-action-course-0126-read\READING_REPORT.md"),
            Path(r"D:\codex\price-action-course-0126-read\unified-index\verification.txt"),
        ),
    },
    "louie_structural_trailing_v5_nextbar_opposite_session_filter10": {
        "id": "louie_case_supplemented_ema20_structural_trailing_v5_nextbar_opposite_session_filter10_20260824",
        "display_name": "Louie V5：结构跟踪 + 反向信号下一根确认平仓 + 开收盘各10根禁新仓",
        "runbook": ROOT / "louie-causal-replay-runbook-v5-nextbar-opposite-session-filter10-20260824.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-session-filter10-20260824.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "louie_structural_trailing_v5_close_confirmed_entry": {
        "id": "louie_case_supplemented_ema20_structural_trailing_v5_close_confirmed_entry_20260820",
        "display_name": "Louie V5：下一根收盘确认进场 + 反向信号下一根确认平仓",
        "runbook": ROOT / "louie-causal-replay-runbook-v5-close-confirmed-entry-20260820.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "louie-case-enhanced-ema20-structural-trailing-v4-20260816.md",
            SOURCE_RULE_ROOT / "louie-price-action-case-supplement-structural-trailing-v5-20260816.md",
            SOURCE_RULE_ROOT / "louie-structural-trailing-management-higher-high-20260817.md",
            SOURCE_RULE_ROOT / "价格行为学基础进阶-source-identity-20260813.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (),
        "source_documents": (
            Path(r"D:\项目\tradingview\价格行为学\1.《价格行为学》（基础篇1-36章）.pdf"),
            Path(r"D:\项目\tradingview\价格行为学\2.《价格行为学》（进阶篇37-52章）.pdf"),
        ),
    },
    "user_custom": {
        "id": "tvfloat_user_custom_03_06_07_v1_20260810",
        "display_name": "用户自定义 03+06+07 版",
        "runbook": ROOT / "custom-causal-replay-runbook-20260810.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-causal-signal-rules-20260810.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
        ),
    },
    "user_custom_v2_legacy": {
        "id": "tvfloat_user_custom_v2_four_setups_20260810",
        "display_name": "用户自定义 V2 四类交易版（历史）",
        "runbook": ROOT / "custom-v2-causal-replay-runbook-20260810.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
        ),
    },
    "user_custom_v2_range30_legacy": {
        "id": "tvfloat_user_custom_v2_range30_one_sided_20260810",
        "display_name": "用户自定义 V2 四类交易版（30根与单边边沿，历史）",
        "runbook": ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
        ),
    },
    "user_custom_v2_unanchored_legacy": {
        "id": "tvfloat_user_custom_v2_range30_unanchored_pullback_20260810",
        "display_name": "用户自定义 V2 四类交易版（允许无锚点首次回调，历史）",
        "runbook": ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_five_close_legacy": {
        "id": "tvfloat_user_custom_v2_five_close_breakout_20260811",
        "display_name": "用户自定义 V2 四类交易版（连续五根收盘真突破，历史）",
        "runbook": ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_anchor_required_legacy": {
        "id": "tvfloat_user_custom_v2_anchor_required_first_pullback_20260811",
        "display_name": "用户自定义 V2 四类交易版（仅影线锚点接触，历史）",
        "runbook": ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-required-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_anchor_candle_contact_legacy": {
        "id": "tvfloat_user_custom_v2_anchor_candle_contact_first_pullback_20260811",
        "display_name": "用户自定义 V2 四类交易版（锚点 K 线接触、首次回调，历史）",
        "runbook": ROOT / "custom-v2-anchor-candle-contact-first-pullback-causal-replay-runbook-20260811.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-candle-contact-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            HANDOFF_ROOT / "13-窄通道首次回调K线覆盖锚点与收盘接受规则-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-required-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_any_pullback_legacy": {
        "id": "tvfloat_user_custom_v2_any_pullback_body50_anchor_contact_20260811",
        "display_name": "用户自定义 V2 四类交易版（任意回调、实体守住50%、锚点接触，历史）",
        "runbook": ROOT / "custom-v2-any-pullback-body50-anchor-contact-causal-replay-runbook-20260811.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-any-pullback-body50-anchor-contact-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            HANDOFF_ROOT / "13-窄通道首次回调K线覆盖锚点与收盘接受规则-20260811.md",
            HANDOFF_ROOT / "14-震荡边沿实体检查仅从正式确认后开始-20260811.md",
            HANDOFF_ROOT / "15-窄通道取消首次回调限制与实体守住方向腿50规则-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-candle-contact-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-required-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            ROOT / "custom-v2-anchor-candle-contact-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_strict_narrow_channel_legacy": {
        "id": "tvfloat_user_custom_v2_strict_narrow_channel_any_pullback_20260812",
        "display_name": "用户自定义 V2 四类交易版（严格ATR强推进窄通道、历史）",
        "runbook": ROOT / "custom-v2-strict-narrow-channel-any-pullback-causal-replay-runbook-20260812.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-any-pullback-body50-anchor-contact-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            HANDOFF_ROOT / "13-窄通道首次回调K线覆盖锚点与收盘接受规则-20260811.md",
            HANDOFF_ROOT / "14-震荡边沿实体检查仅从正式确认后开始-20260811.md",
            HANDOFF_ROOT / "15-窄通道取消首次回调限制与实体守住方向腿50规则-20260811.md",
            HANDOFF_ROOT / "16-严格ATR强推进窄通道与既有回调规则-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-candle-contact-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-required-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            ROOT / "custom-v2-any-pullback-body50-anchor-contact-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-candle-contact-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2": {
        "id": "tvfloat_user_custom_v2_range_lifecycle_bound_20260812",
        "display_name": "用户自定义 V2（五连收盘唯一终止、无实体裁切、生命周期绑定）",
        "runbook": ROOT / "custom-v2-range-lifecycle-bound-causal-replay-runbook-20260812.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-range-lifecycle-bound-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-effective-swing-support-resistance-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-ema20-two-close-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-any-pullback-body50-anchor-contact-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            HANDOFF_ROOT / "13-窄通道首次回调K线覆盖锚点与收盘接受规则-20260811.md",
            HANDOFF_ROOT / "14-震荡边沿实体检查仅从正式确认后开始-20260811.md",
            HANDOFF_ROOT / "15-窄通道取消首次回调限制与实体守住方向腿50规则-20260811.md",
            HANDOFF_ROOT / "16-严格ATR强推进窄通道与既有回调规则-20260812.md",
            HANDOFF_ROOT / "17-严格窄通道连续两根收盘位于EMA20方向侧规则-20260812.md",
            HANDOFF_ROOT / "18-支撑压力反转使用动态有效前低前高规则-20260812.md",
            HANDOFF_ROOT / "19-震荡区间五连收盘唯一终止无实体裁剪与信号生命周期绑定规则-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-candle-contact-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-anchor-required-first-pullback-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-five-close-breakout-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-unanchored-first-pullback-causal-signal-rules-20260810.md",
            ROOT / "custom-v2-strict-narrow-channel-ema20-two-close-any-pullback-causal-replay-runbook-20260812.md",
            ROOT / "custom-v2-strict-narrow-channel-any-pullback-causal-replay-runbook-20260812.md",
            ROOT / "custom-v2-any-pullback-body50-anchor-contact-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-candle-contact-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
    "user_custom_v2_effective_swing_sr_legacy": {
        "id": "tvfloat_user_custom_v2_effective_swing_sr_20260812",
        "display_name": "用户自定义 V2（动态有效前低/前高，历史）",
        "runbook": ROOT / "custom-v2-effective-swing-support-resistance-causal-replay-runbook-20260812.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-effective-swing-support-resistance-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-ema20-two-close-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "18-支撑压力反转使用动态有效前低前高规则-20260812.md",
        ),
    },
    "user_custom_v2_ema20_two_close_legacy": {
        "id": "tvfloat_user_custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_20260812",
        "display_name": "用户自定义 V2 四类交易版（任意两日历史K支撑压力，历史）",
        "runbook": ROOT / "custom-v2-strict-narrow-channel-ema20-two-close-any-pullback-causal-replay-runbook-20260812.md",
        "prompt_files": (
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-ema20-two-close-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-strict-narrow-channel-any-pullback-causal-signal-rules-20260812.md",
            SOURCE_RULE_ROOT / "user-custom-v2-any-pullback-body50-anchor-contact-causal-signal-rules-20260811.md",
            SOURCE_RULE_ROOT / "user-custom-v2-range30-one-sided-causal-signal-rules-20260810.md",
            SOURCE_RULE_ROOT / "louie-ema20-no-fixed-target-execution-rules-20260810.md",
            SOURCE_RULE_ROOT / "Louie交易规则完整整理_案例扩展版.md",
            SOURCE_RULE_ROOT / "louie-case-expanded.md",
        ),
        "source_files": (
            HANDOFF_ROOT / "03-TVFloat完整权威上下文-20260801.md",
            HANDOFF_ROOT / "06-震荡区间生命周期合并与绘图纠错规则-20260803.md",
            HANDOFF_ROOT / "07-AI震荡区间漏报一致性纠错规则-20260804.md",
            HANDOFF_ROOT / "08-用户自定义V2四类交易规则-20260810.md",
            HANDOFF_ROOT / "09-震荡区间至少30根与单边水平边沿规则-20260810.md",
            HANDOFF_ROOT / "10-窄通道取消无锚点旗形震荡硬条件-20260810.md",
            HANDOFF_ROOT / "11-震荡边沿连续五根收盘真突破生命周期规则-20260811.md",
            HANDOFF_ROOT / "12-窄通道首次回调必须触及锚点规则-20260811.md",
            HANDOFF_ROOT / "13-窄通道首次回调K线覆盖锚点与收盘接受规则-20260811.md",
            HANDOFF_ROOT / "14-震荡边沿实体检查仅从正式确认后开始-20260811.md",
            HANDOFF_ROOT / "15-窄通道取消首次回调限制与实体守住方向腿50规则-20260811.md",
            HANDOFF_ROOT / "16-严格ATR强推进窄通道与既有回调规则-20260812.md",
            HANDOFF_ROOT / "17-严格窄通道连续两根收盘位于EMA20方向侧规则-20260812.md",
            ROOT / "custom-v2-strict-narrow-channel-any-pullback-causal-replay-runbook-20260812.md",
            ROOT / "custom-v2-any-pullback-body50-anchor-contact-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-candle-contact-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-anchor-required-first-pullback-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-five-close-breakout-causal-replay-runbook-20260811.md",
            ROOT / "custom-v2-unanchored-first-pullback-causal-replay-runbook-20260810.md",
            ROOT / "custom-v2-range30-one-sided-causal-replay-runbook-20260810.md",
        ),
    },
}
# Keep the pre-2026-08-20 V5 definition addressable after the bare ``V5``
# alias moves to the close-confirmed entry rule.  This is an execution
# identity split, not a rewrite of any archived replay.
RULE_SET_DEFINITIONS["louie_structural_trailing_v5_legacy"] = {
    **RULE_SET_DEFINITIONS["louie_structural_trailing_v5"],
    "display_name": "Louie V5（历史：下一根影线突破进场）",
}
RULE_SET_ALIASES = {
    "louie": "louie",
    "louie_ema20": "louie",
    "louie_case_enhanced_ema20_no_fixed_target_v3_20260813": "louie",
    "louie_course_target": "louie_course_target",
    "louie_course_target_v4": "louie_course_target",
    "louie_case_enhanced_ema20_course_target_v4_20260813": "louie_course_target",
    "louie_case_enhanced_ema20_no_fixed_target_v4_20260816": "louie_course_target",
    "louie_structural_trailing_v4": "louie_structural_trailing_v4",
    "louie_case_enhanced_ema20_structural_trailing_v4_20260816": "louie_structural_trailing_v4",
    "louie_structural_trailing_v4_higher_high": "louie_structural_trailing_v4_higher_high",
    "louie_case_enhanced_ema20_structural_trailing_v4_higher_high_20260817": "louie_structural_trailing_v4_higher_high",
    "louie_course_target_cases": "louie_course_target_cases",
    "louie_course_target_v5": "louie_course_target_cases",
    "louie_case_supplemented_ema20_course_target_v5_20260813": "louie_course_target_cases",
    "louie_case_supplemented_ema20_no_fixed_target_v5_20260816": "louie_course_target_cases",
    "louie_structural_trailing_v5": "louie_structural_trailing_v5_close_confirmed_entry",
    "louie_structural_trailing_v5_legacy": "louie_structural_trailing_v5_legacy",
    "louie_case_supplemented_ema20_structural_trailing_v5_20260816": "louie_structural_trailing_v5_legacy",
    "louie_structural_trailing_v5_higher_high": "louie_structural_trailing_v5_higher_high",
    "louie_case_supplemented_ema20_structural_trailing_v5_higher_high_20260817": "louie_structural_trailing_v5_higher_high",
    "louie_structural_trailing_v5_nextbar_opposite": "louie_structural_trailing_v5_nextbar_opposite",
    "louie_case_supplemented_ema20_structural_trailing_v5_nextbar_opposite_20260818": "louie_structural_trailing_v5_nextbar_opposite",
    "louie_v6": "louie_structural_trailing_v6_nextbar_opposite",
    "louie_structural_trailing_v6": "louie_structural_trailing_v6_nextbar_opposite",
    "louie_structural_trailing_v6_nextbar_opposite": "louie_structural_trailing_v6_nextbar_opposite",
    "louie_al_brooks_full_corpus_ema20_structural_trailing_v6_nextbar_opposite_20260830": "louie_structural_trailing_v6_nextbar_opposite",
    "louie_structural_trailing_v5_nextbar_opposite_session_filter10": "louie_structural_trailing_v5_nextbar_opposite_session_filter10",
    "louie_case_supplemented_ema20_structural_trailing_v5_nextbar_opposite_session_filter10_20260824": "louie_structural_trailing_v5_nextbar_opposite_session_filter10",
    "louie_structural_trailing_v5_close_confirmed_entry": "louie_structural_trailing_v5_close_confirmed_entry",
    "louie_case_supplemented_ema20_structural_trailing_v5_close_confirmed_entry_20260820": "louie_structural_trailing_v5_close_confirmed_entry",
    "user_custom": "user_custom",
    "custom": "user_custom",
    "tvfloat_user_custom_03_06_07_v1_20260810": "user_custom",
    "user_custom_v2": "user_custom_v2",
    "custom_v2": "user_custom_v2",
    "tvfloat_user_custom_v2_range_lifecycle_bound_20260812": "user_custom_v2",
    "user_custom_v2_effective_swing_sr_legacy": "user_custom_v2_effective_swing_sr_legacy",
    "tvfloat_user_custom_v2_effective_swing_sr_20260812": "user_custom_v2_effective_swing_sr_legacy",
    "user_custom_v2_ema20_two_close_legacy": "user_custom_v2_ema20_two_close_legacy",
    "tvfloat_user_custom_v2_strict_narrow_channel_ema20_two_close_any_pullback_20260812": "user_custom_v2_ema20_two_close_legacy",
    "user_custom_v2_strict_narrow_channel_legacy": "user_custom_v2_strict_narrow_channel_legacy",
    "tvfloat_user_custom_v2_strict_narrow_channel_any_pullback_20260812": "user_custom_v2_strict_narrow_channel_legacy",
    "user_custom_v2_any_pullback_legacy": "user_custom_v2_any_pullback_legacy",
    "tvfloat_user_custom_v2_any_pullback_body50_anchor_contact_20260811": "user_custom_v2_any_pullback_legacy",
    "user_custom_v2_anchor_candle_contact_legacy": "user_custom_v2_anchor_candle_contact_legacy",
    "tvfloat_user_custom_v2_anchor_candle_contact_first_pullback_20260811": "user_custom_v2_anchor_candle_contact_legacy",
    "user_custom_v2_anchor_required_legacy": "user_custom_v2_anchor_required_legacy",
    "tvfloat_user_custom_v2_anchor_required_first_pullback_20260811": "user_custom_v2_anchor_required_legacy",
    "user_custom_v2_five_close_legacy": "user_custom_v2_five_close_legacy",
    "tvfloat_user_custom_v2_five_close_breakout_20260811": "user_custom_v2_five_close_legacy",
    "user_custom_v2_unanchored_legacy": "user_custom_v2_unanchored_legacy",
    "tvfloat_user_custom_v2_range30_unanchored_pullback_20260810": "user_custom_v2_unanchored_legacy",
    "user_custom_v2_range30_legacy": "user_custom_v2_range30_legacy",
    "tvfloat_user_custom_v2_range30_one_sided_20260810": "user_custom_v2_range30_legacy",
    "user_custom_v2_legacy": "user_custom_v2_legacy",
    "tvfloat_user_custom_v2_four_setups_20260810": "user_custom_v2_legacy",
}

CUSTOM_RULE_SET_KEYS = {
    "user_custom",
    "user_custom_v2",
    "user_custom_v2_effective_swing_sr_legacy",
    "user_custom_v2_strict_narrow_channel_legacy",
    "user_custom_v2_any_pullback_legacy",
    "user_custom_v2_anchor_candle_contact_legacy",
    "user_custom_v2_anchor_required_legacy",
    "user_custom_v2_five_close_legacy",
    "user_custom_v2_unanchored_legacy",
    "user_custom_v2_range30_legacy",
    "user_custom_v2_legacy",
}
CUSTOM_V2_RULE_SET_KEYS = {
    "user_custom_v2",
    "user_custom_v2_effective_swing_sr_legacy",
    "user_custom_v2_ema20_two_close_legacy",
    "user_custom_v2_strict_narrow_channel_legacy",
    "user_custom_v2_any_pullback_legacy",
    "user_custom_v2_anchor_candle_contact_legacy",
    "user_custom_v2_anchor_required_legacy",
    "user_custom_v2_five_close_legacy",
    "user_custom_v2_unanchored_legacy",
    "user_custom_v2_range30_legacy",
    "user_custom_v2_legacy",
}
CUSTOM_V2_RANGE30_RULE_SET_KEYS = {
    "user_custom_v2",
    "user_custom_v2_effective_swing_sr_legacy",
    "user_custom_v2_ema20_two_close_legacy",
    "user_custom_v2_strict_narrow_channel_legacy",
    "user_custom_v2_any_pullback_legacy",
    "user_custom_v2_anchor_candle_contact_legacy",
    "user_custom_v2_anchor_required_legacy",
    "user_custom_v2_five_close_legacy",
    "user_custom_v2_unanchored_legacy",
    "user_custom_v2_range30_legacy",
}
MODEL = os.environ.get("CAUSAL_MODEL", "gpt-5.6-luna")
EFFORT = os.environ.get("CAUSAL_EFFORT", "max")
SERVICE_TIER = os.environ.get("CAUSAL_SERVICE_TIER", "default")
TEXT_ONLY = os.environ.get("CAUSAL_TEXT_ONLY", "0")
START_IDX = int(os.environ.get("CAUSAL_START_IDX", "999"))
BAR_COUNT = int(os.environ.get("CAUSAL_BAR_COUNT", "500"))
END_IDX = START_IDX + BAR_COUNT
TURN_LIMIT = int(os.environ.get("CAUSAL_TURN_LIMIT", "30"))
TURN_TIMEOUT = int(os.environ.get("CAUSAL_TURN_TIMEOUT", "1800"))
NO_PROGRESS_LIMIT = int(os.environ.get("CAUSAL_NO_PROGRESS_LIMIT", "2"))
SNAPSHOTS_PER_TURN = 12
SNAPSHOTS_TOTAL_REQUESTED = int(os.environ.get("CAUSAL_SNAPSHOTS_TOTAL", "0"))
# A replay can legitimately request more than one chart snapshot per bar.  The
# old fixed default of 800 was smaller than the observed usage of a 1380-bar
# window and caused otherwise causal runs to fail near the end.  Keep a large
# minimum, scale it with the requested window, and expand it if the actual run
# still needs more evidence.  This is a bookkeeping ceiling, not a reason to
# discard a valid replay.
SNAPSHOT_BUDGET_POLICY = "auto_expand_by_bar_count"
SNAPSHOT_BUDGET_MINIMUM = max(2000, BAR_COUNT * 2)
SNAPSHOTS_TOTAL = max(SNAPSHOT_BUDGET_MINIMUM, SNAPSHOTS_TOTAL_REQUESTED)
PROMPT_MODE = os.environ.get("CAUSAL_LUNA_PROMPT_MODE", "legacy")
RULE_SET_KEY = RULE_SET_ALIASES.get(
    os.environ.get("CAUSAL_RULE_SET", "louie").strip().lower(), ""
)


def expanded_snapshot_budget(current_budget: int, total_snapshots: int) -> int:
    """Return a larger evidence budget without interrupting a causal replay."""

    return max(current_budget * 2, total_snapshots + SNAPSHOT_BUDGET_MINIMUM)


def rule_set_definition(key: str | None = None) -> dict[str, Any]:
    selected = RULE_SET_ALIASES.get(str(key or RULE_SET_KEY).strip().lower(), str(key or RULE_SET_KEY))
    if selected not in RULE_SET_DEFINITIONS:
        choices = ", ".join(sorted(RULE_SET_DEFINITIONS))
        raise SystemExit(f"unknown CAUSAL_RULE_SET={key or RULE_SET_KEY!r}; choose one of: {choices}")
    return RULE_SET_DEFINITIONS[selected]


def rule_file_record(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise SystemExit(f"required rule file not found: {path}")
    raw = path.read_bytes()
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def source_document_record(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise SystemExit(f"required source document not found: {path}")
    raw = path.read_bytes()
    return {
        "path": str(path),
        "archive_path": (Path("_external") / path.name).as_posix(),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def build_rule_set_manifest(key: str | None = None) -> dict[str, Any]:
    definition = rule_set_definition(key)
    prompt_files = [rule_file_record(path) for path in definition["prompt_files"]]
    source_files = [rule_file_record(path) for path in definition["source_files"]]
    runbook = rule_file_record(definition["runbook"])
    selected_key = RULE_SET_ALIASES.get(
        str(key or RULE_SET_KEY).strip().lower(), str(key or RULE_SET_KEY)
    )
    if selected_key == "louie_structural_trailing_v6_nextbar_opposite":
        if not V6_SOURCE_IDENTITY.is_file():
            raise SystemExit(f"V6 source identity file not found: {V6_SOURCE_IDENTITY}")
        source_documents = json.loads(V6_SOURCE_IDENTITY.read_text(encoding="utf-8"))["source_documents"]
    else:
        source_documents = [
            source_document_record(path) for path in definition.get("source_documents", ())
        ]
    identity = {
        "rule_set_id": definition["id"],
        "prompt_files": prompt_files,
        "source_files": source_files,
        "runbook": runbook,
    }
    if source_documents:
        identity["source_documents"] = source_documents
    combined = hashlib.sha256(
        json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if selected_key == "louie_structural_trailing_v6_nextbar_opposite" and combined != V6_CANONICAL_RULE_SET_SHA256:
        raise SystemExit(
            "V6 packaged rule identity changed: "
            f"expected {V6_CANONICAL_RULE_SET_SHA256}, got {combined}"
        )
    manifest = {
        "schema_version": 1,
        "rule_set_key": RULE_SET_ALIASES.get(str(key or RULE_SET_KEY).strip().lower(), str(key or RULE_SET_KEY)),
        "rule_set_id": definition["id"],
        "display_name": definition["display_name"],
        "combined_sha256": combined,
        "prompt_files": prompt_files,
        "source_files": source_files,
        "runbook": runbook,
    }
    if selected_key == "louie_structural_trailing_v6_nextbar_opposite":
        manifest["packaged_source_identity"] = V6_SOURCE_IDENTITY.relative_to(ROOT).as_posix()
    if source_documents:
        manifest["source_documents"] = source_documents
    return manifest


RULE_SET_MANIFEST = build_rule_set_manifest()
RULE_SET_ID = str(RULE_SET_MANIFEST["rule_set_id"])
RULE_SET_SHA256 = str(RULE_SET_MANIFEST["combined_sha256"])


def resolve_codex_command_prefix() -> list[str]:
    override = os.environ.get("CAUSAL_CODEX_EXECUTABLE")
    if override:
        return [override]
    if os.name == "nt":
        appdata = Path(os.environ.get("APPDATA", ""))
        npm_entry = appdata / "npm" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
        node = shutil.which("node.exe")
        if node and npm_entry.is_file():
            return [node, str(npm_entry)]
    executable = shutil.which("codex.exe") or shutil.which("codex")
    if not executable:
        raise SystemExit("codex executable not found")
    return [executable]


CODEX_COMMAND_PREFIX = resolve_codex_command_prefix()

AUDIT_OMIT_KEYS = {"reasoning", "chain_of_thought", "chainofthought", "cot", "thoughts", "scratchpad"}
AUDIT_SECRET_KEYS = {"password", "token", "cookie", "authorization", "auth", "api_key", "private_key", "secret", "session"}


def audit_omitted(value: Any, reason: str) -> dict[str, Any]:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return {"omitted": True, "reason": reason, "sha256": hashlib.sha256(raw).hexdigest(), "original_length": len(raw)}


def sanitize_audit_value(value: Any) -> Any:
    if isinstance(value, dict):
        item = value.get("item")
        if value.get("type") in AUDIT_OMIT_KEYS or (
            isinstance(item, dict) and item.get("type") in AUDIT_OMIT_KEYS
        ):
            return {"type": value.get("type", "omitted"), "content": audit_omitted(value, "hidden_chain_of_thought")}
        result: dict[str, Any] = {}
        for key, child in value.items():
            normalized = re.sub(r"[^a-z0-9_]", "", str(key).lower())
            if normalized in AUDIT_OMIT_KEYS:
                result[key] = audit_omitted(child, "hidden_chain_of_thought")
            elif normalized in AUDIT_SECRET_KEYS:
                result[key] = "[REDACTED]"
            elif key == "data" and value.get("type") == "image" and isinstance(child, str):
                result[key] = audit_omitted(child, "png_bytes_saved_as_file")
            else:
                result[key] = sanitize_audit_value(child)
        return result
    if isinstance(value, list):
        return [sanitize_audit_value(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
        value = re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b", "[REDACTED_TOKEN]", value)
        return value
    return value


def sanitize_codex_jsonl(stdout: str) -> str:
    lines: list[str] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = sanitize_audit_value(json.loads(line))
        except json.JSONDecodeError:
            raw = line.encode("utf-8")
            event = {"type": "unparsed", "omitted": True, "sha256": hashlib.sha256(raw).hexdigest(), "original_length": len(raw)}
        lines.append(json.dumps(event, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(lines) + ("\n" if lines else "")

COMMON = [
    "--json",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--disable", "shell_tool",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "browser_use",
    "--disable", "multi_agent",
    "--disable", "tool_suggest",
    "-m", MODEL,
    "-c", f'model_reasoning_effort="{EFFORT}"',
    "-c", f'service_tier="{SERVICE_TIER}"',
    "--dangerously-bypass-approvals-and-sandbox",
]


def write_progress(value: dict[str, Any]) -> None:
    temp = PROGRESS.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(PROGRESS)


def state() -> dict[str, Any]:
    return json.loads((LEDGER / "gate_state.json").read_text(encoding="utf-8"))


def data_sha256() -> str:
    return hashlib.sha256(DATA.read_bytes()).hexdigest()


def replay_dataset_metadata(data_path: Path | None = None) -> dict[str, Any]:
    path = data_path or DATA
    payload = json.loads(path.read_text(encoding="utf-8"))
    symbol = str(payload.get("symbol") or "").strip()
    timeframe_raw = payload.get("timeframe_minutes", payload.get("timeframe"))
    try:
        timeframe_minutes = int(timeframe_raw)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"invalid replay timeframe in {path}: {timeframe_raw!r}") from exc
    bars = payload.get("bars")
    if not symbol or timeframe_minutes <= 0 or not isinstance(bars, list):
        raise SystemExit(f"invalid replay dataset metadata: {path}")
    return {
        "symbol": symbol,
        "timeframe_minutes": timeframe_minutes,
        "bar_count": len(bars),
    }


def python_executable() -> Path:
    override = os.environ.get("CAUSAL_PYTHON_EXECUTABLE")
    if override:
        return Path(override)
    if VENV_PYTHON.exists():
        return VENV_PYTHON
    return Path(sys.executable)


def gate_environment() -> dict[str, str]:
    env = os.environ.copy()
    env["XAU_DATA_FILE"] = str(DATA)
    env["XAU_EXPECTED_SHA"] = data_sha256()
    env["CAUSAL_START_IDX"] = str(START_IDX)
    env["CAUSAL_MODEL"] = MODEL
    env["CAUSAL_EFFORT"] = EFFORT
    env["CAUSAL_RULE_SET"] = RULE_SET_KEY
    env["CAUSAL_RULE_SET_ID"] = RULE_SET_ID
    env["CAUSAL_RULE_SET_SHA256"] = RULE_SET_SHA256
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def run_gate(arguments: list[str]) -> dict[str, Any]:
    python = python_executable()
    completed = subprocess.run(
        [str(python), str(WORK / "xau_causal_gate.py"), "--data", str(DATA), "--out", str(LEDGER), *arguments],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=gate_environment(),
    )
    return json.loads(completed.stdout)


def parse_events(text: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def validate_events(events: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    calls: list[dict[str, Any]] = []
    forbidden: list[dict[str, Any]] = []
    snapshots = 0
    for event in events:
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        item_type = item.get("type")
        if item_type == "mcp_tool_call":
            calls.append(item)
            if item.get("server") != "causal_gate" or item.get("tool") not in {"status", "commit", "chart_snapshot"}:
                forbidden.append(item)
            elif item.get("tool") == "chart_snapshot":
                snapshots += 1
        elif item_type in {
            "agent_message", "reasoning", "error", "message", "custom_tool_call_output",
            "custom_tool_call_input", "todo_list", "plan", "update_plan", "request_user_input",
            "collaboration_followup_task", "collaboration_spawn_agent",
        }:
            continue
        elif item_type in {"custom_tool_call", "function_call", "shell_command", "exec_command"}:
            forbidden.append(item)
    return calls, forbidden, snapshots


def usage_blocked(events: list[dict[str, Any]]) -> tuple[bool, str]:
    for event in events:
        if event.get("type") != "error":
            continue
        message = str(event.get("message") or "")
        lower = message.lower()
        if "usage limit" in lower or ("limit" in lower and "retry" in lower):
            return True, message
    return False, ""


def setup_isolated_env() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    isolated_sources = [
        "xau_causal_gate.py",
        "chart_text_snapshot.py",
        "xau_causal_luna_image_mcp_server.py",
    ]
    if RULE_SET_KEY in CUSTOM_RULE_SET_KEYS:
        isolated_sources.extend(("candidate_filter_v2.py", "kline_store.py"))
    if RULE_SET_KEY in {"user_custom_v2", "user_custom_v2_strict_narrow_channel_legacy"}:
        isolated_sources.append("strict_narrow_channel.py")
    for name in isolated_sources:
        shutil.copy2(REPO / name, WORK / name)
    ISOLATED_CODEX_HOME.mkdir(parents=True, exist_ok=True)
    auth_src = Path.home() / ".codex" / "auth.json"
    if auth_src.exists():
        shutil.copy2(auth_src, ISOLATED_CODEX_HOME / "auth.json")
    python = python_executable()
    python_toml = str(python).replace("\\", "/")
    server_toml = str(WORK / "xau_causal_luna_image_mcp_server.py").replace("\\", "/")
    work_toml = str(WORK).replace("\\", "/")
    data_toml = str(DATA).replace("\\", "/")
    strict_channel_toml = ""
    if RULE_SET_KEY in {"user_custom_v2", "user_custom_v2_strict_narrow_channel_legacy"}:
        try:
            from strict_narrow_channel import ENV_FIELDS, config_from_env
        except ModuleNotFoundError:
            from .strict_narrow_channel import ENV_FIELDS, config_from_env

        selected_channel_config = config_from_env()
        strict_channel_toml = "\n".join(
            f'{name} = "{getattr(selected_channel_config, field_name)}"'
            for name, (field_name, _) in ENV_FIELDS.items()
        )
    config = f'''model = "{MODEL}"
model_reasoning_effort = "{EFFORT}"
service_tier = "{SERVICE_TIER}"
approval_policy = "never"
sandbox_mode = "read-only"

[mcp_servers.causal_gate]
command = "{python_toml}"
args = ["{server_toml}"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.causal_gate.env]
XAU_DATA_FILE = "{data_toml}"
XAU_EXPECTED_SHA = "{data_sha256()}"
CAUSAL_START_IDX = "{START_IDX}"
CAUSAL_MODEL = "{MODEL}"
CAUSAL_EFFORT = "{EFFORT}"
XAU_TEXT_ONLY = "{TEXT_ONLY}"
CAUSAL_RULE_SET = "{RULE_SET_KEY}"
CAUSAL_RULE_SET_ID = "{RULE_SET_ID}"
CAUSAL_RULE_SET_SHA256 = "{RULE_SET_SHA256}"
{strict_channel_toml}

[projects.'{work_toml}']
trust_level = "trusted"
'''
    (ISOLATED_CODEX_HOME / "config.toml").write_text(config, encoding="utf-8")


def prompt() -> str:
    definition = rule_set_definition()
    dataset = replay_dataset_metadata()
    symbol = dataset["symbol"]
    timeframe_minutes = dataset["timeframe_minutes"]
    rule_sections = []
    for index, source in enumerate(definition["prompt_files"], start=1):
        rule_sections.append(
            f"===== 固定规则全文 {index}：{source.name} =====\n"
            f"{source.read_text(encoding='utf-8')}\n"
            f"===== 固定规则全文 {index} 结束 ====="
        )
    rendered_rules = "\n\n".join(rule_sections)
    structural_dedup_rule = "" if PROMPT_MODE == "legacy" else """- 结构级去重：同一背景、同一结构腿内的延续、普通回测、二次推进或微型突破，若没有形成独立新论点，优先判 OBSERVE；反向 SIGNAL 必须先证明旧结构失效且新方向已经接受与跟随。不得用固定时间/K线冷却代替结构判断。
"""
    custom_range_rule = "" if RULE_SET_KEY not in CUSTOM_RULE_SET_KEYS else """- 因果门的 structure_hint.range_consistency 是同一截止 idx 的闭合K线证明。proof_status=active 时必须结合当前 PNG 复核该区间；不得直接声称没有区间。文字、PNG、proof 冲突时提交 OBSERVE。
- setup 必须使用自定义规则规定的六类机会之一，可在冒号后补充结构说明，不得创造第七类。
"""
    if RULE_SET_KEY in CUSTOM_V2_RULE_SET_KEYS:
        narrow_channel_setup = (
            "窄通道回调顺势"
            if RULE_SET_KEY in {
                "user_custom_v2",
                "user_custom_v2_ema20_two_close_legacy",
                "user_custom_v2_strict_narrow_channel_legacy",
                "user_custom_v2_any_pullback_legacy",
            }
            else "窄通道首次回调顺势"
        )
        custom_range_rule = f"""- 因果门的 structure_hint.range_consistency 是同一截止 idx 的闭合K线证明。proof_status=active 时必须结合当前 PNG 复核该区间；不得直接声称没有区间。文字、PNG、proof 冲突时提交 OBSERVE。
- V2 的 SIGNAL setup 只能精确使用：震荡真突破、震荡反转、{narrow_channel_setup}、支撑压力反转。其余 Louie 结构只能 OBSERVE 或 NO_SIGNAL。
- V2 SIGNAL 必须提交固定规则所列的 signal_context；它记录边沿价格区间、入场触发、固定止损及对应结构索引。不得从未来K线补写。
"""
        if RULE_SET_KEY in {
            "user_custom_v2",
            "user_custom_v2_effective_swing_sr_legacy",
        }:
            custom_range_rule += """- 支撑压力反转只能引用 structure_hint.effective_swing_support_resistance 中信号时点已确认的最近有效摆动低点/高点。多头只用 latest confirmed swing low，空头只用 latest confirmed swing high；较新的同侧摆动点经右侧K线收盘确认后立即替换旧参考。
- 禁止把任意超过两天的历史K线、离当前价最近的旧实体/影线、或未确认局部极值当作支撑压力。该 setup 不要求震荡上下沿，也不要求三次触碰。
"""
        else:
            custom_range_rule += """- structure_hint.historical_support_resistance 是该历史版本严格超过2个经过日的历史K线候选清单；不得把该旧口径倒写进当前活动版本。
"""
    if RULE_SET_KEY in CUSTOM_V2_RANGE30_RULE_SET_KEYS:
        custom_range_rule += """- 本活动版本的双边震荡至少30根，上下边沿各至少两组独立触碰；相邻或密集触碰簇只算一次。
- 单边水平边沿允许缺少另一侧，但活动边必须至少三组独立触碰、首末触碰横跨至少30根，且形成期没有实体接受到外侧；不得补画缺失边。
- range SIGNAL 必须使用本规则适配器指定的 rule_version，并提交 kind、起止 idx、活动边及独立触碰 idx；单边反转不得虚构中点或对侧价格。
"""
    if RULE_SET_KEY in {"user_custom_v2_five_close_legacy", "user_custom_v2_unanchored_legacy"}:
        active_rule_version = (
            "custom_v2_range30_one_sided_unanchored_pullback_five_close_breakout"
            if RULE_SET_KEY == "user_custom_v2_five_close_legacy"
            else "custom_v2_range30_one_sided_unanchored_pullback"
        )
        custom_range_rule += f"""- 当前活动版本使用 rule_version={active_rule_version}。
- 窄通道第一次回调未触及50%、EMA20或先前边沿时，不要求牛旗、熊旗或震荡；使用 unanchored_first_pullback，touch_anchors=[]、consolidation_kind=null。
- 不得使用 flag_or_range_pullback 或以新名称恢复已删除的旗形/震荡硬门槛。
"""
    if RULE_SET_KEY == "user_custom_v2_anchor_required_legacy":
        custom_range_rule += """- 当前活动版本使用 rule_version=custom_v2_range30_one_sided_anchor_required_five_close_breakout。
- 窄通道首次回调的候选信号 K，多头下影线/空头上影线必须真实触及方向腿 50%、当根 EMA20、或前一个相关被突破震荡边沿价格带中的至少一个。仅实体覆盖不算触及。
- 只能使用 variant=anchor_touch_pullback；touch_anchors 必须完整列出真实触及的 trend_leg_50_percent、ema20、prior_breakout_edge_zone。三者都未触及必须 OBSERVE/NO_SIGNAL。
- 禁止 unanchored_first_pullback、flag_or_range_pullback 及任何改名的无锚点替代变体；不得伪造先前边沿。
"""
    if RULE_SET_KEY == "user_custom_v2_anchor_candle_contact_legacy":
        custom_range_rule += """- 当前活动版本使用 rule_version=custom_v2_range30_one_sided_anchor_candle_contact_five_close_breakout。
- 窄通道首次回调的候选信号 K，多头由下影线加实体、空头由上影线加实体接触方向腿 50%、当根 EMA20、或前一个相关被突破震荡边沿价格带中的至少一个都算接触；反方向影线不算。
- 多头信号 K 收盘不得低于被接触的点锚，对价格带不得低于 zone.low；空头对称地不得高于点锚或 zone.high。只有候选信号 K 新增“实体覆盖可算接触”的例外；它之前的回调 K 仍不得盘中越过方向腿 50%，原有 EMA20 与适用边沿收盘约束也不变。
- 只能使用 variant=anchor_touch_pullback；touch_anchors 必须完整列出真实且被收盘接受的 trend_leg_50_percent、ema20、prior_breakout_edge_zone。三者都未形成有效接触必须 OBSERVE/NO_SIGNAL。
- 禁止 unanchored_first_pullback、flag_or_range_pullback 及任何改名的无锚点替代变体；不得伪造先前边沿。
"""
    if RULE_SET_KEY in {
        "user_custom_v2",
        "user_custom_v2_effective_swing_sr_legacy",
        "user_custom_v2_ema20_two_close_legacy",
        "user_custom_v2_strict_narrow_channel_legacy",
    }:
        active_rule_version = (
            "custom_v2_range_lifecycle_bound_effective_swing_sr"
            if RULE_SET_KEY == "user_custom_v2"
            else "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout_effective_swing_sr"
            if RULE_SET_KEY == "user_custom_v2_effective_swing_sr_legacy"
            else "custom_v2_range30_one_sided_strict_narrow_channel_ema20_two_close_any_pullback_body50_anchor_contact_five_close_breakout"
            if RULE_SET_KEY == "user_custom_v2_ema20_two_close_legacy"
            else "custom_v2_range30_one_sided_strict_narrow_channel_any_pullback_body50_anchor_contact_five_close_breakout"
        )
        ema20_formation_rule = (
            "- 上涨窄通道在首次确认前必须至少有连续2根收盘严格高于各自EMA20；下跌对称地连续2根严格低于各自EMA20。等于EMA20不计并中断连续计数。因果证明必须记录最大连续根数和精确索引。\n"
            if RULE_SET_KEY in {
                "user_custom_v2",
                "user_custom_v2_effective_swing_sr_legacy",
                "user_custom_v2_ema20_two_close_legacy",
            }
            else "- 这是不含EMA20连续两收盘形成门槛的历史严格ATR版本，不得用新版条件倒写历史ledger。\n"
        )
        custom_range_rule += f"""- 当前活动版本使用 rule_version={active_rule_version}。
- 窄通道 setup 使用“窄通道回调顺势”、family=narrow_channel_pullback，并记录 first_pullback_required=false；不再要求整段趋势里的第一次回调。
- structure_hint.strict_narrow_channel_consistency 是冻结 OHLC、起点 ATR14 与当前截止 idx 的定量因果证明。方向腿必须引用其中已登记的 strict_narrow_channel，且 trend_leg_indices 必须逐根连续、start_idx/last_updated_idx 与证明完全一致；禁止模型自报窄通道。
- 窄通道以 bars>=3、方向极值移动>=2.0 ATR、净移动>=1.5 ATR、收盘/盘中最大回调的 ATR 与回调前推进比例门槛，以及本规则身份明确要求的 EMA20 连续收盘条件判定。十字星、小实体、反方向K、重叠、短暂停顿和阶梯推进不能单独否决。
{ema20_formation_rule}- ATR 固定为候选起点已确定的 ATR14；回调比例分母只能使用回调发生前已走出的最大方向距离。小于1 ATR的早期推进只检查ATR回调门槛。首次满足立即确认，first_detected_at 不得后移；结束只在违规K收盘确认。
- 完整回调逐根检查实体：多头 min(open,close)>=方向腿50%，空头 max(open,close)<=方向腿50%；等号允许，影线可以触及或穿过50%，实体穿过则拒绝。
- 回调必须从方向腿结束后的下一根K线开始，pullback_indices逐根连续覆盖到当前信号K；structure_indices必须有序、无重复并包含完整方向腿与完整回调，禁止跳过中间不利K线。
- 严格窄通道只须在trend_leg_end_idx因果成立；后续回调可以结束通道，但不得绕过完整回调的50%、EMA20和锚点门槛。
- 候选信号 K 的方向侧影线或实体仍须接触方向腿50%、当根EMA20或适用先前边沿至少一个，并在方向有效侧收盘；反方向影线不算。
- 只能使用 variant=anchor_touch_pullback；touch_anchors 必须完整列出真实有效的 trend_leg_50_percent、ema20、prior_breakout_edge_zone。禁止无锚点或旗形/震荡替代变体。
"""
    if RULE_SET_KEY == "user_custom_v2_any_pullback_legacy":
        custom_range_rule += """- 当前历史版本使用 rule_version=custom_v2_range30_one_sided_any_pullback_body50_anchor_contact_five_close_breakout。
- 窄通道 setup 使用“窄通道回调顺势”、family=narrow_channel_pullback，并记录 first_pullback_required=false；沿用该历史版本的连续方向腿、非阶梯推进要求。
- 完整回调实体守住方向腿50%，候选信号K必须形成有效锚点接触；不得把新版严格ATR识别器倒写进历史 ledger。
"""
    if RULE_SET_KEY in {
        "user_custom_v2",
        "user_custom_v2_effective_swing_sr_legacy",
        "user_custom_v2_ema20_two_close_legacy",
        "user_custom_v2_strict_narrow_channel_legacy",
        "user_custom_v2_any_pullback_legacy",
        "user_custom_v2_anchor_candle_contact_legacy",
        "user_custom_v2_anchor_required_legacy",
        "user_custom_v2_five_close_legacy",
    }:
        custom_range_rule += """- 已成立区间只有连续5根闭合K都严格收在同一外侧边界之外才终止；中间收回立即把对应计数归零。
- 第5根确认K才允许发出震荡真突破，variant=fifth_consecutive_close_outside_edge，并记录 break_confirmation_closes=5 与五根确认索引。
"""
    if RULE_SET_KEY == "user_custom_v2":
        custom_range_rule += """- 五根连续收盘突破是区间唯一终止条件。实体进入、覆盖或穿过价格带不得裁切、缩窄、删除或提前终止区间。
- 任何引用震荡区间的 SIGNAL 都必须绑定实际生命周期：range SIGNAL 提交 range.range_lifecycle_id；窄通道若使用 prior_breakout_edge_zone，也必须提交该边沿的 range_lifecycle_id。价格带、方向、起止和触碰证据必须与 structure_hint.range_consistency 中同一 ID 的实际因果生命周期完全一致；不得引用相近、重叠或更强的其他区间。
- 绘图右端只延长到终止前最后一根 high-low 实际触碰原始未裁切价格带的后续K线；没有后续触碰时停在形成末端，不因逻辑仍有效而无限延长。
"""
    louie_ema_rule = "" if RULE_SET_KEY != "louie" else """- 本版本只使用 EMA20；不得计算、查看或引用 EMA50，也不得使用双均线交叉。EMA20 只能作为辅助证据。
- 信号判断不得用前高/前低固定止盈、固定 RR 或利润上限过滤机会；入场时只设置固定初始止损，盈利退出由反向信号或移动止损管理。
- “Louie 案例增强层”是正式判断层：必须把案例中的背景、位置、状态转换、接受与跟随以及成功/失败分界用于当前逐根判断，不能只复述形态定义。
- Louie 每根提交都必须带 case_context，逐项填写 market_state、background、location、acceptance_follow_through、trigger、success_failure_boundary、case_families 与 evidence_indices。case_families 只能从 signal_bar_entry、pullback_count、gap、market_cycle、breakout_retest_second_leg、wedge_or_climax、risk_or_management_context、no_specific_case 中选择；无特定案例时只能单独使用 no_specific_case，不得伪造案例命中。
- case_context.evidence_indices 必须包含当前 idx，且只能引用已释放 K，并被顶层 evidence_indices 完整覆盖。这样每根判断都能机械审计是否真正走过“背景→位置→接受/跟随→触发→成功/失败分界”，而不是只在 reason 中挂名。
- MM、50%、TBTL、时段/点数概率只作案例背景；不得变成固定止盈、信号评分或新增硬阈值。限价加仓、主观提前离场、打平止损和期权策略不进入本执行版本。
"""
    louie_course_target_rule = "" if RULE_SET_KEY not in {"louie_course_target", "louie_course_target_cases"} else """- 本版本只使用 EMA20；不得计算、查看或引用 EMA50，也不得使用双均线交叉。EMA20 只能作为辅助证据。
- 入场与持仓完全沿用当前 Louie：信号 K 收盘后只观察紧邻下一根的严格突破，固定信号时初始止损；单仓位、同向忽略、反向收盘平仓和 100 USD/100 USD 移动止损不变。
- 本 V4/V5 版本完全不设置固定或成交后动态止盈：take_profit.enabled_at_entry=false、price=null；1R、2R、前高前低、Leg1=Leg2 MM 和 Actual Risk 只能作为案例解释背景，不能形成退出动作。
- “Louie 案例增强层”仍是正式判断层：必须把全书案例中的背景、位置、状态转换、接受与跟随以及成功/失败分界用于当前逐根决策，不能只复述形态定义。
- 每根判断必须带 case_context：market_state、background、location、acceptance_follow_through、trigger、success_failure_boundary、case_families、evidence_indices；无特定案例时只能单独使用 no_specific_case。
- MM、1R/2R、Actual Risk、前高前低和书中主观离场只保留为 context_only，不得变成信号评分、入场过滤、固定目标、动态目标、额外阈值、加仓、保本或主观提前离场。
"""
    louie_case_supplement_rule = "" if RULE_SET_KEY != "louie_course_target_cases" else """- V5 在 V4 执行层之上增加《价格行为学》4214页案例补充；它只影响背景、位置、状态、接受/跟随、触发和成功/失败边界的解释，不能改变任何入场、止损、仓位或退出动作。
- 每根 case_context 还必须提交 supplemental_case_lenses，并明确 v4_execution_unchanged=true；不得用 no_additional_case 掩盖已经命中的补充透镜。
- 信号K质量必须与背景/位置共同判断；回调计数可有歧义且强突破后可重置；迟到跟随不得回填旧决定；看不清时允许 OBSERVE/NO_SIGNAL，不强制分类。
- 区间限价反向、任意时刻/收盘价进场、加仓、保本、分批、主观退出、EMA50/其他周期、概率/点数/时段阈值全部是 context_only。
"""
    louie_structural_trailing_rule = "" if RULE_SET_KEY not in {
        "louie_structural_trailing_v4",
        "louie_structural_trailing_v5",
        "louie_structural_trailing_v5_legacy",
        "louie_structural_trailing_v4_higher_high",
        "louie_structural_trailing_v5_higher_high",
        "louie_structural_trailing_v5_nextbar_opposite",
        "louie_structural_trailing_v6_nextbar_opposite",
        "louie_structural_trailing_v5_nextbar_opposite_session_filter10",
        "louie_structural_trailing_v5_close_confirmed_entry",
    } else """- 本 V4/V5 执行层不使用 100 USD 浮盈启动或 100 USD 固定回撤距离；该旧兼容字段必须为 null。
- 多头的强突破—新极值事件：持仓后，当前闭合 K 线必须以多头实体收盘，收盘严格高于持仓后此前所有 K 线的最高价，并且当前 high 严格创持仓后新高。空头完全对称：空头实体收盘、收盘严格低于此前所有持仓后 K 线最低价、当前 low 严格创持仓后新低。
- 事件确认后不立即移动止损；继续等待该突破之后形成的三 K 线风险侧结构低点/高点，并由右侧 K 线闭合确认。多头保护线跟踪确认结构低点，空头跟踪确认结构高点。
- 结构保护线只向有利方向 ratchet，不能放宽；确认 K 收盘后更新，下一根 K 线才允许触发。没有新结构确认时保持此前有效保护线；没有任何结构跟踪时保持信号时固定初始止损。
- 该规则不生成固定止盈或动态课程目标；MM、1R/2R、Actual Risk、前高前低和主观利润回撤规则只能作为解释背景。
"""
    louie_structural_higher_high_gate_rule = "" if RULE_SET_KEY not in {
        "louie_structural_trailing_v4_higher_high",
        "louie_structural_trailing_v5_higher_high",
        "louie_structural_trailing_v5_nextbar_opposite",
        "louie_structural_trailing_v6_nextbar_opposite",
        "louie_structural_trailing_v5_nextbar_opposite_session_filter10",
        "louie_structural_trailing_v5_close_confirmed_entry",
    } else """- 严格结构移动止损门槛：多头风险侧低点必须先由右侧 K 线确认，随后 favorable wick 严格高于该低点之前最近已确认高点，才可把止损移动到该低点；空头严格对称。
- 前高/前低突破必须发生在风险侧结构已经确认之后；同一根 K 线同时确认结构和突破，不得在该根移动，下一根才检查新保护线。
"""
    louie_structural_case_supplement_rule = "" if RULE_SET_KEY not in {"louie_structural_trailing_v5", "louie_structural_trailing_v5_legacy", "louie_structural_trailing_v5_higher_high", "louie_structural_trailing_v5_nextbar_opposite", "louie_structural_trailing_v6_nextbar_opposite", "louie_structural_trailing_v5_nextbar_opposite_session_filter10", "louie_structural_trailing_v5_close_confirmed_entry"} else """- V5 仍以 V4 结构跟踪执行层为最高优先级；《价格行为学》案例只补充背景、位置、接受/跟随、突破质量和失败边界的解释，不改变结构跟踪的确定性状态机。
- 每根 case_context 还必须提交 supplemental_case_lenses，并明确 v4_execution_unchanged=true；案例不能授权固定止盈、美元阈值、任意时刻移动止损、加仓、保本或分批平仓。
"""
    louie_brooks_full_corpus_rule = "" if RULE_SET_KEY != "louie_structural_trailing_v6_nextbar_opposite" else """- V6 以 0818 V5 为唯一执行父版本；Al Brooks 全案例只扩展解释和审计，必须明确 v5_0818_execution_unchanged=true，不能改变原始信号、下一根影线严格突破进场、初始止损、单仓位、反向信号下一根确认、严格前高/前低结构移动止损或无固定止盈。
- 每根 case_context 还必须提交 brooks_case_lenses 与 brooks_source_families。no_matching_brooks_case 必须单独出现，并且来源只能是 no_specific_brooks_source；不得伪造页码、视频时间戳或案例编号。
- 所有课程目标、限价/任意时刻进场、加仓、保本、分批、主观退出、特定时段统计和新增硬阈值均为 context_only。案例有冲突或证据不足时提交 OBSERVE/NO_SIGNAL，不得改写确定性执行层。
"""
    session_filter_rule = "" if RULE_SET_KEY != "louie_structural_trailing_v5_nextbar_opposite_session_filter10" else """- 本规则新增确定性的入场时段过滤，仅适用于 XAUUSD、XAGUSD、US500：按冻结数据的北京时间/实际时间戳因果识别每个交易时段，开盘后的前10根K线和收盘前的后10根K线禁止新开仓；待成交的信号在禁入场边界内直接过期。
- 该过滤只作用于新入场计划，不改变原始信号生成、信号K、止损、已有持仓管理、反向平仓确认或结构移动止盈；已有持仓可以跨越边界并按原 V5 状态机退出。非目标标的不启用。
"""
    snapshot_trigger = (
        "EMA20回踩或价格有效穿越EMA20"
        if RULE_SET_KEY in {"louie", "louie_course_target", "louie_course_target_cases", "louie_structural_trailing_v4", "louie_structural_trailing_v5", "louie_structural_trailing_v5_legacy", "louie_structural_trailing_v4_higher_high", "louie_structural_trailing_v5_higher_high", "louie_structural_trailing_v5_nextbar_opposite", "louie_structural_trailing_v6_nextbar_opposite", "louie_structural_trailing_v5_nextbar_opposite_session_filter10", "louie_structural_trailing_v5_close_confirmed_entry"} or RULE_SET_KEY in CUSTOM_V2_RULE_SET_KEYS
        else "EMA交叉"
    )
    threshold_rule = (
        "- 新增硬阈值仅限 strict_narrow_channel_consistency 中已锁定的 ATR/移动/回调参数与EMA20方向侧连续两收盘；"
        "不得再增加形态、成交量、拟合度、K线数量或冷却门槛。\n"
        if RULE_SET_KEY == "user_custom_v2"
        else "- 新增硬阈值仅限 strict_narrow_channel_consistency 中已锁定的 ATR/移动/回调参数；不得把新版EMA20连续两收盘门槛倒写进此历史身份。\n"
        if RULE_SET_KEY == "user_custom_v2_strict_narrow_channel_legacy"
        else "- 不使用A/B等级，不添加固定ATR、百分比、分数、冷却根数等规则原文没有的硬门槛。\n"
    )
    evidence_order = (
        "- 依次检查：环境/背景 → 定量窄通道证明 → 回调锚点与接受 → 当前触发；"
        "EMA20还承担明确的窄通道连续两收盘形成门槛，ATR只按严格窄通道固定参数使用。\n"
        if RULE_SET_KEY == "user_custom_v2"
        else "- 依次检查：环境/背景 → 定量窄通道证明 → 回调锚点与接受 → 当前触发；EMA20只按历史身份作为回调锚点/辅助，ATR只按严格窄通道固定参数使用。\n"
        if RULE_SET_KEY == "user_custom_v2_strict_narrow_channel_legacy"
        else "- 依次检查：环境/背景 → 位置 → 接受与跟随 → 被破坏的结构 → 当前触发；EMA/ATR只作辅助。\n"
    )
    return f"""你是正式的离线价格行为逐根回放判断器，使用 {MODEL}、{EFFORT} 推理强度。

本轮规则集：{definition['display_name']}；rule_set_id={RULE_SET_ID}；rule_set_sha256={RULE_SET_SHA256}。只执行下方固定规则，不得混入另一规则集。

本次冻结市场：{symbol}；K线周期：{timeframe_minutes}分钟。固定规则全文中的“5分钟”来自生产监控原文；本专项回放只把相同价格行为规则应用于当前 {timeframe_minutes} 分钟闭合K线，不得读取、混入或假装存在5分钟数据。

这次只回放完整冻结数据的最后 {BAR_COUNT} 根：原始 idx={START_IDX} 到 idx={END_IDX - 1}，一根不少。原始 idx 0 到 {START_IDX - 1} 已预加载，仅用于计算 EMA/ATR、已确认枢轴和结构上下文，不提交任何历史判断，也不能引用其后的未来K线。

严格因果：每根{timeframe_minutes}分钟K线收盘后才能判断；只有 commit 当前 idx 写入哈希链后，因果门才释放下一根。只允许使用 causal_gate 的 status、commit、chart_snapshot 三个工具。不得使用 Shell、文件、网络、TradingView、数据库、基准答案或子代理能力。

图像识别要求：chart_snapshot 返回截止当前 idx 的结构化文字和一张实际 PNG 图像。调用后必须同时检查文字与图像，确认市场背景、区间/通道、支撑压力、突破或扫荡是否被接受；PNG 也只能包含当前及此前K线，绝不能据图推断未来。普通延续和窄幅整理不要机械调用；当 structure_hint.suggest_snapshot=true，或出现突破/假突破、扫荡、{snapshot_trigger}、缺口、异常大实体时，优先调用 chart_snapshot。

判断口径：
- 每根提交 NO_SIGNAL / OBSERVE / SIGNAL 三者之一。
- SIGNAL 只用于当前收盘已经形成规则定义的信号K；V2 震荡真突破的初始收盘突破本身可以成为 SIGNAL，其后确认K、健康回调和实际成交由独立因果入场状态机处理。其他仍需形成信号K的结构只能 OBSERVE。
{structural_dedup_rule}{custom_range_rule}{louie_ema_rule}{louie_course_target_rule}{louie_case_supplement_rule}{louie_structural_trailing_rule}{louie_structural_higher_high_gate_rule}{louie_structural_case_supplement_rule}{louie_brooks_full_corpus_rule}{session_filter_rule}{threshold_rule}{evidence_order}
- setup 用规则集规定的中文形态词；reason 用简体中文2–4句，按“背景→位置→接受与跟随→触发”。

commit 必须一次给全：idx=当前 status 返回的 idx；decision；direction（非SIGNAL固定 none）；setup；reason；evidence_indices（包含当前idx和实际引用的历史结构索引）；max_used_idx=当前idx。Louie 每根还必须提交 case_context；V2 SIGNAL 还必须提交 signal_context。不得回填旧判断，不能引用 idx 之后的信息。

本轮先读 status，再逐根提交最多 {TURN_LIMIT} 根；达到上限后停止，不要总结后续行情。完成 idx={END_IDX - 1} 后停止。

{rendered_rules}
"""


def run_turn(turn_no: int) -> tuple[list[dict[str, Any]], int, int, str]:
    last_message = WORK / f"turn_{turn_no:03d}_last.txt"
    command = [*CODEX_COMMAND_PREFIX, "exec", "-", *COMMON, "-C", str(WORK), "-o", str(last_message)]
    turn_prompt = prompt()
    dataset = replay_dataset_metadata()
    (WORK / f"turn_{turn_no:03d}_prompt.txt").write_text(turn_prompt, encoding="utf-8")
    (WORK / f"turn_{turn_no:03d}_command.json").write_text(
        json.dumps(
            {
                "argv": command,
                "cwd": str(WORK),
                "timeout_seconds": TURN_TIMEOUT,
                "model": MODEL,
                "reasoning_effort": EFFORT,
                "service_tier": SERVICE_TIER,
                "prompt_mode": PROMPT_MODE,
                "text_only": TEXT_ONLY,
                "rule_set_key": RULE_SET_KEY,
                "rule_set_id": RULE_SET_ID,
                "rule_set_sha256": RULE_SET_SHA256,
                "symbol": dataset["symbol"],
                "timeframe_minutes": dataset["timeframe_minutes"],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["CODEX_HOME"] = str(ISOLATED_CODEX_HOME)
    env.update(gate_environment())
    started = time.time()
    try:
        completed = subprocess.run(
            command,
            input=turn_prompt,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env=env,
            timeout=TURN_TIMEOUT,
            check=False,
        )
        stdout = completed.stdout
        stderr = completed.stderr
        returncode = completed.returncode
    except subprocess.TimeoutExpired as exc:
        # Preserve any JSON events emitted before the timeout. The gate is
        # independently durable, so the outer loop can continue from its
        # actual next_idx on the next turn.
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        stderr = f"{stderr}\n[turn timeout after {TURN_TIMEOUT}s]\n"
        returncode = 124
    (WORK / f"turn_{turn_no:03d}.jsonl").write_text(sanitize_codex_jsonl(stdout), encoding="utf-8")
    (WORK / f"turn_{turn_no:03d}.stderr.txt").write_text(str(sanitize_audit_value(stderr)), encoding="utf-8")
    if last_message.exists():
        last_message.write_text(str(sanitize_audit_value(last_message.read_text(encoding="utf-8", errors="replace"))), encoding="utf-8")
    return parse_events(stdout), int(time.time() - started), returncode, stderr


def publish_outputs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("decisions.jsonl", "gate_state.json", "manifest.json"):
        shutil.copy2(LEDGER / name, OUTPUT_DIR / name)
    for name in (
        "orchestrator_progress.json",
        "rule_set_manifest.json",
        "snapshot_log.jsonl",
        "mcp_debug.log",
    ):
        source = WORK / name
        if source.exists():
            shutil.copy2(source, OUTPUT_DIR / name)
    rule_sources = OUTPUT_DIR / "rule_sources"
    for record in [
        RULE_SET_MANIFEST["runbook"],
        *RULE_SET_MANIFEST["prompt_files"],
        *RULE_SET_MANIFEST["source_files"],
    ]:
        source = ROOT / str(record["path"])
        destination = rule_sources / str(record["path"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    for record in RULE_SET_MANIFEST.get("source_documents", []):
        source = Path(str(record["path"]))
        # V6 deliberately packages the frozen source identities, not the
        # original course PDFs/media.  Preserve the identity in the manifest
        # but do not make publication fail when the external source is absent.
        if not source.is_file():
            continue
        destination = rule_sources / str(record["archive_path"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    if RULE_SET_KEY == "louie_structural_trailing_v6_nextbar_opposite":
        identity_destination = rule_sources / V6_SOURCE_IDENTITY.relative_to(ROOT)
        identity_destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(V6_SOURCE_IDENTITY, identity_destination)
    turn_dir = OUTPUT_DIR / "turn_logs"
    turn_dir.mkdir(parents=True, exist_ok=True)
    for source in WORK.glob("turn_*"):
        if source.is_file():
            shutil.copy2(source, turn_dir / source.name)
    snapshot_dir = OUTPUT_DIR / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    for source in (WORK / "snapshots").glob("*.png"):
        shutil.copy2(source, snapshot_dir / source.name)


def export_recognized_ranges() -> Path | None:
    """Build the post-replay range ledger used by the local K-line Studio."""

    if RULE_SET_KEY not in {
        "user_custom_v2",
        "user_custom_v2_strict_narrow_channel_legacy",
    }:
        return None
    destination = OUTPUT_DIR / "recognized_ranges.json"
    completed = subprocess.run(
        [
            str(python_executable()),
            str(REPO / "export_xau_replay_ranges.py"),
            "--raw-dir",
            str(OUTPUT_DIR),
            "--data-file",
            str(DATA),
            "--output",
            str(destination),
        ],
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            "recognized range export failed: "
            + (completed.stderr.strip() or completed.stdout.strip() or f"returncode={completed.returncode}")
        )
    return destination


def publish_incomplete_on_exit() -> None:
    """Best-effort publication so failed/interrupted attempts remain archivable."""
    try:
        if PROGRESS.exists():
            progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
            if progress.get("status") == "running":
                progress.update(
                    {
                        "status": "interrupted_or_unhandled_exit",
                        "finished_at_epoch": int(time.time()),
                    }
                )
                write_progress(progress)
        if (LEDGER / "manifest.json").exists():
            publish_outputs()
    except Exception:
        # Never replace the original runner error during interpreter shutdown.
        pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resume", action="store_true", help="Resume an existing isolated causal replay run.")
    args = parser.parse_args()
    snapshot_budget = SNAPSHOTS_TOTAL
    if not DATA.exists():
        raise SystemExit(f"data file not found: {DATA}")
    digest = data_sha256()
    if START_IDX < 0:
        raise SystemExit(f"invalid start idx: {START_IDX}")
    if BAR_COUNT <= 0:
        raise SystemExit(f"invalid bar count: {BAR_COUNT}")
    dataset = replay_dataset_metadata()
    if END_IDX > int(dataset["bar_count"]):
        raise SystemExit(
            f"requested replay end idx {END_IDX} exceeds frozen bar count {dataset['bar_count']}"
        )
    if OUTPUT_DIR.exists() and not args.resume and (OUTPUT_DIR / "decisions.jsonl").exists():
        raise SystemExit(f"output already exists; use a new output/work directory: {OUTPUT_DIR}")
    setup_isolated_env()
    rule_manifest_path = WORK / "rule_set_manifest.json"
    if args.resume:
        if not PROGRESS.exists() or not (LEDGER / "gate_state.json").exists() or not rule_manifest_path.exists():
            raise SystemExit("cannot resume: progress or causal ledger is missing")
        saved_rule_manifest = json.loads(rule_manifest_path.read_text(encoding="utf-8"))
        if saved_rule_manifest != RULE_SET_MANIFEST:
            raise SystemExit("cannot resume after rule-set source or hash changed")
        progress = json.loads(PROGRESS.read_text(encoding="utf-8"))
        expected_configuration = {
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "service_tier": SERVICE_TIER,
            "codex_command_prefix": CODEX_COMMAND_PREFIX,
            "prompt_mode": PROMPT_MODE,
            "text_only": TEXT_ONLY,
            "rule_set_key": RULE_SET_KEY,
            "rule_set_id": RULE_SET_ID,
            "rule_set_sha256": RULE_SET_SHA256,
            "start_idx": START_IDX,
            "end_idx_exclusive": END_IDX,
            "bar_count": BAR_COUNT,
            "data_sha256": digest,
        }
        mismatches = {
            key: {"saved": progress.get(key), "requested": value}
            for key, value in expected_configuration.items()
            if progress.get(key) is not None and str(progress.get(key)) != str(value)
        }
        if mismatches:
            raise SystemExit(f"cannot resume with changed configuration: {json.dumps(mismatches, ensure_ascii=False)}")
        snapshot_budget = max(
            SNAPSHOTS_TOTAL,
            int(progress.get("snapshots_total", 0) or 0),
            int(progress.get("total_snapshots", 0) or 0) + SNAPSHOT_BUDGET_MINIMUM,
        )
        turn_no = len(progress.get("turns", []))
        progress.update(
            {
                "status": "running",
                "next_idx": int(state()["next_idx"]),
                "snapshots_per_turn": SNAPSHOTS_PER_TURN,
                "snapshots_total": snapshot_budget,
                "snapshot_budget_policy": SNAPSHOT_BUDGET_POLICY,
                "snapshot_budget_requested": SNAPSHOTS_TOTAL_REQUESTED,
                "snapshot_budget_minimum": SNAPSHOT_BUDGET_MINIMUM,
                "snapshot_budget_expansions": progress.get("snapshot_budget_expansions", []),
                **expected_configuration,
            }
        )
        write_progress(progress)
    else:
        if (LEDGER / "gate_state.json").exists():
            raise SystemExit(f"work directory already has a ledger; use --resume or a new work directory: {WORK}")
        rule_manifest_path.write_text(
            json.dumps(RULE_SET_MANIFEST, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        run_gate(["init"])
        progress = {
            "status": "running",
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "service_tier": SERVICE_TIER,
            "codex_command_prefix": CODEX_COMMAND_PREFIX,
            "prompt_mode": PROMPT_MODE,
            "text_only": TEXT_ONLY,
            "rule_set_key": RULE_SET_KEY,
            "rule_set_id": RULE_SET_ID,
            "rule_set_sha256": RULE_SET_SHA256,
            "start_idx": START_IDX,
            "end_idx_exclusive": END_IDX,
            "bar_count": BAR_COUNT,
            "data_sha256": digest,
            "turns": [],
            "next_idx": START_IDX,
            "snapshots_per_turn": SNAPSHOTS_PER_TURN,
            "snapshots_total": snapshot_budget,
            "total_snapshots": 0,
            "snapshot_budget_policy": SNAPSHOT_BUDGET_POLICY,
            "snapshot_budget_requested": SNAPSHOTS_TOTAL_REQUESTED,
            "snapshot_budget_minimum": SNAPSHOT_BUDGET_MINIMUM,
            "snapshot_budget_expansions": [],
        }
        write_progress(progress)
        turn_no = 0

    atexit.register(publish_incomplete_on_exit)

    no_progress = 0
    while int(state()["next_idx"]) < END_IDX:
        before = int(state()["next_idx"])
        events, duration, returncode, stderr = run_turn(turn_no)
        after = int(state()["next_idx"])
        calls, forbidden, snapshots = validate_events(events)
        progress["turns"].append(
            {
                "turn": turn_no,
                "before_idx": before,
                "after_idx": after,
                "commits": sum(1 for c in calls if c.get("tool") == "commit" and c.get("status") == "completed"),
                "status_calls": sum(1 for c in calls if c.get("tool") == "status"),
                "snapshots": snapshots,
                "forbidden_count": len(forbidden),
                "codex_returncode": returncode,
                "duration_seconds": duration,
            }
        )
        progress["next_idx"] = after
        progress["chain_sha256"] = state()["chain_sha256"]
        progress["total_snapshots"] = int(progress.get("total_snapshots", 0)) + snapshots
        write_progress(progress)
        print(
            json.dumps(
                {
                    "status": "running",
                    "turn": turn_no,
                    "before_idx": before,
                    "after_idx": after,
                    "completed_bars": after - START_IDX,
                    "bar_count": BAR_COUNT,
                    "snapshots": snapshots,
                    "total_snapshots": progress["total_snapshots"],
                    "codex_returncode": returncode,
                    "forbidden_count": len(forbidden),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        if returncode != 0 and after <= before:
            progress.update({"status": "failed", "error": f"codex returncode={returncode}", "stderr_tail": stderr[-2000:]})
            write_progress(progress)
            return 2
        if forbidden:
            progress.update({"status": "failed", "error": "forbidden tool item", "forbidden": forbidden[:5]})
            write_progress(progress)
            return 3
        if int(progress["total_snapshots"]) > snapshot_budget:
            previous_budget = snapshot_budget
            snapshot_budget = expanded_snapshot_budget(snapshot_budget, int(progress["total_snapshots"]))
            progress["snapshots_total"] = snapshot_budget
            progress.setdefault("snapshot_budget_expansions", []).append(
                {
                    "turn": turn_no,
                    "previous_budget": previous_budget,
                    "actual_total": int(progress["total_snapshots"]),
                    "new_budget": snapshot_budget,
                    "reason": "legitimate PNG evidence exceeded the initial estimate",
                }
            )
            progress.setdefault("warnings", []).append(
                {
                    "turn": turn_no,
                    "type": "snapshot_budget_auto_expanded",
                    "new_budget": snapshot_budget,
                }
            )
            write_progress(progress)
        if snapshots > SNAPSHOTS_PER_TURN:
            progress.setdefault("warnings", []).append({"turn": turn_no, "snapshots": snapshots})
        if after <= before:
            no_progress += 1
        else:
            no_progress = 0
        if no_progress >= NO_PROGRESS_LIMIT:
            progress.update({"status": "failed", "error": "two turns without progress"})
            write_progress(progress)
            return 5
        turn_no += 1

    progress.update(
        {
            "status": "complete",
            "next_idx": int(state()["next_idx"]),
            "chain_sha256": state()["chain_sha256"],
            "finished_at_epoch": int(time.time()),
        }
    )
    write_progress(progress)
    publish_outputs()
    range_artifact = export_recognized_ranges()
    if range_artifact is not None:
        progress["recognized_ranges_file"] = str(range_artifact)
        write_progress(progress)
        shutil.copy2(PROGRESS, OUTPUT_DIR / PROGRESS.name)
    atexit.unregister(publish_incomplete_on_exit)
    print(json.dumps({"status": "complete", "output_dir": str(OUTPUT_DIR), "recognized_ranges": str(range_artifact) if range_artifact else None, "start_idx": START_IDX, "end_idx": END_IDX - 1}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
