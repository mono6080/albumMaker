import os
from pathlib import Path


BACKEND_DIR = Path(__file__).parent
UPLOADS_DIR = Path(os.environ.get("ALBUM_MAKER_UPLOADS_DIR", BACKEND_DIR / "uploads"))
