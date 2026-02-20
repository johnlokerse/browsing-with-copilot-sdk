# Copilot Browser Agent PoC (Local-Only)

Minimal end-to-end proof-of-concept:
- Browser extension side panel provides chat UI.
- Node/TypeScript backend uses GitHub Copilot SDK and emits browser tool calls.
- Extension executes tool calls in the active tab with visible HUD + highlight feedback.
- Backend and extension communicate over `ws://127.0.0.1:3210/ws` with a shared pairing token.

## Repo Layout

```
/
  backend/
  extension/
  README.md
```

## Prerequisites

- Node.js 18+
- GitHub Copilot CLI installed (required by `@github/copilot-sdk`)
- GitHub CLI authenticated for Copilot (run `gh auth login` and `gh auth refresh -h github.com -s copilot`)

Optional environment variables:
- `PAIRING_TOKEN` (default: `change-me-local-token`)
- `COPILOT_MODEL` (default: `claude-sonnet-4.6`; backend validates this against `client.listModels()` and falls back to Copilot default if unavailable)

## Run (Exact Steps)

1. Install backend dependencies:

```bash
cd backend
npm install
```

2. Start backend:

```bash
PAIRING_TOKEN=change-me-local-token npm start
```

The backend listens on:
- `ws://127.0.0.1:3210/ws`

3. Load unpacked extension:
- Open Chrome/Edge `chrome://extensions` (or `edge://extensions`)
- Enable **Developer mode**
- Click **Load unpacked**
- Select `/Users/john/Documents/Repositories/github-copilot-sdk-browser/extension`

4. Open any website for testing.

5. Open the extension side panel:
- Click the extension action icon (panel opens via `openPanelOnActionClick`), or open side panel manually.

6. In side panel:
- Verify pairing token is `change-me-local-token` (or match your `PAIRING_TOKEN`)
- Click **Connect**
- Send sample messages:
  - `Find and highlight the search box`
  - `Type 'hello world' into the search box`
  - `Click the first visible 'Search' button`
  - `On tweakers.net find me news about AirPods Max`

## Behavior Implemented

- Required protocol messages implemented exactly:
  - Extension -> Backend: `user_message`, `user_approval`, `cancel`, `tool_result`
  - Backend -> Extension: `assistant_delta`, `assistant_final`, `tool_request`
- Deterministic agent workflow instructions enforced in system prompt:
  1. optional `browser.navigate` when user references a target site
  2. `browser.find`
  3. `browser.highlight`
  4. wait for approval when needed
  5. `browser.click` or `browser.type` (or summarize for information-only requests)
  6. completion confirmation
- If `find` returns multiple candidates, the agent is instructed to ask for disambiguation instead of guessing.
- Dangerous click actions always require explicit approval (even when Auto-run is ON).
- Tool timeout: backend waits max 5 seconds per `tool_request`.
- Cancellation:
  - Side panel **Stop** sends `cancel`
  - Backend aborts run and pending tool waits
- Shared secret enforcement:
  - Every message is validated against `PAIRING_TOKEN`

## How It Works (Message Flow)

1. User sends chat text in side panel.
2. Extension background sends `user_message` over WebSocket.
3. Backend forwards prompt to Copilot SDK session with browser tools:
   - `browser.navigate(url)`
   - `browser.find(query)`
   - `browser.highlight(selector, label?)`
   - `browser.click(selector)`
   - `browser.type(selector, text)`
4. For each tool call, backend emits `tool_request` and waits for matching `tool_result`.
5. Extension receives `tool_request`:
   - Shows page HUD: `Copilot: <label>...`
   - If approval needed, waits for Approve/Reject from side panel
   - Executes via content script in active tab (find/highlight/click/type)
   - Sends `tool_result`
   - Updates HUD to `Done` or `Failed: <error>`
6. Backend streams assistant text with `assistant_delta` and final response with `assistant_final` (including step list).

## Notes

- Auto-run default is OFF.
- With Auto-run OFF, click/type waits for manual approval.
- Logging is enabled in backend console and extension/content-script consoles.
