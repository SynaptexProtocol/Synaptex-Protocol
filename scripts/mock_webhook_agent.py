#!/usr/bin/env python3
import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/decide":
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}

        tokens = payload.get("snapshot", {}).get("tokens", {})
        eth = tokens.get("ETH", {})
        change = float(eth.get("change24h", 0) or 0)

        signals = []
        if change > 0.01:
            signals.append({
                "action": "BUY",
                "token": "ETH",
                "amount_usd": 120,
                "confidence": 0.72,
                "reason": "mock webhook momentum long",
            })
        elif change < -0.01:
            signals.append({
                "action": "SELL",
                "token": "ETH",
                "amount_usd": 120,
                "confidence": 0.72,
                "reason": "mock webhook momentum short",
            })

        out = {
            "schema_version": "2.0",
            "signals": signals,
        }
        data = json.dumps(out).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        return


def main() -> int:
    server = HTTPServer(("127.0.0.1", 9001), Handler)
    print("mock webhook agent listening on http://127.0.0.1:9001/decide")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

