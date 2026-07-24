"""LearnIQ AI — FastAPI application (Vercel serverless entrypoint).

All endpoints are stateless: the browser owns persistence (IndexedDB) and sends
the data each call needs. All Claude calls are funded by the deployment
owner's ANTHROPIC_API_KEY environment variable — client keys are never accepted.
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # noqa: E402 — Vercel runs from repo root

import base64
import hashlib
import json as _json
import os
import urllib.parse
import urllib.request
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from core import features
from core.pdf_report import markdown_to_pdf
from core.chunker import chunk_text
from core.config import DEFAULT_MODEL, MAX_UPLOAD_BYTES, TOP_K_CHUNKS, resolve_api_key, resolve_provider
from core.llm import LLMError, MissingApiKeyError, make_llm_client, _extract_json
from core.logger import get_logger
from core.retriever import retrieve
from core.text_extract import ExtractionError, extract_text
from core import prompts

logger = get_logger(__name__)

app = FastAPI(title="LearnIQ AI", version="1.0.0", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ---------- request models ----------

class ChunkIn(BaseModel):
    id: str
    text: str
    doc_id: Optional[str] = None
    doc_name: Optional[str] = None
    seq: Optional[int] = None


class ChatRequest(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    chunks: list[ChunkIn] = []
    history: list[dict[str, str]] = []
    model: Optional[str] = None


class QuizRequest(BaseModel):
    chunks: list[ChunkIn] = []
    count: int = 8
    difficulty: str = "medium"
    types: list[str] = ["mcq", "true_false"]
    topic: str = ""
    subject: str = ""
    model: Optional[str] = None


class GradeRequest(BaseModel):
    question: str
    correct_answer: str
    student_answer: str
    model: Optional[str] = None


class NotesRequest(BaseModel):
    chunks: list[ChunkIn] = []
    mode: str = "summary"
    topic: str = ""
    subject: str = ""
    model: Optional[str] = None


class FlashcardsRequest(BaseModel):
    chunks: list[ChunkIn] = []
    count: int = 12
    topic: str = ""
    subject: str = ""
    model: Optional[str] = None


class RoadmapRequest(BaseModel):
    documents: list[dict[str, Any]] = []
    quiz_history: list[dict[str, Any]] = []
    horizon: str = "weekly"
    minutes_per_day: int = 60
    model: Optional[str] = None


class ExplainRequest(BaseModel):
    concept: str = Field(min_length=1, max_length=500)
    level: str = "beginner"
    chunks: list[ChunkIn] = []
    model: Optional[str] = None


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    chunks: list[ChunkIn]
    top_k: int = 8


class WeakTopicsRequest(BaseModel):
    quiz_history: list[dict[str, Any]]
    with_recommendation: bool = True
    model: Optional[str] = None


# ---------- helpers ----------

def _client(model: Optional[str]):
    """Build the active provider's LLM client (server-side key only)."""
    try:
        return make_llm_client(resolve_api_key(), model=model)
    except MissingApiKeyError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


def _dump(chunks: list[ChunkIn]) -> list[dict]:
    return [c.model_dump() for c in chunks]


@app.exception_handler(LLMError)
async def llm_error_handler(_, exc: LLMError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=502, content={"detail": str(exc)})


# ---------- endpoints ----------

class ReportRequest(BaseModel):
    title: str = "LearnIQ Report"
    markdown: str = ""
    filename: str = "learniq-report"


@app.post("/api/report")
def report(body: ReportRequest):
    """Render report Markdown into a downloadable PDF."""
    pdf = markdown_to_pdf(body.title, body.markdown)
    safe = "".join(c for c in body.filename if c.isalnum() or c in "-_") or "learniq-report"
    return Response(content=pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'})


@app.get("/api/config")
def config() -> dict:
    """Public front-end configuration. The anon key is safe to expose to browsers
    because every table is protected by row-level security (RLS)."""
    return {
        "supabase_url": os.environ.get("SUPABASE_URL", "").strip(),
        "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY", "").strip(),
    }


