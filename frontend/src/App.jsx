import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");
const STORAGE_KEY = "llm-chat-history-v1";
const THEME_KEY = "llm-chat-theme";

const SUGGESTIONS = [
  "What is the capital of India?",
  "Explain caching in 3 sentences",
  "Write a Python palindrome checker",
  "My name is Poonam. Remember it.",
];

const FAILURE_PRESETS = [
  { label: "Off", value: "" },
  { label: "key_1 → 429", value: "key_1=429" },
  { label: "key_1 → 500", value: "key_1=500" },
  { label: "All keys fail", value: "*=429" },
];

const newSessionId = () => {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `s-${rand}`;
};

const loadChats = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const initialTheme = () => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
};

function readableError(status, body) {
  const detail = body && body.detail;
  if (status === 503) return "All AI providers are unavailable right now. Please try again in a moment.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const parts = detail.map((d) => {
      const field = Array.isArray(d.loc) ? d.loc.filter((x) => x !== "body").join(".") : "";
      return field ? `${field}: ${d.msg}` : d.msg;
    });
    return `Invalid request — ${parts.join("; ")}`;
  }
  if (status === 422) return "Invalid request. Check that your message is 1–4000 characters.";
  return `Something went wrong (status ${status}). Please try again.`;
}

const Icon = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

