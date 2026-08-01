from __future__ import annotations

import ctypes
import json
import multiprocessing as mp
import msvcrt
import os
import queue
import threading
import time
import tkinter as tk
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import quote as url_quote

import pythoncom

from tv_float import (
    HEALTHCHECK_SECONDS,
    HEALTHCHECK_TIMEOUT_SECONDS,
    POLL_SECONDS,
    Quote,
    acknowledge_symbol_alerts,
    latest_processing_status_text,
    navigate_to_tradingview_symbol,
    read_pending_signal_alerts,
    read_tradingview_quotes,
    read_tradingview_quotes_with_timeout,
    restore_minimized_tradingview_in_background,
)
from tv_sync_protocol import (
    DEFAULT_PORT,
    atomic_write_json,
    generate_token,
    local_ipv4_addresses,
)


HOST_APP_NAME = "TradingView 行情同步主机（A电脑）"
_host_lock_file = None


def host_config_path() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloatHost"
    return base / "config.json"


def load_host_config() -> dict[str, Any]:
    try:
        value = json.loads(host_config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        value = {}
    if not isinstance(value, dict):
        value = {}
    value.setdefault("port", DEFAULT_PORT)
    value.setdefault("token", generate_token())
    return value


def activate_existing_host_window() -> None:
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(
        ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
    )

    def visit(hwnd: int, _lparam: int) -> bool:
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if buffer.value == HOST_APP_NAME:
            user32.ShowWindow(hwnd, 9)
            user32.SetForegroundWindow(hwnd)
            return False
        return True

    user32.EnumWindows(callback_type(visit), 0)


def acquire_host_single_instance() -> bool:
    global _host_lock_file
    lock_path = host_config_path().parent / ".host-instance.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_file = lock_path.open("a+b")
    lock_file.seek(0, os.SEEK_END)
    if lock_file.tell() == 0:
        lock_file.write(b"0")
        lock_file.flush()
    lock_file.seek(0)
    try:
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        lock_file.close()
        activate_existing_host_window()
        return False
    _host_lock_file = lock_file
    return True


class QuoteState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.quotes: dict[str, Quote] = {}
        self.last_success_wall_time = 0.0
        self.last_error = ""

    def update(self, quotes: dict[str, Quote]) -> None:
        with self.lock:
            if quotes:
                self.quotes.update(quotes)
                self.last_success_wall_time = time.time()
                self.last_error = ""

    def set_error(self, message: str) -> None:
        with self.lock:
            self.last_error = message

    def payload(self) -> dict[str, Any]:
        now = time.monotonic()
        pending_alerts = read_pending_signal_alerts()
        with self.lock:
            rows = [
                {
                    "symbol": quote.symbol,
                    "price": quote.price,
                    "change": quote.change,
                    "direction": quote.direction,
                    "age_seconds": max(0.0, now - quote.seen_at),
                }
                for quote in self.quotes.values()
            ]
            return {
                "ok": True,
                "server_time": time.time(),
                "last_success_time": self.last_success_wall_time,
                "last_error": self.last_error,
                "processing_status": latest_processing_status_text(),
                "alerts": [
                    {
                        "display_symbol": display_symbol,
                        "id": alert.id,
                        "vendor": alert.vendor,
                        "symbol": alert.symbol,
                        "direction": alert.direction,
                        "setup_type": alert.setup_type,
                        "grade": alert.grade,
                        "bar_time": alert.bar_time,
                        "signal_price": alert.signal_price,
                    }
                    for display_symbol, alert in pending_alerts.items()
                ],
                "quotes": rows,
            }


class SyncRequestHandler(BaseHTTPRequestHandler):
    server_version = "TVFloatSync/1.0"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    @property
    def sync_server(self) -> "QuoteHttpServer":
        return self.server  # type: ignore[return-value]

    def send_json(self, status: int, value: dict[str, Any]) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def is_authorized(self) -> bool:
        expected = f"Bearer {self.sync_server.token}"
        return self.headers.get("Authorization", "") == expected

    def read_payload(self) -> dict[str, Any]:
        try:
            length = min(4096, int(self.headers.get("Content-Length", "0")))
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            return value if isinstance(value, dict) else {}
        except (ValueError, UnicodeError):
            return {}

    def do_GET(self) -> None:
        if not self.is_authorized():
            self.send_json(401, {"ok": False, "error": "unauthorized"})
            return
        if self.path == "/api/quotes":
            self.send_json(200, self.sync_server.quote_state.payload())
            return
        if self.path == "/api/health":
            self.send_json(200, {"ok": True, "server_time": time.time()})
            return
        self.send_json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if not self.is_authorized():
            self.send_json(401, {"ok": False, "error": "unauthorized"})
            return
        payload = self.read_payload()
        symbol = str(payload.get("symbol", "")).strip().upper()
        if not symbol or any(character.isspace() for character in symbol) or len(symbol) > 60:
            self.send_json(400, {"ok": False, "error": "invalid_symbol"})
            return
        if self.path == "/api/open-symbol":
            qualified = symbol
            url = "https://www.tradingview.com/chart/?symbol=" + url_quote(
                qualified, safe=""
            )

            def open_symbol() -> None:
                try:
                    os.startfile(url)
                except OSError:
                    pass

            threading.Thread(target=open_symbol, daemon=True).start()
            self.send_json(200, {"ok": True})
            return
        if self.path == "/api/acknowledge-alert":
            try:
                signal_id = int(payload.get("signal_id", 0))
            except (TypeError, ValueError):
                signal_id = 0
            acknowledged = (
                acknowledge_symbol_alerts(symbol, through_id=signal_id)
                if signal_id > 0
                else 0
            )
            self.send_json(
                200,
                {
                    "ok": True,
                    "signal_id": signal_id,
                    "symbol": symbol,
                    "acknowledged": acknowledged,
                },
            )
            return
        if self.path == "/api/activate-symbol":
            threading.Thread(
                target=navigate_to_tradingview_symbol,
                args=(symbol.rsplit(":", 1)[-1],),
                daemon=True,
            ).start()
            self.send_json(200, {"ok": True})
            return
        self.send_json(404, {"ok": False, "error": "not_found"})


class QuoteHttpServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port: int, token: str, quote_state: QuoteState) -> None:
        self.token = token
        self.quote_state = quote_state
        super().__init__(("0.0.0.0", port), SyncRequestHandler)


