from __future__ import annotations

import ctypes
import json
import multiprocessing as mp
import msvcrt
import os
import queue
import re
import sqlite3
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import quote as url_quote

import psutil
import pythoncom
from pywinauto import Desktop


APP_NAME = "TradingView 悬浮行情"
POLL_SECONDS = 0.8
STALE_SECONDS = 5.0
HEALTHCHECK_SECONDS = 60.0
HEALTHCHECK_TIMEOUT_SECONDS = 12.0
SIGNAL_POLL_MILLISECONDS = 500
SW_SHOWNOACTIVATE = 4
SW_RESTORE = 9
HWND_BOTTOM = 1
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010

_instance_lock_file = None

SIGNAL_LONG_COLOR = "#35f28b"
SIGNAL_LONG_BACKGROUND = "#123c2b"
SIGNAL_SHORT_COLOR = "#ff5c6c"
SIGNAL_SHORT_BACKGROUND = "#472028"
SYMBOL_LINKS = {
    "BTCUSDT.P": "BYBIT:BTCUSDT.P",
    "XAGUSD": "OANDA:XAGUSD",
    "XAUUSD": "OANDA:XAUUSD",
    "US500": "CAPITALCOM:SPX500",
    "SPX500": "CAPITALCOM:SPX500",
}
SIGNAL_DISPLAY_SYMBOLS = {
    "SPX500": "US500",
}

PRICE_RE = re.compile(r"^[+\-−]?\d[\d,.]*$")
PERCENT_RE = re.compile(r"^[+\-−]?\d+(?:[.,]\d+)?%$")
TITLE_RE = re.compile(
    r"^(?P<symbol>\S{1,30})\s+(?P<arrow>[▲▼])\s+"
    r"(?P<price>[+\-−]?\d[\d,.]*)\s+"
    r"(?P<change>[+\-−]?\d+(?:[.,]\d+)?%)"
)
@dataclass(frozen=True)
class Quote:
    symbol: str
    price: str
    change: str
    direction: str
    seen_at: float


@dataclass(frozen=True)
class SignalAlert:
    id: int
    vendor: str
    symbol: str
    direction: str
    setup_type: str
    grade: str
    bar_time: int
    signal_price: float

def config_path() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "TVFloat"
    base.mkdir(parents=True, exist_ok=True)
    return base / "config.json"


def signal_db_path() -> Path:
    override = os.environ.get("TVFLOAT_SIGNAL_DB")
    if override:
        return Path(override).expanduser()
    return config_path().parent / "market.db"


def latest_processing_status_text() -> str:
    """Return the latest collector completion time and its review outcome."""
    path = config_path().parent / "candidate_queue.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        processed_at = datetime.fromtimestamp(path.stat().st_mtime)
    except (OSError, ValueError):
        return "最近处理：等待首次完成"
    candidates = payload.get("candidates", []) if isinstance(payload, dict) else []
    candidates = candidates if isinstance(candidates, list) else []
    result = "无候选"
    if candidates:
        current_keys = {
            (
                f"{candidate.get('vendor', '')}:{candidate.get('symbol', '')}:"
                f"{candidate.get('bar_time', '')}:{candidate.get('reason', '')}"
            )
            for candidate in candidates
            if isinstance(candidate, dict)
        }
        review_status_path = config_path().parent / "candidate_review_status.json"
        try:
            review_status = json.loads(
                review_status_path.read_text(encoding="utf-8-sig")
            )
        except (OSError, ValueError, TypeError):
            review_status = {}
        if (
            isinstance(review_status, dict)
            and review_status.get("key") in current_keys
            and review_status.get("status") in {"running", "failed", "timeout"}
        ):
            status = review_status.get("status")
            symbol = str(review_status.get("symbol", ""))
            model = str(review_status.get("model", ""))
            message = str(review_status.get("message", "")).strip()
            if status == "running":
                result = f"AI复核中：{symbol} · {model}"
            elif status == "timeout":
                result = f"复核超时：{symbol} · {message}"
            else:
                result = f"复核失败：{symbol} · {message}"
            if processed_at.date() == datetime.now().date():
                time_text = f"{processed_at:%H:%M:%S}"
            else:
                time_text = f"{processed_at:%m-%d %H:%M:%S}"
            return f"最近处理：{time_text}  ·  结果：{result}"
        signal_count = 0
        db_path = signal_db_path()
        if db_path.exists():
            try:
                connection = sqlite3.connect(
                    f"file:{db_path.as_posix()}?mode=ro",
                    uri=True,
                    timeout=0.2,
                )
                for candidate in candidates:
                    if not isinstance(candidate, dict):
                        continue
                    found = connection.execute(
                        """
                        SELECT 1 FROM signals
                        WHERE vendor=? AND symbol=? AND timeframe=? AND bar_time=?
                          AND grade IN ('A', 'B')
                        LIMIT 1
                        """,
                        (
                            str(candidate.get("vendor", "")),
                            str(candidate.get("symbol", "")),
                            str(candidate.get("timeframe", "5")),
                            int(candidate.get("bar_time", 0)),
                        ),
                    ).fetchone()
                    signal_count += int(found is not None)
                connection.close()
            except (OSError, sqlite3.Error, TypeError, ValueError):
                signal_count = 0
        if signal_count:
            result = f"{signal_count}个A/B级信号"
        else:
            reviewed_path = config_path().parent / "candidate_reviewed.json"
            try:
                reviewed = set(
                    json.loads(reviewed_path.read_text(encoding="utf-8-sig"))
                )
            except (OSError, ValueError, TypeError):
                reviewed = set()
            pending = 0
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                key = (
                    f"{candidate.get('vendor', '')}:{candidate.get('symbol', '')}:"
                    f"{candidate.get('timeframe', '5')}:"
                    f"{candidate.get('bar_time', '')}:{candidate.get('reason', '')}"
                )
                pending += int(key not in reviewed)
            result = (
                f"{pending}个候选待复核"
                if pending
                else "复核完成，无A/B信号"
            )
    if processed_at.date() == datetime.now().date():
        time_text = f"{processed_at:%H:%M:%S}"
    else:
        time_text = f"{processed_at:%m-%d %H:%M:%S}"
    return f"最近处理：{time_text}  ·  结果：{result}"


