"""Publication safety tests using synthetic files only; never open real schedules."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('pages', ROOT / 'scripts/build-pages.py')
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)

class PagesTests(unittest.TestCase):
    def setUp(self):
        (ROOT / 'test-data').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix='pages-synthetic-', dir=ROOT / 'test-data')
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'source'
        self.output = Path(self.temp.name) / 'output'
        self.files = list(pages.REQUIRED) + ['vendor/pdfjs/cmaps/example.bcmap', 'vendor/pdfjs/standard_fonts/example.ttf']
        for name in self.files:
            self.write(self.source, name, b'/* synthetic resource */')
        self.write(self.source, 'index.html', b'<link href="css/style.css"><script src="js/app.js"></script>')

    def write(self, root, name, data):
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def build(self):
        tracked = ('\0'.join(self.files) + '\0').encode()
        with patch.object(pages.subprocess, 'check_output', return_value=tracked):
            return pages.build_site(self.source, self.output)

    def test_only_tracked_website_files_published(self):
        for name in ['test-data/synthetic.pdf', 'tests/example.js', 'scripts/example.py', 'sources/example.xlsx', '.env', 'js/untracked.js', 'vendor/untracked.pdf']:
            self.write(self.source, name, b'never publish')
        self.assertEqual(self.build(), sorted(self.files))
        self.assertEqual(pages.validate_site(self.output), sorted(self.files))

    def test_forbidden_tracked_files_fail_before_copy(self):
        for name in ['js/synthetic.PDF', 'vendor/synthetic.xlsx', 'vendor/synthetic.xls', 'vendor/synthetic.csv', 'js/.env', 'js/.env.production', 'vendor/credentials.env', 'js/tests/example.js', 'vendor/sources/example.js']:
            with self.subTest(kind=Path(name).suffix):
                self.write(self.source, name, b'synthetic')
                self.files.append(name)
                with self.assertRaises(pages.UnsafeArtifact):
                    self.build()
                self.assertFalse(self.output.exists())
                self.files.pop()

    def test_renamed_documents_fail(self):
        for header in [b'%PDF-1.4 synthetic', b'PK\x03\x04synthetic', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1']:
            with self.subTest(format=header[:4]):
                self.write(self.source, 'js/app.js', header)
                with self.assertRaises(pages.UnsafeArtifact):
                    self.build()
                self.assertFalse(self.output.exists())

    def test_final_artifact_injection_fails(self):
        self.build()
        for name in ['test-data/synthetic.pdf', 'tests/example.js', 'scripts/example.py', 'sources/example.js', '.env', 'vendor/synthetic.xlsx']:
            with self.subTest(kind=Path(name).suffix):
                self.write(self.output, name, b'synthetic')
                with self.assertRaises(pages.UnsafeArtifact):
                    pages.validate_site(self.output)
                (self.output / name).unlink()
                parent = (self.output / name).parent
                if parent.name in {'test-data', 'tests', 'scripts', 'sources'}:
                    parent.rmdir()

    def test_symbolic_and_hard_links_fail(self):
        target = self.source / 'js/app.js'
        target.unlink()
        target.symlink_to(self.source / 'css/style.css')
        with self.assertRaises(pages.UnsafeArtifact):
            self.build()
        target.unlink()
        target.hardlink_to(self.source / 'css/style.css')
        with self.assertRaises(pages.UnsafeArtifact):
            self.build()

    def test_missing_worker_and_font_resources_fail(self):
        self.build()
        (self.output / 'vendor/pdfjs/pdf.worker.mjs').unlink()
        with self.assertRaises(pages.UnsafeArtifact):
            pages.validate_site(self.output)
        self.write(self.output, 'vendor/pdfjs/pdf.worker.mjs', b'/* synthetic */')
        (self.output / 'vendor/pdfjs/standard_fonts/example.ttf').unlink()
        with self.assertRaises(pages.UnsafeArtifact):
            pages.validate_site(self.output)

    def test_project_subpath_and_external_references(self):
        self.build()
        for reference in ['/js/app.js', '../js/app.js', 'https://example.org/sdk.js', 'js/missing.js']:
            self.write(self.output, 'index.html', f'<script src="{reference}"></script>'.encode())
            with self.assertRaises(pages.UnsafeArtifact):
                pages.validate_site(self.output)

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        self.write(self.output, 'keep.txt', b'unchanged')
        with self.assertRaises(pages.UnsafeArtifact):
            self.build()
        self.assertEqual((self.output / 'keep.txt').read_bytes(), b'unchanged')

    def test_real_website_artifact_inventory(self):
        # Reads only tracked public resources; never private schedule folders.
        inventory = pages.build_site(ROOT, self.output)
        self.assertGreater(len(inventory), len(pages.REQUIRED))
        self.assertTrue(all(pages.allowed_path(Path(name)) for name in inventory))
        self.assertEqual(pages.validate_site(self.output), inventory)

if __name__ == '__main__':
    unittest.main()
