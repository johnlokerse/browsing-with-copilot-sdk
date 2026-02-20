import process from "node:process";
import { randomUUID } from "node:crypto";
import { CopilotClient, defineTool, type CopilotSession, type SessionConfig } from "@github/copilot-sdk";
import { WebSocket, WebSocketServer } from "ws";
import type {
  BackendToExtension,
  Candidate,
  ExtensionToBackend,
  FindResult,
  ToolName,
  ToolRequest,
  ToolResultError,
} from "./protocol.js";

const WS_HOST = "127.0.0.1";
const WS_PORT = 3210;
const WS_PATH = "/ws";
const TOOL_TIMEOUT_MS = 5_000;
const TOOL_TIMEOUT_NAVIGATE_MS = 30_000;
const TOOL_TIMEOUT_ACTION_MS = 60_000;
const MESSAGE_TIMEOUT_MS = 120_000;

function toolTimeoutMs(tool: ToolName): number {
  if (tool === "browser_navigate") return TOOL_TIMEOUT_NAVIGATE_MS;
  if (tool === "browser_click" || tool === "browser_type") return TOOL_TIMEOUT_ACTION_MS;
  return TOOL_TIMEOUT_MS;
}

const pairingToken = process.env.PAIRING_TOKEN ?? randomUUID();
const configuredModelName = process.env.COPILOT_MODEL ?? "claude-sonnet-4.6";
let selectedModelName: string | undefined = configuredModelName;

const SYSTEM_PROMPT = [
  "You are a browser interaction agent controlled by strict rules.",
  "Workflow for each actionable interaction request:",
  "1) If the user mentions a site/domain and the current page is not that site, call browser.navigate first.",
  "2) Then call browser.find.",
  "3) If browser.find returns 0 candidates, ask the user for a better query.",
  "4) If browser.find returns multiple candidates and you need to click/type, call browser.select_candidate with the candidate id to disambiguate, then proceed. If unsure which candidate the user wants, ask them to pick an id first.",
  "5) If exactly one candidate is selected, call browser.highlight before any click/type action.",
  "6) After highlight, give a short one-sentence explanation.",
  "7) Then call browser.click or browser.type depending on the user request.",
  "8) Confirm completion with exactly what action was taken and the selector.",
  "For information lookup requests (for example: find news about topic X), you may use browser.find to collect multiple relevant candidate labels and summarize them without clicking.",
  "Safety:",
  "- Never perform dangerous clicks (delete, purchase, send, submit payment) without explicit user approval.",
  "- If unsure, ask.",
  "Output style:",
  "- Be concise.",
].join("\n");

type RunContext = {
  cancelled: boolean;
  finalSent: boolean;
  steps: string[];
};

type PendingToolCall = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  tool: ToolName;
};

type SessionState = {
  sessionId: string;
  token: string;
  ws: WebSocket;
  copilotSession: CopilotSession | null;
  queue: Promise<void>;
  run: RunContext | null;
  pendingTools: Map<string, PendingToolCall>;
  lastFindCandidates: Candidate[];
  unsubs: Array<() => void>;
};

const sessions = new Map<string, SessionState>();

const client = new CopilotClient({
  useLoggedInUser: true,
  autoStart: true,
  cwd: process.cwd(),
});

function now() {
  return new Date().toISOString();
}

function log(message: string, details?: unknown) {
  if (details !== undefined) {
    console.log(`[${now()}] ${message}`, details);
    return;
  }
  console.log(`[${now()}] ${message}`);
}

function toErrorCode(value: unknown): ToolResultError {
  if (
    value === "EXTENSION_NOT_READY" ||
    value === "NO_ACTIVE_TAB" ||
    value === "PERMISSION_DENIED" ||
    value === "NOT_FOUND" ||
    value === "TIMEOUT" ||
    value === "CANCELLED"
  ) {
    return value;
  }
  return "EXTENSION_NOT_READY";
}

