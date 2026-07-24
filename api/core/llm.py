"""Claude LLM client with retries, streaming, and robust JSON extraction."""
from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from typing import Any

import anthropic

from .config import DEFAULT_MODEL, LLM_MAX_RETRIES, LLM_RETRY_BASE_DELAY
from .logger import get_logger

logger = get_logger(__name__)


class MissingApiKeyError(Exception):
    """Raised when no Anthropic API key is available."""


class LLMError(Exception):
    """Raised when the LLM call ultimately fails after retries."""


class ClaudeClient:
    """Thin, stateless wrapper around the Anthropic SDK.

    A new instance is created per request (serverless-safe); the underlying
    SDK client is cheap to construct.
    """

    def __init__(self, api_key: str | None, model: str | None = None) -> None:
        """Initialize the client.

        Args:
            api_key: Anthropic API key. Raises MissingApiKeyError if falsy.
            model: Optional model override.
        """
        if not api_key:
            raise MissingApiKeyError(
                "No Anthropic API key configured. Add one in Settings or set "
                "ANTHROPIC_API_KEY in your deployment environment."
            )
        self._client = anthropic.Anthropic(api_key=api_key, max_retries=0)
        self.model = model or DEFAULT_MODEL

    def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> str:
        """Run a non-streaming completion with exponential-backoff retries.

        Args:
            system: System prompt.
            messages: Chat messages [{role, content}, ...].
            max_tokens: Response token cap.
            temperature: Sampling temperature.

        Returns:
            The assistant's text response.

        Raises:
            LLMError: If all retries fail.
        """
        last_error: Exception | None = None
        for attempt in range(1, LLM_MAX_RETRIES + 1):
            try:
                response = self._client.messages.create(
                    model=self.model,
                    system=system,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                )
                return "".join(
                    block.text for block in response.content if block.type == "text"
                )
            except anthropic.AuthenticationError as exc:
                raise LLMError("Your API key was rejected. Check it in Settings.") from exc
            except (anthropic.APIError, anthropic.APIConnectionError) as exc:
                last_error = exc
                delay = LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.warning("LLM attempt %d/%d failed: %s", attempt, LLM_MAX_RETRIES, exc)
                if attempt < LLM_MAX_RETRIES:
                    time.sleep(delay)
        raise LLMError(
            "The AI service is temporarily unavailable. Please try again."
        ) from last_error

    def stream_text(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> Iterator[str]:
        """Stream a completion as text deltas.

        Yields:
            Text fragments as they arrive.

        Raises:
            LLMError: On authentication failure or connection errors.
        """
        try:
            with self._client.messages.stream(
                model=self.model,
                system=system,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            ) as stream:
                yield from stream.text_stream
        except anthropic.AuthenticationError as exc:
            raise LLMError("Your API key was rejected. Check ANTHROPIC_API_KEY.") from exc
        except (anthropic.APIError, anthropic.APIConnectionError) as exc:
            # Networks that block streaming often still allow normal requests —
            # fall back so chat keeps working instead of failing outright.
            logger.warning("Claude stream failed (%s); falling back to non-streaming",
                           type(exc).__name__)
            yield self.complete(system, messages, max_tokens=max_tokens, temperature=temperature)

    def solve_image(self, system: str, prompt: str, image_b64: str, mime: str,
                    max_tokens: int = 2048) -> str:
        """Answer a question shown in an image (vision).

        Args:
            system: System prompt.
            prompt: Text instruction accompanying the image.
            image_b64: Base64-encoded image data (no data-URI prefix).
            mime: Image MIME type, e.g. "image/jpeg".
            max_tokens: Response cap.

        Returns:
            The model's Markdown answer.

        Raises:
            LLMError: On auth failure or after retries.
        """
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": mime, "data": image_b64}},
            {"type": "text", "text": prompt},
        ]
        last_error: Exception | None = None
        for attempt in range(1, LLM_MAX_RETRIES + 1):
            try:
                response = self._client.messages.create(
                    model=self.model, system=system, max_tokens=max_tokens,
                    messages=[{"role": "user", "content": content}],
                )
                return "".join(b.text for b in response.content if b.type == "text")
            except anthropic.AuthenticationError as exc:
                raise LLMError("Your API key was rejected. Check ANTHROPIC_API_KEY.") from exc
            except (anthropic.APIError, anthropic.APIConnectionError) as exc:
                last_error = exc
                logger.warning("Claude vision attempt %d/%d failed: %s", attempt, LLM_MAX_RETRIES, exc)
                if attempt < LLM_MAX_RETRIES:
                    time.sleep(LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
        raise LLMError("Couldn't read the image. Please retry with a clearer photo.") from last_error

    def complete_json(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 4096,
    ) -> Any:
        """Run a completion expected to return JSON; parse robustly with one repair retry.

        Returns:
            Parsed JSON (dict or list).

        Raises:
            LLMError: If JSON cannot be parsed after a repair attempt.
        """
        text = self.complete(system, messages, max_tokens=max_tokens, temperature=0.4)
        parsed = _extract_json(text)
        if parsed is not None:
            return parsed
        logger.warning("JSON parse failed; asking model to repair output")
        repair_messages = messages + [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "Your previous reply was not valid JSON. "
             "Respond again with ONLY the valid JSON, no prose, no code fences."},
        ]
        text = self.complete(system, repair_messages, max_tokens=max_tokens, temperature=0.2)
        parsed = _extract_json(text)
        if parsed is None:
            raise LLMError("The AI returned malformed data. Please try again.")
        return parsed


