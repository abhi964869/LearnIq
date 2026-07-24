"""BM25 retrieval over client-supplied chunks (stateless, serverless-safe)."""
from __future__ import annotations

import re

from rank_bm25 import BM25Okapi

from .config import TOP_K_CHUNKS

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Lowercase alphanumeric tokenization."""
    return _TOKEN_RE.findall(text.lower())


def retrieve(query: str, chunks: list[dict], top_k: int = TOP_K_CHUNKS) -> list[dict]:
    """Rank chunks against a query with BM25 and return the top-k.

    BM25's IDF turns non-positive for terms present in (nearly) every chunk,
    which zeroes out small corpora entirely — a single uploaded page would get
    no retrieval at all. When BM25 yields nothing positive, fall back to plain
    query-token overlap so relevant chunks are still surfaced.

    Args:
        query: The user's question or search string.
        chunks: [{"id", "text", ...}] — as stored by the client.
        top_k: Maximum number of chunks to return.

    Returns:
        Chunks sorted by relevance, each augmented with a "score" float.
    """
    if not query.strip() or not chunks:
        return []
    query_tokens = _tokenize(query)
    corpus = [_tokenize(chunk.get("text", "")) for chunk in chunks]

    bm25 = BM25Okapi(corpus)
    scores = bm25.get_scores(query_tokens)
    ranked = sorted(zip(chunks, scores), key=lambda pair: pair[1], reverse=True)
    results = [
        {**chunk, "score": round(float(score), 4)}
        for chunk, score in ranked[:top_k]
        if score > 0
    ]
    if results:
        return results

    # Fallback: token-overlap ranking (handles tiny/uniform corpora).
    query_set = set(query_tokens)
    overlaps = [len(query_set.intersection(tokens)) for tokens in corpus]
    ranked = sorted(zip(chunks, overlaps), key=lambda pair: pair[1], reverse=True)
    return [
        {**chunk, "score": float(overlap)}
        for chunk, overlap in ranked[:top_k]
        if overlap > 0
    ]
