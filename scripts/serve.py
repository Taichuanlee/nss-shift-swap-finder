"""Local static code server. Private schedule folders and POSTs are never served."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
import argparse
import re

ROOT = Path(__file__).resolve().parent.parent

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript'}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def allowed(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/':
            self.path = '/index.html'
            return True
        if not re.fullmatch(r'/(index\.html|(?:js|css|vendor)/[\w/.-]+)', path):
            return False
        target = (ROOT / path.lstrip('/')).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file():
            return False
        return target.suffix in {'.html', '.js', '.mjs', '.css', '.bcmap', '.pfb', '.ttf'}

    def do_GET(self):
        if not self.allowed():
            self.send_error(404, 'Only application resources are served')
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed():
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        self.send_error(405, 'Uploads are not supported')

    def log_message(self, format, *args):
        pass  # No document names or contents in request logs.

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8000)
    options = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', options.port), Handler)
    print(f'Open http://127.0.0.1:{options.port}/ — Ctrl+C to stop')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
