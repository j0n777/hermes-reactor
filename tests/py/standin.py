"""A stand-in program path for tests that build a plan with a fake `which`.

The plan builder only accepts an absolute path to a file that exists, so a fake answer must be a real (empty) file,
outside every session folder. Nothing here is ever started.
"""

import tempfile
from pathlib import Path

_DIR = Path(tempfile.mkdtemp(prefix="reactor-standin-")).resolve()


def stand_in(name):
    path = _DIR / f"{name}.exe"
    path.touch()
    return str(path)
