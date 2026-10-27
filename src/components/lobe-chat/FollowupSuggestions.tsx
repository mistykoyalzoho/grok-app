import { useMemo, useState } from "react";
import { createT, type Locale } from "@/i18n";
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
  locale,
  onSend,
}: {
  toolCallId: string;
  items: FollowupItem[];
  disabled?: boolean;
  locale?: Locale;
  onSend?: (prompt: string) => void;
}) {
  const tr = useMemo(() => createT(locale ?? "en"), [locale]);
  const [clicked, setClicked] = useState<number[]>(() => loadClicked(toolCallId));
  if (!items.length || !onSend) return null;
  const sent = clicked.length > 0;

  return (
    <section className="lobe-followups" aria-label={tr("followups.aria")}>
      <h3 className="lobe-followups__title">{tr("followups.title")}</h3>
      <div className="lobe-followups__list">
        {items.map((item, index) => {
          const used = clicked.includes(index);
          const label = (item.label || item.prompt).trim();
          const prompt = item.prompt.trim();
          const showPrompt = !!item.label && label !== prompt;
          return (
            <button
              key={`${toolCallId}-${index}`}
              type="button"
              className={
                "lobe-followups__card" + (used ? " lobe-followups__card--used" : "")
              }
              disabled={disabled || used}
              aria-pressed={used}
              onClick={() => {
                const next = clicked.includes(index) ? clicked : [...clicked, index];
                setClicked(next);
                try {
                  sessionStorage.setItem(clickedKey(toolCallId), JSON.stringify(next));
                } catch {
                  /* private mode */
                }
                onSend(prompt);
              }}
            >
              <strong>{used ? `✓ ${label}` : label}</strong>
              {showPrompt ? <small>{prompt}</small> : null}
            </button>
          );
        })}
      </div>
      <p className="lobe-followups__hint">
        {sent ? tr("followups.sent") : tr("followups.hint")}
      </p>
    </section>
  );
}
