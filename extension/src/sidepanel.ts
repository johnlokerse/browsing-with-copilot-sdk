/// <reference types="chrome"/>

const transcriptEl = document.getElementById("transcript") as HTMLElement;
const statusDotEl = document.getElementById("statusDot") as HTMLElement;
const statusTextEl = document.getElementById("statusText") as HTMLElement;
const tokenInputEl = document.getElementById("tokenInput") as HTMLInputElement;
const connectBtnEl = document.getElementById("connectBtn") as HTMLButtonElement;
const stopBtnEl = document.getElementById("stopBtn") as HTMLButtonElement;
const autoRunToggleEl = document.getElementById("autoRunToggle") as HTMLInputElement;
const approvalLabelEl = document.getElementById("approvalLabel") as HTMLElement;
const approveBtnEl = document.getElementById("approveBtn") as HTMLButtonElement;
const rejectBtnEl = document.getElementById("rejectBtn") as HTMLButtonElement;
const composerEl = document.getElementById("composer") as HTMLFormElement;
const messageInputEl = document.getElementById("messageInput") as HTMLInputElement;
const sendBtnEl = document.getElementById("sendBtn") as HTMLButtonElement;
const sendLabelEl = document.getElementById("sendLabel") as HTMLElement;
const sendSpinnerEl = document.getElementById("sendSpinner") as HTMLElement;
const controlsDetailsEl = document.getElementById("controlsDetails") as HTMLDetailsElement;
const quickActionsEl = document.getElementById("quickActions") as HTMLElement;

interface UiState {
  sessionId: string;
  token: string;
  autoRun: boolean;
  connected: boolean;
  connecting: boolean;
  pendingAction: { actionId: string; label: string } | null;
}

interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

const uiState: UiState = {
  sessionId: "",
  token: "",
  autoRun: false,
  connected: false,
  connecting: false,
  pendingAction: null,
};

// Message types for dynamic rendering
const MSG_CLASSES = {
  user: "rounded-lg border px-3 py-2 text-xs leading-relaxed border-gh-blue/40 bg-gh-blue/10 text-gh-text",
  assistant: "rounded-lg border px-3 py-2 text-xs leading-relaxed border-gh-green/30 bg-gh-green/10 text-gh-text",
  system: "rounded-lg border px-3 py-2 text-xs leading-relaxed border-gh-orange/40 bg-gh-orange/10 text-gh-muted italic",
} as const;

let streamingMessageEl: (HTMLElement & { _rawText?: string }) | null = null;
let activityCardEl: HTMLElement | null = null;
let activityStepsEl: HTMLElement | null = null;
let activityStepCount = 0;
let awaitingAssistantResponse = false;

// ── Activity card ────────────────────────────────────────────────────────────

