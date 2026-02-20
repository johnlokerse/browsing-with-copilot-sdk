export type ToolName = "browser_find" | "browser_highlight" | "browser_click" | "browser_type" | "browser_navigate" | "browser_select_candidate";

export type ToolResultError =
  | "EXTENSION_NOT_READY"
  | "NO_ACTIVE_TAB"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "CANCELLED";

export type UserMessage = {
  type: "user_message";
  sessionId: string;
  token: string;
  text: string;
};

export type UserApproval = {
  type: "user_approval";
  sessionId: string;
  token: string;
  actionId: string;
  approved: boolean;
};

export type Cancel = {
  type: "cancel";
  sessionId: string;
  token: string;
};

export type ToolResult = {
  type: "tool_result";
  sessionId: string;
  token: string;
  actionId: string;
  ok: boolean;
  data?: unknown;
  error?: ToolResultError;
};

export type ExtensionToBackend = UserMessage | UserApproval | Cancel | ToolResult;

export type AssistantDelta = {
  type: "assistant_delta";
  sessionId: string;
  token: string;
  textDelta: string;
};

export type AssistantFinal = {
  type: "assistant_final";
  sessionId: string;
  token: string;
  text: string;
};

export type ToolRequest = {
  type: "tool_request";
  sessionId: string;
  token: string;
  actionId: string;
  tool: ToolName;
  params: Record<string, unknown>;
  ui: { label: string };
  timeoutMs: number;
};

export type StepEvent = {
  type: "step_event";
  sessionId: string;
  token: string;
  step: string;
};

export type BackendToExtension = AssistantDelta | AssistantFinal | ToolRequest | StepEvent;

export type Candidate = {
  id: string;
  label: string;
  selector: string;
};

export type FindResult = {
  candidates: Candidate[];
};