class HostWindow:
    def __init__(self) -> None:
        self.config = load_host_config()
        atomic_write_json(host_config_path(), self.config)
        self.port = min(65535, max(1024, int(self.config["port"])))
        self.token = str(self.config["token"]).strip()
        self.quote_state = QuoteState()
        self.stop_event = threading.Event()
        self.http_server: QuoteHttpServer | None = None

        self.root = tk.Tk()
        self.root.title(HOST_APP_NAME)
        self.root.geometry("760x430")
        self.root.minsize(700, 390)
        self.root.configure(bg="#11161c")
        self.root.attributes("-topmost", False)
        self.root.protocol("WM_DELETE_WINDOW", self.hide_window)

        heading = tk.Label(
            self.root,
            text="A 电脑 · TradingView 行情主机",
            bg="#11161c",
            fg="#f4f7fa",
            font=("Segoe UI Semibold", 18),
            anchor="w",
        )
        heading.pack(fill="x", padx=24, pady=(22, 6))
        tk.Label(
            self.root,
            text="保持本程序和 TradingView 运行，B 电脑即可同步显示。",
            bg="#11161c",
            fg="#9aa6b2",
            font=("Segoe UI", 10),
            anchor="w",
        ).pack(fill="x", padx=24)

        connection = tk.Frame(self.root, bg="#1a212a", padx=14, pady=12)
        connection.pack(fill="x", padx=24, pady=(20, 12))
        addresses = local_ipv4_addresses()
        address_text = " / ".join(f"{address}:{self.port}" for address in addresses)
        if not address_text:
            address_text = f"请查看本机 IPv4 地址，端口 {self.port}"
        self.address_label = self.add_info_row(connection, "连接地址", address_text)
        self.token_label = self.add_info_row(connection, "连接密钥", self.token)

        buttons = tk.Frame(self.root, bg="#11161c")
        buttons.pack(fill="x", padx=24)
        tk.Button(
            buttons,
            text="复制 B 电脑连接信息",
            command=self.copy_connection,
            bg="#2962ff",
            fg="#ffffff",
            activebackground="#1e4fd1",
            activeforeground="#ffffff",
            relief="flat",
            padx=16,
            pady=7,
        ).pack(side="left")
        tk.Button(
            buttons,
            text="最小化窗口（主机继续运行）",
            command=self.hide_window,
            bg="#28313c",
            fg="#d8e0e8",
            activebackground="#35414e",
            activeforeground="#ffffff",
            relief="flat",
            padx=16,
            pady=7,
        ).pack(side="left", padx=10)

        self.status_label = tk.Label(
            self.root,
            text="正在启动…",
            bg="#11161c",
            fg="#f1c75b",
            font=("Segoe UI Semibold", 11),
            anchor="w",
        )
        self.status_label.pack(fill="x", padx=24, pady=(24, 4))
        self.detail_label = tk.Label(
            self.root,
            text="",
            bg="#11161c",
            fg="#7f8b99",
            font=("Segoe UI", 9),
            anchor="w",
        )
        self.detail_label.pack(fill="x", padx=24)

        threading.Thread(target=self.reader_loop, daemon=True).start()
        threading.Thread(target=self.healthcheck_loop, daemon=True).start()
        threading.Thread(target=self.serve_loop, daemon=True).start()
        self.root.after(500, self.refresh_status)

    @staticmethod
    def add_info_row(parent: tk.Frame, title: str, value: str) -> tk.Label:
        row = tk.Frame(parent, bg="#1a212a")
        row.pack(fill="x", pady=3)
        tk.Label(
            row,
            text=title,
            width=10,
            bg="#1a212a",
            fg="#9aa6b2",
            font=("Segoe UI", 10),
            anchor="w",
        ).pack(side="left")
        label = tk.Label(
            row,
            text=value,
            bg="#1a212a",
            fg="#f4f7fa",
            font=("Cascadia Mono", 10),
            anchor="w",
        )
        label.pack(side="left", fill="x", expand=True)
        return label

    def copy_connection(self) -> None:
        addresses = local_ipv4_addresses()
        address = addresses[0] if addresses else "A电脑IPv4地址"
        text = f"地址={address}:{self.port}\n密钥={self.token}"
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status_label.configure(text="连接信息已复制", fg="#35c986")

    def hide_window(self) -> None:
        self.root.iconify()

    def serve_loop(self) -> None:
        try:
            self.http_server = QuoteHttpServer(
                self.port, self.token, self.quote_state
            )
            self.http_server.serve_forever(poll_interval=0.5)
        except OSError as exc:
            self.quote_state.set_error(f"端口 {self.port} 启动失败：{exc}")

    def reader_loop(self) -> None:
        pythoncom.CoInitialize()
        try:
            while not self.stop_event.is_set():
                try:
                    if restore_minimized_tradingview_in_background():
                        self.stop_event.wait(0.35)
                    self.quote_state.update(read_tradingview_quotes())
                except Exception as exc:
                    self.quote_state.set_error(f"读取失败：{exc}")
                self.stop_event.wait(POLL_SECONDS)
        finally:
            pythoncom.CoUninitialize()

    def healthcheck_loop(self) -> None:
        while not self.stop_event.wait(HEALTHCHECK_SECONDS):
            result = read_tradingview_quotes_with_timeout(
                HEALTHCHECK_TIMEOUT_SECONDS
            )
            if result is not None:
                self.quote_state.update(result)

    def refresh_status(self) -> None:
        payload = self.quote_state.payload()
        quote_count = len(payload["quotes"])
        server_ready = self.http_server is not None
        if server_ready and quote_count:
            self.status_label.configure(
                text=f"主机运行中 · 已读取 {quote_count} 个标的", fg="#35c986"
            )
            latest = float(payload["last_success_time"])
            self.detail_label.configure(
                text=f"最后更新：{time.strftime('%H:%M:%S', time.localtime(latest))}"
            )
        elif server_ready:
            self.status_label.configure(
                text="主机运行中 · 等待 TradingView 标签页数据", fg="#f1c75b"
            )
            self.detail_label.configure(text=str(payload["last_error"]))
        else:
            self.status_label.configure(text="正在启动同步服务…", fg="#f1c75b")
        if not self.stop_event.is_set():
            self.root.after(500, self.refresh_status)

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    mp.freeze_support()
    if acquire_host_single_instance():
        HostWindow().run()
