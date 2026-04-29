# Retrograde WebUI (rewrite)

A **static, local-first** chat interface for talking to LLMs through an **OpenAI-compatible HTTP API**. Everything runs in your browser: chats, characters, and settings are stored in **local storage** unless you export them. The page you load only serves the UI; your browser sends prompts to whatever **API base URL** you configure (for example a server on your own machine).

There is **no bundled telemetry** in this interface. Third-party CDNs are not required for normal use (markdown and syntax highlighting ship as local files).

---

## What you need

- A **modern browser** with JavaScript enabled.
- An **LLM backend** that speaks the OpenAI-style REST API, typically with:
  - `GET /v1/models` (used to populate the model list and optional context length hints)
  - `POST /v1/chat/completions` (default chat mode)
  - Optionally `POST /v1/completions` if you use a **chat adapter** (see below)
- **HTTP(S) access** to this folder from the browser. ES modules (`<script type="module">`) and `fetch` to your API mean you should open the app via a **local or remote web server**, not as a raw `file://` URL, unless your browser and API setup happen to allow it.

---

## Quick start

### 1. Get the files

Use this directory as the document root (it contains `index.html`, `css/`, `js/`, `img/`, `adapters/`, etc.).

### 2. Serve it over HTTP

Pick any static server and point it at this folder. Examples:

```bash
# Python 3
python -m http.server 8080

# Node (npx)
npx --yes serve -l 8080 .

# Or use VS Code / Cursor “Live Server”, Caddy, nginx, etc.
```

Then open `http://localhost:8080` (or the URL your tool prints).

### 3. Start your LLM API

Run your backend (llama.cpp server, KoboldCPP, vLLM, text-generation-webui OpenAI extension, LM Studio, etc.) so it exposes something like `http://localhost:5001/v1` (port and path vary by product).

### 4. Configure the UI

1. Choose or create a **character** in the sidebar (or import a JSON card).
2. Open **Settings**.
3. Set **Endpoint base** to your API root, e.g. `http://localhost:5001/v1`.
4. Add an **API key** if your server requires one.
5. Pick a **model** and optional **chat adapter**, then use **Test connection** if you want a quick `/v1/models` check.

Start a **new conversation** and send a message from the composer.

---

## Optional: developer setup (markdown bundle)

The shipped `js/markdown.bundle.js` already includes Markdown rendering (marked, DOMPurify, highlight.js) for offline use. You only need Node if you change `js/markdown.js` and want to rebuild that bundle.

```bash
cd rewrite   # this directory
npm install
npm run build:markdown
```

This runs esbuild and writes `js/markdown.bundle.js`. Deploy **without** uploading `node_modules`; the static site only needs the built JS, CSS, HTML, `img/`, and `adapters/` as in the repo.

---

## How it works (architecture)

| Area | Role |
|------|------|
| `index.html` | Single-page shell: sidebar (characters, conversations), chat column, modals (settings, help, character editor, import, disclaimer). |
| `js/main.js` | App entry: UI wiring, send/regenerate/resend/stop, conversation list, settings, message edit/branching. |
| `js/storage.js` | `localStorage` CRUD, export/import (v2 JSON), migration from legacy keys, wipe. |
| `js/api.js` | `fetch` to `/v1/models`, `/v1/chat/completions`, streaming SSE, and `/v1/completions` for adapters. |
| `js/adapter.js` | Loads `adapters/*.json` templates and `adapters/manifest.json`; builds a single prompt string for completion APIs. |
| `js/context.js` | Trims message history by turn count, approximate tokens, or backend-reported context length. |
| `js/prompt.js` / `js/persona.js` | System prompt from character + settings; `{{user}}` / `{{char}}` substitution (SillyTavern-style). |
| `js/markdown.bundle.js` | Renders assistant/user message bodies as Markdown with sanitization and code highlighting. |
| `css/styles.css` | Layout, themes (dark/light), chat scroll containment, modals, components. |

**Chat flow (default):** visible user and assistant turns are assembled with an optional system message, optionally trimmed for context, then sent as `messages` to `POST /v1/chat/completions` (non-streaming JSON or streaming SSE, depending on Settings).

**Chat adapters:** If you select an adapter in Settings, the UI loads a JSON template from `adapters/`, formats the conversation into one `prompt` string, and calls `POST /v1/completions` instead. Your server must implement that endpoint. The list of adapters comes from `adapters/manifest.json`; you can add or remove entries there to match the JSON files you ship.

---

## Settings (summary)

- **Your persona** — Name and “about” text; used in display and substituted into prompts where `{{user}}` appears on character cards.
- **API** — Base URL (`…/v1`), optional bearer token, **Test connection**.
- **Model** — Dropdown from `/v1/models`, temperature, max tokens, penalties, **streaming** toggle, **context** mode (full history, last N turns, token budget, or backend context length), continuation prompt for empty-send “continue” when the last line is assistant.
- **Appearance** — Theme, accent color, font size (stored per browser).
- **Data** — Export all data, import bundle, **Forget everything** (irreversible local wipe).

Opening Settings fetches models and the adapter manifest; a short loading state is shown while those requests run.

---

## Chat UI behaviors

- **Send** — Adds a user message (or continues the thread on empty send, depending on context).
- **Stop** — Aborts an in-flight streamed request.
- **Back** — Removes the last user or assistant message.
- **Regenerate / Resend** — Re-requests the model according to the last turn (see in-app Help).
- **Clear** — After confirmation, removes all **user and assistant** messages in the current conversation but **keeps the system** message (if any), then saves.
- **Edit (pen icon)** — Edit a user or assistant message; on **Save**, text is updated and **all later messages are removed** so you can continue from that point with a clean branch.
- The **message list** scrolls inside the chat card; the page layout is viewport-bounded so long threads do not grow the whole document.

---

## CORS and security

Browsers enforce **same-origin policy** on `fetch`. If the WebUI is served from `http://localhost:8080` and your API from `http://localhost:5001`, the API must respond with **CORS headers** that allow your origin (many local inference servers can enable this in config). If you cannot change CORS, a common approach is to put the static UI and the API behind the **same origin** (reverse proxy).

You choose the API URL: only connect to endpoints you trust. Exported JSON backups may contain conversation text; handle them like private data.

---

## Data storage keys (reference)

The app uses namespaced `localStorage` keys (see `js/storage.js`), including characters, conversations, settings, and current selection. **Export** produces a versioned JSON bundle for backup and migration; **Import** merges or replaces according to the implemented logic. **Forget everything** clears app storage for this origin.

---

## Troubleshooting

| Symptom | Things to check |
|--------|------------------|
| Blank model list or connection errors | API running, URL includes `/v1` if your server expects it, CORS, API key, firewall. |
| Adapters missing or stuck loading | `adapters/manifest.json` and JSON files are deployed next to `index.html`; server returns them with correct MIME type; path is same origin as the page. |
| Module load errors | Serve over `http(s)://`, not `file://`. |
| Edited markdown not updating | Run `npm run build:markdown` after changing `js/markdown.js`. |
