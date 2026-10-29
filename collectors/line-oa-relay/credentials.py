"""Read only the already configured IyakusaiBot credential. Never print it."""
from pathlib import Path
import shlex
from oa_relay import ValidationError


def read_env(path):
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        try:
            parts = shlex.split(value, comments=True)
        except ValueError:
            continue
        values[key.strip()] = parts[0] if parts else ""
    return values


def existing_token():
    env = read_env(Path.home() / "iyakusai/secrets.env")
    token = env.get("DISCORD_TOKEN")
    if not token and env.get("DISCORD_TOKEN_FILE"):
        path = Path(env["DISCORD_TOKEN_FILE"]).expanduser()
        data = path.read_text(encoding="utf-8").strip()
        token = read_env(path).get("DISCORD_TOKEN") if "=" in data else data
    if not token:
        raise ValidationError("existing_bot_token_unavailable")
    return token
