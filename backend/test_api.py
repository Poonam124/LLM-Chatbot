import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    monkeypatch.setenv("LLM_API_KEYS", "fake1,fake2")
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "true")

    import llm
    import main

    seen = set()
    calls = []

    def fake_completion(**kw):
        calls.append(kw)
        key = json.dumps(kw["messages"])
        hit = key in seen
        seen.add(key)
        last = kw["messages"][-1]["content"]
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=f"reply to: {last}"))],
            usage=SimpleNamespace(prompt_tokens=10, completion_tokens=3),
            _hidden_params={"cache_hit": hit},
        )

    monkeypatch.setattr(llm.litellm, "completion", fake_completion)

    with TestClient(main.app) as c:
        c.calls = calls
        yield c


def post(client, message="hello", session="s1", headers=None, **extra):
    body = {"session_id": session, "message": message, **extra}
    return client.post("/chat", json=body, headers=headers or {})


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "keys_configured": 2, "cache_enabled": True}


def test_validation_422(client):
    assert client.post("/chat", json={"session_id": "s1", "message": ""}).status_code == 422
    assert client.post("/chat", json={"session_id": "s1", "message": "   "}).status_code == 422
    assert client.post("/chat", json={"message": "hi"}).status_code == 422
    assert post(client, "x" * 4001).status_code == 422
    r = client.post("/chat", content="{bad json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_live_response_and_history(client):
    r = post(client, "What is the capital of France?")
    assert r.status_code == 200
    m = r.json()["metadata"]
    assert m["resolution_source"] == "LIVE_INFERENCE"
    assert m["key_id"] == "key_1"
    assert m["fallback_attempts"] == 0
    assert m["input_tokens"] == 10 and m["output_tokens"] == 3

    h = client.get("/sessions/s1/messages").json()
    assert [x["role"] for x in h["messages"]] == ["user", "assistant"]
    assert "metadata" in h["messages"][1]
    assert "metadata" not in h["messages"][0]


def test_cache_hit_in_new_session(client):
    first = post(client, "same question", session="a").json()
    second = post(client, "same question", session="b").json()
    assert second["metadata"]["resolution_source"] == "LLM_CACHE"
    assert second["metadata"]["key_id"] is None
    assert second["metadata"]["fallback_attempts"] == 0
    assert second["reply"] == first["reply"]


def test_different_message_not_cached(client):
    post(client, "one", session="a")
    r = post(client, "two", session="b").json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_multi_turn_sends_history(client):
    post(client, "my name is Poonam")
    post(client, "what is my name?")
    sent = client.calls[-1]["messages"]
    assert sent[0]["role"] == "system"
    assert len(sent) == 4


def test_failover_key1_429(client):
    r = post(client, "failover test", headers={"X-Simulate-Failure": "key_1=429"})
    assert r.status_code == 200
    m = r.json()["metadata"]
    assert m["key_id"] == "key_2"
    assert m["fallback_attempts"] == 1
    assert client.calls[-1]["api_key"] == "fake2"


def test_all_keys_fail_503_not_saved(client):
    r = post(client, "nope", session="dead", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 503
    assert r.json() == {"detail": "all providers unavailable"}
    assert client.get("/sessions/dead/messages").status_code == 404


def test_unknown_session_404(client):
    r = client.get("/sessions/unknown/messages")
    assert r.status_code == 404
    assert r.json() == {"detail": "session not found"}


def test_simulation_off_when_disabled(client, monkeypatch):
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "false")
    r = post(client, "x", headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 200