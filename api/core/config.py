"""Central configuration for LearnIQ AI backend."""
import os
import pathlib

try:  # Load .env for local development; on Vercel, env vars are injected directly.
    from dotenv import load_dotenv

    load_dotenv(pathlib.Path(__file__).resolve().parents[2] / ".env")
except ImportError:  # pragma: no cover — dotenv is in requirements, but never fatal
    pass

def resolve_provider() -> str:
    """Pick the LLM provider: explicit LEARNIQ_PROVIDER wins, else whichever key exists.

    Gemini takes precedence when both keys are present only if explicitly forced;
    otherwise the first configured key decides (Gemini checked first because a
    Gemini-only deployment is the common case for this option).
    """
    forced = os.environ.get("LEARNIQ_PROVIDER", "").strip().lower()
    if forced in {"gemini", "anthropic"}:
        return forced
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return "gemini"
    return "anthropic"


def default_model() -> str:
    """Default model for the active provider (LEARNIQ_MODEL overrides)."""
    override = os.environ.get("LEARNIQ_MODEL", "").strip()
    if override:
        return override
    return "gemini-2.5-flash" if resolve_provider() == "gemini" else "claude-sonnet-5"


DEFAULT_MODEL: str = default_model()
MAX_TOKENS_ANSWER: int = 2048
MAX_TOKENS_GENERATION: int = 8192
CHUNK_SIZE_WORDS: int = 220
CHUNK_OVERLAP_WORDS: int = 40
TOP_K_CHUNKS: int = 6
MAX_UPLOAD_BYTES: int = 15 * 1024 * 1024  # 15 MB
LLM_MAX_RETRIES: int = 3
LLM_RETRY_BASE_DELAY: float = 1.5


def resolve_api_key() -> "str | None":
    """Return the server-side API key for the active provider.

    Keys are intentionally NEVER accepted from clients: the deployment owner
    funds all requests, and no visitor ever handles or stores a key.
    """
    env_name = "GEMINI_API_KEY" if resolve_provider() == "gemini" else "ANTHROPIC_API_KEY"
    return os.environ.get(env_name, "").strip() or None