function normalizeMessage(raw: WebSocket.RawData): ExtensionToBackend | null {
  try {
    const parsed = JSON.parse(raw.toString()) as ExtensionToBackend;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (typeof (parsed as { sessionId?: unknown }).sessionId !== "string") {
      return null;
    }
    if (typeof (parsed as { token?: unknown }).token !== "string") {
      return null;
    }
    if (typeof (parsed as { type?: unknown }).type !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function send(state: SessionState, message: BackendToExtension) {
  if (state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify(message));
}

function sendDelta(state: SessionState, textDelta: string) {
  send(state, {
    type: "assistant_delta",
    sessionId: state.sessionId,
    token: state.token,
    textDelta,
  });
}

function sendFinal(state: SessionState, text: string) {
  send(state, {
    type: "assistant_final",
    sessionId: state.sessionId,
    token: state.token,
    text,
  });
}

function sendStep(state: SessionState, step: string) {
  send(state, {
    type: "step_event",
    sessionId: state.sessionId,
    token: state.token,
    step,
  });
}

function appendStep(state: SessionState, text: string) {
  if (!state.run) {
    return;
  }
  state.run.steps.push(text);
  sendStep(state, text);
}

function ensureSingleCandidateBeforeAction(state: SessionState, tool: ToolName) {
  if (tool === "browser_find") {
    return;
  }
  if (state.lastFindCandidates.length === 0) {
    throw new Error("Call browser.find first and identify a candidate before taking actions.");
  }
  if (state.lastFindCandidates.length > 1) {
    throw new Error("Multiple candidates are still unresolved. Ask the user to disambiguate by candidate id.");
  }
}

async function requestToolRoundTrip(
  state: SessionState,
  actionId: string,
  tool: ToolName,
  params: Record<string, unknown>,
  uiLabel: string,
) {
  if (state.ws.readyState !== WebSocket.OPEN) {
    throw new Error("EXTENSION_NOT_READY");
  }

  const payload: ToolRequest = {
    type: "tool_request",
    sessionId: state.sessionId,
    token: state.token,
    actionId,
    tool,
    params,
    ui: { label: uiLabel },
    timeoutMs: toolTimeoutMs(tool),
  };

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingTools.delete(actionId);
      reject(new Error("TIMEOUT"));
    }, toolTimeoutMs(tool));

    state.pendingTools.set(actionId, {
      resolve,
      reject,
      timer,
      tool,
    });
  });

  send(state, payload);
  return resultPromise;
}

function candidateFromUnknown(value: unknown): Candidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const item = value as { id?: unknown; label?: unknown; selector?: unknown };
  if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.selector !== "string") {
    return null;
  }
  return {
    id: item.id,
    label: item.label,
    selector: item.selector,
  };
}

function parseFindResult(data: unknown): FindResult {
  if (!data || typeof data !== "object") {
    return { candidates: [] };
  }
  const maybe = data as { candidates?: unknown };
  if (!Array.isArray(maybe.candidates)) {
    return { candidates: [] };
  }
  const candidates = maybe.candidates.map(candidateFromUnknown).filter((v): v is Candidate => v !== null);
  return { candidates };
}

