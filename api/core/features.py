"""Feature orchestration — quiz, notes, flashcards, roadmap, ELI5, weak topics.

Each function is stateless: it receives everything it needs (chunks, history)
from the client and returns plain data. Persistence lives in the browser.
"""
from __future__ import annotations

import random
from collections import defaultdict


def _as_list(raw) -> list:
    """Coerce an LLM JSON reply into a list. Models sometimes wrap the array in
    an object like {"questions": [...]} or {"cards": [...]}; unwrap those."""
    if isinstance(raw, list):
        return raw
    if isinstance(raw, dict):
        for key in ("questions", "quiz", "cards", "flashcards", "items", "data", "result"):
            if isinstance(raw.get(key), list):
                return raw[key]
        # single-object dict that looks like one item
        return [raw]
    return []

from .config import MAX_TOKENS_GENERATION
from .llm import LLMError, _extract_json
from .logger import get_logger
from . import prompts

logger = get_logger(__name__)

_VALID_QUESTION_TYPES = {"mcq", "true_false", "fill_blank", "short_answer"}


def _sample_material(chunks: list[dict], max_words: int = 5000) -> str:
    """Build a representative material sample under a word budget.

    Chunks are sampled evenly across the document(s) rather than truncated from
    the front, so generated content covers the whole material.
    """
    if not chunks:
        return ""
    budget_chunks: list[dict] = []
    words = 0
    step = max(1, len(chunks) // max(1, max_words // 200))
    for chunk in chunks[::step]:
        chunk_words = len(chunk.get("text", "").split())
        if words + chunk_words > max_words:
            break
        budget_chunks.append(chunk)
        words += chunk_words
    return "\n\n".join(c["text"] for c in budget_chunks)


def generate_quiz(
    client,
    chunks: list[dict],
    count: int,
    difficulty: str,
    types: list[str],
    topic: str = "",
) -> list[dict]:
    """Generate a validated quiz from document chunks, or from a topic when no
    documents are provided (using the model's own knowledge)."""
    types = [t for t in types if t in _VALID_QUESTION_TYPES] or ["mcq"]
    count = max(1, min(count, 20))
    material = _sample_material(chunks)
    if not material and not topic.strip():
        raise LLMError("Select a document or set a topic to build a quiz from.")
    # Use the plain-text completion path (same one Notes uses successfully), then
    # parse the JSON ourselves. This avoids provider JSON-mode quirks that were
    # returning empty/truncated output.
    text = client.complete(
        prompts.QUIZ_SYSTEM + " Output ONLY the JSON array — no prose, no code fences.",
        [{"role": "user", "content": prompts.build_quiz_prompt(material, count, difficulty, types, topic)}],
        max_tokens=MAX_TOKENS_GENERATION, temperature=0.4,
    )
    raw = _extract_json(text)
    if raw is None:
        raise LLMError(f"Quiz generation returned unreadable output ({len(text)} chars). Please retry.")
    questions: list[dict] = []
    for i, item in enumerate(_as_list(raw)):
        if not isinstance(item, dict) or item.get("type") not in _VALID_QUESTION_TYPES:
            continue
        if not item.get("question") or not item.get("answer"):
            continue
        if item["type"] == "mcq":
            options = item.get("options")
            if not isinstance(options, list) or len(options) < 2 or item["answer"] not in options:
                continue
            random.shuffle(options)
            item["options"] = options
        questions.append(
            {
                "id": f"q{i}",
                "type": item["type"],
                "question": str(item["question"]),
                "options": item.get("options"),
                "answer": str(item["answer"]),
                "explanation": str(item.get("explanation", "")),
                "topic": str(item.get("topic", "General")),
            }
        )
    if not questions:
        raise LLMError("Quiz generation produced no valid questions — please retry.")
    return questions


def grade_short_answer(
    client, question: str, correct_answer: str, student_answer: str
) -> dict:
    """Grade a free-text answer with the LLM."""
    result = client.complete_json(
        prompts.GRADER_SYSTEM,
        [{"role": "user", "content": (
            f"QUESTION: {question}\nREFERENCE ANSWER: {correct_answer}\n"
            f"LEARNER ANSWER: {student_answer}")}],
        max_tokens=512,
    )
    return {
        "correct": bool(result.get("correct", False)),
        "score": int(result.get("score", 0)),
        "feedback": str(result.get("feedback", "")),
    }


def generate_notes(client, chunks: list[dict], mode: str, topic: str = "", subject: str = "") -> str:
    """Generate study notes from documents or from a topic (model knowledge)."""
    instruction = prompts.NOTES_MODES.get(mode, prompts.NOTES_MODES["summary"])
    material = _sample_material(chunks, max_words=6000)
    if not material and not topic.strip():
        raise LLMError("Select a document or set a topic to build notes from.")
    body = f"{instruction}\n\n" + (f"MATERIAL:\n{material}" if material
                                     else prompts.topic_material(topic, subject))
    return client.complete(prompts.NOTES_SYSTEM,
                           [{"role": "user", "content": body}], max_tokens=MAX_TOKENS_GENERATION)


def generate_flashcards(client, chunks: list[dict], count: int, topic: str = "", subject: str = "") -> list[dict]:
    """Generate flashcards from documents or from a topic (model knowledge)."""
    count = max(4, min(count, 40))
    material = _sample_material(chunks)
    if not material and not topic.strip():
        raise LLMError("Select a document or set a topic to build flashcards from.")
    src_block = f"MATERIAL:\n{material}" if material else prompts.topic_material(topic, subject)
    text = client.complete(
        prompts.FLASHCARDS_SYSTEM + " Output ONLY the JSON array — no prose, no code fences.",
        [{"role": "user", "content": f"Create exactly {count} flashcards.\n\n{src_block}"}],
        max_tokens=MAX_TOKENS_GENERATION, temperature=0.4,
    )
    raw = _extract_json(text)
    if raw is None:
        raise LLMError(f"Flashcard generation returned unreadable output ({len(text)} chars). Please retry.")
    cards = [
        {"front": str(c["front"]), "back": str(c["back"]), "topic": str(c.get("topic", "General"))}
        for c in _as_list(raw)
        if isinstance(c, dict) and c.get("front") and c.get("back")
    ]
    if not cards:
        raise LLMError("Flashcard generation failed — please retry.")
    return cards


def generate_roadmap(
    client,
    documents: list[dict],
    weak_topics: list[dict],
    horizon: str,
    minutes_per_day: int,
) -> str:
    """Generate a personalized study roadmap."""
    doc_lines = "\n".join(
        f"- {d.get('name', 'document')} ({d.get('words', '?')} words)" for d in documents
    ) or "- (no documents uploaded yet)"
    weak_lines = "\n".join(
        f"- {t['topic']}: {t['accuracy']}% accuracy over {t['attempts']} questions"
        for t in weak_topics
    ) or "- none identified yet"
    return client.complete(
        prompts.ROADMAP_SYSTEM,
        [{"role": "user", "content": (
            f"Horizon: {horizon}. Available study time: ~{minutes_per_day} minutes/day.\n"
            f"DOCUMENTS:\n{doc_lines}\n\nWEAK TOPICS:\n{weak_lines}")}],
        max_tokens=MAX_TOKENS_GENERATION,
    )


def explain(client, concept: str, level: str, chunks: list[dict]) -> str:
    """Explain a concept at the requested depth, grounded in excerpts if provided."""
    level = level if level in {"beginner", "intermediate", "advanced"} else "beginner"
    context = "\n\n".join(c["text"] for c in chunks[:4]) if chunks else ""
    body = f"Level: {level}\nConcept: {concept}"
    if context:
        body += f"\n\nRELEVANT EXCERPTS:\n{context}"
    return client.complete(prompts.ELI5_SYSTEM, [{"role": "user", "content": body}], max_tokens=1536)


def analyze_weak_topics(quiz_history: list[dict], threshold: float = 60.0) -> list[dict]:
    """Compute per-topic accuracy from quiz history (pure Python, no LLM).

    Args:
        quiz_history: [{"topic": str, "correct": bool}, ...] flattened attempts.
        threshold: Accuracy percentage below which a topic counts as weak.

    Returns:
        Weak topics sorted worst-first: [{"topic", "accuracy", "attempts"}].
    """
    stats: dict[str, list[int]] = defaultdict(lambda: [0, 0])  # topic -> [correct, total]
    for attempt in quiz_history:
        topic = str(attempt.get("topic", "General")).strip() or "General"
        stats[topic][1] += 1
        if attempt.get("correct"):
            stats[topic][0] += 1
    weak = [
        {"topic": topic, "accuracy": round(100 * correct / total, 1), "attempts": total}
        for topic, (correct, total) in stats.items()
        if total >= 2 and (100 * correct / total) < threshold
    ]
    return sorted(weak, key=lambda t: t["accuracy"])


def recommend_revision(client, weak_topics: list[dict]) -> str:
    """LLM-written revision advice for the computed weak topics."""
    if not weak_topics:
        return ("**No weak topics detected.** Keep taking quizzes so LearnIQ can "
                "spot where you need revision.")
    lines = "\n".join(
        f"- {t['topic']}: {t['accuracy']}% over {t['attempts']} questions" for t in weak_topics
    )
    return client.complete(
        prompts.WEAK_TOPICS_SYSTEM,
        [{"role": "user", "content": lines}],
        max_tokens=1024,
    )
