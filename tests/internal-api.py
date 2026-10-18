"""Exercise the generated internal namespace policy using a real Caddy server."""

import http.client
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

fixture = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert fixture["legacyUnchanged"], "Existing notification route changed"
assert "*.internal.leolab.party" in fixture["tls"]
assert "ai.internal 60 IN A 192.168.2.4" in fixture["lan"]
assert "ai.internal 60 IN A 100.104.119.103" in fixture["tailnet"]


class Backend(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
threading.Thread(target=backend.serve_forever, daemon=True).start()
with socket.socket() as reservation:
    reservation.bind(("127.0.0.1", 0))
    port = reservation.getsockname()[1]

with tempfile.TemporaryDirectory(prefix="ai-caddy-check-") as directory:
    config_path = pathlib.Path(directory) / "Caddyfile"
    route = fixture["caddy"].replace(
        "127.0.0.1:9088", f"127.0.0.1:{backend.server_port}"
    )
    config_path.write_text(
        "{\n"
        "  admin off\n"
        "  auto_https off\n"
        "  servers {\n"
        "    trusted_proxies static 127.0.0.0/8\n"
        "    trusted_proxies_strict\n"
        "    client_ip_headers CF-Connecting-IP\n"
        "  }\n"
        "}\n"
        f"http://*.internal.leolab.party:{port} {{\n{route}\n}}\n"
    )
    subprocess.run(
        ["caddy", "validate", "--config", str(config_path), "--adapter", "caddyfile"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    with open(pathlib.Path(directory) / "caddy.log", "w+") as log:
        process = subprocess.Popen(
            ["caddy", "run", "--config", str(config_path), "--adapter", "caddyfile"],
            stdout=log,
            stderr=log,
        )
        try:
            for attempt in range(100):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError("Caddy exited before accepting connections")
                    time.sleep(0.05)
            else:
                raise RuntimeError("Caddy did not start")

            def request(client_ip, host="ai.internal.leolab.party", extra=None):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                headers = {"Host": host, "Content-Type": "application/json"}
                if client_ip:
                    headers["CF-Connecting-IP"] = client_ip
                headers.update(extra or {})
                try:
                    connection.request(
                        "POST", "/v1/chat/completions", b'{"message":"body preserved"}', headers
                    )
                    response = connection.getresponse()
                    return response.status, response.read()
                finally:
                    connection.close()

            # Simulate cloudflared's trusted header as well as direct loopback calls.
            for client_ip in [None, "127.0.0.1", "10.88.0.5", "100.64.1.2"]:
                status, body = request(client_ip)
                assert status == 200, (client_ip, status, body)
                assert body == b'{"message":"body preserved"}'
            assert request("100.64.1.2", host="probe.internal.leolab.party")[0] == 200
            assert request("203.0.113.10", host="probe.internal.leolab.party")[0] == 403
            for client_ip in ["192.168.2.20", "203.0.113.10", "::1"]:
                assert request(client_ip)[0] == 403, client_ip
            assert request(
                "203.0.113.10",
                extra={"X-Forwarded-For": "127.0.0.1", "X-Real-IP": "100.64.1.2"},
            )[0] == 403
            assert request("100.64.1.2", host="missing.internal.leolab.party")[0] == 404
            assert request("203.0.113.10", host="missing.internal.leolab.party")[0] == 403
            print(
                "PASS: internal DNS/TLS, shared Caddy routing, request bodies, "
                "approved networks, LAN/public denial, spoofed headers, unknown hosts"
            )
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            process.terminate()
            process.wait(timeout=5)
backend.shutdown()
backend.server_close()