function getStringArg(args: unknown, key: string): string {
  if (!args || typeof args !== "object") {
    return "";
  }
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function extractDomainHint(text: string): string | null {
  const match = text.match(/\b([a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?)\b/i);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase();
}

function isBadRequestError(message: string): boolean {
  return (
    message.includes("400 Bad Request") ||
    message.includes("CAPIError: 400") ||
    /\b400\b/.test(message)
  );
}

async function resolveModelSelection(): Promise<void> {
  try {
    const models = await client.listModels();
    const modelIds = models.map((model) => model.id);
    if (modelIds.length) {
      log(`Available Copilot models: ${modelIds.join(", ")}`);
    }

    if (configuredModelName && !modelIds.includes(configuredModelName)) {
      selectedModelName = undefined;
      log(
        `Configured model '${configuredModelName}' is not available for this account/policy. Falling back to Copilot CLI default model.`,
      );
      return;
    }

    selectedModelName = configuredModelName;
  } catch (error) {
    selectedModelName = configuredModelName;
    log("Could not list Copilot models; continuing with configured/default model.", error);
  }
}

function buildSessionConfig(state: SessionState, includeConfiguredModel: boolean): SessionConfig {
  return {
    sessionId: state.sessionId,
    ...(includeConfiguredModel && selectedModelName ? { model: selectedModelName } : {}),
    streaming: true,
    tools: createTools(state),
    availableTools: ["browser_navigate", "browser_find", "browser_select_candidate", "browser_highlight", "browser_click", "browser_type"],
    systemMessage: {
      content: SYSTEM_PROMPT,
    },
    infiniteSessions: {
      enabled: false,
    },
  };
}

async function rebuildSessionWithDefaultModel(state: SessionState): Promise<void> {
  for (const unsub of state.unsubs) {
    unsub();
  }
  state.unsubs.length = 0;

  if (state.copilotSession) {
    try {
      await state.copilotSession.destroy();
    } catch (error) {
      log(`Failed to destroy session during fallback ${state.sessionId}`, error);
    }
  }

  state.copilotSession = await client.createSession(buildSessionConfig(state, false));
  wireSessionEvents(state);
}

function createTools(state: SessionState) {
  return [
    defineTool("browser_navigate", {
      description: "Navigate the active browser tab to a URL or domain.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
      handler: async (args, invocation) => {
        const url = getStringArg(args, "url").trim();
        if (!url) {
          throw new Error("NOT_FOUND");
        }

        appendStep(state, `Navigating to ${url}`);
        const rawResult = await requestToolRoundTrip(
          state,
          invocation.toolCallId,
          "browser_navigate",
          { url },
          `navigating to ${url}`,
        );
        const result = typeof rawResult === "object" && rawResult ? rawResult : { ok: true, url };
        state.lastFindCandidates = [];
        return result;
      },
    }),
    defineTool("browser_find", {
      description: "Find candidate elements from a user query. Call this first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
      handler: async (args, invocation) => {
        const query = getStringArg(args, "query").trim();
        if (!query) {
          return { candidates: [] };
        }

        appendStep(state, `Finding elements for \"${query}\"`);
        const rawResult = await requestToolRoundTrip(
          state,
          invocation.toolCallId,
          "browser_find",
          { query },
          `finding ${query}`,
        );

        const parsed = parseFindResult(rawResult);
        state.lastFindCandidates = parsed.candidates;
        appendStep(state, `Found ${parsed.candidates.length} candidate(s)`);
        return parsed;
      },
    }),
    defineTool("browser_select_candidate", {
      description: "Select a single candidate from the last browser.find results by candidate id. Use this to disambiguate when browser.find returned multiple candidates.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (args) => {
        const id = getStringArg(args, "id").trim();
        const candidate = state.lastFindCandidates.find((c) => c.id === id);
        if (!candidate) {
          throw new Error("NOT_FOUND");
        }
        state.lastFindCandidates = [candidate];
        appendStep(state, `Selected candidate ${id}: ${candidate.label}`);
        return { selected: candidate };
      },
    }),
    defineTool("browser_highlight", {
      description: "Highlight a selected element on the active page.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          label: { type: "string" },
        },
        required: ["selector"],
      },
      handler: async (args, invocation) => {
        ensureSingleCandidateBeforeAction(state, "browser_highlight");
        const selector = getStringArg(args, "selector").trim();
        const label = getStringArg(args, "label").trim();
        if (!selector) {
          throw new Error("NOT_FOUND");
        }

        appendStep(state, `Highlighting ${selector}`);
        await requestToolRoundTrip(
          state,
          invocation.toolCallId,
          "browser_highlight",
          { selector, label },
          `highlighting ${label || selector}`,
        );
        return { ok: true };
      },
    }),
    defineTool("browser_click", {
      description: "Click the target element.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
        },
        required: ["selector"],
      },
      handler: async (args, invocation) => {
        ensureSingleCandidateBeforeAction(state, "browser_click");
        const selector = getStringArg(args, "selector").trim();
        if (!selector) {
          throw new Error("NOT_FOUND");
        }

        appendStep(state, `Clicking ${selector}`);
        await requestToolRoundTrip(state, invocation.toolCallId, "browser_click", { selector }, `clicking ${selector}`);
        return { ok: true };
      },
    }),
    defineTool("browser_type", {
      description: "Type text into the target input element.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string" },
          text: { type: "string" },
        },
        required: ["selector", "text"],
      },
      handler: async (args, invocation) => {
        ensureSingleCandidateBeforeAction(state, "browser_type");
        const selector = getStringArg(args, "selector").trim();
        const text = getStringArg(args, "text");
        if (!selector) {
          throw new Error("NOT_FOUND");
        }

        appendStep(state, `Typing into ${selector}`);
        await requestToolRoundTrip(
          state,
          invocation.toolCallId,
          "browser_type",
          { selector, text },
          `typing into ${selector}`,
        );
        return { ok: true };
      },
    }),
  ];
}