function getOrCreateActivityCard(): HTMLElement {
  if (activityCardEl) return activityCardEl;

  activityCardEl = document.createElement("div");
  activityCardEl.className = "rounded-lg border border-gh-border bg-gh-overlay px-3 py-2 text-xs";

  const header = document.createElement("div");
  header.className = "flex items-center gap-2 font-semibold text-gh-muted";

  const spinner = document.createElement("span");
  spinner.className = "w-2.5 h-2.5 rounded-full border-2 border-gh-border border-t-gh-blue spin shrink-0";
  spinner.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.textContent = "Working…";

  header.appendChild(spinner);
  header.appendChild(label);
  activityCardEl.appendChild(header);

  activityStepsEl = document.createElement("div");
  activityStepsEl.className = "mt-1.5 flex flex-col gap-0.5";
  activityCardEl.appendChild(activityStepsEl);

  transcriptEl.appendChild(activityCardEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return activityCardEl;
}

function appendActivityStep(text: string): void {
  activityStepCount++;
  getOrCreateActivityCard();
  const item = document.createElement("div");
  item.className = "text-gh-muted pl-4 relative before:absolute before:left-0 before:content-['✓'] before:text-gh-green before:text-[10px]";
  item.textContent = text;
  activityStepsEl!.appendChild(item);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function collapseActivityCard(stepCount: number): void {
  if (!activityCardEl) return;

  const details = document.createElement("details");
  details.className = "text-[11px] text-gh-muted";

  const summary = document.createElement("summary");
  summary.className = "cursor-pointer select-none list-none inline-flex items-center gap-1 py-0.5 px-1 rounded hover:text-gh-blue transition-colors [&::-webkit-details-marker]:hidden";
  summary.innerHTML = `<span class="text-[8px]">▶</span> ${stepCount} step${stepCount !== 1 ? "s" : ""}`;
  details.appendChild(summary);

  if (activityStepsEl) {
    const clone = activityStepsEl.cloneNode(true) as HTMLElement;
    clone.className = "mt-1 flex flex-col gap-0.5 pl-2";
    details.appendChild(clone);
  }

  activityCardEl.replaceWith(details);
  activityCardEl = null;
  activityStepsEl = null;
  activityStepCount = 0;
}

function resetActivity(): void {
  activityCardEl?.remove();
  activityCardEl = null;
  activityStepsEl = null;
  activityStepCount = 0;
}

// ── Markdown ─────────────────────────────────────────────────────────────────

function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="mt-1.5 mb-0.5 bg-gh-canvas border border-gh-border rounded p-2 overflow-x-auto"><code class="font-mono text-[11px]">${code.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, `<code class="font-mono text-[11px] bg-gh-canvas border border-gh-border/60 rounded px-1 py-px">$1</code>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/(?<!href="|">)(https?:\/\/[^\s<]+)/g, `<a href="$1" target="_blank" rel="noopener noreferrer" class="text-gh-blue underline break-all hover:text-gh-blue-hover">$1</a>`)
    .replace(/\n/g, "<br>");
}

// ── Messages ─────────────────────────────────────────────────────────────────

function appendMessage(role: keyof typeof MSG_CLASSES, text: string): HTMLElement & { _rawText?: string } {
  const messageEl = document.createElement("div") as HTMLElement & { _rawText?: string };
  messageEl.className = MSG_CLASSES[role];
  if (role === "assistant") {
    messageEl.innerHTML = renderMarkdown(text);
  } else {
    messageEl.textContent = text;
  }
  transcriptEl.appendChild(messageEl);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return messageEl;
}

// ── State rendering ───────────────────────────────────────────────────────────

function renderState(): void {
  tokenInputEl.value = uiState.token;
  autoRunToggleEl.checked = uiState.autoRun;
  connectBtnEl.disabled = uiState.connecting;
  connectBtnEl.textContent = uiState.connected ? "Reconnect" : uiState.connecting ? "Connecting..." : "Connect";

  // Status dot
  statusDotEl.classList.toggle("bg-gh-green", uiState.connected);
  statusDotEl.classList.toggle("status-breathing", uiState.connected);
  statusDotEl.classList.toggle("bg-gh-orange", uiState.connecting);
  statusDotEl.classList.toggle("bg-gh-red", !uiState.connected && !uiState.connecting);
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

function setComposerWaiting(isWaiting: boolean): void {
  awaitingAssistantResponse = isWaiting;
  messageInputEl.disabled = isWaiting;
  sendBtnEl.disabled = isWaiting;
  sendBtnEl.setAttribute("aria-busy", isWaiting ? "true" : "false");
  sendLabelEl.textContent = isWaiting ? "Waiting..." : "Send";
  sendSpinnerEl.classList.toggle("hidden", !isWaiting);
  renderQuickActions();
}

async function callBackground(message: object): Promise<any> {
  return chrome.runtime.sendMessage(message);
}

function applyState(nextState: Partial<UiState>): void {
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

// ── Quick actions ─────────────────────────────────────────────────────────────

const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  { id: "qa-default-1", label: "Go to Google", prompt: "Navigate to https://google.com" },
  { id: "qa-default-2", label: "Find links",   prompt: "Find all links on this page" },
  { id: "qa-default-3", label: "Find buttons", prompt: "Find all buttons on this page" },
];

let quickActions: QuickAction[] = [];

async function loadQuickActions(): Promise<void> {
  const saved = await chrome.storage.local.get("quickActions");
  quickActions = Array.isArray(saved.quickActions) ? saved.quickActions : [...DEFAULT_QUICK_ACTIONS];
}

async function saveQuickActions(): Promise<void> {
  await chrome.storage.local.set({ quickActions });
}

function renderQuickActions(): void {
  quickActionsEl.innerHTML = "";
  const isWaiting = awaitingAssistantResponse;

  for (const action of quickActions) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "inline-flex items-center gap-1 rounded-full border border-gh-border bg-gh-overlay text-gh-muted text-[11px] font-semibold px-2.5 py-1 cursor-pointer whitespace-nowrap transition-colors hover:border-gh-blue hover:text-gh-blue disabled:opacity-40 disabled:cursor-not-allowed group";
    chip.disabled = isWaiting;
    chip.title = action.prompt;

    const labelSpan = document.createElement("span");
    labelSpan.textContent = action.label;
    chip.appendChild(labelSpan);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "hidden group-hover:inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gh-border/60 text-[10px] leading-none hover:bg-gh-red/30 hover:text-gh-red transition-colors cursor-pointer";
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
      } catch (error: any) {
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
  addBtn.className = "inline-flex items-center gap-1 rounded-full border border-dashed border-gh-border text-gh-muted text-[11px] font-semibold px-2.5 py-1 cursor-pointer whitespace-nowrap transition-colors hover:border-gh-blue hover:text-gh-blue disabled:opacity-40 disabled:cursor-not-allowed";
  addBtn.disabled = isWaiting;
  addBtn.textContent = "+ Add";
  addBtn.addEventListener("click", () => showQuickActionForm());
  quickActionsEl.appendChild(addBtn);
}

function showQuickActionForm(): void {
  if (quickActionsEl.querySelector(".qa-form")) return;

  const form = document.createElement("div");
  form.className = "qa-form flex flex-wrap gap-1.5 items-center w-full pt-1";

  const makeInput = (placeholder: string, maxLength: number) => {
    const el = document.createElement("input");
    el.type = "text";
    el.placeholder = placeholder;
    el.maxLength = maxLength;
    el.className = "flex-1 min-w-[60px] bg-gh-overlay border border-gh-border rounded-lg px-2 py-1 text-[11px] text-gh-text placeholder:text-gh-muted outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue/20 transition";
    return el;
  };

  const labelInput = makeInput("Label", 30);
  const promptInput = makeInput("Prompt", 200);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.className = "rounded-lg bg-gh-blue hover:bg-gh-blue-hover text-white text-[11px] font-semibold py-1 px-2.5 transition-colors";
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
  cancelBtn.className = "rounded-lg border border-gh-border text-gh-muted text-[11px] font-semibold py-1 px-2.5 hover:border-gh-border/80 transition-colors";
  cancelBtn.addEventListener("click", () => renderQuickActions());

  form.append(labelInput, promptInput, saveBtn, cancelBtn);
  quickActionsEl.appendChild(form);
  labelInput.focus();
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function initialize(): Promise<void> {
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

// ── Event listeners ───────────────────────────────────────────────────────────

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
  if (response?.ok && response.state) applyState(response.state);
});

approveBtnEl.addEventListener("click", async () => {
  if (!uiState.pendingAction) return;
  await callBackground({ type: "ui_approval", actionId: uiState.pendingAction.actionId, approved: true });
});

rejectBtnEl.addEventListener("click", async () => {
  if (!uiState.pendingAction) return;
  await callBackground({ type: "ui_approval", actionId: uiState.pendingAction.actionId, approved: false });
});

stopBtnEl.addEventListener("click", async () => {
  await callBackground({ type: "ui_stop" });
  setComposerWaiting(false);
  appendMessage("system", "Stop sent.");
});

composerEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInputEl.value.trim();
  if (!text) return;

  appendMessage("user", text);
  streamingMessageEl = null;
  resetActivity();
  setComposerWaiting(true);

  let response;
  try {
    response = await callBackground({ type: "ui_send_user_message", text });
  } catch (error: any) {
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
  if (!message || typeof message !== "object") return;

  if (message.type === "ui_state" && message.state) {
    applyState(message.state);
    return;
  }

  if (message.type !== "ui_event" || !message.event) return;

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
    streamingMessageEl._rawText! += event.textDelta;
    streamingMessageEl.innerHTML = renderMarkdown(streamingMessageEl._rawText!);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    return;
  }

  if (event.type === "assistant_final") {
    setComposerWaiting(false);
    streamingMessageEl?.remove();
    streamingMessageEl = null;
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