function Meta({ meta }) {
  const cached = meta.resolution_source === "LLM_CACHE";
  return (
    <div className="meta">
      <span className={`m ${cached ? "src-cache" : "src-live"}`}>
        <b data-testid="meta-source">{meta.resolution_source}</b>
      </span>
      <span className="m"><b data-testid="meta-model">{meta.model}</b></span>
      <span className="m"><b data-testid="meta-latency">{meta.latency_ms} ms</b></span>
      <span className="m"><i>in</i> <b data-testid="meta-input-tokens">{meta.input_tokens}</b></span>
      <span className="m"><i>out</i> <b data-testid="meta-output-tokens">{meta.output_tokens}</b></span>
      <span className="m"><i>key</i> <b>{meta.key_id ?? "none"}</b></span>
      {meta.fallback_attempts > 0 && (
        <span className="m warn"><b>{meta.fallback_attempts} key failed, failover used</b></span>
      )}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [sessionId, setSessionId] = useState(newSessionId); // new session on every page load
  const [messages, setMessages] = useState([]);
  const [chats, setChats] = useState(loadChats);
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [simulate, setSimulate] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 800);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const lastText = useRef("");
  const endRef = useRef(null);
  const taRef = useRef(null);
  const skipSave = useRef(false);

  const isMobile = () => window.innerWidth <= 800;

  // theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  // persist chat list
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch {
      /* storage full or blocked */
    }
  }, [chats]);

  // save the current chat into the list whenever it changes
  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (messages.length === 0) return;
    setChats((prev) => {
      const existing = prev.find((c) => c.id === sessionId);
      const firstUser = messages.find((m) => m.role === "user");
      const title = existing?.title || (firstUser ? firstUser.content.slice(0, 48) : "New chat");
      const entry = { id: sessionId, title, messages, systemPrompt, updatedAt: Date.now() };
      return [entry, ...prev.filter((c) => c.id !== sessionId)].slice(0, 50);
    });
  }, [messages, systemPrompt, sessionId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [input]);

  async function copy(key, text) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      /* clipboard not available */
    }
  }

  async function send(raw, retry = false) {
    const text = (raw || "").trim();
    if (!text || loading) return;
    lastText.current = text;

    setMessages((m) => {
      if (retry) return m[m.length - 1]?.role === "error" ? m.slice(0, -1) : m;
      return [...m, { role: "user", content: text }];
    });
    setLoading(true);

    const headers = { "Content-Type": "application/json" };
    if (simulate.trim()) headers["X-Simulate-Failure"] = simulate.trim();

    const body = { session_id: sessionId, message: text };
    if (systemPrompt.trim()) body.system_prompt = systemPrompt.trim();

    try {
      const res = await fetch(`${API_URL}/chat`, { method: "POST", headers, body: JSON.stringify(body) });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        setMessages((m) => [...m, { role: "error", content: readableError(res.status, data) }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data.reply, metadata: data.metadata }]);
      }
    } catch {
      setMessages((m) => [
        ...m,
        { role: "error", content: "Can't reach the server. Check your connection and try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function submit() {
    const t = input;
    if (!t.trim() || loading) return;
    setInput("");
    send(t);
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function newChat() {
    if (loading) return;
    setMessages([]);
    setSystemPrompt("");
    setSessionId(newSessionId());
    if (isMobile()) setSidebarOpen(false);
  }

  function openChat(chat) {
    if (loading || chat.id === sessionId) {
      if (isMobile()) setSidebarOpen(false);
      return;
    }
    skipSave.current = true; // opening a chat should not reorder the list
    setSessionId(chat.id);
    setMessages(chat.messages || []);
    setSystemPrompt(chat.systemPrompt || "");
    if (isMobile()) setSidebarOpen(false);
  }

  function deleteChat(id) {
    if (loading) return;
    setChats((prev) => prev.filter((c) => c.id !== id));
    if (id === sessionId) newChat();
  }

  function clearAll() {
    if (loading) return;
    setChats([]);
    newChat();
  }

  const empty = messages.length === 0 && !loading;

  return (
    <div className="shell">
      {sidebarOpen && <div className="backdrop" onClick={() => setSidebarOpen(false)} />}

      {/* ---------------- sidebar ---------------- */}
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-hidden={!sidebarOpen}>
        <div className="sidebar-inner">
          <div className="side-head">
            <button type="button" className="new-chat" onClick={newChat} disabled={loading}>
              <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></Icon>
              New chat
            </button>
            <button type="button" className="icon-btn close-btn" aria-label="Close sidebar"
                    onClick={() => setSidebarOpen(false)}>
              <Icon><path d="M18 6 6 18M6 6l12 12" /></Icon>
            </button>
          </div>

          <div className="history">
            <div className="label-row">
              <span className="label">Chats</span>
              {chats.length > 0 && (
                <button type="button" className="link-btn" onClick={clearAll} disabled={loading}>Clear all</button>
              )}
            </div>
            {chats.length === 0 ? (
              <p className="muted-note">Your chats are saved here.</p>
            ) : (
              <ul>
                {chats.map((c) => (
                  <li key={c.id} className={c.id === sessionId ? "active" : ""}>
                    <button type="button" className="chat-item" onClick={() => openChat(c)} title={c.title}>
                      {c.title}
                    </button>
                    <button type="button" className="del" aria-label={`Delete chat ${c.title}`}
                            onClick={() => deleteChat(c.id)} disabled={loading}>
                      <Icon size={15}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></Icon>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="side-settings">
            <div className="side-block">
              <label htmlFor="sys-prompt">System prompt</label>
              <textarea
                id="sys-prompt"
                data-testid="system-prompt-input"
                rows={3}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Optional. e.g. You are a concise assistant."
              />
            </div>

            <div className="side-block">
              <label>Failover test</label>
              <div className="presets">
                {FAILURE_PRESETS.map((p) => (
                  <button type="button" key={p.label}
                          className={`preset ${simulate === p.value ? "active" : ""}`}
                          onClick={() => setSimulate(p.value)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <input type="text" value={simulate} onChange={(e) => setSimulate(e.target.value)}
                     placeholder="key_1=429,key_2=500" aria-label="Custom failure header" />
            </div>
          </div>

          <div className="side-foot">
            <div className="side-foot">
            <button type="button" className="session" onClick={() => copy("session", sessionId)} title="Copy session id">
              {copied === "session" ? "Copied" : sessionId}
            </button>
          </div>
            <button type="button" className="session" onClick={() => copy("session", sessionId)} title="Copy session id">
              {copied === "session" ? "Copied" : sessionId}
            </button>
          </div>
        </div>
      </aside>

      {/* ---------------- main ---------------- */}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn" aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
                  onClick={() => setSidebarOpen((v) => !v)}>
            <Icon><path d="M3 6h18M3 12h18M3 18h18" /></Icon>
          </button>
          <span className="title">Lyftr Chatbot</span>
          {simulate && (
            <button type="button" className="sim-badge" onClick={() => setSimulate("")} title="Click to turn off">
              Simulating {simulate} ✕
            </button>
          )}
          <button type="button" className="icon-btn theme-top" aria-label="Toggle theme"
                  onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? (
              <Icon><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>
            ) : (
              <Icon><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></Icon>
            )}
          </button>
        </header>

        <main className="thread" aria-live="polite">
          <div className="thread-inner">
            {empty && (
              <div className="hero">
                <h2>What can I help with?</h2>
              </div>
            )}

            {messages.map((m, i) => {
              if (m.role === "user") {
                return (
                  <div key={i} className="msg msg-user">
                    <div className="user-bubble" data-testid="user-message">{m.content}</div>
                  </div>
                );
              }
              if (m.role === "error") {
                return (
                  <div key={i} className="msg">
                    <div className="error-box" role="alert" data-testid="error-message">
                      <span>{m.content}</span>
                      <button type="button" onClick={() => send(lastText.current, true)} disabled={loading}>
                        Retry
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} className="msg msg-ai" data-testid="assistant-message">
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                  <div className="ai-foot">
                    <button type="button" className="act" aria-label="Copy reply" onClick={() => copy(`m${i}`, m.content)}>
                      {copied === `m${i}` ? (
                        <Icon size={15}><path d="M20 6 9 17l-5-5" /></Icon>
                      ) : (
                        <Icon size={15}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></Icon>
                      )}
                    </button>
                    {m.metadata && <Meta meta={m.metadata} />}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="msg msg-ai">
                <span className="pulse" aria-label="Assistant is typing" />
              </div>
            )}
            <div ref={endRef} />
          </div>
        </main>

        <footer className="composer-wrap">
          {empty && (
            <div className="suggest">
              {SUGGESTIONS.map((s) => (
                <button type="button" key={s} onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          )}
          <div className="composer">
            <textarea
              ref={taRef}
              data-testid="chat-input"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything"
              aria-label="Message"
            />
            {input.length > 3500 && (
              <span className={`count ${input.length > 4000 ? "over" : ""}`}>{input.length}/4000</span>
            )}
            <button type="button" className="send" data-testid="send-button" aria-label="Send message"
                    onClick={submit} disabled={loading || !input.trim()}>
              <Icon size={18}><path d="M12 19V5M5 12l7-7 7 7" /></Icon>
            </button>
          </div>
          <p className="foot-note">Replies show their source, model, latency and token usage.</p>
        </footer>
      </div>
    </div>
  );
}