function wireSessionEvents(state: SessionState) {
  if (!state.copilotSession) {
    return;
  }

  state.unsubs.push(
    state.copilotSession.on("assistant.message_delta", (event) => {
      if (!state.run || state.run.cancelled) {
        return;
      }
      const delta = event.data.deltaContent;
      if (delta) {
        sendDelta(state, delta);
      }
    }),
  );

  state.unsubs.push(
    state.copilotSession.on("tool.execution_start", (event) => {
      if (!state.run || state.run.cancelled) {
        return;
      }
      appendStep(state, `Tool start: ${event.data.toolName}`);
    }),
  );

  state.unsubs.push(
    state.copilotSession.on("tool.execution_complete", (event) => {
      if (!state.run || state.run.cancelled) {
        return;
      }
      const status = event.data.success ? "ok" : `failed (${event.data.error?.message ?? "error"})`;
      appendStep(state, `Tool complete: ${event.data.toolCallId} ${status}`);
    }),
  );
}

async function createSessionState(sessionId: string, token: string, ws: WebSocket): Promise<SessionState> {
  const state: SessionState = {
    sessionId,
    token,
    ws,
    copilotSession: null,
    queue: Promise.resolve(),
    run: null,
    pendingTools: new Map(),
    lastFindCandidates: [],
    unsubs: [],
  };

  const baseConfig = buildSessionConfig(state, false);

  try {
    state.copilotSession = await client.createSession(buildSessionConfig(state, true));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldFallbackToDefaultModel =
      Boolean(selectedModelName) &&
      isBadRequestError(message) &&
      !message.includes("401");

    if (!shouldFallbackToDefaultModel) {
      throw error;
    }

    log(
      `Model ${selectedModelName} failed with 400. Falling back to Copilot CLI default model for session ${sessionId}.`,
    );
    selectedModelName = undefined;
    state.copilotSession = await client.createSession(baseConfig);
  }

  wireSessionEvents(state);
  sessions.set(sessionId, state);
  log(`Created Copilot session ${sessionId}`);
  return state;
}

async function getSessionState(sessionId: string, token: string, ws: WebSocket) {
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.ws = ws;
    existing.token = token;
    return existing;
  }
  return createSessionState(sessionId, token, ws);
}

