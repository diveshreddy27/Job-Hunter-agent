"""
Train a local spaCy NER model on (raw_post → normalized) pairs from the DB.

Primary source: normalized_posts WHERE is_trained = 'not_trained'
  Every post normalised by Gemini is now written to normalized_posts
  regardless of whether it passed the ATS filter.  This gives the NER model
  the full, unfiltered dataset — not just the small subset that reached
  target_jobs.

After a successful training run all processed rows are flipped to
is_trained = 'trained', so subsequent runs only consume NEW posts
(incremental training — never re-trains on data already seen).

Legacy fallback: staging/training/training_data.jsonl
  Posts scraped before this DB-first architecture was in place live only in
  the JSONL.  Any URN not found in the DB is read from there so that
  historical data is not wasted.  These posts have no DB id to track, so
  they are re-read on every run until manually migrated or the model has
  seen enough DB-sourced data to make them irrelevant.

The model learns: JOB_TITLE, COMPANY, SKILL, SUBJECT_FORMAT.
Regex utils (email, experience, location, work_mode) are already accurate
and don't need NER.

Usage:
    python model/train.py               # incremental — only new posts
    python model/train.py --all         # retrain from scratch (all posts)
    python model/train.py --min 50      # require at least 50 examples
    python model/train.py --iters 40    # more iterations for better accuracy
"""
import json
import random
import pathlib
import argparse
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

import spacy
from spacy.training import Example
from spacy.util import minibatch, compounding

from db import database as db

MODEL_DIR     = pathlib.Path(__file__).parent / "linkedin_ner"
TRAINING_FILE = pathlib.Path(__file__).parent.parent / "data" / "queue" / "training" / "training_data.jsonl"


def _find_span(text: str, value: str):
    if not value or not value.strip():
        return None
    lo  = text.lower()
    val = value.lower().strip()
    idx = lo.find(val)
    if idx == -1:
        return None
    return (idx, idx + len(val))


def _remove_overlaps(entities: list) -> list:
    entities = sorted(entities, key=lambda e: e[1] - e[0], reverse=True)
    kept = []
    for ent in entities:
        if not any(ent[0] < k[1] and ent[1] > k[0] for k in kept):
            kept.append(ent)
    return kept


def _to_spacy_example(text: str, norm: dict):
    """Convert a (text, norm dict) pair to a spaCy training tuple, or None."""
    if not norm.get("title"):
        return None
    entities = []

    span = _find_span(text, norm.get("title"))
    if span:
        entities.append((*span, "JOB_TITLE"))

    span = _find_span(text, norm.get("company"))
    if span:
        entities.append((*span, "COMPANY"))

    for skill in (norm.get("skills") or "").split(","):
        skill = skill.strip()
        if not skill:
            continue
        span = _find_span(text, skill)
        if span:
            entities.append((*span, "SKILL"))

    span = _find_span(text, norm.get("email_subject_format"))
    if span:
        entities.append((*span, "SUBJECT_FORMAT"))

    if not entities:
        return None
    return (text, {"entities": _remove_overlaps(entities)})


