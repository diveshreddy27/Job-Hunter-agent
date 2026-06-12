"""
Daily usage tracker for Gemini API models.

Reads/writes staging/model_usage/YYYY-MM-DD.json.
Thread-safe — both the extractor and scorer share one tracker instance.

Usage in a cascade:
    tracker = ModelUsageTracker()
    for model, limits in cfg.GEMINI_MODEL_LIMITS.items():
        if not tracker.is_available(model, limits["rpd"]):
            continue
        try:
            result = call_api(model, ...)
            tracker.record_call(model)
            break
        except RateLimitError:
            tracker.mark_exhausted(model)
            continue
"""
import json
import logging
import pathlib
import threading
from datetime import date

log = logging.getLogger("utils.model_tracker")

_USAGE_DIR = pathlib.Path(__file__).parent.parent / "data" / "model_usage"


class ModelUsageTracker:
    """Thread-safe daily usage counter per model."""

    def __init__(self, usage_dir: pathlib.Path = _USAGE_DIR):
        self._dir  = pathlib.Path(usage_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._data: dict = {}
        self._today = ""
        self._reload()

    # ── Public API ────────────────────────────────────────────────────────────

    def is_available(self, model_id: str, daily_limit: int) -> bool:
        """Return True if this model still has quota today."""
        with self._lock:
            self._refresh_day()
            entry = self._data.get(model_id, {})
            if entry.get("exhausted"):
                return False
            return entry.get("calls", 0) < daily_limit

    def record_call(self, model_id: str) -> int:
        """Increment call count. Returns new total."""
        with self._lock:
            self._refresh_day()
            entry = self._data.setdefault(model_id, {"calls": 0, "exhausted": False})
            entry["calls"] += 1
            self._save()
            return entry["calls"]

    def mark_exhausted(self, model_id: str) -> None:
        """Mark model as quota-exhausted for today (skip on 429)."""
        with self._lock:
            self._refresh_day()
            entry = self._data.setdefault(model_id, {"calls": 0, "exhausted": False})
            entry["exhausted"] = True
            self._save()
            log.warning("[model_tracker] %s marked exhausted for today (%s)",
                        model_id, self._today)

    def today_summary(self) -> dict:
        """Return a copy of today's usage data."""
        with self._lock:
            self._refresh_day()
            return dict(self._data)

    def print_status(self, model_limits: dict) -> None:
        """Log a human-readable usage table."""
        summary = self.today_summary()
        log.info("── Model usage for %s ─────────────────────", self._today)
        for model_id, limits in model_limits.items():
            entry  = summary.get(model_id, {})
            calls  = entry.get("calls", 0)
            limit  = limits.get("rpd", "?")
            status = "EXHAUSTED" if entry.get("exhausted") else f"{calls}/{limit}"
            log.info("  %-35s  %s", model_id, status)
        log.info("───────────────────────────────────────────────────")

    # ── Internal ──────────────────────────────────────────────────────────────

    def _today_str(self) -> str:
        return date.today().isoformat()

    def _file_path(self) -> pathlib.Path:
        return self._dir / f"{self._today}.json"

    def _refresh_day(self) -> None:
        """If the date rolled over, reload from today's file (or start fresh)."""
        today = self._today_str()
        if today != self._today:
            self._today = today
            self._reload()

    def _reload(self) -> None:
        self._today = self._today_str()
        fp = self._file_path()
        if fp.exists():
            try:
                self._data = json.loads(fp.read_text(encoding="utf-8"))
            except Exception:
                self._data = {}
        else:
            self._data = {}

    def _save(self) -> None:
        try:
            self._file_path().write_text(
                json.dumps(self._data, indent=2), encoding="utf-8"
            )
        except Exception as e:
            log.warning("[model_tracker] Could not save usage file: %s", e)


# ── Singleton shared across extractor + scorer threads ───────────────────────
_tracker = None  # type: ModelUsageTracker
_tracker_lock = threading.Lock()


def get_tracker() -> ModelUsageTracker:
    global _tracker
    if _tracker is None:
        with _tracker_lock:
            if _tracker is None:
                _tracker = ModelUsageTracker()
    return _tracker
