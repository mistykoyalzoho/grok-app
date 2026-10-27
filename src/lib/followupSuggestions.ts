/** Clickable follow-up prompts from a suggest_followups tool call. */

export type FollowupItem = {
  prompt: string;
  label?: string;
};

type ToolLike = {
  title?: string;
  toolKind?: string;
  input?: string;
  detail?: string;
  toolCallId?: string;
};

export function isFollowupTool(tool: ToolLike): boolean {
  const blob = `${tool.title ?? ""} ${tool.toolKind ?? ""} ${tool.input ?? ""} ${tool.detail ?? ""}`;
  return /suggest_followups/i.test(blob);
}

function unwrapFollowupValue(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 4) return value;
  const record = value as { followups?: unknown; tool_input?: unknown; arguments?: unknown };
  if (Array.isArray(record.followups)) return value;
  const inner = record.tool_input ?? record.arguments;
  if (typeof inner === "string") {
    try {
      return unwrapFollowupValue(JSON.parse(inner), depth + 1);
    } catch {
      return value;
    }
  }
  if (inner && typeof inner === "object") return unwrapFollowupValue(inner, depth + 1);
  return value;
}

function asItems(value: unknown): FollowupItem[] {
  const unwrapped = unwrapFollowupValue(value);
  const list = Array.isArray(unwrapped)
    ? unwrapped
    : unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as { followups?: unknown }).followups)
      ? (unwrapped as { followups: unknown[] }).followups
      : null;
  if (!list) return [];
  const out: FollowupItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const prompt = (item as { prompt?: unknown }).prompt;
    if (typeof prompt !== "string" || !prompt.trim()) continue;
    const label = (item as { label?: unknown }).label;
    out.push({
      prompt,
      label: typeof label === "string" && label.trim() ? label : undefined,
    });
  }
  return out;
}

export function parseFollowupItems(raw: string | undefined): FollowupItem[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const direct = asItems(parsed);
    if (direct.length) return direct;
    if (parsed && typeof parsed === "object") {
      const args = (parsed as { arguments?: unknown }).arguments;
      if (typeof args === "string") return asItems(JSON.parse(args));
      return asItems(args);
    }
  } catch {
    return [];
  }
  return [];
}

export function followupsFromTool(tool: ToolLike): FollowupItem[] {
  if (!isFollowupTool(tool)) return [];
  const fromInput = parseFollowupItems(tool.input);
  return fromInput.length ? fromInput : parseFollowupItems(tool.detail);
}

export function latestFollowupTool<T extends ToolLike>(tools: T[]): T | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (followupsFromTool(tools[i]).length) return tools[i];
  }
  return null;
}
