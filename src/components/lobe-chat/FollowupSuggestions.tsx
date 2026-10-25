import { useState } from "react";
import type { FollowupItem } from "@/lib/followupSuggestions";

const clickedKey = (id: string) => `grok.followup.clicked.${id}`;

function loadClicked(id: string): number[] {
  try {
    const raw = sessionStorage.getItem(clickedKey(id));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function FollowupSuggestions({
  toolCallId,
  items,
  disabled,
  onSend,
}: {
  toolCallId: string;
  items: FollowupItem[];
  disabled?: boolean;
  onSend?: (prompt: string) => void;
}) {
  const [clicked, setClicked] = useState<number[]>(() => loadClicked(toolCallId));
  if (!items.length || !onSend) return null;

  return (
    <div className="lobe-followups" role="group" aria-label="Suggested follow-ups">
      {items.map((item, index) => {
        const used = clicked.includes(index);
        const text = item.label || item.prompt;
        return (
          <button
            key={`${toolCallId}-${index}`}
            type="button"
            className={
              "lobe-followups__btn" + (used ? " lobe-followups__btn--used" : "")
            }
            disabled={disabled || used}
            title={item.prompt}
            onClick={() => {
              const next = clicked.includes(index) ? clicked : [...clicked, index];
              setClicked(next);
              try {
                sessionStorage.setItem(clickedKey(toolCallId), JSON.stringify(next));
              } catch {
                /* private mode */
              }
              onSend(item.prompt);
            }}
          >
            <span aria-hidden="true">{used ? "✓" : "→"}</span>
            {text}
          </button>
        );
      })}
    </div>
  );
}
