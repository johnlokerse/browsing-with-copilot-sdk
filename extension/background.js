const BACKEND_WS_URL = "ws://127.0.0.1:3210/ws";
const DEFAULT_TOKEN = "change-me-local-token";
const TOOL_TIMEOUT_MS = 5000;
const DANGEROUS_CLICK_RE =
  /(delete|remove|purchase|buy|checkout|send|payment|pay|place order|confirm order|submit payment|transfer|confirm|submit|withdraw|irreversible)/i;

const state = {
  sessionId: "",
  token: DEFAULT_TOKEN,
  autoRun: false,
  connected: false,
  connecting: false,
  pendingAction: null,
};

let ws = null;
let connectPromise = null;
const pendingToolRequests = new Map();

function log(...args) {
  console.log("[copilot-extension]", ...args);
}

function getPublicState() {
  return {
    sessionId: state.sessionId,
    token: state.token,
    autoRun: state.autoRun,
    connected: state.connected,
    connecting: state.connecting,
    pendingAction: state.pendingAction,
  };
}

function broadcastState() {
  safeSendRuntimeMessage({ type: "ui_state", state: getPublicState() });
}

function broadcastEvent(event) {
  safeSendRuntimeMessage({ type: "ui_event", event });
}

function safeSendRuntimeMessage(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // Side panel might not be open.
  });
}

async function persistState() {
  await chrome.storage.local.set({
    sessionId: state.sessionId,
    token: state.token,
    autoRun: state.autoRun,
  });
}

async function initState() {
  const saved = await chrome.storage.local.get(["sessionId", "token", "autoRun"]);
  state.sessionId = saved.sessionId || crypto.randomUUID();
  state.token = typeof saved.token === "string" && saved.token.length ? saved.token : DEFAULT_TOKEN;
  state.autoRun = saved.autoRun === true;
  await persistState();

  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }

  broadcastState();
}