def load_config() -> dict:
    try:
        value = json.loads(config_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def save_config(value: dict) -> None:
    path = config_path()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def read_pending_signal_alerts() -> dict[str, SignalAlert]:
    path = signal_db_path()
    if not path.exists():
        return {}
    try:
        connection = sqlite3.connect(
            f"file:{path.as_posix()}?mode=ro",
            uri=True,
            timeout=0.2,
        )
        connection.row_factory = sqlite3.Row
        rows = connection.execute(
            """
            SELECT id, vendor, symbol, direction, setup_type, grade,
                   bar_time, signal_price
            FROM signals
            WHERE acknowledged_at IS NULL
              AND direction IN ('long', 'short')
              AND grade IN ('A', 'B')
            ORDER BY bar_time DESC, id DESC
            """
        ).fetchall()
        connection.close()
    except (OSError, sqlite3.Error):
        return {}

    alerts: dict[str, SignalAlert] = {}
    for row in rows:
        signal_symbol = str(row["symbol"]).upper()
        display_symbol = SIGNAL_DISPLAY_SYMBOLS.get(signal_symbol, signal_symbol)
        if display_symbol in alerts:
            continue
        alerts[display_symbol] = SignalAlert(
            id=int(row["id"]),
            vendor=str(row["vendor"]),
            symbol=signal_symbol,
            direction=str(row["direction"]),
            setup_type=str(row["setup_type"]),
            grade=str(row["grade"]),
            bar_time=int(row["bar_time"]),
            signal_price=float(row["signal_price"]),
        )
    return alerts


def acknowledge_symbol_alerts(symbol: str) -> int:
    path = signal_db_path()
    if not path.exists():
        return 0
    try:
        connection = sqlite3.connect(path, timeout=1.0)
        cursor = connection.execute(
            """
            UPDATE signals
            SET acknowledged_at=?
            WHERE symbol=? AND acknowledged_at IS NULL
            """,
            (int(time.time()), symbol.upper()),
        )
        connection.commit()
        count = cursor.rowcount
        connection.close()
        return count
    except (OSError, sqlite3.Error):
        return 0


def foreground_tradingview() -> None:
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not is_tradingview_process(pid.value):
            return True
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        return False

    user32.EnumWindows(callback_type(visit), 0)


def open_tradingview_symbol(symbol: str) -> bool:
    qualified = SYMBOL_LINKS.get(symbol.upper(), symbol.upper())
    url = (
        "https://www.tradingview.com/chart/?symbol="
        + url_quote(qualified, safe="")
        + "&interval=5"
    )
    try:
        os.startfile(url)
    except OSError:
        return False
    return True


def activate_tradingview_symbol_tab(symbol: str) -> bool:
    """Activate the matching chart tab in TradingView Desktop."""
    pythoncom.CoInitialize()
    try:
        candidates = []
        desktop = Desktop(backend="uia")
        for window in desktop.windows():
            try:
                if not is_tradingview_process(window.element_info.process_id):
                    continue
                window_rect = window.rectangle()
                for control in window.descendants(control_type="Text"):
                    try:
                        if control.window_text().strip() != symbol.upper():
                            continue
                        rect = control.rectangle()
                        # Top chart tabs are near the title bar. Restricting the
                        # search avoids duplicate symbols in the watchlist.
                        if rect.top <= window_rect.top + 95:
                            candidates.append((rect.top, rect.left, control))
                    except Exception:
                        continue
            except Exception:
                continue

        if not candidates:
            return False

        _, _, control = min(candidates, key=lambda item: (item[0], item[1]))
        # Invoke through UI Automation instead of sending a screen-coordinate
        # click. The always-on-top overlay may physically cover the chart tab.
        control.iface_invoke.Invoke()
        foreground_tradingview()
        return True
    except Exception:
        return False
    finally:
        pythoncom.CoUninitialize()


def navigate_to_tradingview_symbol(symbol: str) -> None:
    if activate_tradingview_symbol_tab(symbol):
        return
    if open_tradingview_symbol(symbol):
        time.sleep(0.7)
        foreground_tradingview()


def activate_existing_window() -> None:
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd: int, _lparam: int) -> bool:
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if buffer.value == APP_NAME:
            user32.ShowWindow(hwnd, SW_RESTORE)
            user32.SetForegroundWindow(hwnd)
            return False
        return True

    user32.EnumWindows(callback_type(visit), 0)


def acquire_single_instance() -> bool:
    global _instance_lock_file
    lock_path = config_path().parent / ".instance.lock"
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
        activate_existing_window()
        return False
    _instance_lock_file = lock_file
    return True


