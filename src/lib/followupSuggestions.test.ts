import { describe, expect, it } from "vitest";
import {
  followupsFromTool,
  isFollowupTool,
  latestFollowupTool,
  parseFollowupItems,
} from "./followupSuggestions";

describe("followupSuggestions", () => {
  it("reads a suggest_followups argument object", () => {
    const items = parseFollowupItems(
      JSON.stringify({
        followups: [{ prompt: "Open the studio", label: "Studio" }],
      }),
    );
    expect(items).toEqual([{ prompt: "Open the studio", label: "Studio" }]);
  });

  it("unwraps a Grok use_tool envelope", () => {
    const items = parseFollowupItems(
      JSON.stringify({
        tool_name: "codebuff__suggest_followups",
        tool_input: {
          followups: [
            { label: "Update Issue #1 spec", prompt: "Add the verified 5% safe-inset requirement." },
          ],
        },
      }),
    );
    expect(items[0]?.label).toBe("Update Issue #1 spec");
    expect(items[0]?.prompt).toContain("safe-inset");
  });

  it("keeps the latest follow-up tool in a turn", () => {
    const tools = [
      {
        title: "codebuff__suggest_followups",
        input: JSON.stringify({ followups: [{ prompt: "First" }] }),
      },
      { title: "read_file", input: "{}" },
      {
        toolKind: "mcp",
        title: "suggest_followups",
        input: JSON.stringify({ followups: [{ prompt: "Second", label: "Next" }] }),
      },
    ];
    expect(followupsFromTool(tools[2])[0]?.label).toBe("Next");
    expect(latestFollowupTool(tools)?.title).toBe("suggest_followups");
  });

  it("recognizes suggest_followups inside a use_tool call", () => {
    const tool = {
      title: "use_tool",
      toolKind: "use_tool",
      input: JSON.stringify({
        tool_name: "codebuff__suggest_followups",
        tool_input: { followups: [{ prompt: "Send the full prompt", label: "Next" }] },
      }),
    };
    expect(isFollowupTool(tool)).toBe(true);
    expect(followupsFromTool(tool)[0]?.prompt).toBe("Send the full prompt");
  });
});
