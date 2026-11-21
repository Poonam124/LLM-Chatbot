import logging
import os

import litellm
from litellm.caching.caching import Cache

logger = logging.getLogger("llm")

litellm.cache = Cache(type="local")
litellm.drop_params = True

VALID_SIM_STATUSES = {"429", "500", "502", "503"}


def get_model() -> str:
    return os.getenv("LLM_MODEL", "groq/openai/gpt-oss-120b")


def get_keys() -> list[str]:
    raw = os.getenv("LLM_API_KEYS", "")
    return [k.strip() for k in raw.split(",") if k.strip()]


def parse_simulation(raw: str | None) -> dict[str, int]:
    out: dict[str, int] = {}
    if not raw:
        return out
    for part in raw.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if k and v in VALID_SIM_STATUSES:
            out[k] = int(v)
    return out


def complete(messages: list[dict], simulate: dict[str, int]) -> dict | None:
    model = get_model()
    attempts = 0

    for i, key in enumerate(get_keys()):
        key_id = f"key_{i + 1}"

        if simulate.get(key_id) or simulate.get("*"):
            attempts += 1
            continue

        try:
            kwargs = dict(
                model=model,
                messages=messages,
                api_key=key,
                caching=True,
                num_retries=0,
                timeout=30,
            )
            if simulate:
                kwargs["cache"] = {"no-cache": True}

            resp = litellm.completion(**kwargs)

            text = (resp.choices[0].message.content or "").strip()
            if not text:
                raise ValueError("empty reply")

            hidden = getattr(resp, "_hidden_params", None) or {}
            hit = bool(hidden.get("cache_hit"))
            usage = resp.usage

            return {
                "reply": text,
                "source": "LLM_CACHE" if hit else "LIVE_INFERENCE",
                "model": model,
                "input_tokens": int(usage.prompt_tokens or 0),
                "output_tokens": int(usage.completion_tokens or 0),
                "key_id": None if hit else key_id,
                "fallback_attempts": 0 if hit else attempts,
            }
        except Exception as e:
            attempts += 1
            logger.warning("%s failed: %s", key_id, type(e).__name__)
            continue

    return None