@app.get("/api/debug/quiz")
def debug_quiz(topic: str = "thermodynamics") -> dict:
    """Diagnostic: run a raw quiz-JSON generation and report exactly what the LLM
    returned (finish reason, raw text, whether it parsed). Open in a browser to
    see the true cause of any 'malformed data' error."""
    import traceback

    result: dict = {"provider": resolve_provider(), "model": DEFAULT_MODEL, "attempts": []}
    key = resolve_api_key()
    if not key:
        result["error"] = "No API key configured."
        return result
    try:
        client = make_llm_client(key)
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        return result

    prompt = prompts.build_quiz_prompt("", 3, "easy", ["mcq"], topic)
    messages = [{"role": "user", "content": prompt}]

    provider = resolve_provider()
    if provider == "gemini":
        for label, json_mode, thinking in [("json+nothink", True, False),
                                           ("plain+nothink", False, False),
                                           ("plain+default", False, True)]:
            attempt = {"config": label}
            try:
                cfg = {"system_instruction": prompts.QUIZ_SYSTEM, "max_output_tokens": 8192,
                       "temperature": 0.4}
                if not thinking:
                    cfg["thinking_config"] = {"thinking_budget": 0}
                if json_mode:
                    cfg["response_mime_type"] = "application/json"
                resp = client._call(client.model, client._contents(messages), cfg)
                try:
                    text = resp.text or ""
                except Exception as te:
                    text = ""
                    attempt["text_error"] = str(te)
                cand = (resp.candidates or [None])[0]
                attempt["finish_reason"] = str(getattr(cand, "finish_reason", "?"))
                attempt["raw_len"] = len(text)
                attempt["raw_preview"] = text[:1500]
                attempt["parsed_ok"] = _extract_json(text) is not None
            except Exception as exc:
                attempt["exception"] = f"{type(exc).__name__}: {str(exc)[:400]}"
                attempt["trace"] = traceback.format_exc()[-600:]
            result["attempts"].append(attempt)
    else:
        try:
            out = client.complete_json(prompts.QUIZ_SYSTEM, messages, max_tokens=8192)
            result["attempts"].append({"config": "claude", "parsed_ok": True, "sample": str(out)[:800]})
        except Exception as exc:
            result["attempts"].append({"config": "claude", "exception": f"{type(exc).__name__}: {exc}"})
    return result


@app.get("/api/videos")
def videos(topic: str, max_results: int = 4) -> dict:
    """Return real, embeddable YouTube videos for a topic via the YouTube Data API.

    If YOUTUBE_API_KEY is not configured, returns configured=False so the front
    end can fall back to plain search links (no thumbnails / inline playback).
    """
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not key:
        return {"configured": False, "videos": []}
    params = urllib.parse.urlencode({
        "part": "snippet", "q": f"{topic.strip()} lecture", "type": "video",
        "videoEmbeddable": "true", "maxResults": max(1, min(max_results, 6)),
        "safeSearch": "strict", "relevanceLanguage": "en",
        "regionCode": "IN", "order": "relevance", "key": key,   # bias to Indian educators
    })
    url = "https://www.googleapis.com/youtube/v3/search?" + params
    try:
        with urllib.request.urlopen(url, timeout=8) as resp:
            data = _json.loads(resp.read().decode())
    except Exception as exc:  # network / quota / bad key
        logger.warning("YouTube API error: %s", exc)
        return {"configured": True, "videos": [], "error": "Could not load videos right now."}
    out = []
    for item in data.get("items", []):
        vid = (item.get("id") or {}).get("videoId")
        sn = item.get("snippet") or {}
        if not vid:
            continue
        thumbs = sn.get("thumbnails") or {}
        thumb = (thumbs.get("medium") or thumbs.get("high") or thumbs.get("default") or {}).get("url", "")
        out.append({"id": vid, "title": sn.get("title", ""),
                    "channel": sn.get("channelTitle", ""), "thumbnail": thumb})
    return {"configured": True, "videos": out}


@app.get("/api/health")
def health(probe: bool = False) -> dict:
    """Service status. Add ?probe=1 to run a live one-token LLM call for diagnosis."""
    info = {
        "status": "ok",
        "provider": resolve_provider(),
        "model": DEFAULT_MODEL,
        "has_server_key": bool(resolve_api_key()),
    }
    if probe:
        # Live one-token call so misconfigurations surface with the REAL error.
        try:
            client = make_llm_client(resolve_api_key(), model=None)
            reply = client.complete("You are a health check.",
                                    [{"role": "user", "content": "Reply with the single word OK."}],
                                    max_tokens=8, temperature=0)
            info["probe"] = {"ok": True, "reply": reply.strip()[:40]}
        except Exception as exc:  # surface the true cause to the browser
            info["probe"] = {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:400]}"}
    return info


@app.post("/api/extract")
async def extract(file: UploadFile = File(...)) -> dict:
    """Extract and chunk an uploaded document. Returns chunks for client storage."""
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "File is larger than the 15 MB limit.")
    try:
        text, meta = extract_text(file.filename or "upload", data)
    except ExtractionError as exc:
        raise HTTPException(422, str(exc)) from exc
    doc_id = hashlib.sha1(data).hexdigest()[:10]
    chunks = chunk_text(text, doc_id)
    logger.info("extracted %s: %d words, %d chunks", file.filename, meta["words"], len(chunks))
    return {"doc_id": doc_id, "name": file.filename, "meta": meta,
            "chunks": chunks, "preview": text[:1200]}


