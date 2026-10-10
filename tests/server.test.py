"""Synthetic HTTP checks: never open or log any actual schedule."""
import importlib.util
import threading
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
spec = importlib.util.spec_from_file_location('serve', Path(__file__).resolve().parent.parent / 'scripts/serve.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LocalServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), module.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def test_app_resources(self):
        for path in ['/', '/js/pdf-parser.js', '/vendor/pdfjs/pdf.mjs', '/css/style.css']:
            with urlopen(self.origin+path) as response:
                self.assertEqual(response.status, 200)
                response.read()

    def test_private_paths_and_traversal_blocked(self):
        for path in ['/test-data/example.pdf', '/sources/example.pdf', '/.git/config', '/README.md', '/vendor/../../.git/config', '/vendor/%2e%2e/%2e%2e/.git/config', '/js/', '/test-data/']:
            with self.assertRaises(HTTPError) as error:
                urlopen(self.origin+path)
            self.assertEqual(error.exception.code, 404)

    def test_uploads_blocked(self):
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.origin+'/index.html',data=b'fictional',method='POST'))
        self.assertEqual(error.exception.code, 405)

if __name__ == '__main__':
    unittest.main()