def is_tradingview_process(pid: int) -> bool:
    try:
        return psutil.Process(pid).name().casefold() == "tradingview.exe"
    except (psutil.Error, OSError):
        return False


def restore_minimized_tradingview_in_background() -> bool:
    """Restore minimized TradingView without taking focus from the current app."""
    user32 = ctypes.windll.user32
    restored = False
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd: int, _lparam: int) -> bool:
        nonlocal restored
        if not user32.IsWindowVisible(hwnd) or not user32.IsIconic(hwnd):
            return True
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not is_tradingview_process(pid.value):
            return True
        user32.ShowWindowAsync(hwnd, SW_SHOWNOACTIVATE)
        user32.SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        restored = True
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return restored


def looks_like_symbol(text: str) -> bool:
    if not text or len(text) > 30 or any(char.isspace() for char in text):
        return False
    return any(char.isalpha() for char in text) or text.isdigit()


def quote_from_parts(symbol: str, arrow: str, price: str, change: str) -> Quote:
    return Quote(
        symbol=symbol.strip(),
        price=price.strip(),
        change=change.strip(),
        direction="up" if arrow == "▲" else "down",
        seen_at=time.monotonic(),
    )


def parse_quotes(texts: list[str], title: str) -> dict[str, Quote]:
    result: dict[str, Quote] = {}

    # TradingView exposes every visible chart tab as four adjacent text nodes:
    # XAUUSD, ▼, 4,115.030, −0.36%
    for index in range(max(0, len(texts) - 3)):
        symbol, arrow, price, change = texts[index : index + 4]
        if (
            looks_like_symbol(symbol)
            and arrow in {"▲", "▼"}
            and PRICE_RE.fullmatch(price)
            and PERCENT_RE.fullmatch(change)
        ):
            result[symbol] = quote_from_parts(symbol, arrow, price, change)

    # The active tab also appears in the native window title. This fallback keeps
    # the tool useful if Chromium changes how its individual text nodes appear.
    match = TITLE_RE.match(title.strip())
    if match:
        parts = match.groupdict()
        result[parts["symbol"]] = quote_from_parts(
            parts["symbol"], parts["arrow"], parts["price"], parts["change"]
        )
    return result


def read_tradingview_quotes() -> dict[str, Quote]:
    quotes: dict[str, Quote] = {}
    desktop = Desktop(backend="uia")
    for window in desktop.windows(visible_only=False, enabled_only=False):
        try:
            pid = window.element_info.process_id
            if not is_tradingview_process(pid):
                continue
            title = window.window_text() or ""
            texts = [
                child.window_text().strip()
                for child in window.descendants(control_type="Text")
                if child.window_text().strip()
            ]
            quotes.update(parse_quotes(texts, title))
        except Exception:
            # TradingView may rebuild its Electron accessibility tree while a tab
            # changes. A later polling pass will retry with fresh elements.
            continue
    return quotes


def read_tradingview_quotes_worker(output: mp.Queue) -> None:
    pythoncom.CoInitialize()
    try:
        if restore_minimized_tradingview_in_background():
            time.sleep(0.35)
        output.put(read_tradingview_quotes())
    except Exception:
        output.put({})
    finally:
        pythoncom.CoUninitialize()


def read_tradingview_quotes_with_timeout(
    timeout_seconds: float,
) -> dict[str, Quote] | None:
    context = mp.get_context("spawn")
    output: mp.Queue = context.Queue(maxsize=1)
    process = context.Process(target=read_tradingview_quotes_worker, args=(output,))
    process.daemon = True
    process.start()
    process.join(timeout_seconds)
    if process.is_alive():
        process.terminate()
        process.join(2)
        return None
    try:
        return output.get_nowait()
    except queue.Empty:
        return {}