_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


@app.post("/api/solve")
async def solve(file: UploadFile = File(...), prompt: str = "Solve every question in this image."):
    """Read questions from a photo/scan and return worked answers (vision)."""
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image is larger than the 15 MB limit.")
    mime = file.content_type or "image/jpeg"
    if mime not in _IMAGE_TYPES:
        # browsers sometimes send octet-stream for camera captures — default to jpeg
        mime = "image/jpeg"
    if not data:
        raise HTTPException(422, "No image received.")
    client = _client(None)
    image_b64 = base64.b64encode(data).decode()
    answer = client.solve_image(prompts.SOLVE_IMAGE_SYSTEM, prompt, image_b64, mime)
    return {"markdown": answer}


@app.post("/api/chat")
def chat(body: ChatRequest):
    """RAG chat turn — streams Markdown text (with [chunk-id] citations and
    trailing FOLLOW-UP lines the frontend parses)."""
    client = _client(body.model)
    context = retrieve(body.query, _dump(body.chunks), top_k=TOP_K_CHUNKS)
    user_message = prompts.build_chat_prompt(body.query, context)
    messages = [
        {"role": m["role"], "content": m["content"]}
        for m in body.history[-12:]
        if m.get("role") in {"user", "assistant"} and m.get("content")
    ] + [{"role": "user", "content": user_message}]

    source_ids = ",".join(c["id"] for c in context)

    def generate():
        try:
            yield from client.stream_text(prompts.TUTOR_SYSTEM, messages)
        except LLMError as exc:
            yield f"\n\n> ⚠ {exc}"

    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"x-learniq-sources": source_ids, "cache-control": "no-store"},
    )


@app.post("/api/quiz/generate")
def quiz_generate(body: QuizRequest) -> dict:
    client = _client(body.model)
    questions = features.generate_quiz(
        client, _dump(body.chunks), body.count, body.difficulty, body.types, body.topic
    )
    return {"questions": questions}


@app.post("/api/quiz/grade")
def quiz_grade(body: GradeRequest) -> dict:
    client = _client(body.model)
    return features.grade_short_answer(
        client, body.question, body.correct_answer, body.student_answer
    )


@app.post("/api/notes")
def notes(body: NotesRequest) -> dict:
    client = _client(body.model)
    return {"markdown": features.generate_notes(client, _dump(body.chunks), body.mode, body.topic, body.subject)}


@app.post("/api/flashcards")
def flashcards(body: FlashcardsRequest) -> dict:
    client = _client(body.model)
    return {"cards": features.generate_flashcards(client, _dump(body.chunks), body.count, body.topic, body.subject)}


@app.post("/api/roadmap")
def roadmap(body: RoadmapRequest) -> dict:
    client = _client(body.model)
    weak = features.analyze_weak_topics(body.quiz_history)
    markdown = features.generate_roadmap(
        client, body.documents, weak, body.horizon, body.minutes_per_day
    )
    return {"markdown": markdown, "weak_topics": weak}


@app.post("/api/explain")
def explain(body: ExplainRequest) -> dict:
    client = _client(body.model)
    context = retrieve(body.concept, _dump(body.chunks), top_k=4)
    return {"markdown": features.explain(client, body.concept, body.level, context)}


@app.post("/api/search")
def search(body: SearchRequest) -> dict:
    """Semantic-ish search (BM25) across all supplied chunks. No LLM, no key needed."""
    results = retrieve(body.query, _dump(body.chunks), top_k=max(1, min(body.top_k, 25)))
    return {"results": results}


@app.post("/api/weak-topics")
def weak_topics(body: WeakTopicsRequest) -> dict:
    weak = features.analyze_weak_topics(body.quiz_history)
    recommendation = None
    if body.with_recommendation and weak:
        client = _client(body.model)
        recommendation = features.recommend_revision(client, weak)
    return {"weak_topics": weak, "recommendation": recommendation}


# ---------- local development only ----------
# On Vercel the public/ directory is served by the platform; locally, uvicorn
# serves it so `uvicorn index:app` from api/ gives the full app at one URL.
if not os.environ.get("VERCEL"):
    from fastapi.staticfiles import StaticFiles

    _public = pathlib.Path(__file__).resolve().parent.parent / "public"
    if _public.is_dir():
        app.mount("/", StaticFiles(directory=str(_public), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
