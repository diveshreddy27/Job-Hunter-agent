"""
ATS scorer — unified model cascade + 2 parallel workers.

Model selection:
  All scoring models (Gemini + Groq) are tried in a single priority-ordered
  list defined in settings.ATS_UNIFIED_MODELS (best → worst quality).
  For each job the cascade always starts at index 0, so better models are
  automatically preferred again once their rate-limit window expires.

Rate limiting (reactive):
  _AvailabilityTracker — shared across workers.
    • On 429: mark model as unavailable for `reset_seconds` (from response
      headers / body); skip it until the window expires.
    • After a successful Groq call: mark model limited proactively when
      remaining tokens < GROQ_SCORE_MIN_TOK_REMAINING.
    • ModelUsageTracker (utils/model_tracker.py): tracks daily RPD counts
      for Gemini models; models over their daily quota are permanently
      skipped until tomorrow.

Worker flow (per job, sequential):
  pull job → run unified cascade → insert score → pull next job
  Two workers run this loop in parallel (2 jobs in flight at once).
  model_used and provider columns record which model/API scored each job.
"""
import json
import logging
import pathlib
import queue
import sys
import threading
import time

import requests

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent.parent))

from db import database as db
import settings as cfg
from utils.model_tracker import get_tracker

log = logging.getLogger("ats.scorer")

RESUME_DIR  = pathlib.Path(__file__).parent.parent.parent / "resume"
PROMPT_FILE = pathlib.Path(__file__).parent.parent.parent / "prompts" / "ats_prompt.txt"
MAX_POST_CHARS = 4_000

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models"
    "/{model}:generateContent?key={key}"
)
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


# ── Rate-limit availability tracker ──────────────────────────