class QuoteOverlay:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg="#101317")

        config = load_config()
        self.opacity = min(1.0, max(0.35, float(config.get("opacity", 1.0))))
        self.font_size = min(24, max(8, int(config.get("font_size", 11))))
        self.symbol_price_gap = min(
            120, max(0, int(config.get("symbol_price_gap", 20)))
        )
        self.price_change_gap = min(
            80, max(0, int(config.get("price_change_gap", 12)))
        )
        self.root.attributes("-alpha", self.opacity)
        position = config.get("position", {})
        x = int(position.get("x", 40))
        y = int(position.get("y", 80))
        size = config.get("size", {})
        width = max(360, int(size.get("width", 440)))
        height = max(120, int(size.get("height", 160)))
        self.root.geometry(f"{width}x{height}+{x}+{y}")

        stored = config.get("selected_symbols", None)
        self.selected_symbols: set[str] | None = (
            set(stored) if isinstance(stored, list) else None
        )
        manual = config.get("manual_symbols", [])
        self.manual_symbols: set[str] = set(manual) if isinstance(manual, list) else set()
        self.known_symbols: set[str] = set(self.manual_symbols)
        stored_order = config.get("symbol_order", [])
        self.symbol_order: list[str] = (
            list(dict.fromkeys(item for item in stored_order if isinstance(item, str)))
            if isinstance(stored_order, list)
            else []
        )
        for symbol in sorted(self.known_symbols):
            if symbol not in self.symbol_order:
                self.symbol_order.append(symbol)
        self.quotes: dict[str, Quote] = {}
        self.active_alerts: dict[str, SignalAlert] = {}
        self.alert_flash_on = True
        self.results: queue.Queue[dict[str, Quote]] = queue.Queue(maxsize=1)
        self.stop_event = threading.Event()
        self.drag_origin: tuple[int, int, int, int] | None = None
        self.resize_origin: tuple[int, int, int, int] | None = None
        self.content_min_height = 120
        self.settings_window: tk.Toplevel | None = None
        stored_settings_position = config.get("settings_position", {})
        self.settings_position: dict[str, int] | None = (
            {
                "x": int(stored_settings_position["x"]),
                "y": int(stored_settings_position["y"]),
            }
            if isinstance(stored_settings_position, dict)
            and "x" in stored_settings_position
            and "y" in stored_settings_position
            else None
        )
        self.settings_drag_origin: tuple[int, int, int, int] | None = None

        self.container = tk.Frame(
            self.root,
            bg="#101317",
            highlightbackground="#303842",
            highlightthickness=1,
            padx=12,
            pady=9,
        )
        self.container.pack(fill="both", expand=True)

        self.header_bar = tk.Frame(self.container, bg="#101317")
        self.header_bar.pack(fill="x")
        self.header_text_area = tk.Frame(self.header_bar, bg="#101317")
        self.header_text_area.pack(side="left", fill="x", expand=True)
        self.header = tk.Label(
            self.header_text_area,
            text="TRADINGVIEW  ·  正在连接…",
            bg="#101317",
            fg="#7f8b99",
            font=("Segoe UI", max(8, self.font_size - 2)),
            anchor="w",
        )
        self.header.pack(fill="x")
        self.processing_status_last_checked = time.monotonic()
        self.processed_time = tk.Label(
            self.header_text_area,
            text=latest_processing_status_text(),
            bg="#101317",
            fg="#68727d",
            font=("Segoe UI", max(8, self.font_size - 3)),
            anchor="w",
        )
        self.processed_time.pack(fill="x")
        self.settings_button = tk.Button(
            self.header_bar,
            text="⚙",
            command=self.open_settings,
            bg="#101317",
            fg="#a9b3bd",
            activebackground="#252c34",
            activeforeground="#ffffff",
            relief="flat",
            borderwidth=0,
            cursor="hand2",
            font=("Segoe UI Symbol", 12),
            padx=5,
            pady=0,
        )
        self.settings_button.pack(side="right", anchor="n")

        self.rows = tk.Frame(self.container, bg="#101317")
        self.rows.pack(fill="both", expand=True, pady=(5, 0))
        self.rendered_symbols: list[str] = []
        self.row_widgets: dict[
            str, tuple[tk.Frame, tk.Label, tk.Label, tk.Label]
        ] = {}

        self.resize_grip = tk.Label(
            self.root,
            text="◢",
            bg="#101317",
            fg="#596471",
            cursor="size_nw_se",
            font=("Segoe UI Symbol", 10),
            padx=1,
            pady=0,
        )
        self.resize_grip.place(relx=1.0, rely=1.0, anchor="se")
        self.resize_grip.bind("<ButtonPress-1>", self.start_resize)
        self.resize_grip.bind("<B1-Motion>", self.resize)
        self.resize_grip.bind("<ButtonRelease-1>", self.end_resize)

        for widget in (
            self.root,
            self.container,
            self.header_bar,
            self.header_text_area,
            self.header,
            self.processed_time,
        ):
            widget.bind("<ButtonPress-1>", self.start_drag)
            widget.bind("<B1-Motion>", self.drag)
            widget.bind("<ButtonRelease-1>", self.end_drag)
            widget.bind("<Button-3>", self.show_menu)

        self.root.protocol("WM_DELETE_WINDOW", lambda: None)
        self.root.after(150, self.consume_results)
        self.root.after(250, self.poll_signal_alerts)
        threading.Thread(target=self.reader_loop, daemon=True).start()
        threading.Thread(target=self.healthcheck_loop, daemon=True).start()

    def publish_quotes(self, result: dict[str, Quote]) -> None:
        try:
            while True:
                self.results.get_nowait()
        except queue.Empty:
            pass
        try:
            self.results.put_nowait(result)
        except queue.Full:
            pass

    def reader_loop(self) -> None:
        pythoncom.CoInitialize()
        try:
            while not self.stop_event.is_set():
                if restore_minimized_tradingview_in_background():
                    # Electron needs a brief moment to rebuild the accessibility
                    # tree after leaving the minimized state.
                    self.stop_event.wait(0.35)
                result = read_tradingview_quotes()
                self.publish_quotes(result)
                self.stop_event.wait(POLL_SECONDS)
        finally:
            pythoncom.CoUninitialize()

    def healthcheck_loop(self) -> None:
        while not self.stop_event.wait(HEALTHCHECK_SECONDS):
            result = read_tradingview_quotes_with_timeout(HEALTHCHECK_TIMEOUT_SECONDS)
            if result is not None:
                self.publish_quotes(result)

    def consume_results(self) -> None:
        latest = None
        try:
            while True:
                latest = self.results.get_nowait()
        except queue.Empty:
            pass
        if latest is not None:
            self.quotes.update(latest)
            self.known_symbols.update(latest)
            for symbol in latest:
                if symbol not in self.symbol_order:
                    self.symbol_order.append(symbol)
            self.render()
        if not self.stop_event.is_set():
            self.root.after(200, self.consume_results)

    def poll_signal_alerts(self) -> None:
        latest = read_pending_signal_alerts()
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

    def visible_symbols(self) -> list[str]:
        selected = self.known_symbols if self.selected_symbols is None else self.selected_symbols
        return [
            *[symbol for symbol in self.symbol_order if symbol in selected],
            *sorted(selected.difference(self.symbol_order)),
        ]

    def ordered_known_symbols(self) -> list[str]:
        return [
            *[symbol for symbol in self.symbol_order if symbol in self.known_symbols],
            *sorted(self.known_symbols.difference(self.symbol_order)),
        ]

    def render(self) -> None:
        now = time.monotonic()
        symbols = self.visible_symbols()
        if symbols != self.rendered_symbols:
            for child in self.rows.winfo_children():
                child.destroy()
            self.row_widgets.clear()
            self.rendered_symbols = list(symbols)

            if symbols:
                for symbol in symbols:
                    row = tk.Frame(self.rows, bg="#101317")
                    row.pack(fill="x", pady=2)
                    row.grid_columnconfigure(0, minsize=130)
                    row.grid_columnconfigure(1, minsize=self.symbol_price_gap)
                    row.grid_columnconfigure(2, minsize=135)
                    row.grid_columnconfigure(3, minsize=self.price_change_gap)
                    row.grid_columnconfigure(4, minsize=85)
                    symbol_label = tk.Label(
                        row,
                        text=symbol,
                        anchor="w",
                        bg="#101317",
                        font=("Segoe UI Semibold", self.font_size),
                    )
                    symbol_label.grid(row=0, column=0, sticky="w")
                    price_label = tk.Label(
                        row,
                        anchor="e",
                        bg="#101317",
                        font=("Cascadia Mono", self.font_size),
                    )
                    price_label.grid(row=0, column=2, sticky="e")
                    change_label = tk.Label(
                        row,
                        anchor="e",
                        bg="#101317",
                        font=("Cascadia Mono", max(8, self.font_size - 1)),
                    )
                    change_label.grid(row=0, column=4, sticky="e")
                    self.row_widgets[symbol] = (
                        row,
                        symbol_label,
                        price_label,
                        change_label,
                    )
                    for widget in (row, symbol_label, price_label, change_label):
                        widget.configure(cursor="hand2")
                        widget.bind(
                            "<Button-1>",
                            lambda _event, item=symbol: self.on_symbol_click(item),
                        )
            else:
                tk.Label(
                    self.rows,
                    text="请在 TradingView 中打开图表标签",
                    anchor="w",
                    bg="#101317",
                    fg="#a9b3bd",
                    font=("Segoe UI", 10),
                ).pack(fill="x", pady=3)

        live_count = 0
        for symbol in symbols:
            quote = self.quotes.get(symbol)
            row, symbol_label, price_label, change_label = self.row_widgets[symbol]
            alert = self.active_alerts.get(symbol.upper())
            if quote is None:
                symbol_label.configure(text=symbol, fg="#a9b3bd")
                price_label.configure(text="", fg="#68727d")
                change_label.configure(text="等待…", fg="#68727d")
                stale = True
            else:
                stale = now - quote.seen_at > STALE_SECONDS
                if not stale:
                    live_count += 1
                color = (
                    "#68727d"
                    if stale
                    else ("#35c986" if quote.direction == "up" else "#f05b69")
                )
                symbol_label.configure(
                    text=symbol,
                    fg="#e7edf3" if not stale else "#68727d",
                )
                price_label.configure(
                    text=quote.price,
                    fg="#f4f7fa" if not stale else "#68727d",
                )
                change_label.configure(
                    text="暂停" if stale else quote.change,
                    fg=color,
                )

            background = "#101317"
            if alert is not None and self.alert_flash_on:
                if alert.direction == "long":
                    background = SIGNAL_LONG_BACKGROUND
                    alert_color = SIGNAL_LONG_COLOR
                    marker = "▲"
                else:
                    background = SIGNAL_SHORT_BACKGROUND
                    alert_color = SIGNAL_SHORT_COLOR
                    marker = "▼"
                symbol_label.configure(
                    text=f"{marker} {symbol}",
                    fg=alert_color,
                )
                price_label.configure(fg=alert_color)
                change_label.configure(
                    text=f"{alert.grade}级信号",
                    fg=alert_color,
                )
            row.configure(bg=background)
            for label in (symbol_label, price_label, change_label):
                label.configure(bg=background)

        if live_count:
            status = f"已连接  ·  {live_count} 个标的"
        else:
            status = "等待 TradingView 数据…"
        if self.active_alerts:
            status += f"  ·  {len(self.active_alerts)} 个新信号"
        self.header.configure(text=f"TRADINGVIEW  ·  {status}")
        if time.monotonic() - self.processing_status_last_checked >= 1.0:
            self.processing_status_last_checked = time.monotonic()
            self.processed_time.configure(text=latest_processing_status_text())
        self.root.update_idletasks()
        self.content_min_height = max(120, self.container.winfo_reqheight() + 12)
        required_width = max(360, self.container.winfo_reqwidth() + 12)
        current_width = max(self.root.winfo_width(), required_width)
        current_height = max(self.root.winfo_height(), self.content_min_height)
        self.root.geometry(f"{current_width}x{current_height}")
        self.resize_grip.lift()

    def on_symbol_click(self, symbol: str) -> None:
        alert = self.active_alerts.get(symbol.upper())
        if alert is not None:
            acknowledged = acknowledge_symbol_alerts(alert.symbol)
            if acknowledged:
                self.active_alerts.pop(symbol.upper(), None)
                self.alert_flash_on = False
                self.render()
        threading.Thread(
            target=navigate_to_tradingview_symbol,
            args=(symbol,),
            daemon=True,
            name=f"TradingViewNavigate-{symbol}",
        ).start()

    def start_drag(self, event: tk.Event) -> None:
        self.drag_origin = (event.x_root, event.y_root, self.root.winfo_x(), self.root.winfo_y())

    def drag(self, event: tk.Event) -> None:
        if self.drag_origin is None:
            return
        sx, sy, wx, wy = self.drag_origin
        self.root.geometry(f"+{wx + event.x_root - sx}+{wy + event.y_root - sy}")

    def end_drag(self, _event: tk.Event) -> None:
        self.drag_origin = None
        self.persist()

    def start_resize(self, event: tk.Event) -> None:
        self.resize_origin = (
            event.x_root,
            event.y_root,
            self.root.winfo_width(),
            self.root.winfo_height(),
        )

    def resize(self, event: tk.Event) -> None:
        if self.resize_origin is None:
            return
        sx, sy, width, height = self.resize_origin
        new_width = max(360, width + event.x_root - sx)
        new_height = max(self.content_min_height, height + event.y_root - sy)
        self.root.geometry(f"{new_width}x{new_height}")
        self.resize_grip.lift()

    def end_resize(self, _event: tk.Event) -> None:
        self.resize_origin = None
        self.persist()

    def toggle_symbol(self, symbol: str) -> None:
        if self.selected_symbols is None:
            self.selected_symbols = set(self.known_symbols)
        if symbol in self.selected_symbols:
            self.selected_symbols.remove(symbol)
        else:
            self.selected_symbols.add(symbol)
        self.persist()
        self.render()

    def show_all(self) -> None:
        self.selected_symbols = None
        self.persist()
        self.render()

    def set_opacity(self, value: str | float) -> None:
        self.opacity = min(1.0, max(0.35, float(value) / 100.0 if float(value) > 1 else float(value)))
        self.root.attributes("-alpha", self.opacity)
        self.persist()

    def set_font_size(self, value: str | float) -> None:
        new_size = min(24, max(8, int(round(float(value)))))
        if new_size == self.font_size:
            return
        self.font_size = new_size
        self.header.configure(font=("Segoe UI", max(8, self.font_size - 2)))
        self.processed_time.configure(font=("Segoe UI", max(8, self.font_size - 3)))
        self.rendered_symbols = []
        self.render()
        self.persist()

    def adjust_column_gap(
        self, attribute: str, delta: int, value_label: tk.Label
    ) -> None:
        maximum = 120 if attribute == "symbol_price_gap" else 80
        value = min(maximum, max(0, int(getattr(self, attribute)) + delta))
        setattr(self, attribute, value)
        value_label.configure(text=f"{value} px")
        self.rendered_symbols = []
        self.render()
        self.persist()

    def add_tradingview_symbol(self, entry: tk.Entry, status: tk.Label) -> None:
        raw = entry.get().strip().upper()
        if not raw or any(char.isspace() for char in raw) or len(raw) > 60:
            status.configure(text="请输入有效代码，例如 NASDAQ:AAPL", fg="#f05b69")
            return
        display_symbol = raw.rsplit(":", 1)[-1]
        self.manual_symbols.add(display_symbol)
        self.known_symbols.add(display_symbol)
        if display_symbol not in self.symbol_order:
            self.symbol_order.append(display_symbol)
        if self.selected_symbols is not None:
            self.selected_symbols.add(display_symbol)
        self.persist()
        self.render()
        url = "https://www.tradingview.com/chart/?symbol=" + url_quote(raw, safe="")
        try:
            os.startfile(url)  # TradingView Desktop handles TradingView links on Windows.
            status.configure(text=f"已请求打开 {raw}；检测到价格后自动更新", fg="#35c986")
            entry.delete(0, "end")
        except OSError:
            status.configure(text="无法打开 TradingView 链接，请确认桌面版已安装", fg="#f05b69")

    def open_settings(self) -> None:
        if self.settings_window is not None and self.settings_window.winfo_exists():
            self.settings_window.deiconify()
            self.settings_window.state("normal")
            self.settings_window.attributes("-topmost", True)
            self.settings_window.lift()
            self.settings_window.focus_force()
            return

        window = tk.Toplevel(self.root)
        self.settings_window = window
        window.title("悬浮行情设置")
        window.transient(self.root)
        settings_x = (
            self.settings_position["x"]
            if self.settings_position is not None
            else self.root.winfo_x() + 30
        )
        settings_y = (
            self.settings_position["y"]
            if self.settings_position is not None
            else self.root.winfo_y() + 30
        )
        window.geometry(f"460x800+{settings_x}+{settings_y}")
        window.configure(bg="#151a20")
        window.attributes("-topmost", True)
        window.minsize(420, 500)
        window.resizable(True, True)

        def start_settings_drag(event: tk.Event) -> None:
            self.settings_drag_origin = (
                event.x_root,
                event.y_root,
                window.winfo_x(),
                window.winfo_y(),
            )

        def drag_settings(event: tk.Event) -> None:
            if self.settings_drag_origin is None:
                return
            start_x, start_y, window_x, window_y = self.settings_drag_origin
            new_x = window_x + event.x_root - start_x
            new_y = window_y + event.y_root - start_y
            window.geometry(f"+{new_x}+{new_y}")
            self.settings_position = {"x": new_x, "y": new_y}

        def finish_settings_drag(_event: tk.Event | None = None) -> None:
            self.settings_drag_origin = None
            window.update_idletasks()
            self.settings_position = {"x": window.winfo_x(), "y": window.winfo_y()}
            self.persist()

        def close_settings() -> None:
            finish_settings_drag()
            window.destroy()
            self.settings_window = None

        window.protocol("WM_DELETE_WINDOW", close_settings)

        settings_heading = tk.Label(
            window,
            text="悬浮行情设置   ⋮⋮  拖动",
            bg="#151a20",
            fg="#f4f7fa",
            font=("Segoe UI Semibold", 16),
            anchor="w",
            cursor="fleur",
        )
        settings_heading.pack(fill="x", padx=20, pady=(18, 12))
        settings_heading.bind("<ButtonPress-1>", start_settings_drag)
        settings_heading.bind("<B1-Motion>", drag_settings)
        settings_heading.bind("<ButtonRelease-1>", finish_settings_drag)

        tk.Label(
            window,
            text="添加 TradingView 标的",
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(fill="x", padx=20)
        add_row = tk.Frame(window, bg="#151a20")
        add_row.pack(fill="x", padx=20, pady=(7, 3))
        entry = tk.Entry(
            add_row,
            bg="#222932",
            fg="#f4f7fa",
            insertbackground="#ffffff",
            relief="flat",
            font=("Cascadia Mono", 10),
        )
        entry.pack(side="left", fill="x", expand=True, ipady=7)
        status = tk.Label(
            window,
            text="输入完整代码，例如 BINANCE:ETHUSDT、NASDAQ:AAPL",
            bg="#151a20",
            fg="#7f8b99",
            font=("Segoe UI", 9),
            anchor="w",
        )
        status.pack(fill="x", padx=20)
        add_button = tk.Button(
            add_row,
            text="添加",
            bg="#2962ff",
            fg="#ffffff",
            activebackground="#1e4fd1",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            font=("Segoe UI Semibold", 10),
            padx=16,
            pady=5,
            command=lambda: self.add_tradingview_symbol(entry, status),
        )
        add_button.pack(side="right", padx=(8, 0))
        entry.bind("<Return>", lambda _event: self.add_tradingview_symbol(entry, status))

        symbols_heading = tk.Frame(window, bg="#151a20")
        symbols_heading.pack(fill="x", padx=20, pady=(20, 5))
        tk.Label(
            symbols_heading,
            text="显示的标的",
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(side="left")
        symbols_frame = tk.Frame(window, bg="#1b2129", padx=10, pady=8)
        symbols_frame.pack(fill="x", padx=20)
        symbol_rows: dict[str, tk.Frame] = {}
        dragged_symbol: str | None = None

        def start_symbol_drag(_event: tk.Event, symbol: str) -> None:
            nonlocal dragged_symbol
            dragged_symbol = symbol

        def finish_symbol_drag(event: tk.Event) -> None:
            nonlocal dragged_symbol
            source = dragged_symbol
            dragged_symbol = None
            if source is None or source not in symbol_rows:
                return
            candidates = [
                symbol for symbol in self.ordered_known_symbols() if symbol != source
            ]
            if not candidates:
                return
            target = min(
                candidates,
                key=lambda symbol: abs(
                    event.y_root
                    - (
                        symbol_rows[symbol].winfo_rooty()
                        + symbol_rows[symbol].winfo_height() / 2
                    )
                ),
            )
            target_center = (
                symbol_rows[target].winfo_rooty()
                + symbol_rows[target].winfo_height() / 2
            )
            insert_at = candidates.index(target)
            if event.y_root > target_center:
                insert_at += 1
            candidates.insert(insert_at, source)
            self.symbol_order = candidates
            self.persist()
            self.render()
            populate_symbols()

        def populate_symbols() -> None:
            symbol_rows.clear()
            for child in symbols_frame.winfo_children():
                child.destroy()
            if self.known_symbols:
                for symbol in self.ordered_known_symbols():
                    enabled = tk.BooleanVar(
                        value=self.selected_symbols is None or symbol in self.selected_symbols
                    )

                    def update_symbol(item: str = symbol, variable: tk.BooleanVar = enabled) -> None:
                        if self.selected_symbols is None:
                            self.selected_symbols = set(self.known_symbols)
                        if variable.get():
                            self.selected_symbols.add(item)
                        else:
                            self.selected_symbols.discard(item)
                        self.persist()
                        self.render()

                    symbol_row = tk.Frame(symbols_frame, bg="#1b2129")
                    symbol_row.pack(fill="x")
                    symbol_rows[symbol] = symbol_row
                    drag_handle = tk.Label(
                        symbol_row,
                        text="☰",
                        bg="#1b2129",
                        fg="#7f8b99",
                        activebackground="#252c34",
                        font=("Segoe UI Symbol", 10),
                        cursor="fleur",
                        padx=3,
                    )
                    drag_handle.pack(side="left")
                    drag_handle.bind(
                        "<ButtonPress-1>",
                        lambda event, item=symbol: start_symbol_drag(event, item),
                    )
                    drag_handle.bind("<ButtonRelease-1>", finish_symbol_drag)

                    tk.Checkbutton(
                        symbol_row,
                        text=symbol,
                        variable=enabled,
                        command=update_symbol,
                        bg="#1b2129",
                        fg="#e7edf3",
                        activebackground="#1b2129",
                        activeforeground="#ffffff",
                        selectcolor="#252c34",
                        anchor="w",
                        font=("Cascadia Mono", 10),
                    ).pack(side="left", fill="x", expand=True)
            else:
                tk.Label(
                    symbols_frame,
                    text="尚未检测到图表标签",
                    bg="#1b2129",
                    fg="#7f8b99",
                    font=("Segoe UI", 9),
                ).pack(anchor="w")

        tk.Button(
            symbols_heading,
            text="刷新列表",
            command=populate_symbols,
            bg="#252c34",
            fg="#c9d1d9",
            activebackground="#303842",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            font=("Segoe UI", 9),
            padx=10,
            pady=2,
        ).pack(side="right")
        populate_symbols()

        tk.Label(
            window,
            text="三列间距",
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(fill="x", padx=20, pady=(18, 5))

        def add_gap_control(title: str, attribute: str) -> None:
            control = tk.Frame(window, bg="#1b2129", padx=10, pady=5)
            control.pack(fill="x", padx=20, pady=2)
            tk.Label(
                control,
                text=title,
                bg="#1b2129",
                fg="#e7edf3",
                font=("Segoe UI", 9),
                anchor="w",
            ).pack(side="left", fill="x", expand=True)
            value_label = tk.Label(
                control,
                text=f"{getattr(self, attribute)} px",
                width=7,
                bg="#1b2129",
                fg="#a9b3bd",
                font=("Cascadia Mono", 9),
            )
            value_label.pack(side="right", padx=5)
            tk.Button(
                control,
                text="+",
                command=lambda: self.adjust_column_gap(attribute, 4, value_label),
                bg="#2962ff",
                fg="#ffffff",
                activebackground="#1e4fd1",
                activeforeground="#ffffff",
                relief="flat",
                cursor="hand2",
                font=("Segoe UI Semibold", 10),
                width=3,
            ).pack(side="right")
            tk.Button(
                control,
                text="−",
                command=lambda: self.adjust_column_gap(attribute, -4, value_label),
                bg="#252c34",
                fg="#ffffff",
                activebackground="#303842",
                activeforeground="#ffffff",
                relief="flat",
                cursor="hand2",
                font=("Segoe UI Semibold", 10),
                width=3,
            ).pack(side="right")

        add_gap_control("标的 ↔ 价格", "symbol_price_gap")
        add_gap_control("价格 ↔ 涨跌", "price_change_gap")

        tk.Label(
            window,
            text="窗口透明度",
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(fill="x", padx=20, pady=(20, 3))
        scale = tk.Scale(
            window,
            from_=35,
            to=100,
            orient="horizontal",
            command=self.set_opacity,
            bg="#151a20",
            fg="#e7edf3",
            troughcolor="#303842",
            activebackground="#2962ff",
            highlightthickness=0,
            length=410,
        )
        scale.set(round(self.opacity * 100))
        scale.pack(padx=20)

        tk.Label(
            window,
            text="行情字体大小",
            bg="#151a20",
            fg="#c9d1d9",
            font=("Segoe UI Semibold", 10),
            anchor="w",
        ).pack(fill="x", padx=20, pady=(15, 3))
        font_scale = tk.Scale(
            window,
            from_=8,
            to=24,
            orient="horizontal",
            command=self.set_font_size,
            bg="#151a20",
            fg="#e7edf3",
            troughcolor="#303842",
            activebackground="#2962ff",
            highlightthickness=0,
            length=410,
        )
        font_scale.set(self.font_size)
        font_scale.pack(padx=20)

        tk.Button(
            window,
            text="完成",
            command=close_settings,
            bg="#2a313a",
            fg="#ffffff",
            activebackground="#38424e",
            activeforeground="#ffffff",
            relief="flat",
            cursor="hand2",
            font=("Segoe UI Semibold", 10),
            padx=24,
            pady=7,
        ).pack(side="bottom", pady=18)

    def show_menu(self, event: tk.Event) -> None:
        menu = tk.Menu(self.root, tearoff=False, bg="#171c22", fg="#e7edf3")
        menu.add_command(label="显示的标的", state="disabled")
        if self.known_symbols:
            for symbol in self.ordered_known_symbols():
                checked = self.selected_symbols is None or symbol in self.selected_symbols
                menu.add_command(
                    label=("✓  " if checked else "    ") + symbol,
                    command=lambda item=symbol: self.toggle_symbol(item),
                )
            menu.add_command(label="显示全部", command=self.show_all)
        else:
            menu.add_command(label="尚未发现图表标签", state="disabled")
        menu.add_separator()
        menu.add_command(label="窗口已锁定运行", state="disabled")
        menu.tk_popup(event.x_root, event.y_root)

    def persist(self) -> None:
        save_config(
            {
                "position": {"x": self.root.winfo_x(), "y": self.root.winfo_y()},
                "size": {
                    "width": self.root.winfo_width(),
                    "height": self.root.winfo_height(),
                },
                "selected_symbols": (
                    None if self.selected_symbols is None else sorted(self.selected_symbols)
                ),
                "manual_symbols": sorted(self.manual_symbols),
                "symbol_order": self.symbol_order,
                "opacity": self.opacity,
                "font_size": self.font_size,
                "symbol_price_gap": self.symbol_price_gap,
                "price_change_gap": self.price_change_gap,
                "settings_position": self.settings_position,
            }
        )

    def close(self) -> None:
        self.persist()
        self.stop_event.set()
        self.root.destroy()

    def run(self) -> None:
        self.root.mainloop()


if __name__ == "__main__":
    mp.freeze_support()
    if acquire_single_instance():
        QuoteOverlay().run()
