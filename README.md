# Lyftr Chatbot with Key Failover and Response Caching

A full-stack AI chat app. It keeps multi-turn conversation history in SQLite, fails over automatically between API keys when one is rate-limited or down, and caches responses so repeated prompts return instantly. Every AI reply shows its own source, model, latency and token usage.

**Stack:** React (Vite) · FastAPI · LiteLLM · SQLite · Docker

## 1. Live URLs

| Service | URL |
|---|---|
| Frontend | `<your-frontend-url>` |
| Backend | `<your-backend-url>` |
| Backend health | `<your-backend-url>/health` |
| GitHub repo | `<your-github-repo-url>` |
| Demo video | `<your-demo-video-url>` |

## 2. Run locally

### Project structure

```
lyftr-chatbot/
├── backend/            FastAPI app, LiteLLM gateway, SQLite access, tests
├── frontend/           React (Vite) UI, served by nginx in Docker
├── docker-compose.yml
├── Makefile
├── .env.example
└── README.md
```

### With Docker

Requirements: Docker Desktop and `make`.

```bash
cp .env.example .env      # on Windows PowerShell: copy .env.example .env
# edit .env and put at least 2 real API keys in LLM_API_KEYS
make up
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8000 (health check at `/health`)

Stop everything with `make down`. The SQLite file lives in the named Docker volume mounted at `/data`, so history survives restarts.

If `make` is not installed, run `docker compose up --build -d` and `docker compose down` instead.

### Without Docker

**Backend** (Python 3.11+):

```bash
cd backend
python -m venv venv
venv\Scripts\activate          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env`:

```
LLM_API_KEYS=key_one,key_two
DATABASE_URL=sqlite:///./app.db
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
ENABLE_FAILURE_SIMULATION=true
```

Then start the server:

```bash
uvicorn main:app --reload --port 8000
```

**Frontend** (Node 20+), in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

Create `frontend/.env`:

```
VITE_API_URL=http://localhost:8000
```

Open http://localhost:3000.

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `LLM_API_KEYS` | backend | Comma-separated key pool, at least 2 keys. Ids are `key_1`, `key_2`, ... in this order |
| `DATABASE_URL` | backend | SQLite location, e.g. `sqlite:////data/app.db` in Docker, `sqlite:///./app.db` locally |
| `ALLOWED_ORIGINS` | backend | Comma-separated CORS origins |
| `ENABLE_FAILURE_SIMULATION` | backend | `true` enables the `X-Simulate-Failure` test header |
| `VITE_API_URL` | frontend | Base URL of the backend, baked in at build time |

Real keys never go in the repo. `.env` files are git-ignored and `.env.example` only has placeholders.

### Run the tests

```bash
cd backend
pytest
```

## 3. Design decisions

### Key fallback

- The key pool comes from `LLM_API_KEYS`. Keys get ids `key_1`, `key_2`, ... in order, and only the id is ever returned or logged, never the key itself.
- Each request tries the keys in order through LiteLLM. If a key fails with HTTP 429, a quota error or a 5xx, the next key is tried automatically.
- The reply reports which key answered (`key_id`) and how many keys failed first (`fallback_attempts`).
- If every key fails, the API returns `503 {"detail": "all providers unavailable"}`. The failed request is not saved to history, and the UI shows a readable message with a Retry button.
- Failover can be demonstrated on demand without burning real quota. Send the `X-Simulate-Failure` header (for example `key_1=429`, `key_1=429,key_2=500` or `*=429`). It only affects that single request and only works when `ENABLE_FAILURE_SIMULATION=true`.

### Caching

- LiteLLM's built-in in-memory cache is enabled.
- The cache key is the model plus the full message list sent to the LLM (system prompt + history + new message). The same first message in a brand-new session is therefore a cache hit, while any different message is a miss.
- A cache hit returns the identical reply text. Tokens are the usage stored with the cached response, `key_id` is `null` and `fallback_attempts` is `0`.
- `resolution_source` is `LLM_CACHE` for a hit and `LIVE_INFERENCE` for a fresh call. `latency_ms` is measured on the server for each request, so cache hits are visibly faster.
- The cache lives in process memory, so it resets when the backend restarts. Conversation history is unaffected because it is stored in SQLite.

