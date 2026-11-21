import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Annotated, Optional

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

import db
import llm

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("app")

DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant."


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="LLM Chatbot", lifespan=lifespan)

origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled(_, exc: Exception):
    logger.exception("unhandled error")
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


class ChatRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    message: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)
    ]
    system_prompt: Optional[str] = Field(default=None, max_length=4000)


@app.get("/health")
def health():
    try:
        db.check_db()
    except Exception:
        raise HTTPException(status_code=503, detail="database unreachable")
    keys = llm.get_keys()
    if not keys:
        raise HTTPException(status_code=503, detail="no api keys configured")
    return {"status": "ok", "keys_configured": len(keys), "cache_enabled": True}


@app.post("/chat")
def chat(req: ChatRequest, x_simulate_failure: Optional[str] = Header(default=None)):
    start = time.perf_counter()

    simulate = {}
    if os.getenv("ENABLE_FAILURE_SIMULATION", "false").lower() == "true":
        simulate = llm.parse_simulation(x_simulate_failure)

    history = db.get_history(req.session_id)
    system_prompt = (
        req.system_prompt
        or db.get_system_prompt(req.session_id)
        or DEFAULT_SYSTEM_PROMPT
    )
    messages = (
        [{"role": "system", "content": system_prompt}]
        + history
        + [{"role": "user", "content": req.message}]
    )

    result = llm.complete(messages, simulate)
    if result is None:
        raise HTTPException(status_code=503, detail="all providers unavailable")

    latency_ms = max(1, int((time.perf_counter() - start) * 1000))
    metadata = {
        "resolution_source": result["source"],
        "model": result["model"],
        "latency_ms": latency_ms,
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "key_id": result["key_id"],
        "fallback_attempts": result["fallback_attempts"],
    }

    db.add_exchange(
        req.session_id, req.message, result["reply"], metadata, req.system_prompt
    )

    return {"session_id": req.session_id, "reply": result["reply"], "metadata": metadata}


@app.get("/sessions/{session_id}/messages")
def session_messages(session_id: str):
    msgs = db.get_messages(session_id)
    if msgs is None:
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": session_id, "messages": msgs}
