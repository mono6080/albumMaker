"""Docker healthcheck：優先透過 uvicorn UDS，否則檢查 localhost TCP。"""

import os
import socket


def check() -> bool:
    uds_path = os.getenv("ALBUM_MAKER_SOCKET", "/album_maker_socket/app.sock")
    if os.path.exists(uds_path):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        address = uds_path
    else:
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        address = ("127.0.0.1", int(os.getenv("PORT", "8765")))
    client.settimeout(4)
    try:
        client.connect(address)
        client.sendall(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        chunks = []
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)
        response = b"".join(chunks)
        return response.startswith(b"HTTP/1.1 200") and b'"status":"ok"' in response
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(0 if check() else 1)