def _extract_json(text: str) -> Any:
    """Extract the first JSON object/array from text, tolerating code fences."""
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    candidates = [fenced.group(1)] if fenced else []
    match = re.search(r"[\[{][\s\S]*[\]}]", text)
    if match:
        candidates.append(match.group(0))
    candidates.append(text)
    for candidate in candidates:
        try:
            return json.loads(candidate.strip())
        except (json.JSONDecodeError, ValueError):
            continue
    return None


# Live Gemini models to try in order if the configured one is retired/unavailable.
# Google periodically shuts models down (e.g. gemini-2.0-flash on 2026-06-01), so
# the client degrades gracefully instead of failing outright.
GEMINI_FALLBACK_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"]


class GeminiClient:
    """Google Gemini client exposing the same interface as ClaudeClient.

    Feature code never imports this directly — use make_llm_client(), which
    picks the provider from the environment. Keeping the two clients
    interface-identical (complete / stream_text / complete_json) means every
    feature works unchanged on either provider.
    """

    def __init__(self, api_key: str | None, model: str | None = None) -> None:
        """Initialize the client.

        Args:
            api_key: Google AI Studio API key. Raises MissingApiKeyError if falsy.
            model: Optional model override (e.g. "gemini-2.0-flash").
        """
        if not api_key:
            raise MissingApiKeyError(
                "No Gemini API key configured. Set GEMINI_API_KEY in your "
                "deployment environment."
            )
        from google import genai  # lazy import: only loaded on Gemini deployments

        self._genai = genai
        self._client = genai.Client(api_key=api_key)
        from .config import DEFAULT_MODEL

        self.model = model or DEFAULT_MODEL

    def _call(self, model: str, contents, cfg: dict):
        """generate_content that self-heals if the SDK/model rejects a config key.

        Older google-genai versions don't understand thinking_config; rather than
        let that break generation, retry once without it on ANY error."""
        try:
            return self._client.models.generate_content(model=model, contents=contents, config=cfg)
        except Exception as exc:
            if "thinking_config" in cfg:
                try:
                    safe = {k: v for k, v in cfg.items() if k != "thinking_config"}
                    logger.warning("config rejected (%s); retrying without thinking_config", type(exc).__name__)
                    return self._client.models.generate_content(model=model, contents=contents, config=safe)
                except Exception:
                    raise exc
            raise

    @staticmethod
    def _contents(messages: list[dict[str, str]]) -> list[dict]:
        """Convert Anthropic-style messages to Gemini contents."""
        role_map = {"user": "user", "assistant": "model"}
        return [
            {"role": role_map.get(m["role"], "user"), "parts": [{"text": m["content"]}]}
            for m in messages
        ]

    def _config(self, system: str, max_tokens: int, temperature: float, json_mode: bool = False) -> dict:
        cfg = {
            "system_instruction": system,
            "max_output_tokens": max_tokens,
            "temperature": temperature,
            # Gemini 2.5 models "think" by consuming output tokens; that can
            # truncate a long JSON reply into invalid JSON. Turn thinking off so
            # the entire budget is spent on the actual answer.
            "thinking_config": {"thinking_budget": 0},
        }
        if json_mode:
            cfg["response_mime_type"] = "application/json"
        return cfg

    def _raise_for(self, exc: Exception) -> None:
        """Translate auth/key failures into a friendly terminal error.

        Gemini returns HTTP 400 with "API key not valid" for bad keys (not
        401/403), so the message text must be inspected too.
        """
        code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
        message = str(exc)
        if code in (401, 403) or "API key not valid" in message or "API_KEY_INVALID" in message:
            raise LLMError(
                "Your Gemini API key was rejected by Google. Confirm GEMINI_API_KEY "
                "in .env is correct and that the google-genai library is up to date "
                "(pip install -U google-genai) — older versions reject the new AQ. "
                "auth-key format."
            ) from exc

    @staticmethod
    def _is_model_error(exc: Exception) -> bool:
        """True when the failure is a retired/unknown/unavailable model."""
        msg = str(exc).lower()
        code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
        return code == 404 or "not found" in msg or "not supported" in msg or "is not available" in msg

    def _models_to_try(self) -> list[str]:
        """Configured model first, then live fallbacks (de-duplicated)."""
        ordered = [self.model] + [m for m in GEMINI_FALLBACK_MODELS if m != self.model]
        return ordered

    def complete(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> str:
        """Run a non-streaming completion, retrying transient errors and falling
        back to alternate models if the requested one is retired/unavailable."""
        last_error: Exception | None = None
        for model in self._models_to_try():
            for attempt in range(1, LLM_MAX_RETRIES + 1):
                try:
                    response = self._client.models.generate_content(
                        model=model,
                        contents=self._contents(messages),
                        config=self._config(system, max_tokens, temperature),
                    )
                    if model != self.model:
                        logger.info("Gemini fell back to model %s", model)
                        self.model = model  # stick with the working model this request
                    return response.text or ""
                except Exception as exc:
                    self._raise_for(exc)  # real auth errors raise immediately
                    last_error = exc
                    if self._is_model_error(exc):
                        logger.warning("Model %s unavailable (%s); trying next", model, exc)
                        break  # move to next candidate model
                    logger.warning("Gemini attempt %d/%d on %s failed: %s",
                                   attempt, LLM_MAX_RETRIES, model, exc)
                    if attempt < LLM_MAX_RETRIES:
                        time.sleep(LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
        raise LLMError(
            f"Gemini request failed ({type(last_error).__name__}: "
            f"{str(last_error)[:200]}). Check your key and model."
        ) from last_error

    def stream_text(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ):
        """Stream a completion as text deltas."""
        try:
            stream = self._client.models.generate_content_stream(
                model=self.model,
                contents=self._contents(messages),
                config=self._config(system, max_tokens, temperature),
            )
            for chunk in stream:
                if chunk.text:
                    yield chunk.text
        except Exception as exc:
            self._raise_for(exc)  # re-raise real auth errors, don't mask them
            # Many Windows setups (antivirus, proxies, firewalls) break the
            # streaming connection while normal requests work fine. Fall back to
            # a single non-streaming call so the user still gets their answer.
            logger.warning("Gemini stream failed (%s); falling back to non-streaming",
                           type(exc).__name__)
            yield self.complete(system, messages, max_tokens=max_tokens, temperature=temperature)

    def solve_image(self, system: str, prompt: str, image_b64: str, mime: str,
                    max_tokens: int = 2048) -> str:
        """Answer a question shown in an image (vision), with model fallback."""
        import base64 as _b64

        from google.genai import types

        image_part = types.Part.from_bytes(data=_b64.b64decode(image_b64), mime_type=mime)
        last_error: Exception | None = None
        for model in self._models_to_try():
            for attempt in range(1, LLM_MAX_RETRIES + 1):
                try:
                    response = self._client.models.generate_content(
                        model=model,
                        contents=[image_part, prompt],
                        config=self._config(system, max_tokens, 0.4),
                    )
                    if model != self.model:
                        self.model = model
                    return response.text or ""
                except Exception as exc:
                    self._raise_for(exc)
                    last_error = exc
                    if self._is_model_error(exc):
                        break
                    logger.warning("Gemini vision attempt %d/%d on %s failed: %s",
                                   attempt, LLM_MAX_RETRIES, model, exc)
                    if attempt < LLM_MAX_RETRIES:
                        time.sleep(LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
        raise LLMError(
            f"Couldn't read the image ({type(last_error).__name__}: {str(last_error)[:150]}). "
            "Try a clearer photo."
        ) from last_error

    def complete_json(
        self,
        system: str,
        messages: list[dict[str, str]],
        max_tokens: int = 4096,
    ):
        """JSON completion using Gemini's native JSON mode, with a repair retry."""
        last_error: Exception | None = None
        for attempt in range(1, LLM_MAX_RETRIES + 1):
            try:
                response = self._client.models.generate_content(
                    model=self.model,
                    contents=self._contents(messages),
                    config=self._config(system, max_tokens, 0.4, json_mode=True),
                )
                parsed = _extract_json(response.text or "")
                if parsed is not None:
                    return parsed
                last_error = LLMError("malformed JSON")
            except Exception as exc:
                self._raise_for(exc)
                last_error = exc
                logger.warning("Gemini JSON attempt %d/%d failed: %s", attempt, LLM_MAX_RETRIES, exc)
            if attempt < LLM_MAX_RETRIES:
                time.sleep(LLM_RETRY_BASE_DELAY * (2 ** (attempt - 1)))
        raise LLMError("The AI returned malformed data. Please try again.") from last_error


def make_llm_client(api_key: str | None, model: str | None = None):
    """Build the LLM client for the active provider (Gemini or Claude).

    Args:
        api_key: The provider's API key (from config.resolve_api_key()).
        model: Optional model override from the request.

    Returns:
        A client exposing complete / stream_text / complete_json.
    """
    from .config import resolve_provider

    if resolve_provider() == "gemini":
        return GeminiClient(api_key, model=model)
    return ClaudeClient(api_key, model=model)
