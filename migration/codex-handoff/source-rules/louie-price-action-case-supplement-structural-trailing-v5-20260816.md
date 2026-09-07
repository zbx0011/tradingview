# Louie V5《价格行为学》案例补充层：结构跟踪版（2026-08-16）

规则集 ID：`louie_case_supplemented_ema20_structural_trailing_v5_20260816`。

本层读取《价格行为学》基础篇与进阶篇的案例，用于逐根补充背景、位置、接受/跟随、突破/陷阱、反转、通道、区间和失败边界。它不改变 V4 执行层。

V4 的结构跟踪优先级高于本案例层：强突破必须先形成新极值，结构低点/高点必须由右侧 K 线闭合确认，移动线下一根生效。案例中的目标管理、Measured Move、1R/2R、Actual Risk、分批、保本和主观提前离场均是 `context_only`。

每根 V5 判断必须继续提交 `case_context`、`supplemental_case_lenses`，并明确 `v4_execution_unchanged=true`。