async function teardownSession(state: SessionState, reason: string) {
  for (const [, pending] of state.pendingTools) {
    clearTimeout(pending.timer);
    pending.reject(new Error("CANCELLED"));
  }
  state.pendingTools.clear();

  for (const unsub of state.unsubs) {
    unsub();
  }
  state.unsubs.length = 0;

  if (state.copilotSession) {
    try {
      await state.copilotSession.destroy();
    } catch (error) {
      log(`Failed to destroy session ${state.sessionId}`, error);
    }
  }

  sessions.delete(state.sessionId);
  log(`Session ${state.sessionId} closed (${reason})`);
}

function formatFinalWithSteps(text: string, _steps: string[]) {
  return text;
}

async function handleUserMessage(state: SessionState, text: string) {
  if (!state.copilotSession) {
    throw new Error("Session not ready");
  }

  state.run = {
    cancelled: false,
    finalSent: false,
    steps: [],
  };

  state.lastFindCandidates = [];
  appendStep(state, "Started run");

  const keepAlive = setInterval(() => {
    if (!state.run || state.run.cancelled) {
      return;
    }
    sendDelta(state, "...");
  }, 20_000);

  const domainHint = extractDomainHint(text);
  const domainInstruction = domainHint
    ? `The user referenced site ${domainHint}. Call browser.navigate with ${domainHint} before searching unless already on that site.`
    : "";

  const prompt = [
    "User request:",
    text,
    "",
    "Follow the mandatory browser workflow in system instructions.",
    "When browser.find has multiple candidates and a click/type action is needed, ask the user to pick an id and stop.",
    "If the request is information-only, summarize relevant candidates instead of clicking.",
    domainInstruction,
  ].join("\n");

  try {
    const sendPrompt = async () => {
      if (!state.copilotSession) {
        throw new Error("Session not ready");
      }
      return state.copilotSession.sendAndWait({ prompt }, MESSAGE_TIMEOUT_MS);
    };

    let finalEvent;
    try {
      finalEvent = await sendPrompt();
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const shouldRetryOnDefaultModel =
        Boolean(selectedModelName) && isBadRequestError(rawMessage) && !rawMessage.includes("401");

      if (!shouldRetryOnDefaultModel) {
        throw error;
      }

      appendStep(state, `Model ${selectedModelName} failed with 400; retrying with Copilot default model`);
      selectedModelName = undefined;
      await rebuildSessionWithDefaultModel(state);
      finalEvent = await sendPrompt();
    }

    if (!state.run || state.run.cancelled || state.run.finalSent) {
      return;
    }

    const finalText = finalEvent?.data?.content?.trim() || "Done.";
    sendFinal(state, formatFinalWithSteps(finalText, state.run.steps));
    state.run.finalSent = true;
  } catch (error) {
    if (state.run?.cancelled) {
      return;
    }

    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const message =
      isBadRequestError(rawMessage) && configuredModelName
        ? `${rawMessage}\nHint: configured model '${configuredModelName}' may be invalid for your account/policy. Set COPILOT_MODEL to a model from listModels() output or unset it to use default.`
        : rawMessage;
    sendFinal(state, `Failed: ${message}`);
    if (state.run) {
      state.run.finalSent = true;
    }
  } finally {
    clearInterval(keepAlive);
    state.run = null;
  }
}

async function cancelRun(state: SessionState) {
  if (!state.run) {
    return;
  }

  state.run.cancelled = true;

  for (const [, pending] of state.pendingTools) {
    clearTimeout(pending.timer);
    pending.reject(new Error("CANCELLED"));
  }
  state.pendingTools.clear();

  if (state.copilotSession) {
    try {
      await state.copilotSession.abort();
    } catch (error) {
      log(`Abort failed for session ${state.sessionId}`, error);
    }
  }

  if (!state.run.finalSent) {
    sendFinal(state, "Cancelled by user.");
    state.run.finalSent = true;
  }
}

