"""Unit tests for LearnIQ AI core modules (no network required)."""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "api"))

from core.chunker import chunk_text
from core.features import analyze_weak_topics
from core.llm import _extract_json
from core.retriever import retrieve
from core.text_extract import ExtractionError, clean_text, extract_text


class TestChunker:
    def test_overlapping_windows(self):
        text = " ".join(f"w{i}" for i in range(500))
        chunks = chunk_text(text, "doc1", size=100, overlap=20)
        assert chunks[0]["id"] == "doc1-c0"
        assert len(chunks[0]["text"].split()) == 100
        # consecutive chunks overlap by 20 words
        assert chunks[0]["text"].split()[-20:] == chunks[1]["text"].split()[:20]

    def test_short_text_single_chunk(self):
        assert len(chunk_text("only a few words here", "d")) == 1

    def test_empty(self):
        assert chunk_text("", "d") == []

    def test_invalid_params(self):
        with pytest.raises(ValueError):
            chunk_text("a b c", "d", size=10, overlap=10)


class TestRetriever:
    def test_ranks_relevant_first(self):
        chunks = [
            {"id": "a", "text": "photosynthesis converts light into chemical energy"},
            {"id": "b", "text": "the mitochondria is the powerhouse of the cell"},
            {"id": "c", "text": "gradient descent optimizes neural networks"},
        ]
        results = retrieve("how does photosynthesis work", chunks, top_k=2)
        assert results and results[0]["id"] == "a"

    def test_empty_inputs(self):
        assert retrieve("", [{"id": "a", "text": "x"}]) == []
        assert retrieve("query", []) == []


class TestExtraction:
    def test_txt(self):
        text, meta = extract_text("notes.txt", ("hello world " * 30).encode())
        assert meta["words"] == 60 and "hello" in text

    def test_pdf_roundtrip(self):
        import fitz
        doc = fitz.open()
        page = doc.new_page()
        for line_index in range(12):
            page.insert_text((72, 72 + 16 * line_index), "Machine learning is the study of algorithms.")
        data = doc.tobytes()
        text, meta = extract_text("test.pdf", data)
        assert meta["pages"] == 1 and "Machine learning" in text

    def test_rejects_empty(self):
        with pytest.raises(ExtractionError):
            extract_text("x.pdf", b"")

    def test_rejects_unknown_type(self):
        with pytest.raises(ExtractionError):
            extract_text("x.exe", b"data" * 100)

    def test_clean_dehyphenates(self):
        assert "understanding" in clean_text("under-\nstanding")


class TestWeakTopics:
    def test_flags_low_accuracy(self):
        history = (
            [{"topic": "Calculus", "correct": False}] * 3
            + [{"topic": "Calculus", "correct": True}]
            + [{"topic": "Algebra", "correct": True}] * 4
        )
        weak = analyze_weak_topics(history)
        assert [w["topic"] for w in weak] == ["Calculus"]
        assert weak[0]["accuracy"] == 25.0

    def test_ignores_single_attempts(self):
        assert analyze_weak_topics([{"topic": "X", "correct": False}]) == []


class TestJsonExtraction:
    def test_plain(self):
        assert _extract_json('{"a": 1}') == {"a": 1}

    def test_fenced(self):
        assert _extract_json('Here:\n```json\n[1, 2]\n```') == [1, 2]

    def test_with_prose(self):
        assert _extract_json('Sure! {"ok": true} hope that helps') == {"ok": True}

    def test_garbage(self):
        assert _extract_json("not json at all") is None


class TestProviderSelection:
    def test_defaults_to_anthropic(self, monkeypatch):
        from core.config import resolve_provider
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("LEARNIQ_PROVIDER", raising=False)
        assert resolve_provider() == "anthropic"

    def test_gemini_key_switches_provider(self, monkeypatch):
        from core.config import resolve_provider, resolve_api_key
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.delenv("LEARNIQ_PROVIDER", raising=False)
        assert resolve_provider() == "gemini"
        assert resolve_api_key() == "test-key"

    def test_explicit_override_wins(self, monkeypatch):
        from core.config import resolve_provider
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.setenv("LEARNIQ_PROVIDER", "anthropic")
        assert resolve_provider() == "anthropic"

    def test_factory_builds_gemini(self, monkeypatch):
        from core.llm import make_llm_client, GeminiClient, MissingApiKeyError
        import pytest as _pytest
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        monkeypatch.delenv("LEARNIQ_PROVIDER", raising=False)
        assert isinstance(make_llm_client("test-key"), GeminiClient)
        with _pytest.raises(MissingApiKeyError):
            make_llm_client(None)
