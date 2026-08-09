#!/usr/bin/env python3
# louie规则监控/回放共用（20260806版本）
"""Keep TradingView in the background while the monitor drives it via CDP.

Commands:
  save              print the current foreground window (hwnd/pid/title)
  unminimize        restore a minimized TradingView window without focus
  restore <hwnd>    if TradingView is in the foreground, return focus to hwnd
                    and push TradingView to the bottom of the z-order
"""

from __future__ import annotations

import ctypes
import json
import sys


user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

SW_SHOWNOACTIVATE = 4
HWND_BOTTOM = 1
SWP_NOMOVE = 0x0001
SWP_NOSIZE = 0x0002
SWP_NOACTIVATE = 0x0010
SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001


def is_tradingview_pid(pid: int) -> bool:
    try:
        import psutil

        return psutil.Process(pid).name().casefold() == "tradingview.exe"
    except Exception:
        return False


def foreground_hwnd() -> int:
    return int(user32.GetForegroundWindow())


def window_title(hwnd: int) -> str:
    try:
        buffer = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buffer, 256)
        return buffer.value
    except Exception:
        return ""


def save() -> None:
    hwnd = foreground_hwnd()
    pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    print(
        json.dumps(
            {"hwnd": hwnd, "pid": int(pid.value), "title": window_title(hwnd)},
            ensure_ascii=False,
        )
    )


def unminimize() -> None:
    """Restore minimized TradingView windows without stealing focus."""
    callback_type = ctypes.WINFUNCTYPE(
        ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
    )
    restored: list[int] = []

    def visit(hwnd: int, _lparam: int) -> bool:
        if not user32.IsWindowVisible(hwnd) or not user32.IsIconic(hwnd):
            return True
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not is_tradingview_pid(pid.value):
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
        restored.append(int(hwnd))
        return True

    user32.EnumWindows(callback_type(visit), 0)
    print(json.dumps({"unminimized": restored}))


def restore(hwnd: int) -> None:
    """Return focus to ``hwnd`` and keep TradingView behind other windows."""
    if not hwnd:
        print(json.dumps({"restored": False, "reason": "no_hwnd"}))
        return
    current = foreground_hwnd()
    current_pid = ctypes.c_ulong()
    user32.GetWindowThreadProcessId(current, ctypes.byref(current_pid))
    if not (is_tradingview_pid(current_pid.value) or current == hwnd):
        print(json.dumps({"restored": False, "reason": "foreground_unchanged"}))
        return

    # Windows restricts SetForegroundWindow from background processes; lift the
    # foreground lock temporarily and attach input queues to make it stick.
    timeout = ctypes.c_uint()
    user32.SystemParametersInfoW(
        SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(timeout), 0
    )
    user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, 0, 0)
    target_thread = user32.GetWindowThreadProcessId(hwnd, None)
    current_thread = kernel32.GetCurrentThreadId()
    attached = False
    if target_thread:
        attached = bool(user32.AttachThreadInput(current_thread, target_thread, True))
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(current_thread, target_thread, False)
        user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeout, 0)

    # TradingView may have been activated during CDP operations; push it to the
    # bottom of the z-order without taking focus away from the restored window.
    user32.SetWindowPos(
        current,
        HWND_BOTTOM,
        0,
        0,
        0,
        0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
    )
    print(json.dumps({"restored": True, "hwnd": hwnd}))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    command = sys.argv[1]
    if command == "save":
        save()
    elif command == "unminimize":
        unminimize()
    elif command == "restore" and len(sys.argv) >= 3:
        restore(int(sys.argv[2], 0))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