function onToolResult(message: Extract<ExtensionToBackend, { type: "tool_result" }>) {
  const state = sessions.get(message.sessionId);
  if (!state) {
    return;
  }

  const pending = state.pendingTools.get(message.actionId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  state.pendingTools.delete(message.actionId);

  if (message.ok) {
    pending.resolve(message.data);
    return;
  }

  pending.reject(new Error(toErrorCode(message.error)));
}

async function routeMessage(ws: WebSocket, message: ExtensionToBackend) {
  if (message.token !== pairingToken) {
    log(`Rejected message with invalid token for session ${message.sessionId}`);
    ws.close(4001, "invalid token");
    return;
  }

  switch (message.type) {
    case "user_message": {
      log(`user_message ${message.sessionId}`, message.text);
      const state = await getSessionState(message.sessionId, message.token, ws);
      state.queue = state.queue.then(() => handleUserMessage(state, message.text)).catch((error) => {
        const errMessage = error instanceof Error ? error.message : String(error);
        sendFinal(state, `Failed: ${errMessage}`);
      });
      break;
    }
    case "user_approval": {
      const state = sessions.get(message.sessionId);
      if (!state || !state.run || state.run.cancelled) {
        return;
      }
      const decision = message.approved ? "approved" : "rejected";
      appendStep(state, `User ${decision} action ${message.actionId}`);
      break;
    }
    case "cancel": {
      const state = sessions.get(message.sessionId);
      if (!state) {
        return;
      }
      log(`cancel ${message.sessionId}`);
      await cancelRun(state);
      break;
    }
    case "tool_result": {
      log(`tool_result ${message.sessionId}:${message.actionId} ok=${message.ok}`);
      onToolResult(message);
      break;
    }
    default: {
      const exhaustive: never = message;
      throw new Error(`Unhandled message: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function main() {
  await client.start();
  try {
    const auth = await client.getAuthStatus();
    log(
      `Copilot auth status: ${auth.isAuthenticated ? "authenticated" : "not authenticated"} (${auth.authType ?? "unknown"})`,
    );
  } catch (error) {
    log("Could not read Copilot auth status", error);
  }
  await resolveModelSelection();

  const wss = new WebSocketServer({
    host: WS_HOST,
    port: WS_PORT,
    path: WS_PATH,
    verifyClient: ({ req }: { req: import("http").IncomingMessage }) => {
      const origin = req.headers.origin ?? "";
      if (!origin || origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://")) {
        return true;
      }
      log(`Rejected WebSocket connection from origin: ${origin}`);
      return false;
    },
  });

  wss.on("connection", (ws, request) => {
    log(`Extension connected from ${request.socket.remoteAddress ?? "unknown"}`);

    ws.on("message", async (raw) => {
      const message = normalizeMessage(raw);
      if (!message) {
        return;
      }
      try {
        await routeMessage(ws, message);
      } catch (error) {
        log("Failed to route message", error);
      }
    });

    ws.on("close", async () => {
      const linked = [...sessions.values()].filter((s) => s.ws === ws);
      for (const state of linked) {
        await teardownSession(state, "socket closed");
      }
    });

    ws.on("error", (error) => {
      log("WS error", error);
    });
  });

  process.on("SIGINT", async () => {
    log("Shutting down...");
    for (const state of [...sessions.values()]) {
      await teardownSession(state, "shutdown");
    }
    await client.stop();
    wss.close(() => process.exit(0));
  });

  log(`Backend ready at ws://${WS_HOST}:${WS_PORT}${WS_PATH}`);
  log(`Pairing token: ${pairingToken}`);
  if (!process.env.PAIRING_TOKEN) { log("IMPORTANT: Copy the pairing token above into the extension settings."); }
  log(`Copilot provider: GitHub Copilot CLI auth`);
  log(`Configured model: ${configuredModelName}`);
  log(`Effective model: ${selectedModelName ?? "default from Copilot CLI"}`);
}

main().catch(async (error) => {
  console.error(error);
  await client.stop();
  process.exit(1);
});
