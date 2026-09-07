# Louie V4 执行适配器：EMA20 与结构跟踪（2026-08-16）

规则集 ID：`louie_case_enhanced_ema20_structural_trailing_v4_20260816`。

本版本保留 V4 的 EMA20-only 辅助上下文、原始 SIGNAL、下一根严格突破入场、信号时固定初始止损、固定风险仓位、单仓位、同向忽略、反向信号收盘平仓和既有自定义结构退出。移动止盈改为共有的“强突破—新极值—结构低点/高点跟踪”管理层。

入场时 `take_profit.enabled_at_entry=false`、`price=null`。成交后不得生成固定或动态目标。`trailing_activation_usd`、`trailing_distance_usd` 仅作为兼容审计字段，必须为 `null`。

每根判断仍须使用当前及此前已释放的闭合 K、EMA20、已确认结构和案例证据；不得使用未来 K 线回填结构或移动线。

