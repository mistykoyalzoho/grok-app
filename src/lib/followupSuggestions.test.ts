import { describe, expect, it } from "vitest";
import {
  followupsFromTool,
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
});
