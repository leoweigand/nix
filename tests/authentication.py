"""Exercise generated Caddy gates and the real OAuth2 Proxy against an isolated IdP."""

import base64
import hashlib
import http.client
import http.cookies
import json
import os
import shlex
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa


fixture = json.loads(Path(sys.argv[1]).read_text())
backend_requests = []
auth_requests = []
auth_state = {"status": 401}
oidc_state = {"groups": ["admins"], "codes": {}}
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def integer(value):
    return b64(value.to_bytes((value.bit_length() + 7) // 8, "big"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body=b"", headers=()):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Backend(Handler):
    def do_GET(self):
        if self.headers.get("Upgrade", "").lower() == "websocket":
            # WebSocket uses standard base64, including its padding.
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            first = self.rfile.read(2)
            mask = self.rfile.read(4)
            data = self.rfile.read(first[1] & 127)
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
            self.wfile.write(b"\x81" + bytes([len(payload)]) + payload)
            self.wfile.flush()
            backend_requests.append({"method": "WEBSOCKET"})
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        result = {
            "method": self.command,
            "path": self.path,
            "body": body.decode(),
            "user": self.headers.get("Remote-User"),
        }
        backend_requests.append(result)
        self.send(200, json.dumps(result).encode())

    do_POST = do_GET


class Authoriser(Handler):
    def do_GET(self):
        auth_requests.append(dict(self.headers))
        assert self.path == "/", self.path
        self.send(auth_state["status"], headers=[
            ("X-Auth-Request-Preferred-Username", "leo"),
            ("Set-Cookie", "renewed=one; Secure; HttpOnly; Path=/"),
            ("Set-Cookie", "second=two; Secure; HttpOnly; Path=/"),
        ])


class IdP(Handler):
    def json(self, value):
        self.send(200, json.dumps(value).encode(), [("Content-Type", "application/json")])

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/.well-known/openid-configuration":
            self.json({
                "issuer": issuer,
                "authorization_endpoint": issuer + "/authorize",
                "token_endpoint": issuer + "/token",
                "userinfo_endpoint": issuer + "/userinfo",
                "jwks_uri": issuer + "/jwks",
                "response_types_supported": ["code"],
                "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"],
                "token_endpoint_auth_methods_supported": ["client_secret_basic"],
                "code_challenge_methods_supported": ["S256"],
            })
        elif url.path == "/jwks":
            public = key.public_key().public_numbers()
            self.json({"keys": [{"kty": "RSA", "kid": "test", "use": "sig",
                                 "alg": "RS256", "n": integer(public.n), "e": integer(public.e)}]})
        elif url.path == "/authorize":
            query = urllib.parse.parse_qs(url.query)
            assert query["code_challenge_method"] == ["S256"]
            code = str(len(oidc_state["codes"]) + 1)
            oidc_state["codes"][code] = {"query": query, "groups": list(oidc_state["groups"])}
            callback = query["redirect_uri"][0] + "?" + urllib.parse.urlencode({
                "code": code, "state": query["state"][0],
            })
            self.send(302, headers=[("Location", callback)])
        elif url.path == "/userinfo":
            self.json({"sub": "leo", "email": "leo@leolab.party", "email_verified": True})
        else:
            self.send(404)

    def do_POST(self):
        assert self.path == "/token"
        query = urllib.parse.parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
        code = oidc_state["codes"][query["code"][0]]
        challenge = b64(hashlib.sha256(query["code_verifier"][0].encode()).digest())
        assert challenge == code["query"]["code_challenge"][0]
        claims = {
            "iss": issuer, "aud": "test-client", "sub": "leo", "iat": int(time.time()),
            "exp": int(time.time()) + 7200, "email": "leo@leolab.party", "email_verified": True,
            "preferred_username": "leo", "groups": code["groups"],
        }
        if "nonce" in code["query"]:
            claims["nonce"] = code["query"]["nonce"][0]
        unsigned = b64(json.dumps({"alg": "RS256", "kid": "test"}).encode()) + "." + b64(json.dumps(claims).encode())
        token = unsigned + "." + b64(key.sign(unsigned.encode(), padding.PKCS1v15(), hashes.SHA256()))
        self.json({"access_token": "test-access", "refresh_token": "test-refresh", "token_type": "Bearer",
                   "expires_in": 7200, "id_token": token})


def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def request(port, host, path, method="GET", body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request(method, path, body=body, headers={"Host": host, **(headers or {})})
    response = conn.getresponse()
    result = response.status, response.getheaders(), response.read()
    conn.close()
    return result


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def websocket(port, cookies):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as sock:
        key = base64.b64encode(b"test-websocket!!").decode()
        request_headers = ["GET /socket HTTP/1.1", "Host: notes.leolab.party", "Upgrade: websocket",
                           "Connection: Upgrade", "Sec-WebSocket-Version: 13", f"Sec-WebSocket-Key: {key}",
                           "Cookie: " + "; ".join(f"{name}={value}" for name, value in cookies.items())]
        sock.sendall(("\r\n".join(request_headers) + "\r\n\r\n").encode())
        stream = sock.makefile("rb")
        assert b"101" in stream.readline()
        while stream.readline() != b"\r\n":
            pass
        payload = b"authenticated websocket"
        mask = b"abcd"
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        sock.sendall(b"\x81" + bytes([128 | len(payload)]) + mask + masked)
        header = stream.read(2)
        assert stream.read(header[1] & 127) == payload


def wait_http(process, port, host, path="/"):
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(f"Service exited with {process.returncode}; inspect its log")
        try:
            request(port, host, path)
            return
        except (OSError, http.client.HTTPException):
            time.sleep(0.1)
    raise RuntimeError("Service did not start")


def start_caddy(directory, auth_port, backend_port):
    port = available_port()
    sites = []
    for name, text in fixture["sites"].items():
        text = text.replace("127.0.0.1:4180", f"127.0.0.1:{auth_port}")
        for old in [3000, 9696]:
            text = text.replace(f"127.0.0.1:{old}", f"127.0.0.1:{backend_port}")
        sites.append(f"http://{name}.leolab.party:{port} {{\n{text}\n}}")
    path = directory / "Caddyfile"
    path.write_text("{\n admin off\n auto_https off\n}\n" + "\n".join(sites))
    subprocess.run(["caddy", "validate", "--config", str(path), "--adapter", "caddyfile"], check=True)
    log = (directory / "caddy.log").open("w+")
    process = subprocess.Popen(["caddy", "run", "--config", str(path), "--adapter", "caddyfile"], stdout=log, stderr=log)
    wait_http(process, port, "notes.leolab.party")
    return process, port


def stop(process):
    process.terminate()
    process.wait(timeout=10)


def login(caddy_port, idp_port, original):
    cookies = {}
    url = "https://notes.leolab.party" + original
    for _ in range(12):
        parsed = urllib.parse.urlsplit(url)
        port = idp_port if parsed.hostname == "127.0.0.1" else caddy_port
        path = parsed.path + ("?" + parsed.query if parsed.query else "")
        status, headers, body = request(port, parsed.netloc, path, headers={
            "Cookie": "; ".join(f"{name}={value}" for name, value in cookies.items()),
        })
        for name, value in headers:
            if name.lower() == "set-cookie":
                parsed_cookie = http.cookies.SimpleCookie(value)
                for cookie_name, morsel in parsed_cookie.items():
                    if morsel["max-age"] == "0":
                        cookies.pop(cookie_name, None)
                    else:
                        cookies[cookie_name] = morsel.value
        if status not in [301, 302, 303]:
            return status, body, cookies, url
        location = next(value for name, value in headers if name.lower() == "location")
        url = urllib.parse.urljoin(url, location)
    raise AssertionError("Login redirect loop")


with tempfile.TemporaryDirectory() as temp:
    directory = Path(temp)
    backend = serve(Backend)
    auth = serve(Authoriser)
    caddy, caddy_port = start_caddy(directory, auth.server_port, backend.server_port)
    try:
        before = len(backend_requests)
        assert request(caddy_port, "notes.leolab.party", "/private")[0] == 401
        assert len(backend_requests) == before, "Unauthenticated request reached backend"
        for host, path in [("notes", "/service_worker.js"), ("notes", "/.client/app.js"),
                           ("prowlarr", "/api/v1/status"), ("prowlarr", "/123/api")]:
            assert request(caddy_port, host + ".leolab.party", path)[0] == 200
        assert request(caddy_port, "notes.leolab.party", "/.client-other")[0] == 401
        assert request(caddy_port, "prowlarr.leolab.party", "/api/v2/status")[0] == 401

        auth_state["status"] = 202
        path = "/save?first=a%26b&next=%2Fpath&rd=https%3A%2F%2Fevil.example"
        status, headers, body = request(caddy_port, "notes.leolab.party", path, "POST", "keep this body", {
            "Remote-User": "attacker", "X-Auth-Request-Redirect": "https://evil.example/",
        })
        assert status == 200
        received = json.loads(body)
        assert received == {"method": "POST", "path": path, "body": "keep this body", "user": None}, received
        assert auth_requests[-1]["X-Auth-Request-Redirect"] == "https://notes.leolab.party" + path
        assert auth_requests[-1]["X-Forwarded-Method"] == "POST"
        assert len([value for name, value in headers if name.lower() == "set-cookie"]) == 2
        assert json.loads(request(caddy_port, "identity.leolab.party", "/", headers={"Remote-User": "attacker"})[2])["user"] == "leo"
        auth_state["status"] = 503
        before = len(backend_requests)
        assert request(caddy_port, "notes.leolab.party", "/private")[0] == 503
        assert len(backend_requests) == before
        auth.shutdown()
        auth.server_close()
        assert request(caddy_port, "notes.leolab.party", "/private")[0] == 502
        assert len(backend_requests) == before
    finally:
        stop(caddy)

    assert len([message for message in fixture["assertionFailures"] if "Protected edge route" in message]) >= 8
    print("Caddy: denials, outages, bypass boundaries, cookies, user headers and POST bodies passed", flush=True)

    idp = serve(IdP)
    issuer = f"http://127.0.0.1:{idp.server_port}"
    oauth_port = available_port()
    args = shlex.split(fixture["oauthCommand"])
    args = [arg.replace("127.0.0.1:4180", f"127.0.0.1:{oauth_port}")
            .replace("https://id.leolab.party", issuer) for arg in args]
    env = {**os.environ, "OAUTH2_PROXY_CLIENT_ID": "test-client", "OAUTH2_PROXY_CLIENT_SECRET": "test-secret",
           "OAUTH2_PROXY_COOKIE_SECRET": b64(b"a" * 32)}
    log = (directory / "oauth2-proxy.log").open("w+")
    oauth = subprocess.Popen(args, env=env, stdout=log, stderr=log)
    try:
        wait_http(oauth, oauth_port, "login.leolab.party", "/ping")
        caddy, caddy_port = start_caddy(directory, oauth_port, backend.server_port)
        try:
            original = "/private?term=a%26b&next=%2Ffoo%3Fbar%3D1&rd=https%3A%2F%2Fidentity.leolab.party%2Fother"
            status, body, cookies, url = login(caddy_port, idp.server_port, original)
            assert status == 200, (status, body)
            assert url == "https://notes.leolab.party" + original, url
            assert json.loads(body)["path"] == original
            assert "__Secure-leolab_gateway" in cookies
            websocket(caddy_port, cookies)
            oidc_state["groups"] = ["outsiders"]
            before = len(backend_requests)
            status, _, _, _ = login(caddy_port, idp.server_port, "/private")
            assert status == 403, status
            assert len(backend_requests) == before
        finally:
            stop(caddy)
    except Exception:
        log.seek(0)
        print(log.read())
        raise
    finally:
        stop(oauth)
        idp.shutdown()
    print("OAuth2 Proxy: signed OIDC login, PKCE, original URLs, WebSockets and group denial passed", flush=True)

    smoke = directory / "pocket-id"
    (smoke / "uploads").mkdir(parents=True)
    pocket_port = available_port()
    settings = {**fixture["pocketSettings"], "APP_URL": f"http://localhost:{pocket_port}",
                "PORT": pocket_port, "DB_CONNECTION_STRING": str(smoke / "pocket-id.db"),
                "UPLOAD_PATH": str(smoke / "uploads"), "VERSION_CHECK_DISABLED": True,
                "ENCRYPTION_KEY": "isolated-test-encryption-key-32chars"}
    env = {**os.environ, **{name: str(value).lower() if isinstance(value, bool) else str(value)
                           for name, value in settings.items()}}
    log = (directory / "pocket-id.log").open("w+")
    previous_keys = None
    for _ in range(2):
        pocket = subprocess.Popen([fixture["pocketBinary"]], env=env, cwd=smoke, stdout=log, stderr=log)
        try:
            wait_http(pocket, pocket_port, "localhost", "/.well-known/openid-configuration")
            status, _, body = request(pocket_port, "localhost", "/.well-known/openid-configuration")
            assert status == 200
            assert json.loads(body)["issuer"] == settings["APP_URL"]
            status, _, body = request(pocket_port, "localhost", "/.well-known/jwks.json")
            assert status == 200
            signing_keys = json.loads(body)
            assert signing_keys["keys"]
            if previous_keys is not None:
                assert signing_keys == previous_keys, "Signing keys changed after restart"
            previous_keys = signing_keys
        except Exception:
            log.seek(0)
            print(log.read())
            raise
        finally:
            stop(pocket)
    print("Pocket ID: configured binary starts and preserves signing keys across restarts", flush=True)

    # Run the actual backup command against a database with uncheckpointed WAL writes.
    data = directory / "state"
    backup = directory / "backup"
    (data / "uploads").mkdir(parents=True)
    backup.mkdir()
    (data / "uploads" / "logo.txt").write_text("profile upload")
    conn = sqlite3.connect(data / "pocket-id.db")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("CREATE TABLE users (name TEXT)")
    conn.execute("INSERT INTO users VALUES ('leo')")
    conn.commit()
    script = Path(fixture["backupScript"]).read_text().replace(fixture["dataDir"], str(data)).replace(fixture["backupDir"], str(backup))
    subprocess.run(["bash", "-c", script], check=True)
    restored = sqlite3.connect(backup / "pocket-id.db")
    assert restored.execute("SELECT name FROM users").fetchall() == [("leo",)]
    assert restored.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert (backup / "uploads" / "logo.txt").read_text() == "profile upload"
    restored.close()
    conn.close()
    print("SQLite: backup includes committed WAL writes and restores with intact uploads", flush=True)

print("Authentication checks passed")
