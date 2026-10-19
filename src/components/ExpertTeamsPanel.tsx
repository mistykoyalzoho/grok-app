import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "@/lib/api";
import { createT, type Locale } from "@/i18n";
import { MarkdownBody } from "@/components/MarkdownBody";

type Progress = { phase?: string; role?: string; index?: number; total?: number };

export function ExpertTeamsPanel({ locale, projectPath }: { locale: Locale; projectPath?: string | null }) {
  const tr = useMemo(() => createT(locale), [locale]);
  const [teams, setTeams] = useState<api.ExpertTeam[]>([]);
  const [selected, setSelected] = useState("");
  const [task, setTask] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<api.ExpertTeamRunResult | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await api.expertTeamsList();
      setTeams(rows);
      setSelected((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id ?? "");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;
    void listen<Progress>("expert-team://progress", (event) => setProgress(event.payload))
      .then((fn) => { if (mounted) unlisten = fn; else fn(); })
      .catch((cause) => { if (mounted) setError(String(cause)); });
    return () => { mounted = false; unlisten?.(); };
  }, []);

  const visibleTeams = teams.filter((team) => `${team.name} ${team.description} ${team.category} ${team.roles.map((role) => role.name).join(" ")}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const run = async () => {
    if (!selected || !task.trim() || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setProgress({ phase: "starting" });
    try {
      setResult(await api.expertTeamRun({ teamId: selected, task: task.trim(), projectPath }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <section className="settings-card ext-card expert-teams" aria-label={tr("ext.expertTeams.title")}>
      <div className="ext-h2-row">
        <div><h2>{tr("ext.expertTeams.title")}</h2><p className="settings-page__lead">{tr("ext.expertTeams.description")}</p></div>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()} disabled={loading || running}>{tr("ext.refresh")}</button>
      </div>
      {!loading ? <input type="search" className="settings-input expert-teams__search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr("ext.expertTeams.search")} aria-label={tr("ext.expertTeams.search")} /> : null}
      {loading ? <p className="ext-empty">{tr("ext.agents.loading")}</p> : null}
      {!loading && teams.length === 0 ? <p className="ext-empty">{tr("ext.expertTeams.empty")}</p> : null}
      {!loading && teams.length > 0 && visibleTeams.length === 0 ? <p className="ext-empty">{tr("mcpModal.filterEmpty")}</p> : null}
      {visibleTeams.length > 0 ? <>
        <ul className="ext-list">
          {visibleTeams.map((team) => <li className="ext-item" key={team.id}>
            <label className="expert-teams__choice">
              <input type="radio" name="expert-team" value={team.id} checked={selected === team.id} onChange={() => setSelected(team.id)} disabled={running} />
              <span><strong>{team.name}</strong><small>{team.description}</small><small>{team.roles.map((role) => role.name).join(" · ")}</small></span>
            </label>
          </li>)}
        </ul>
        <label className="expert-teams__task-label" htmlFor="expert-team-task">{tr("ext.expertTeams.task")}</label>
        <textarea id="expert-team-task" className="settings-input ext-env-textarea" value={task} onChange={(event) => setTask(event.target.value)} placeholder={tr("ext.expertTeams.taskPlaceholder")} disabled={running} rows={3} />
        <div className="ext-ref-tabs__actions">
          <button type="button" className="btn btn--solid btn--sm" onClick={() => void run()} disabled={running || !selected || !task.trim()}>{running ? tr("ext.expertTeams.running") : tr("ext.expertTeams.run")}</button>
          {running ? <button type="button" className="btn btn--ghost btn--sm" onClick={() => void api.expertTeamCancel().catch((cause) => setError(String(cause)))}>{tr("ext.expertTeams.cancel")}</button> : null}
          {progress?.role ? <span role="status">{tr("ext.expertTeams.progress", { role: progress.role })}</span> : null}
        </div>
      </> : null}
      {error ? <p className="ext-alert" role="alert">{error}</p> : null}
      {result ? <div className="expert-teams__result" role="status">
        <strong>{result.cancelled ? tr("ext.expertTeams.cancelled") : result.ok ? tr("ext.expertTeams.complete") : tr("ext.expertTeams.failed")}</strong>
        <MarkdownBody locale={locale}>{result.report}</MarkdownBody>
        {result.artifactPath ? <small>{tr("ext.expertTeams.artifact", { path: result.artifactPath })}</small> : null}
      </div> : null}
    </section>
  );
}
