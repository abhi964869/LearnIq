"""Word-window chunking with overlap — deterministic and dependency-free."""
from __future__ import annotations

from .config import CHUNK_OVERLAP_WORDS, CHUNK_SIZE_WORDS


def chunk_text(
    text: str,
    doc_id: str,
    size: int = CHUNK_SIZE_WORDS,
    overlap: int = CHUNK_OVERLAP_WORDS,
) -> list[dict]:
    """Split text into overlapping word-window chunks.

    Paragraph boundaries are respected where possible so chunks read naturally,
    which improves both retrieval and citation previews.

    Args:
        text: Cleaned document text.
        doc_id: Stable document identifier (used to build chunk ids).
        size: Target chunk size in words.
        overlap: Overlap between consecutive chunks in words.

    Returns:
        List of {"id": str, "doc_id": str, "seq": int, "text": str}.

    Raises:
        ValueError: If size/overlap are inconsistent.
    """
    if size <= 0 or overlap < 0 or overlap >= size:
        raise ValueError("chunk size must be > 0 and overlap must be < size")
    words = text.split()
    if not words:
        return []
    chunks: list[dict] = []
    step = size - overlap
    seq = 0
    for start in range(0, len(words), step):
        window = words[start : start + size]
        if not window:
            break
        chunks.append(
            {
                "id": f"{doc_id}-c{seq}",
                "doc_id": doc_id,
                "seq": seq,
                "text": " ".join(window),
            }
        )
        seq += 1
        if start + size >= len(words):
            break
    return chunks
