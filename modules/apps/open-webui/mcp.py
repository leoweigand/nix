"""Prepare declarative MCP metadata using the pinned Open WebUI encryption format."""

import base64
import hashlib
import json
import os
from pathlib import Path
import sys

from cryptography.fernet import Fernet


def prepare_connections(connections, secret):
    # Open WebUI v0.13.0 utils/oauth.py uses the signing key unless overridden.
    key = secret.encode() if len(secret) == 44 else base64.urlsafe_b64encode(
        hashlib.sha256(secret.encode()).digest()
    )
    cipher = Fernet(key)
    for connection in connections:
        info = connection["info"]
        info["oauth_client_info"] = cipher.encrypt(
            json.dumps(info["oauth_client_info"]).encode()
        ).decode()
    return connections


if __name__ == "__main__":
    secret = os.environ.get("WEBUI_SECRET_KEY")
    if not secret:
        key_file = Path(os.environ["WEBUI_SECRET_KEY_FILE"])
        if not key_file.exists():
            # Match start.sh's generated key and keep it with the backed-up state.
            with key_file.open("x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
                output.write(base64.b64encode(os.urandom(24)).decode() + "\n")
        secret = key_file.read_text().strip()
    if not secret:
        raise ValueError("Open WebUI signing key is empty")
    os.environ["WEBUI_SECRET_KEY"] = secret
    connections = prepare_connections(
        json.loads(Path(sys.argv[1]).read_text()),
        os.environ.get("OAUTH_CLIENT_INFO_ENCRYPTION_KEY", secret),
    )
    os.environ["TOOL_SERVER_CONNECTIONS"] = json.dumps(connections)
    os.execvpe("bash", ["bash", "start.sh"], os.environ)
