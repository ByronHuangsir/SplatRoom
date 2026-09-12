import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
directory = sys.argv[2] if len(sys.argv) > 2 else "dist"

os.chdir(directory)


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        # SPA-friendly: never cache during preview
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
print(f"preview server on http://localhost:{port} (dir={directory})", flush=True)
httpd.serve_forever()
