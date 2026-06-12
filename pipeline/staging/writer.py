"""
StagingWriter — buffers raw scraped posts and flushes them to JSON batch
files in staging/raw/. The processor thread picks these files up.

Each file is a JSON array of raw post dicts. File names are timestamped
so they sort chronologically and can't collide across runs.
"""
import json
import logging
import pathlib
from datetime import datetime, timezone

log = logging.getLogger("staging.writer")


class StagingWriter:
    def __init__(self, staging_dir, batch_size: int = 10):
        self._raw_dir = pathlib.Path(staging_dir) / "raw"
        self._raw_dir.mkdir(parents=True, exist_ok=True)
        # Pre-create training dir used by model/train.py
        (pathlib.Path(staging_dir) / "training").mkdir(parents=True, exist_ok=True)
        self._batch_size = batch_size
        self._buffer: list[dict] = []

    def add(self, post: dict) -> None:
        """Buffer one post. Flushes to disk automatically at batch_size."""
        self._buffer.append(post)
        if len(self._buffer) >= self._batch_size:
            self.flush()

    def flush(self) -> int:
        """Write whatever is buffered to a new file. Returns posts written."""
        if not self._buffer:
            return 0
        ts   = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        path = self._raw_dir / f"batch_{ts}.json"
        n    = len(self._buffer)
        path.write_text(
            json.dumps(self._buffer, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        log.info("[writer] Flushed %d post(s) → %s", n, path.name)
        self._buffer = []
        return n

    def __len__(self) -> int:
        return len(self._buffer)
