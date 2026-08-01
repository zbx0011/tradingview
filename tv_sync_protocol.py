from __future__ import annotations

import json
import secrets
import socket
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


DEFAULT_PORT = 8765
REQUEST_TIMEOUT_SECONDS = 4.0
# A/B synchronization runs over a LAN or Tailscale address.  Do not send these
# requests through the Windows/system proxy (for example FlClash), otherwise a
# private 100.x Tailscale address can be answered by the proxy with HTTP 502.
_DIRECT_OPENER = build_opener(ProxyHandler({}))


def normalize_server_address(value: str, default_port: int = DEFAULT_PORT) -> str:
    address = value.strip().rstrip("/")
    if not address:
        return ""
    if not address.startswith(("http://", "https://")):
        address = "http://" + address
    authority = address.split("://", 1)[1].split("/", 1)[0]
    if ":" not in authority:
        address += f":{default_port}"
    return address


def generate_token() -> str:
    return secrets.token_hex(8).upper()


def local_ipv4_addresses() -> list[str]:
    addresses: set[str] = set()
    primary_address = ""
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            address = info[4][0]
            if not address.startswith("127."):
                addresses.add(address)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        primary_address = probe.getsockname()[0]
        addresses.add(primary_address)
        probe.close()
    except OSError:
        pass
    return [
        *([primary_address] if primary_address else []),
        *sorted(address for address in addresses if address != primary_address),
    ]


def authorized_json_request(
    base_url: str,
    token: str,
    path: str,
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    url = normalize_server_address(base_url) + path
    body = None
    headers = {
        "Authorization": f"Bearer {token.strip()}",
        "Accept": "application/json",
    }
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with _DIRECT_OPENER.open(request, timeout=timeout) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 401:
            raise ConnectionError("连接密钥不正确") from exc
        raise ConnectionError(f"主机返回错误 {exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise ConnectionError("无法连接到 A 电脑") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ConnectionError("A 电脑返回了无法识别的数据") from exc
    if not isinstance(result, dict):
        raise ConnectionError("A 电脑返回了无效数据")
    return result


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(path)


def monotonic_age(timestamp: float) -> float:
    return max(0.0, time.monotonic() - timestamp)
