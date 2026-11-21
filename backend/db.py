import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone


def _db_path() -> str:
    url = os.getenv("DATABASE_URL", "sqlite:///./app.db")
    return url.replace("sqlite:///", "", 1)


@contextmanager
def get_conn():
    path = _db_path()
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as c:
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                metadata TEXT,
                created_at TEXT NOT NULL
            )
            """
        )
        c.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)"
        )
        c.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                system_prompt TEXT
            )
            """
        )


def check_db() -> bool:
    with get_conn() as c:
        c.execute("SELECT 1")
    return True


def get_history(session_id: str) -> list[dict]:
    with get_conn() as c:
        rows = c.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [{"role": r, "content": t} for r, t in rows]


def get_messages(session_id: str) -> list[dict] | None:
    with get_conn() as c:
        rows = c.execute(
            "SELECT role, content, metadata FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    if not rows:
        return None
    out = []
    for role, content, meta in rows:
        item = {"role": role, "content": content}
        if role == "assistant" and meta:
            item["metadata"] = json.loads(meta)
        out.append(item)
    return out


def get_system_prompt(session_id: str) -> str | None:
    with get_conn() as c:
        row = c.execute(
            "SELECT system_prompt FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
    return row[0] if row else None


def add_exchange(session_id, user_message, assistant_reply, metadata, system_prompt):
    now = datetime.now(timezone.utc).isoformat()
    with get_conn() as c:
        c.execute(
            "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, 'user', ?, NULL, ?)",
            (session_id, user_message, now),
        )
        c.execute(
            "INSERT INTO messages (session_id, role, content, metadata, created_at) VALUES (?, 'assistant', ?, ?, ?)",
            (session_id, assistant_reply, json.dumps(metadata), now),
        )
        if system_prompt:
            c.execute(
                """
                INSERT INTO sessions (session_id, system_prompt) VALUES (?, ?)
                ON CONFLICT(session_id) DO UPDATE SET system_prompt = excluded.system_prompt
                """,
                (session_id, system_prompt),
            )
