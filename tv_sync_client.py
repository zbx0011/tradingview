from __future__ import annotations

import ctypes
import json
import multiprocessing as mp
import os
import queue
import threading
import time
import tkinter as tk
from pathlib import Path
from typing import Any


def prepare_client_config() -> None:
    local_app_data = Path(os.environ.get("LOCALAPPDATA", Path.home()))
    old_path = local_app_data / "TVFloat" / "config.json"
    client_path = local_app_data / "TVFloatClient" / "config.json"
    if client_path.exists() or not old_path.exists():
        return
    try:
        value = json.loads(old_path.read_text(encoding="utf-8-sig"))
        if not isinstance(value, dict):
            return
        client_path.parent.mkdir(parents=True, exist_ok=True)
        client_path.write_text(
            json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except (OSError, ValueError):
        return


prepare_client_config()
os.environ["TVFLOAT_CONFIG_DIR"] = "TVFloatClient"

from tv_float import (
    SIGNAL_POLL_MILLISECONDS,
    Quote,
    QuoteOverlay,
    SignalAlert,
    acquire_single_instance,
    load_config,
    save_config,
)
from tv_sync_protocol import authorized_json_request, normalize_server_address


def enable_native_maximize(window: tk.Toplevel) -> None:
    """Force the native Windows frame to expose resize and maximize controls."""
    if os.name != "nt":
        return
    window.update_idletasks()
    frame_id = window.tk.call("wm", "frame", window._w)
    hwnd = int(str(frame_id), 0)
    user32 = ctypes.windll.user32
    gwl_style = -16
    ws_thickframe = 0x00040000
    ws_maximizebox = 0x00010000
    swp_nosize = 0x0001
    swp_nomove = 0x0002
    swp_nozorder = 0x0004
    swp_framechanged = 0x0020
    style = user32.GetWindowLongW(hwnd, gwl_style)
    user32.SetWindowLongW(
        hwnd,
        gwl_style,
        style | ws_thickframe | ws_maximizebox,
    )
    user32.SetWindowPos(
        hwnd,
        0,
        0,
        0,
        0,
        0,
        swp_nosize | swp_nomove | swp_nozorder | swp_framechanged,
    )


def parse_remote_alerts(payload: dict[str, Any]) -> dict[str, SignalAlert]:
    alerts: dict[str, SignalAlert] = {}
    raw_alerts = payload.get("alerts", [])
    if not isinstance(raw_alerts, list):
        return alerts
    for item in raw_alerts:
        if not isinstance(item, dict):
            continue
        try:
            symbol = str(item["symbol"]).strip().upper()
            display_symbol = str(
                item.get("display_symbol", symbol)
            ).strip().upper()
            direction = str(item["direction"]).strip().lower()
            raw_grade = str(item["grade"]).strip()
            grade = raw_grade.upper() if raw_grade.upper() in {"A", "B"} else raw_grade
            if (
                not symbol
                or not display_symbol
                or direction not in {"long", "short"}
                or grade not in {"A", "B", "边缘预警"}
            ):
                continue
            alerts[display_symbol] = SignalAlert(
                id=int(item["id"]),
                vendor=str(item.get("vendor", "")),
                symbol=symbol,
                direction=direction,
                setup_type=str(item.get("setup_type", "")),
                grade=grade,
                bar_time=int(item.get("bar_time", 0)),
                signal_price=float(item.get("signal_price", 0.0)),
            )
        except (KeyError, TypeError, ValueError):
            continue
    return alerts


def remote_alert_key(alert: SignalAlert) -> str:
    """Return a stable key that will not hide a reused database id."""
    return f"{alert.symbol.upper()}:{alert.id}:{alert.bar_time}"


def load_dismissed_remote_alert_keys(config: dict[str, Any]) -> list[str]:
    raw_keys = config.get("dismissed_remote_alert_keys", [])
    if not isinstance(raw_keys, list):
        return []
    keys: list[str] = []
    for value in raw_keys:
        key = str(value).strip()
        if key and key not in keys:
            keys.append(key)
    return keys[-500:]


class RemoteQuoteOverlay(QuoteOverlay):
    def __init__(self) -> None:
        config = load_config()
        self.remote_server = normalize_server_address(
            str(config.get("remote_server", ""))
        )
        self.remote_token = str(config.get("remote_token", "")).strip()
        self.remote_status = "尚未设置 A 电脑"
        self.remote_processing_status = "最近处理：等待 A 电脑监控状态"
        self.remote_alert_lock = threading.Lock()
        self.remote_alerts: dict[str, SignalAlert] = {}
        self.dismissed_remote_alert_keys = load_dismissed_remote_alert_keys(config)
        self.dismissed_remote_alert_key_set = set(
            self.dismissed_remote_alert_keys
        )
        self.pending_remote_ack_alerts: dict[str, SignalAlert] = {}
        self.connection_window: tk.Toplevel | None = None
        super().__init__()
        self.root.title("TradingView 同步悬浮行情（B电脑）")
        self.processed_time.configure(text=self.remote_processing_status)
        threading.Thread(
            target=self.acknowledgement_retry_loop,
            daemon=True,
            name="TVFloatRemoteAlertAckRetry",
        ).start()
        if not self.remote_server or not self.remote_token:
            self.root.after(500, self.open_connection_settings)

    def reader_loop(self) -> None:
        while not self.stop_event.is_set():
            if not self.remote_server or not self.remote_token:
                self.remote_status = "请设置 A 电脑连接"
                self.stop_event.wait(1.0)
                continue
            try:
                payload = authorized_json_request(
                    self.remote_server,
                    self.remote_token,
                    "/api/quotes",
                    timeout=4.0,
                )
                now = time.monotonic()
                quotes: dict[str, Quote] = {}
                for item in payload.get("quotes", []):
                    if not isinstance(item, dict):
                        continue
                    symbol = str(item.get("symbol", "")).strip()
                    price = str(item.get("price", "")).strip()
                    change = str(item.get("change", "")).strip()
                    direction = str(item.get("direction", "down")).strip()
                    if not symbol or not price:
                        continue
                    try:
                        age = min(3600.0, max(0.0, float(item.get("age_seconds", 0))))
                    except (TypeError, ValueError):
                        age = 0.0
                    quotes[symbol] = Quote(
                        symbol=symbol,
                        price=price,
                        change=change,
                        direction=direction,
                        seen_at=now - age,
                    )
                self.remote_status = (
                    f"已连接 A 电脑 · {len(quotes)} 个标的"
                    if quotes
                    else "已连接 A 电脑 · 等待 TradingView 数据"
                )
                processing_status = str(
                    payload.get("processing_status", "")
                ).strip()
                self.remote_processing_status = (
                    processing_status
                    if processing_status
                    else "最近处理：等待 A 电脑监控状态"
                )
                remote_alerts = parse_remote_alerts(payload)
                with self.remote_alert_lock:
                    dismissed = set(self.dismissed_remote_alert_key_set)
                    for alert in remote_alerts.values():
                        key = remote_alert_key(alert)
                        if key in dismissed:
                            self.pending_remote_ack_alerts[key] = alert
                    self.remote_alerts = {
                        symbol: alert
                        for symbol, alert in remote_alerts.items()
                        if remote_alert_key(alert) not in dismissed
                    }
                self.publish_quotes(quotes)
            except ConnectionError as exc:
                self.remote_status = str(exc)
                self.remote_processing_status = "最近处理：A 电脑状态暂不可用"
                self.publish_quotes({})
            self.stop_event.wait(0.8)

    def acknowledgement_retry_loop(self) -> None:
        while not self.stop_event.wait(10.0):
            with self.remote_alert_lock:
                pending = list(self.pending_remote_ack_alerts.items())
            for key, alert in pending:
                acknowledged = self.send_remote_action(
                    "/api/acknowledge-alert",
                    alert.symbol,
                    {"signal_id": alert.id},
                )
                if acknowledged:
                    with self.remote_alert_lock:
                        current = self.pending_remote_ack_alerts.get(key)
                        if (
                            current is not None
                            and remote_alert_key(current) == key
                        ):
                            self.pending_remote_ack_alerts.pop(key, None)

    def healthcheck_loop(self) -> None:
        while not self.stop_event.wait(60.0):
            if not self.remote_server or not self.remote_token:
                continue
            try:
                authorized_json_request(
                    self.remote_server,
                    self.remote_token,
                    "/api/health",
                    timeout=5.0,
                )
            except ConnectionError as exc:
                self.remote_status = str(exc)

    def poll_signal_alerts(self) -> None:
        with self.remote_alert_lock:
            latest = dict(self.remote_alerts)
        changed = {
            symbol: alert.id for symbol, alert in latest.items()
        } != {
            symbol: alert.id for symbol, alert in self.active_alerts.items()
        }
        self.active_alerts = latest
        if self.active_alerts:
            self.alert_flash_on = not self.alert_flash_on
            self.render()
        elif changed:
            self.alert_flash_on = False
            self.render()
        if not self.stop_event.is_set():
            self.root.after(SIGNAL_POLL_MILLISECONDS, self.poll_signal_alerts)

    def render(self) -> None:
        super().render()
        self.header.configure(text=f"同步行情  ·  {self.remote_status}")
        self.processed_time.configure(text=self.remote_processing_status)

    def on_symbol_click(self, symbol: str) -> None:
        alert = self.active_alerts.get(symbol.upper())
        if alert is not None:
            # Stop the B-side flash before doing any network work.  Older A-side
            # hosts do not expose the acknowledgement endpoint and otherwise
            # resend the same alert forever.
            self.dismiss_remote_alert(symbol, alert)
            threading.Thread(
                target=self.acknowledge_and_activate,
                args=(symbol, alert),
                daemon=True,
            ).start()
            return
        threading.Thread(
            target=self.send_remote_action,
            args=("/api/activate-symbol", symbol),
            daemon=True,
        ).start()

    def dismiss_remote_alert(self, display_symbol: str, alert: SignalAlert) -> None:
        key = remote_alert_key(alert)
        with self.remote_alert_lock:
            if key not in self.dismissed_remote_alert_key_set:
                self.dismissed_remote_alert_keys.append(key)
                self.dismissed_remote_alert_keys = (
                    self.dismissed_remote_alert_keys[-500:]
                )
                self.dismissed_remote_alert_key_set = set(
                    self.dismissed_remote_alert_keys
                )
            current = self.remote_alerts.get(display_symbol.upper())
            if current is not None and remote_alert_key(current) == key:
                self.remote_alerts.pop(display_symbol.upper(), None)
            self.pending_remote_ack_alerts[key] = alert
        current_active = self.active_alerts.get(display_symbol.upper())
        if current_active is not None and remote_alert_key(current_active) == key:
            self.active_alerts.pop(display_symbol.upper(), None)
        self.alert_flash_on = False
        self.persist()
        self.render()

    def acknowledge_and_activate(self, display_symbol: str, alert: SignalAlert) -> None:
        acknowledged = self.send_remote_action(
            "/api/acknowledge-alert",
            alert.symbol,
            {"signal_id": alert.id},
        )
        if acknowledged:
            with self.remote_alert_lock:
                self.pending_remote_ack_alerts.pop(
                    remote_alert_key(alert),
                    None,
                )
        self.send_remote_action("/api/activate-symbol", display_symbol)

    def persist(self) -> None:
        super().persist()
        config = load_config()
        with self.remote_alert_lock:
            dismissed = list(self.dismissed_remote_alert_keys[-500:])
        config["dismissed_remote_alert_keys"] = dismissed
        save_config(config)

    def send_remote_action(
        self,
        path: str,
        symbol: str,
        extra_payload: dict[str, Any] | None = None,
    ) -> bool:
        if not self.remote_server or not self.remote_token:
            return False
        try:
            payload = {"symbol": symbol}
            if extra_payload:
                payload.update(extra_payload)
            result = authorized_json_request(
                self.remote_server,
                self.remote_token,
                path,
                method="POST",
                payload=payload,
                timeout=5.0,
            )
            return bool(result.get("ok"))
        except ConnectionError:
            return False

    def add_tradingview_symbol(self, entry: tk.Entry, status: tk.Label) -> None:
        raw = entry.get().strip().upper()
        if not raw or any(char.isspace() for char in raw) or len(raw) > 60:
            status.configure(text="请输入有效代码，例如 NASDAQ:AAPL", fg="#f05b69")
            return

        def worker() -> None:
            ok = self.send_remote_action("/api/open-symbol", raw)

            def finish() -> None:
                if ok:
                    display_symbol = raw.rsplit(":", 1)[-1]
                    self.manual_symbols.add(display_symbol)
                    self.known_symbols.add(display_symbol)
                    if display_symbol not in self.symbol_order:
                        self.symbol_order.append(display_symbol)
                    if self.selected_symbols is not None:
                        self.selected_symbols.add(display_symbol)
                    self.persist()
                    self.render()
                    entry.delete(0, "end")
                    status.configure(
                        text=f"已请求 A 电脑打开 {raw}", fg="#35c986"
                    )
                else:
                    status.configure(
                        text="请求失败，请检查 A 电脑连接", fg="#f05b69"
                    )

            self.root.after(0, finish)

        threading.Thread(target=worker, daemon=True).start()

    def open_settings(self) -> None:
        super().open_settings()
        window = self.settings_window
        if window is None or not window.winfo_exists():
            return
        if getattr(window, "_remote_controls_added", False):
            return
        window._remote_controls_added = True  # type: ignore[attr-defined]
        frame = tk.Frame(window, bg="#1b2129", padx=10, pady=8)
        children = window.winfo_children()
        before = children[1] if len(children) > 1 else None
        pack_options: dict[str, Any] = {
            "fill": "x",
            "padx": 20,
            "pady": (0, 12),
        }
        if before is not None:
            pack_options["before"] = before
        frame.pack(**pack_options)
        tk.Label(
            frame,
            text="A 电脑连接",
            bg="#1b2129",
            fg="#e7edf3",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(side="left")
        tk.Button(
            frame,
            text="修改连接",
            command=self.open_connection_settings,
            bg="#2962ff",
            fg="#ffffff",
            activebackground="#1e4fd1",
            activeforeground="#ffffff",
            relief="flat",
            padx=10,
            pady=3,
        ).pack(side="right")

    def open_connection_settings(self) -> None:
        if self.connection_window is not None and self.connection_window.winfo_exists():
            self.connection_window.deiconify()
            self.connection_window.lift()
            self.connection_window.focus_force()
            return
        window = tk.Toplevel(self.root)
        self.connection_window = window
        window.title("连接 A 电脑（可缩放版 2）")
        window.geometry(f"620x440+{self.root.winfo_x()+40}+{self.root.winfo_y()+40}")
        window.minsize(500, 360)
        window.configure(bg="#151a20")
        window.attributes("-topmost", True)
        window.resizable(True, True)
        window.after_idle(lambda: enable_native_maximize(window))
        window.after(100, lambda: enable_native_maximize(window))

        tk.Label(
            window,
            text="连接 A 电脑行情主机",
            bg="#151a20",
            fg="#f4f7fa",
            font=("Segoe UI Semibold", 16),
            anchor="w",
        ).pack(fill="x", padx=22, pady=(20, 8))
        instructions = tk.Label(
            window,
            text="先在另一台电脑运行“A电脑-行情主机.exe”，再填写它显示的地址和密钥。",
            bg="#151a20",
            fg="#8d99a6",
            font=("Segoe UI", 9),
            anchor="w",
            justify="left",
            wraplength=536,
        )
        instructions.pack(fill="x", padx=22, pady=(0, 15))

        def resize_instructions(event: tk.Event) -> None:
            if event.widget is window:
                instructions.configure(wraplength=max(300, event.width - 44))

        window.bind("<Configure>", resize_instructions, add="+")

        address_entry = self.connection_entry(window, "A 电脑地址", self.remote_server)
        token_entry = self.connection_entry(window, "连接密钥", self.remote_token)
        message = tk.Label(
            window,
            text="",
            bg="#151a20",
            fg="#f1c75b",
            font=("Segoe UI", 9),
            anchor="w",
        )
        message.pack(fill="x", padx=22, pady=(10, 2))

        def save_and_test() -> None:
            address = normalize_server_address(address_entry.get())
            token = token_entry.get().strip()
            if not address or not token:
                message.configure(text="地址和连接密钥都必须填写", fg="#f05b69")
                return
            message.configure(text="正在测试连接…", fg="#f1c75b")

            def worker() -> None:
                try:
                    authorized_json_request(
                        address, token, "/api/health", timeout=5.0
                    )
                except ConnectionError as exc:
                    error_message = str(exc)
                    self.root.after(
                        0,
                        lambda error_message=error_message: message.configure(
                            text=error_message, fg="#f05b69"
                        ),
                    )
                    return
                except Exception:
                    self.root.after(
                        0,
                        lambda: message.configure(
                            text="连接测试发生未知错误", fg="#f05b69"
                        ),
                    )
                    return

                def finish() -> None:
                    self.remote_server = address
                    self.remote_token = token
                    config = load_config()
                    config["remote_server"] = address
                    config["remote_token"] = token
                    save_config(config)
                    self.remote_status = "连接成功，正在接收行情"
                    message.configure(text="连接成功", fg="#35c986")
                    window.after(500, close_window)

                self.root.after(0, finish)

            threading.Thread(target=worker, daemon=True).start()

        tk.Button(
            window,
            text="保存并测试连接",
            command=save_and_test,
            bg="#2962ff",
            fg="#ffffff",
            activebackground="#1e4fd1",
            activeforeground="#ffffff",
            relief="flat",
            padx=18,
            pady=7,
        ).pack(anchor="e", padx=22, pady=(5, 15))

        def close_window() -> None:
            if window.winfo_exists():
                window.destroy()
            self.connection_window = None

        window.protocol("WM_DELETE_WINDOW", close_window)

    @staticmethod
    def connection_entry(parent: tk.Misc, label: str, value: str) -> tk.Entry:
        row = tk.Frame(parent, bg="#151a20")
        row.pack(fill="x", padx=22, pady=4)
        tk.Label(
            row,
            text=label,
            width=12,
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI", 10),
            anchor="w",
        ).pack(side="left")
        entry = tk.Entry(
            row,
            bg="#222932",
            fg="#f4f7fa",
            insertbackground="#ffffff",
            relief="flat",
            font=("Cascadia Mono", 10),
        )
        entry.pack(side="left", fill="x", expand=True, ipady=6)
        entry.insert(0, value)
        return entry


if __name__ == "__main__":
    mp.freeze_support()
    if acquire_single_instance():
        RemoteQuoteOverlay().run()