class _AvailabilityTracker:
    """
    Tracks temporary (RPM/TPM) rate limits per model, shared across workers.

    When a model returns 429, call .mark_limited(model, reset_seconds).
    Before trying a model, call .is_available(model).
    Because the cascade always starts at index 0 (best model) for each new
    job, better models are automatically preferred once they reset.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._available_at: dict[str, float] = {}

    def mark_limited(self, model: str, reset_seconds: float) -> None:
        with self._lock:
            self._available_at[model] = time.time() + max(reset_seconds, 1.0) + 1.0
        log.info("[avail] %s rate-limited — available in %.0fs", model, reset_seconds)

    def is_available(self, model: str) -> bool:
        with self._lock:
            return time.time() >= self._available_at.get(model, 0.0)

    def seconds_until(self, model: str) -> float:
        with self._lock:
            return max(0.0, self._available_at.get(model, 0.0) - time.time())

    def wait_for_any(self, model_ids: list[str]) -> None:
        """Block until at least one model in the list becomes available."""
        while True:
            with self._lock:
                now = time.time()
                if any(now >= self._available_at.get(m, 0.0) for m in model_ids):
                    return
                soonest = min(self._available_at.get(m, now) for m in model_ids)
                wait = soonest - now + 0.5
            soonest_model = min(model_ids, key=lambda m: self._available_at.get(m, 0.0))
            log.info("[avail] All models rate-limited — waiting %.1fs for %s",
                     wait, soonest_model)
            time.sleep(max(0.1, wait))


# ── Groq reset header parser ──────────────────────────────────

def _parse_groq_reset(s: str) -> float:
    """Convert Groq/Gemini reset strings ('59.75s', '1000ms', '1m30s') to seconds."""
    s = s.strip()
    if not s:
        return 0.0
    if s.endswith("ms"):
        try:
            return float(s[:-2]) / 1000.0
        except ValueError:
            return 0.0
    if "m" in s:
        parts = s.split("m", 1)
        total = 0.0
        try:
            total += float(parts[0]) * 60
        except ValueError:
            pass
        rem = parts[1]
        if rem.endswith("s"):
            try:
                total += float(rem[:-1])
            except ValueError:
                pass
        return total
    if s.endswith("s"):
        try:
            return float(s[:-1])
        except ValueError:
            return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _parse_reset_seconds(response: requests.Response, api: str) -> float:
    """Extract how long to wait from a 429 response."""
    if api == "groq":
        tok = _parse_groq_reset(response.headers.get("x-ratelimit-reset-tokens", "0s"))
        req = _parse_groq_reset(response.headers.get("x-ratelimit-reset-requests", "0s"))
        return max(tok, req, 10.0)
    else:  # gemini — try retryDelay in body; default to 60s RPM window
        try:
            body = response.json()
            for detail in body.get("error", {}).get("details", []):
                delay = detail.get("retryDelay", "")
                if delay:
                    return max(_parse_groq_reset(delay), 10.0)
        except Exception:
            pass
        return 60.0


def _check_groq_tokens(resp: requests.Response, model: str,
                        avail: _AvailabilityTracker) -> None:
    """After a successful Groq call, mark model limited if tokens are near exhaustion."""
    try:
        remaining_tok = int(resp.headers.get("x-ratelimit-remaining-tokens", 999_999))
        remaining_req = int(resp.headers.get("x-ratelimit-remaining-requests", 999))
        reset_tok = _parse_groq_reset(resp.headers.get("x-ratelimit-reset-tokens", "0s"))
        reset_req = _parse_groq_reset(resp.headers.get("x-ratelimit-reset-requests", "0s"))
    except Exception:
        return

    min_tok = getattr(cfg, "GROQ_SCORE_MIN_TOK_REMAINING", 4_000)
    reset = 0.0
    if remaining_req == 0:
        reset = max(reset, reset_req)
        log.info("[groq/%s] request limit hit — marking limited %.0fs", model, reset_req)
    if remaining_tok < min_tok:
        reset = max(reset, reset_tok)
        log.info("[groq/%s] token limit near (%d remaining) — marking limited %.0fs",
                 model, remaining_tok, reset_tok)
    if reset > 0:
        avail.mark_limited(model, reset)


# ── Shared helpers ────────────────────────────────────────────

def _load_resume() -> str:
    files = [f for f in RESUME_DIR.glob("*") if f.is_file() and f.suffix in (".txt", ".pdf")]
    if not files:
        raise FileNotFoundError(f"No resume (.txt or .pdf) in {RESUME_DIR}.")
    target = files[0]
    if target.suffix == ".pdf":
        import pdfminer.high_level as pdfminer
        return pdfminer.extract_text(str(target))
    return target.read_text(encoding="utf-8", errors="ignore")


def _load_prompt() -> str:
    return PROMPT_FILE.read_text(encoding="utf-8")


def _build_user_message(row: dict, resume_text: str) -> str:
    post = (row.get("post_content") or "")[:MAX_POST_CHARS]
    jd = (
        f"JOB TITLE: {row.get('title') or 'Not specified'}\n"
        f"COMPANY: {row.get('company') or 'Not specified'}\n"
        f"REQUIRED SKILLS: {row.get('skills') or 'Not specified'}\n"
        f"EXPERIENCE: {row.get('experience_min')}-{row.get('experience_max')} years\n\n"
        f"FULL JOB POST:\n{post}"
    )
    return f"JOB_DESCRIPTION:\n{jd}\n\nRESUME:\n{resume_text}"


def _extract_fields(data: dict, model_id: str) -> dict:
    sb  = data.get("score_breakdown", {})
    po  = data.get("prediction_outputs", {})
    ja  = data.get("job_analysis", {})
    ra  = data.get("resume_analysis", {})
    ir  = data.get("improvement_recommendations", {})
    gap = ja.get("gap_skills", {})

    def jlist(val):
        if val is None or isinstance(val, str):
            return val
        return json.dumps(val)

    return {
        "final_ats_score":             sb.get("final_ats_score"),
        "keyword_match_score":         sb.get("keyword_match_score"),
        "semantic_alignment_score":    sb.get("semantic_alignment_score"),
        "technical_skills_score":      sb.get("technical_skills_score"),
        "experience_relevance_score":  sb.get("experience_relevance_score"),
        "project_alignment_score":     sb.get("project_alignment_score"),
        "impact_score":                sb.get("impact_score"),
        "ats_structure_score":         sb.get("ats_structure_score"),
        "recruiter_readability_score": sb.get("recruiter_readability_score"),
        "seniority_fit_score":         sb.get("seniority_fit_score"),
        "domain_fit_score":            sb.get("domain_fit_score"),
        "tailoring_readiness_score":   sb.get("tailoring_readiness_score"),
        "ats_pass_probability":        po.get("ats_pass_probability"),
        "shortlist_probability":       po.get("recruiter_shortlist_probability"),
        "interview_probability":       po.get("interview_probability"),
        "rejection_probability":       po.get("rejection_probability"),
        "matched_skills":              jlist(ja.get("matched_skills")),
        "critical_gap_skills":         jlist(gap.get("critical")),
        "resume_strengths":            jlist(ra.get("resume_strengths")),
        "resume_weaknesses":           jlist(ra.get("resume_weaknesses")),
        "priority_changes":            jlist(ir.get("highest_priority_changes")),
        "keyword_injections":          jlist(ir.get("keyword_injections")),
        "raw_response":                json.dumps(data),
        "model_used":                  model_id,
        "scored_at":                   db.now_iso(),
    }


# ── API call functions ────────────────────────────────────────

def _gemini_api_call(system_prompt: str, user_message: str, model: str) -> dict:
    url = GEMINI_URL.format(model=model, key=cfg.GEMINI_API_KEY)
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": user_message}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
            "maxOutputTokens": 16384,
        },
    }
    resp = requests.post(url, json=payload, timeout=120)
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(text)
    if isinstance(result, list):
        result = result[0] if result else {}
    return result


def _groq_api_call(system_prompt: str, user_message: str,
                   model: str) -> tuple[dict, requests.Response]:
    headers = {
        "Authorization": f"Bearer {cfg.GROQ_API_KEY}",
        "Content-Type":  "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "max_tokens": 2048,
    }
    resp = requests.post(GROQ_URL, headers=headers, json=payload, timeout=120)
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    result  = json.loads(content)
    if isinstance(result, list):
        result = result[0] if result else {}
    return result, resp


# ── Unified cascade ───────────────────────────────────────────

def _call_unified_cascade(system_prompt: str, user_message: str,
                           avail: _AvailabilityTracker) -> tuple[dict, str, str]:
    """
    Try models in ATS_UNIFIED_MODELS order (best → worst).
    Returns (result_dict, model_id, api_type).

    On 429: marks model limited in avail_tracker, skips to next model.
    When ALL eligible models are temporarily rate-limited, wait_for_any
    blocks until the soonest one resets, then retries from index 0.
    Up to 10 cascade rounds before giving up.
    """
    daily   = get_tracker()
    limits  = getattr(cfg, "GEMINI_MODEL_LIMITS", {})
    models  = getattr(cfg, "ATS_UNIFIED_MODELS", [])

    for round_num in range(10):
        # Filter out models exhausted for the day
        eligible = [
            m for m in models
            if daily.is_available(m["id"], limits.get(m["id"], {}).get("rpd", 9999))
        ]
        if not eligible:
            raise RuntimeError("All models daily-exhausted — nothing left in cascade")

        avail.wait_for_any([m["id"] for m in eligible])

        for m in eligible:
            mid = m["id"]
            api = m["api"]

            if not avail.is_available(mid):
                log.info("[cascade] %s rate-limited (%.0fs) — skipping",
                         mid, avail.seconds_until(mid))
                continue

            rpd  = limits.get(mid, {}).get("rpd", 9999)
            used = daily.today_summary().get(mid, {}).get("calls", 0)
            log.info("[cascade] Trying %s (%s)  used=%d/%d", mid, api, used, rpd)

            for attempt in range(3):
                try:
                    if api == "gemini":
                        result = _gemini_api_call(system_prompt, user_message, mid)
                        daily.record_call(mid)
                    else:
                        result, resp = _groq_api_call(system_prompt, user_message, mid)
                        _check_groq_tokens(resp, mid, avail)  # proactive token check
                    return result, mid, api

                except requests.HTTPError as e:
                    status = e.response.status_code if e.response is not None else None
                    if status == 429:
                        reset = _parse_reset_seconds(e.response, api)
                        avail.mark_limited(mid, reset)
                        break  # try next model
                    if status == 503 and attempt < 2:
                        time.sleep(10 * (attempt + 1))
                        continue
                    log.warning("[cascade] HTTP %s on %s: %s", status, mid, e)
                    break

                except (json.JSONDecodeError, KeyError) as e:
                    log.warning("[cascade] Parse error on %s attempt %d: %s",
                                mid, attempt + 1, e)
                    if attempt < 2:
                        time.sleep(5)
                        continue
                    break

                except Exception as e:
                    log.warning("[cascade] Error on %s attempt %d: %s",
                                mid, attempt + 1, e)
                    if attempt < 2:
                        time.sleep(5)
                        continue
                    break

        log.info("[cascade] Round %d: all models unavailable — waiting for reset",
                 round_num + 1)

    raise RuntimeError("Cascade exhausted after 10 rounds — all models failed")


# ── Per-job scoring ───────────────────────────────────────────

def _score_job(worker_id: int, row: dict, system_prompt: str,
               resume_text: str, avail: _AvailabilityTracker) -> bool:
    target_id = row["target_id"]
    title     = (row.get("title") or "")[:40]
    user_msg  = _build_user_message(row, resume_text)

    try:
        data, model_id, api = _call_unified_cascade(system_prompt, user_msg, avail)
    except Exception as e:
        log.error("[w%d] Cascade FAILED  target_id=%d: %s", worker_id, target_id, e)
        return False

    fields = _extract_fields(data, model_id)

    try:
        db.insert_ats_score(target_id, fields, provider=api)
    except Exception as e:
        log.error("[w%d] DB FAILED  target_id=%d: %s", worker_id, target_id, e)
        return False

    log.info("[w%d] DONE  target_id=%-3d  score=%-3s  model=%s | %s",
             worker_id, target_id, fields.get("final_ats_score"), model_id, title)
    return True


# ── Worker thread ─────────────────────────────────────────────

def _worker(worker_id: int,
            job_queue: "queue.Queue[dict]",
            system_prompt: str,
            resume_text: str,
            avail: _AvailabilityTracker,
            stats: dict,
            stats_lock: threading.Lock,
            in_flight: set,
            in_flight_lock: threading.Lock,
            enqueue_new: "callable",
            done_event: "threading.Event | None") -> None:
    """
    Pull → cascade score → DB insert → repeat.
    In continuous mode (done_event given): when queue empties, refill from DB
    and keep going until done_event is set and nothing new remains.
    """
    log.info("[w%d] Ready", worker_id)
    while True:
        try:
            row = job_queue.get(timeout=5)
        except queue.Empty:
            new = enqueue_new()
            if new:
                log.info("[w%d] Picked up %d new target(s) from filter", worker_id, new)
                continue
            if done_event is None or done_event.is_set():
                break
            continue  # filter still running — keep polling

        tid = row["target_id"]
        success = _score_job(worker_id, row, system_prompt, resume_text, avail)

        with in_flight_lock:
            in_flight.discard(tid)
        with stats_lock:
            if success:
                stats["scored"] += 1
            else:
                stats["failed"] += 1

        job_queue.task_done()

    log.info("[w%d] Finished", worker_id)


# ── Main entry ────────────────────────────────────────────────

def run_scorer(done_event: "threading.Event | None" = None) -> int:
    """
    Score all unscored target_jobs using 3 parallel workers.

    done_event=None  (default / CLI mode):
        One-shot — scores whatever is in target_jobs right now, then returns.

    done_event=<Event>  (pipeline mode):
        Continuous — workers poll DB for new targets as the filter adds them.
        Exits only when done_event is set AND no more unscored jobs remain.
        The event is set by main.py after the filter has done its final pass.
    """
    system_prompt = _load_prompt()
    resume_text   = _load_resume()
    log.info("[scorer] Resume loaded (%d chars)", len(resume_text))

    avail      = _AvailabilityTracker()
    stats      = {"scored": 0, "failed": 0}
    stats_lock = threading.Lock()

    # in_flight: target_ids currently held by a worker, prevents double-pickup
    in_flight: set[int]    = set()
    in_flight_lock         = threading.Lock()
    job_queue: queue.Queue = queue.Queue()
    refill_lock            = threading.Lock()

    def _enqueue_new() -> int:
        """Add unscored, not-yet-in-flight targets to the queue. Thread-safe."""
        with refill_lock:
            targets = db.get_unscored_targets()
            count = 0
            with in_flight_lock:
                for t in targets:
                    tid = dict(t)["target_id"]
                    if tid not in in_flight:
                        in_flight.add(tid)
                        job_queue.put(dict(t))
                        count += 1
        return count

    initial = _enqueue_new()
    if initial == 0 and done_event is None:
        log.info("[scorer] No targets need scoring")
        return 0

    if initial:
        log.info("[scorer] %d initial target(s) — launching 3 workers", initial)
    else:
        log.info("[scorer] No targets yet — 3 workers will poll as filter adds them")

    workers = []
    for i in range(3):
        t = threading.Thread(
            target=_worker,
            args=(i + 1, job_queue, system_prompt, resume_text,
                  avail, stats, stats_lock,
                  in_flight, in_flight_lock, _enqueue_new, done_event),
            daemon=True,
            name=f"scorer-w{i + 1}",
        )
        t.start()
        workers.append(t)

    for t in workers:
        t.join()

    log.info("[scorer] Done — scored=%d  failed=%d", stats["scored"], stats["failed"])
    return stats["scored"]


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s  %(levelname)-7s  %(message)s")
    db.init_db()
    run_scorer()
