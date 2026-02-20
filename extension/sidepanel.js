const transcriptEl = document.getElementById("transcript");
const statusDotEl = document.getElementById("statusDot");
const statusTextEl = document.getElementById("statusText");
const tokenInputEl = document.getElementById("tokenInput");
const connectBtnEl = document.getElementById("connectBtn");
const stopBtnEl = document.getElementById("stopBtn");
const autoRunToggleEl = document.getElementById("autoRunToggle");
const approvalLabelEl = document.getElementById("approvalLabel");
const approveBtnEl = document.getElementById("approveBtn");
const rejectBtnEl = document.getElementById("rejectBtn");
const composerEl = document.getElementById("composer");
const messageInputEl = document.getElementById("messageInput");
const sendBtnEl = document.getElementById("sendBtn");
const sendLabelEl = document.getElementById("sendLabel");
const controlsDetailsEl = document.getElementById("controlsDetails");

const uiState = {
  sessionId: "",
  token: "",
  autoRun: false,
  connected: false,
  connecting: false,
  pendingAction: null,
};

let streamingMessageEl = null;
let activityCardEl = null;
let activityStepsEl = null;
let activityStepCount = 0;
let awaitingAssistantResponse = false;

function getOrCreateActivityCard() {
  if (activityCardEl) return activityCardEl;

  activityCardEl = document.createElement("div");
  activityCardEl.className = "activity-card";

  const header = document.createElement("div");
  header.className = "activity-header";

  const spinner = document.createElement("span");
  spinner.className = "activity-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "activity-label";
  label.textContent = "Working…";

  header.appendChild(spinner);
  header.appendChild(label);
  activityCardEl.appendChild(header);

  activityStepsEl = document.createElement("div");
  activityStepsEl.className = "activity-steps";
  activityCardEl.appendChild(activityStepsEl);

  transcriptEl.appendChild(activityCardEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return activityCardEl;
}

function appendActivityStep(text) {
  activityStepCount++;
  getOrCreateActivityCard();
  const item = document.createElement("div");
  item.className = "activity-step";
  item.textContent = text;
  activityStepsEl.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function collapseActivityCard(stepCount) {
  if (!activityCardEl) return;

  const details = document.createElement("details");
  details.className = "activity-toggle";

  const summary = document.createElement("summary");
  summary.textContent = `${stepCount} step${stepCount !== 1 ? "s" : ""}`;
  details.appendChild(summary);

  if (activityStepsEl) {
    const clone = activityStepsEl.cloneNode(true);
    details.appendChild(clone);
  }

  activityCardEl.replaceWith(details);
  activityCardEl = null;
  activityStepsEl = null;
  activityStepCount = 0;
}

function resetActivity() {
  if (activityCardEl) {
    activityCardEl.remove();
    activityCardEl = null;
  }
  activityStepsEl = null;
  activityStepCount = 0;
}

function renderMarkdown(text) {
  // Escape raw HTML to prevent injection
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    // Code blocks (``` ... ```) — before inline code
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`)
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    // Auto-link URLs not already inside an href
    .replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    // Newlines to <br>
    .replace(/\n/g, "<br>");
}

function appendMessage(role, text) {
  const messageEl = document.createElement("div");
  messageEl.className = `msg ${role}`;
  if (role === "assistant") {
    messageEl.innerHTML = renderMarkdown(text);
  } else {
    messageEl.textContent = text;
  }
  transcriptEl.appendChild(messageEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return messageEl;
}

function renderState() {
  tokenInputEl.value = uiState.token;
  autoRunToggleEl.checked = uiState.autoRun;
  connectBtnEl.disabled = uiState.connecting;
  connectBtnEl.textContent = uiState.connected ? "Reconnect" : uiState.connecting ? "Connecting..." : "Connect";

  statusDotEl.classList.toggle("connected", uiState.connected);
  statusDotEl.classList.toggle("disconnected", !uiState.connected);
  statusTextEl.textContent = uiState.connected ? "Connected" : uiState.connecting ? "Connecting" : "Offline";

  if (uiState.pendingAction) {
    approvalLabelEl.textContent = `Pending: ${uiState.pendingAction.label}`;
    approveBtnEl.disabled = false;
    rejectBtnEl.disabled = false;
  } else {
    approvalLabelEl.textContent = "No pending action";
    approveBtnEl.disabled = true;
    rejectBtnEl.disabled = true;
  }
}

function setComposerWaiting(isWaiting) {
  awaitingAssistantResponse = isWaiting;
  composerEl.classList.toggle("is-waiting", isWaiting);
  messageInputEl.disabled = isWaiting;
  sendBtnEl.disabled = isWaiting;
  sendBtnEl.setAttribute("aria-busy", isWaiting ? "true" : "false");
  sendLabelEl.textContent = isWaiting ? "Waiting..." : "Send";
  renderQuickActions();
}

async function callBackground(message) {
  const response = await chrome.runtime.sendMessage(message);
  return response;
}

function applyState(nextState) {
  const wasConnected = uiState.connected;
  Object.assign(uiState, nextState);
  if (!uiState.connected && awaitingAssistantResponse) {
    setComposerWaiting(false);
  }
  if (wasConnected && !uiState.connected) {
    controlsDetailsEl.setAttribute("open", "");
  }
  renderState();
}

const quickActionsEl = document.getElementById("quickActions");

const DEFAULT_QUICK_ACTIONS = [
  { id: "qa-default-1", label: "Go to Google",  prompt: "Navigate to https://google.com" },
  { id: "qa-default-2", label: "Find links",    prompt: "Find all links on this page" },
  { id: "qa-default-3", label: "Find buttons",  prompt: "Find all buttons on this page" },
];

let quickActions = [];

async function loadQuickActions() {
  const saved = await chrome.storage.local.get("quickActions");
  quickActions = Array.isArray(saved.quickActions) ? saved.quickActions : [...DEFAULT_QUICK_ACTIONS];
}

async function saveQuickActions() {
  await chrome.storage.local.set({ quickActions });
}

function renderQuickActions() {
  quickActionsEl.innerHTML = "";
  const isWaiting = awaitingAssistantResponse;

  for (const action of quickActions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "qa-chip";
    chip.disabled = isWaiting;
    chip.title = action.prompt;

    const labelSpan = document.createElement("span");
    labelSpan.textContent = action.label;
    chip.appendChild(labelSpan);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "qa-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      quickActions = quickActions.filter((a) => a.id !== action.id);
      await saveQuickActions();
      renderQuickActions();
    });
    chip.appendChild(removeBtn);

    chip.addEventListener("click", async () => {
      if (isWaiting) return;
      if (!uiState.connected) {
        appendMessage("system", "Not connected. Please connect first.");
        return;
      }
      appendMessage("user", action.prompt);
      streamingMessageEl = null;
      resetActivity();
      setComposerWaiting(true);
      let response;
      try {
        response = await callBackground({ type: "ui_send_user_message", text: action.prompt });
      } catch (error) {
        setComposerWaiting(false);
        appendMessage("system", `Failed to send: ${String(error?.message || error)}`);
        return;
      }
      if (!response?.ok) {
        setComposerWaiting(false);
        appendMessage("system", `Failed to send: ${response?.error || "unknown error"}`);
      }
    });

    quickActionsEl.appendChild(chip);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "qa-add-btn";
  addBtn.disabled = isWaiting;
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", () => showQuickActionForm());
  quickActionsEl.appendChild(addBtn);
}

function showQuickActionForm() {
  const existingForm = quickActionsEl.querySelector(".qa-form");
  if (existingForm) return;

  const form = document.createElement("div");
  form.className = "qa-form";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.placeholder = "Label";
  labelInput.maxLength = 30;

  const promptInput = document.createElement("input");
  promptInput.type = "text";
  promptInput.placeholder = "Prompt";
  promptInput.maxLength = 200;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.style.cssText = "background:linear-gradient(180deg,#2f72cf,#1f5eb6);border-color:#1e56a5;color:#fff";
  saveBtn.addEventListener("click", async () => {
    const label = labelInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!label || !prompt) return;
    quickActions.push({ id: crypto.randomUUID(), label, prompt });
    await saveQuickActions();
    renderQuickActions();
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => renderQuickActions());

  form.appendChild(labelInput);
  form.appendChild(promptInput);
  form.appendChild(saveBtn);
  form.appendChild(cancelBtn);
  quickActionsEl.appendChild(form);
  labelInput.focus();
}

async function initialize() {
  await loadQuickActions();
  renderQuickActions();
  const init = await callBackground({ type: "ui_init" });
  if (init?.ok && init.state) {
    applyState(init.state);
    if (!init.state.connected) {
      controlsDetailsEl.setAttribute("open", "");
    }
  } else {
    controlsDetailsEl.setAttribute("open", "");
  }
}

connectBtnEl.addEventListener("click", async () => {
  const token = tokenInputEl.value.trim();
  await callBackground({ type: "ui_set_token", token });
  const response = await callBackground({ type: "ui_connect" });
  if (response?.ok && response.state) {
    applyState(response.state);
    appendMessage("system", "Connected to backend.");
    controlsDetailsEl.removeAttribute("open");
  } else {
    appendMessage("system", `Failed to connect: ${response?.error || "unknown error"}`);
  }
});

autoRunToggleEl.addEventListener("change", async () => {
  const response = await callBackground({ type: "ui_set_auto_run", autoRun: autoRunToggleEl.checked });
  if (response?.ok && response.state) {
    applyState(response.state);
  }
});

approveBtnEl.addEventListener("click", async () => {
  if (!uiState.pendingAction) {
    return;
  }
  await callBackground({
    type: "ui_approval",
    actionId: uiState.pendingAction.actionId,
    approved: true,
  });
});

rejectBtnEl.addEventListener("click", async () => {
  if (!uiState.pendingAction) {
    return;
  }
  await callBackground({
    type: "ui_approval",
    actionId: uiState.pendingAction.actionId,
    approved: false,
  });
});

stopBtnEl.addEventListener("click", async () => {
  await callBackground({ type: "ui_stop" });
  setComposerWaiting(false);
  appendMessage("system", "Stop sent.");
});

composerEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInputEl.value.trim();
  if (!text) {
    return;
  }

  appendMessage("user", text);
  streamingMessageEl = null;
  resetActivity();
  setComposerWaiting(true);

  let response;
  try {
    response = await callBackground({ type: "ui_send_user_message", text });
  } catch (error) {
    setComposerWaiting(false);
    appendMessage("system", `Failed to send: ${String(error?.message || error)}`);
    return;
  }

  if (!response?.ok) {
    setComposerWaiting(false);
    appendMessage("system", `Failed to send: ${response?.error || "unknown error"}`);
    return;
  }

  messageInputEl.value = "";
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "ui_state" && message.state) {
    applyState(message.state);
    return;
  }

  if (message.type !== "ui_event" || !message.event) {
    return;
  }

  const event = message.event;
  if (event.type === "step_event") {
    appendActivityStep(event.step);
    return;
  }

  if (event.type === "assistant_delta") {
    if (!streamingMessageEl) {
      streamingMessageEl = appendMessage("assistant", "");
      streamingMessageEl._rawText = "";
    }
    streamingMessageEl._rawText += event.textDelta;
    streamingMessageEl.innerHTML = renderMarkdown(streamingMessageEl._rawText);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return;
  }

  if (event.type === "assistant_final") {
    setComposerWaiting(false);
    if (streamingMessageEl) {
      streamingMessageEl.remove();
      streamingMessageEl = null;
    }
    const count = activityStepCount;
    collapseActivityCard(count);
    appendMessage("assistant", event.text);
    return;
  }

  if (event.type === "approval_needed" && event.action) {
    appendMessage("system", `Approval required: ${event.action.label}`);
  }
});

initialize().catch((error) => {
  appendMessage("system", `Initialization failed: ${String(error?.message || error)}`);
});

setComposerWaiting(false);