function parseBackendMessage(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function isOpenSocket() {
  return ws && ws.readyState === WebSocket.OPEN;
}

async function ensureConnected() {
  if (isOpenSocket()) {
    return true;
  }

  if (connectPromise) {
    return connectPromise;
  }

  state.connecting = true;
  broadcastState();

  connectPromise = new Promise((resolve) => {
    ws = new WebSocket(BACKEND_WS_URL);

    ws.onopen = () => {
      log("WebSocket connected");
      state.connected = true;
      state.connecting = false;
      broadcastState();
      resolve(true);
    };

    ws.onclose = () => {
      log("WebSocket closed");
      state.connected = false;
      state.connecting = false;
      ws = null;
      resolve(false);
      connectPromise = null;
      broadcastState();
    };

    ws.onerror = (error) => {
      log("WebSocket error", error);
    };

    ws.onmessage = async (messageEvent) => {
      const message = parseBackendMessage(messageEvent);
      if (!message || typeof message.type !== "string") {
        return;
      }

      if (message.sessionId !== state.sessionId || message.token !== state.token) {
        return;
      }

      switch (message.type) {
        case "assistant_delta":
          broadcastEvent({ type: "assistant_delta", textDelta: message.textDelta });
          break;
        case "assistant_final":
          broadcastEvent({ type: "assistant_final", text: message.text });
          break;
        case "step_event":
          broadcastEvent({ type: "step_event", step: message.step });
          break;
        case "tool_request":
          await onToolRequest(message);
          break;
        default:
          break;
      }
    };
  });

  const result = await connectPromise;
  connectPromise = null;
  return result;
}

function sendToBackend(message) {
  if (!isOpenSocket()) {
    throw new Error("EXTENSION_NOT_READY");
  }
  ws.send(JSON.stringify(message));
}

async function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeErrorCode(error) {
  if (!error) {
    return "EXTENSION_NOT_READY";
  }

  const message = typeof error === "string" ? error : error.message;
  if (
    message === "EXTENSION_NOT_READY" ||
    message === "NO_ACTIVE_TAB" ||
    message === "PERMISSION_DENIED" ||
    message === "NOT_FOUND" ||
    message === "TIMEOUT" ||
    message === "CANCELLED"
  ) {
    return message;
  }
  return "EXTENSION_NOT_READY";
}

function requiresManualApproval(request) {
  if (request.tool !== "browser_click" && request.tool !== "browser_type") {
    return false;
  }

  if (!state.autoRun) {
    return true;
  }

  if (request.tool !== "browser_click") {
    return false;
  }

  const selector = String(request.params?.selector || "");
  const label = String(request.ui?.label || "");
  return DANGEROUS_CLICK_RE.test(`${label} ${selector}`);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function isRestrictedUrl(url) {
  if (!url) {
    return true;
  }
  return url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:");
}

function normalizeUrl(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return "";
  }
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw)) {
    return `https://${raw}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

async function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("TIMEOUT"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function navigateActiveTab(url, timeoutMs) {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    throw new Error("NO_ACTIVE_TAB");
  }

  const targetUrl = normalizeUrl(url);
  if (!targetUrl || isRestrictedUrl(targetUrl)) {
    throw new Error("PERMISSION_DENIED");
  }

  const loadPromise = waitForTabLoad(tab.id, timeoutMs);
  await chrome.tabs.update(tab.id, { url: targetUrl });
  await loadPromise;
  return { ok: true, url: targetUrl };
}

async function sendToolMessageToActiveTab(payload) {
  const tab = await getActiveTab();
  if (!tab || typeof tab.id !== "number") {
    throw new Error("NO_ACTIVE_TAB");
  }

  if (isRestrictedUrl(tab.url)) {
    throw new Error("PERMISSION_DENIED");
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, payload);
    if (!response || response.ok !== true) {
      throw new Error(response?.error || "EXTENSION_NOT_READY");
    }
    return response.data;
  } catch (firstError) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });

      const retry = await chrome.tabs.sendMessage(tab.id, payload);
      if (!retry || retry.ok !== true) {
        throw new Error(retry?.error || "EXTENSION_NOT_READY");
      }
      return retry.data;
    } catch {
      if (String(firstError).includes("Cannot access")) {
        throw new Error("PERMISSION_DENIED");
      }
      throw new Error("EXTENSION_NOT_READY");
    }
  }
}

async function updateHud(message) {
  try {
    await sendToolMessageToActiveTab({ kind: "copilot_tool", action: "hud", message });
  } catch (error) {
    log("HUD update failed", error);
  }
}

async function executeToolRequest(request) {
  try {
    let resultData;
    const timeoutMs = Math.min(Number(request.timeoutMs) || TOOL_TIMEOUT_MS, 120_000);

    if (request.tool === "browser_find") {
      const query = String(request.params?.query || "");
      resultData = await withTimeout(
        sendToolMessageToActiveTab({ kind: "copilot_tool", action: "find", query }),
        timeoutMs,
      );
    } else if (request.tool === "browser_navigate") {
      const url = String(request.params?.url || "");
      resultData = await withTimeout(navigateActiveTab(url, timeoutMs), timeoutMs);
    } else if (request.tool === "browser_highlight") {
      const selector = String(request.params?.selector || "");
      const label = String(request.params?.label || "");
      resultData = await withTimeout(
        sendToolMessageToActiveTab({ kind: "copilot_tool", action: "highlight", selector, label }),
        timeoutMs,
      );
    } else if (request.tool === "browser_click") {
      const selector = String(request.params?.selector || "");
      resultData = await withTimeout(
        sendToolMessageToActiveTab({ kind: "copilot_tool", action: "click", selector }),
        timeoutMs,
      );
    } else if (request.tool === "browser_type") {
      const selector = String(request.params?.selector || "");
      const text = String(request.params?.text || "");
      resultData = await withTimeout(
        sendToolMessageToActiveTab({ kind: "copilot_tool", action: "type", selector, text }),
        timeoutMs,
      );
    } else {
      throw new Error("EXTENSION_NOT_READY");
    }

    await updateHud("Done");
    sendToBackend({
      type: "tool_result",
      sessionId: state.sessionId,
      token: state.token,
      actionId: request.actionId,
      ok: true,
      data: resultData,
    });
  } catch (error) {
    const code = normalizeErrorCode(error);
    await updateHud(`Failed: ${code}`);
    sendToBackend({
      type: "tool_result",
      sessionId: state.sessionId,
      token: state.token,
      actionId: request.actionId,
      ok: false,
      error: code,
    });
  } finally {
    pendingToolRequests.delete(request.actionId);
    if (state.pendingAction && state.pendingAction.actionId === request.actionId) {
      state.pendingAction = null;
      broadcastState();
    }
  }
}

async function onToolRequest(request) {
  log("tool_request", request.tool, request.actionId, request.params);
  pendingToolRequests.set(request.actionId, request);

  await updateHud(`Copilot: ${request.ui.label}...`);

  if (requiresManualApproval(request)) {
    state.pendingAction = {
      actionId: request.actionId,
      tool: request.tool,
      label: request.ui.label,
    };
    broadcastState();
    broadcastEvent({ type: "approval_needed", action: state.pendingAction });
    return;
  }

  await executeToolRequest(request);
}

async function handleApproval(actionId, approved) {
  const request = pendingToolRequests.get(actionId);
  if (!request) {
    return;
  }

  sendToBackend({
    type: "user_approval",
    sessionId: state.sessionId,
    token: state.token,
    actionId,
    approved,
  });

  state.pendingAction = null;
  broadcastState();

  if (!approved) {
    pendingToolRequests.delete(actionId);
    await updateHud("Failed: PERMISSION_DENIED");
    sendToBackend({
      type: "tool_result",
      sessionId: state.sessionId,
      token: state.token,
      actionId,
      ok: false,
      error: "PERMISSION_DENIED",
    });
    return;
  }

  await executeToolRequest(request);
}

async function stopRun() {
  if (!isOpenSocket()) {
    return;
  }

  sendToBackend({
    type: "cancel",
    sessionId: state.sessionId,
    token: state.token,
  });

  if (state.pendingAction) {
    const actionId = state.pendingAction.actionId;
    sendToBackend({
      type: "user_approval",
      sessionId: state.sessionId,
      token: state.token,
      actionId,
      approved: false,
    });
    sendToBackend({
      type: "tool_result",
      sessionId: state.sessionId,
      token: state.token,
      actionId,
      ok: false,
      error: "CANCELLED",
    });
    pendingToolRequests.delete(actionId);
    state.pendingAction = null;
    broadcastState();
  }

  await updateHud("Failed: CANCELLED");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "ui_init": {
        sendResponse({ ok: true, state: getPublicState() });
        break;
      }
      case "ui_connect": {
        const ok = await ensureConnected();
        sendResponse({ ok, state: getPublicState() });
        break;
      }
      case "ui_set_token": {
        state.token = String(message.token || DEFAULT_TOKEN);
        await persistState();
        broadcastState();
        sendResponse({ ok: true, state: getPublicState() });
        break;
      }
      case "ui_set_auto_run": {
        state.autoRun = message.autoRun === true;
        await persistState();
        broadcastState();
        sendResponse({ ok: true, state: getPublicState() });
        break;
      }
      case "ui_send_user_message": {
        const text = String(message.text || "").trim();
        if (!text) {
          sendResponse({ ok: false, error: "EMPTY_MESSAGE" });
          return;
        }

        const connected = await ensureConnected();
        if (!connected) {
          sendResponse({ ok: false, error: "EXTENSION_NOT_READY" });
          return;
        }

        sendToBackend({
          type: "user_message",
          sessionId: state.sessionId,
          token: state.token,
          text,
        });
        sendResponse({ ok: true });
        break;
      }
      case "ui_approval": {
        await handleApproval(String(message.actionId || ""), message.approved === true);
        sendResponse({ ok: true, state: getPublicState() });
        break;
      }
      case "ui_stop": {
        await stopRun();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "UNKNOWN_COMMAND" });
    }
  })().catch((error) => {
    log("Message handling error", error);
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});

initState().catch((error) => {
  log("Failed to initialize extension", error);
});
