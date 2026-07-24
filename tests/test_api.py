"""API tests via FastAPI TestClient (no network, no API key needed for these)."""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "api"))

from fastapi.testclient import TestClient

from index import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_extract_and_search_flow():
    import fitz
    doc = fitz.open()
    page = doc.new_page()
    for line_index in range(12):
        page.insert_text((72, 72 + 16 * line_index), "Neural networks learn representations.")
    data = doc.tobytes()

    res = client.post("/api/extract", files={"file": ("nn.pdf", data, "application/pdf")})
    assert res.status_code == 200
    payload = res.json()
    assert payload["chunks"] and payload["meta"]["pages"] == 1

    res = client.post("/api/search", json={"query": "neural networks", "chunks": payload["chunks"]})
    assert res.status_code == 200
    assert res.json()["results"]


def test_extract_rejects_bad_file():
    res = client.post("/api/extract", files={"file": ("x.exe", b"junk" * 50, "application/octet-stream")})
    assert res.status_code == 422


def test_chat_requires_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("LEARNIQ_PROVIDER", raising=False)
    res = client.post("/api/chat", json={"query": "hi", "chunks": []})
    assert res.status_code == 401
    assert "API key" in res.json()["detail"]


def test_weak_topics_no_llm_needed():
    history = [{"topic": "T", "correct": False}, {"topic": "T", "correct": False}]
    res = client.post("/api/weak-topics", json={"quiz_history": history, "with_recommendation": False})
    assert res.status_code == 200
    assert res.json()["weak_topics"][0]["topic"] == "T"
