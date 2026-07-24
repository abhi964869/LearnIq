# LearnIQ AI

**The AI Learning Operating System** — upload your study material, then chat with it, quiz yourself on it, turn it into notes, flashcards, and a personalized study roadmap. Works with Google Gemini or Anthropic Claude — set one API key and go.

## Overview

LearnIQ AI is a serverless learning platform designed to deploy on Vercel with nothing but an Anthropic API key. Documents are processed server-side (PDF/DOCX/TXT extraction, chunking), but **all persistence lives in your browser** (IndexedDB) — the backend is completely stateless, so there is no database to provision and no user data stored on any server.

## Features

**Smart Library** — upload PDF/DOCX/TXT/MD, favorites, tags, rename, preview, semantic search across every document. **AI Chat** — RAG over your documents with streaming responses, inline source citations (click any citation to see the exact passage), suggested follow-up questions, chat history, and Markdown export. **Quiz Engine** — MCQ, true/false, fill-in-the-blank, and AI-graded short answers; difficulty levels, timer, instant grading with explanations, retry-incorrect mode. **Notes Generator** — summaries, key concepts, definitions, examples, formula sheets, interview questions. **Flashcards** — auto-generated, flip/shuffle/review with progress. **Study Roadmap** — personalized daily/weekly/monthly plans that account for your weak topics. **Analytics** — accuracy trends, topic mastery, activity heatmap, weak-topic detection with AI revision advice. **Gamification** — XP, levels, streaks, badges. **Explain** — any concept at beginner/intermediate/advanced depth.

## Architecture

```
Browser (public/)                      Vercel Serverless (api/)
┌─────────────────────────┐            ┌──────────────────────────────┐
│ SPA — Tesla-inspired UI │  ─upload→  │ /api/extract  PyMuPDF/docx   │
│ IndexedDB:              │  ←chunks─  │               + chunker      │
│   docs · chats ·        │            │                              │
│   quizzes · XP events   │  ─chunks+q→│ /api/chat     BM25 retrieval │
│                         │  ←stream──  │               → Claude       │
│ localStorage: API key   │            │ /api/quiz /notes /flashcards │
└─────────────────────────┘            │ /api/roadmap /explain ...    │
                                       └──────────────────────────────┘
```

Clean separation inside `api/`: `core/llm.py` (Claude client: retries, streaming, JSON repair), `core/text_extract.py`, `core/chunker.py`, `core/retriever.py` (BM25 + overlap fallback), `core/prompts.py` (every prompt in one place), `core/features.py` (orchestration), `index.py` (FastAPI routes only).

## Installation (local)

Requires Python 3.9+ (3.10+ recommended).

**Easiest:** double-click `run.bat` (Windows) or run `./run.sh` (macOS/Linux) — it creates a virtualenv, installs dependencies, and starts the app.

**Manual:**

```bash
cd LearnIQ_AI
python -m venv .venv && .venv\Scripts\activate     # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
python api/index.py
```

Open http://127.0.0.1:8000 — the API and the frontend are served together.

Run tests: `python -m pytest tests/ -q`

## Deployment (Vercel)

1. Push this folder to a Git repository.
2. In Vercel: **New Project → Import** the repo. No framework preset needed — Vercel auto-detects the Python function in `api/` and serves `public/` statically.
3. Add ONE environment variable: `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` (Project → Settings → Environment Variables).
4. Deploy. Done — no database, no storage, no other services.

All visitors' AI requests run on this single server-side key — users never see or provide a key.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Google Gemini key — set this **or** the Anthropic one |
| `ANTHROPIC_API_KEY` | — | Anthropic Claude key — set this **or** the Gemini one |
| `LEARNIQ_PROVIDER` | auto | Force `gemini` or `anthropic` when both keys exist |
| `LEARNIQ_MODEL` | per provider | Model override (`gemini-2.0-flash` / `claude-sonnet-5`) |

## Screenshots

*(placeholders — add after first deploy)*

| Dashboard | Chat with citations | Quiz | Analytics |
|---|---|---|---|
| `docs/dashboard.png` | `docs/chat.png` | `docs/quiz.png` | `docs/analytics.png` |

## Folder structure

```
LearnIQ_AI/
├── api/
│   ├── index.py            # FastAPI app — routes only
│   └── core/               # config, logger, llm, text_extract,
│                           # chunker, retriever, prompts, features
├── public/                 # SPA: index.html, style.css, app.js, db.js
├── tests/                  # pytest suite (22 tests, no network needed)
├── vercel.json             # /api/* rewrite
├── requirements.txt        # serverless runtime deps
└── requirements-dev.txt    # + uvicorn, pytest, httpx
```

## Future roadmap

Embedding-based retrieval via an external vector service, spaced-repetition scheduling (SM-2) for flashcards, account sync through a hosted database, PWA offline mode, and collaborative study rooms.

## License

MIT — see LICENSE.