def load_training_data(retrain_all: bool = False) -> tuple[list, list]:
    """
    Returns (spacy_examples, db_norm_ids).

    db_norm_ids: normalized_posts.id values for DB rows — passed to
                 mark_posts_trained() after a successful run.

    retrain_all=True ignores is_trained and reads the full DB (for a
    from-scratch retrain when you want to rebuild the model entirely).
    """
    seen_urns: set = set()
    data:    list  = []
    db_ids:  list  = []
    skipped = 0

    # ── Source 1: DB (primary) ────────────────────────────────────────────────
    db_count = 0
    try:
        trained_filter = "" if retrain_all else "AND n.is_trained = 'not_trained'"
        with db.get_conn() as conn:
            rows = conn.execute(f"""
                SELECT n.id, n.title, n.company, n.skills,
                       n.email_subject_format, n.email_required_fields,
                       r.post_author, r.author_headline, r.post_content,
                       r.activity_urn
                FROM normalized_posts n
                JOIN raw_posts r ON r.id = n.raw_post_id
                WHERE n.title IS NOT NULL
                {trained_filter}
                ORDER BY n.id
            """).fetchall()

        for row in rows:
            row = dict(row)
            urn = row.get("activity_urn", "")
            seen_urns.add(urn)

            text = (
                f"{row['post_author'] or ''}\n"
                f"{row['author_headline'] or ''}\n"
                f"{row['post_content'] or ''}"
            )
            ex = _to_spacy_example(text, row)
            if ex:
                data.append(ex)
                db_ids.append(row["id"])
                db_count += 1
            else:
                skipped += 1

        label = "all" if retrain_all else "is_trained='not_trained'"
        print(f"  DB source    : {db_count} examples  ({label})")
    except Exception as e:
        print(f"  DB source    : skipped ({e})")

    # ── Source 2: JSONL fallback (pre-DB-first posts) ─────────────────────────
    jsonl_count = 0
    if TRAINING_FILE.exists():
        with TRAINING_FILE.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue

                urn  = record.get("activity_urn", "")
                norm = record.get("normalized") or {}

                if urn in seen_urns:
                    continue
                if urn:
                    seen_urns.add(urn)

                text = (
                    f"{record.get('post_author', '')}\n"
                    f"{record.get('author_headline', '')}\n"
                    f"{record.get('post_content', '')}"
                )
                ex = _to_spacy_example(text, norm)
                if ex:
                    data.append(ex)
                    jsonl_count += 1
                else:
                    skipped += 1

        if jsonl_count:
            print(f"  JSONL source : {jsonl_count} examples  (legacy, not yet in DB)")

    print(f"  Total        : {len(data)} examples  ({skipped} skipped — no spans found)")
    return data, db_ids


def train(n_iters: int = 30, min_examples: int = 10, retrain_all: bool = False) -> bool:
    """
    Train the NER model and mark processed DB rows as trained.
    Returns True on success, False when there aren't enough examples.
    """
    print("Loading training data...")
    data, db_ids = load_training_data(retrain_all=retrain_all)

    if len(data) < min_examples:
        print(
            f"Need at least {min_examples} examples — only {len(data)} available.\n"
            "Run more scrapes first, then retrain."
        )
        return False

    nlp = spacy.blank("en")
    ner = nlp.add_pipe("ner")
    for label in ("JOB_TITLE", "COMPANY", "SKILL", "SUBJECT_FORMAT"):
        ner.add_label(label)

    examples = []
    bad = 0
    for text, annotations in data:
        doc = nlp.make_doc(text)
        try:
            examples.append(Example.from_dict(doc, annotations))
        except Exception:
            bad += 1
    if bad:
        print(f"  (dropped {bad} examples with misaligned spans)")

    nlp.initialize(lambda: examples)

    print(f"Training {len(examples)} examples for {n_iters} iterations...")
    for i in range(n_iters):
        random.shuffle(examples)
        losses = {}
        for batch in minibatch(examples, size=compounding(4.0, 32.0, 1.001)):
            nlp.update(batch, drop=0.2, losses=losses)
        if (i + 1) % 5 == 0:
            print(f"  iter {i + 1:3d}  loss={losses.get('ner', 0):.2f}")

    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    nlp.to_disk(MODEL_DIR)
    print(f"\nModel saved → {MODEL_DIR}")

    # Mark DB posts as trained so they're skipped on the next incremental run
    if db_ids and not retrain_all:
        db.mark_posts_trained(db_ids)
        print(f"Marked {len(db_ids)} posts as trained in DB.")

    print("Set USE_LOCAL_MODEL = True in settings.py to activate it.")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--iters", type=int, default=30, help="Training iterations")
    parser.add_argument("--min",   type=int, default=10, dest="min_examples",
                        help="Minimum examples required to start training")
    parser.add_argument("--all",   action="store_true", dest="retrain_all",
                        help="Retrain from scratch — ignore is_trained flag")
    args = parser.parse_args()
    db.init_db()
    train(args.iters, args.min_examples, args.retrain_all)
