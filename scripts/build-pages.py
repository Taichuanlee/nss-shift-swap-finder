"""Build/check a closed GitHub Pages artifact. Never read private schedule folders."""
import argparse
from pathlib import Path
import re
import shutil
import stat
import subprocess
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ('index.html', 'css/style.css', 'js/app.js', 'js/pdf-parser.js',
            'vendor/pdfjs/pdf.mjs', 'vendor/pdfjs/pdf.worker.mjs',
            'vendor/sheetjs/xlsx.full.min.js')
PRIVATE_DIRS = {'test-data', 'tests', 'scripts', 'sources', 'node_modules', '.git'}

class UnsafeArtifact(ValueError):
    pass

def allowed_path(path):
    parts = path.parts
    if not parts or any(part.startswith('.') or part.lower() in PRIVATE_DIRS for part in parts):
        return False
    if parts == ('index.html',):
        return True
    if len(parts) < 2:
        return False
    extensions = {'css': {'.css'}, 'js': {'.js', '.mjs'},
                  'vendor': {'.js', '.mjs', '.bcmap', '.pfb', '.ttf'}}
    if parts[0] not in extensions:
        return False
    if path.name.lower().startswith('license') and parts[0] == 'vendor':
        # Only the vendored license names already used by this project.
        return path.name in {'LICENSE', 'LICENSE_FOXIT', 'LICENSE_LIBERATION'}
    if parts == ('vendor', 'README.md'):
        return True
    return path.suffix.lower() in extensions[parts[0]]

def check_file(root, relative):
    if not allowed_path(relative):
        raise UnsafeArtifact('Forbidden file type or path in Pages artifact; no filenames logged.')
    path = root / relative
    for ancestor in (path, *path.parents):
        if ancestor == root:
            break
        if ancestor.is_symlink():
            raise UnsafeArtifact('Symbolic links are forbidden in Pages artifacts.')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise UnsafeArtifact('Only regular files without hard links may be published.')
    with path.open('rb') as stream:
        header = stream.read(1024)
    # Reject PDF, ZIP-based Office documents and legacy Excel even if renamed.
    if b'%PDF-' in header or header.startswith((b'PK\x03\x04', b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1')):
        raise UnsafeArtifact('Document/archive content is forbidden, including renamed files.')

def validate_site(site):
    if site.is_symlink() or not site.is_dir():
        raise UnsafeArtifact('Pages artifact must be a regular directory.')
    inventory = []
    for path in site.rglob('*'):
        relative = path.relative_to(site)
        if path.is_symlink():
            raise UnsafeArtifact('Symbolic links are forbidden in Pages artifacts.')
        if path.is_dir():
            if relative.parts[0] not in {'css', 'js', 'vendor'} or any(p.startswith('.') or p.lower() in PRIVATE_DIRS for p in relative.parts):
                raise UnsafeArtifact('Unexpected directory in Pages artifact.')
            continue
        check_file(site, relative)
        inventory.append(relative.as_posix())
    if not all((site / name).is_file() for name in REQUIRED):
        raise UnsafeArtifact('Required website resources are missing.')
    html = (site / 'index.html').read_text(encoding='utf8')
    # Verify real resource references against a project subpath, without rewriting them.
    base = 'https://example.github.io/nss-shift-swap-finder/'
    for reference in re.findall(r'(?:src|href)="([^"]+)"', html):
        if not urljoin(base, reference).startswith(base) or not (site / reference).is_file():
            raise UnsafeArtifact('Page resource is missing or escapes the project subpath.')
    for directory in ('vendor/pdfjs/cmaps', 'vendor/pdfjs/standard_fonts'):
        if not (site / directory).is_dir() or not any((site / directory).iterdir()):
            raise UnsafeArtifact('PDF text mapping or font resources are missing.')
    return sorted(inventory)

def build_site(source, output):
    source = source.resolve()
    if output.exists() or output.is_symlink():
        raise UnsafeArtifact('Use a fresh output directory; existing files are never overwritten.')
    tracked = subprocess.check_output(
        ['git', 'ls-files', '-z', '--', 'index.html', 'css/', 'js/', 'vendor/'], cwd=source
    ).decode('utf8').split('\0')
    files = [Path(name) for name in tracked if name]
    # Fail before copying anything if a tracked website file is unsafe.
    for relative in files:
        check_file(source, relative)
    output.mkdir(parents=True)
    for relative in files:
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    return validate_site(output)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/pages')
    parser.add_argument('--check-only', type=Path)
    args = parser.parse_args()
    try:
        inventory = validate_site(args.check_only) if args.check_only else build_site(ROOT, args.output)
    except (UnsafeArtifact, OSError, subprocess.SubprocessError, UnicodeError):
        # Avoid logging filenames that could themselves contain personal data.
        parser.exit(1, 'Pages safety check failed; no private filenames or contents logged.\n')
    print(f'Pages artifact safety check passed: {len(inventory)} website files, no document uploads.')

if __name__ == '__main__':
    main()