### SQLite session storage

- History is stored in a single `messages` table (`id`, `session_id`, `role`, `content`, `metadata`, `created_at`). The schema is created automatically on startup.
- The client sends only the new message. The backend loads the session history from SQLite, builds the prompt (system prompt + history + new message) and stores both the user message and the assistant reply, with the metadata JSON on assistant rows.
- Sessions are isolated by `session_id`. An unknown id starts a new session.
- Failed requests (422, 503) are never added to history.
- `DATABASE_URL` points at the database file. In Docker it is `/data/app.db` on a named volume, so history survives container restarts.
- Token counts are per request, never a running total.

### Frontend

- A new session starts on every page load. A sidebar keeps a list of previous chats in the browser's localStorage and reopens them with their original session id, so the backend still has the context.
- Each assistant reply shows the source, model, latency and input/output tokens for that request only, plus the key used and any failover.
- Error responses (422, 503, network) appear as readable messages in the chat, never a blank screen.

## 4. Verification

Replace `BASE` with `http://localhost:8000` or your live backend URL. On Windows PowerShell use `curl.exe` instead of `curl`, or use the UI.

### Health

```bash
curl BASE/health
# {"status":"ok","keys_configured":2,"cache_enabled":true}
```

### Cache hit

Send the same first message in two different new sessions. The first is `LIVE_INFERENCE`, the second is `LLM_CACHE` with the same reply, `key_id: null` and lower latency.

```bash
curl -X POST BASE/chat -H "Content-Type: application/json" \
  -d '{"session_id":"s-a1","message":"What is the capital of France?"}'

curl -X POST BASE/chat -H "Content-Type: application/json" \
  -d '{"session_id":"s-a2","message":"What is the capital of France?"}'
```

In the UI: send a message, click **New chat**, send the same message again and compare the source chip and latency.

### Failover

```bash
# key_1 fails -> 200, key_id = key_2, fallback_attempts = 1
curl -X POST BASE/chat -H "Content-Type: application/json" \
  -H "X-Simulate-Failure: key_1=429" \
  -d '{"session_id":"s-b1","message":"hello there"}'

# every key fails -> 503 {"detail":"all providers unavailable"}, nothing saved
curl -X POST BASE/chat -H "Content-Type: application/json" \
  -H "X-Simulate-Failure: *=429" \
  -d '{"session_id":"s-b2","message":"hello again"}'
```

In the UI: open the sidebar, pick **key_1 → 429** under *Failover test* and send a message. The reply shows `key_2` and a failover note. Pick **All keys fail** to see the readable 503 message.

### Per-message token usage

Every `/chat` response has `input_tokens` and `output_tokens` for that request only. In the UI they appear under each reply. Two equal-length first messages in two new sessions report about the same `input_tokens`.

### Multi-turn memory and history

```bash
curl BASE/sessions/s-a1/messages        # stored history, oldest first
curl BASE/sessions/does-not-exist/messages   # 404 {"detail":"session not found"}
```

In the UI: send "My name is Rahul", then "What is my name?". Restart the backend and open `/sessions/<id>/messages` to confirm the history is still in SQLite.

### Validation

An empty message, a message over 4000 characters, a missing `session_id` or malformed JSON returns `422` with a JSON `detail`, and nothing is added to history.

## 5. Setup Used

- **Editor:** Visual Studio Code
- **AI tools:** Claude (frontend, debugging and documentation help), `<add any other assistants you used, e.g. BLACKBOX Agent>`
- **LLM provider:** Groq through LiteLLM (`groq/openai/gpt-oss-120b`), using a pool of 2 keys
- **Other tools:** Docker Desktop, Postman, Git/GitHub, `<hosting platforms you used>`

## 6. Bonus features

- **Chat sidebar with saved chats** (localStorage) so earlier conversations can be reopened and continue with their original backend session.
- **Failover test panel** in the UI with one-click presets for `X-Simulate-Failure`, which makes the demo easy.
- **Markdown rendering** for replies (code blocks, lists, tables) and a copy button.
- **Dark and light themes**, remembered across visits.
- **Retry button** on errors, and a character counter near the 4000-character limit.
- **System prompt field**, kept visible in the sidebar.