//! Shared expert-team manifest discovery and cancellable supervisor runs.
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicI32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_ROLES: usize = 12;
const MAX_TASK_CHARS: usize = 32_000;
const MAX_CAPTURE_BYTES: usize = 512 * 1024;
const MAX_SKILL_BYTES: u64 = 64 * 1024;
const MAX_PROMPT_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRole {
    pub id: String,
    pub name: String,
    pub instructions: String,
    #[serde(default)]
    pub skills: Vec<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertTeam {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    pub roles: Vec<TeamRole>,
    pub workflow: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunResult {
    pub ok: bool,
    pub cancelled: bool,
    pub artifact_path: Option<String>,
    pub report: String,
}

static ACTIVE_CANCEL: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);
static ACTIVE_CHILD: Mutex<Option<Child>> = Mutex::new(None);
static ACTIVE_PGID: AtomicI32 = AtomicI32::new(0);

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_team(team: &ExpertTeam, directory_id: &str) -> bool {
    if team.schema_version != 1
        || !valid_id(&team.id)
        || team.id != directory_id
        || team.workflow != "supervisor"
        || team.roles.is_empty()
        || team.roles.len() > MAX_ROLES
    {
        return false;
    }
    let mut ids = std::collections::HashSet::new();
    team.roles.iter().all(|role| {
        valid_id(&role.id)
            && ids.insert(&role.id)
            && !role.name.trim().is_empty()
            && !role.instructions.trim().is_empty()
    })
}

pub fn list() -> Result<Vec<ExpertTeam>, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is unavailable")?;
    let root = home.join(".agents/teams");
    let entries = match fs::read_dir(root) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut teams = Vec::new();
    for entry in entries.flatten() {
        let directory_id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&directory_id) {
            continue;
        }
        let path = entry.path().join("team.json");
        if fs::metadata(&path)
            .map(|m| m.len() > MAX_MANIFEST_BYTES)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(raw) = fs::read_to_string(path) else {
            continue;
        };
        let Ok(team) = serde_json::from_str::<ExpertTeam>(&raw) else {
            continue;
        };
        if valid_team(&team, &directory_id) {
            teams.push(team);
        }
    }
    teams.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(teams)
}

pub fn cancel() -> bool {
    let flag = ACTIVE_CANCEL.lock().ok().and_then(|g| g.as_ref().cloned());
    let Some(flag) = flag else { return false };
    flag.store(true, Ordering::SeqCst);
    terminate_active_group();
    if let Ok(mut child) = ACTIVE_CHILD.lock() {
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }
    true
}

fn terminate_active_group() {
    #[cfg(unix)]
    {
        let pgid = ACTIVE_PGID.load(Ordering::SeqCst);
        if pgid > 0 {
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
}

fn bounded_output(mut reader: impl Read) -> String {
    let mut captured = Vec::with_capacity(MAX_CAPTURE_BYTES.min(16 * 1024));
    let mut chunk = [0u8; 8192];
    loop {
        let Ok(n) = reader.read(&mut chunk) else {
            break;
        };
        if n == 0 {
            break;
        }
        let keep = MAX_CAPTURE_BYTES.saturating_sub(captured.len()).min(n);
        captured.extend_from_slice(&chunk[..keep]);
    }
    String::from_utf8_lossy(&captured).into_owned()
}

fn run_one(
    cli: &str,
    cwd: &str,
    prompt: &str,
    role: &str,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<String, String> {
    run_one_with_auth(cli, cwd, prompt, role, cancel, timeout, true)
}

fn run_one_with_auth(
    cli: &str,
    cwd: &str,
    prompt: &str,
    role: &str,
    cancel: &AtomicBool,
    timeout: Duration,
    prepare_auth: bool,
) -> Result<String, String> {
    if prompt.len() > MAX_PROMPT_BYTES {
        return Err(format!(
            "{role} prompt exceeds {} KiB; reduce task or skill content before retrying.",
            MAX_PROMPT_BYTES / 1024
        ));
    }
    let mut cmd = Command::new(cli);
    cmd.args(["-p", prompt, "--max-turns", "8", "--output-format", "plain"])
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    crate::process_util::apply_process_group_no_window_std(&mut cmd);
    crate::process_util::apply_cli_env_std(&mut cmd);
    if prepare_auth {
        let settings = crate::store::load_settings();
        let home = crate::paths::resolve_agent_grok_home(&settings.session_data_mode);
        fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        cmd.env("GROK_HOME", home);
        if settings.session_data_mode != "shared" {
            crate::providers::prepare_route_auth_for_agent();
        }
    }
    crate::proxy::apply_to_std_command(&mut cmd);
    let child = cmd
        .spawn()
        .map_err(|e| format!("Could not start {role}: {e}"))?;
    ACTIVE_PGID.store(child.id() as i32, Ordering::SeqCst);
    if let Ok(mut active) = ACTIVE_CHILD.lock() {
        *active = Some(child);
    }
    let stdout_reader = {
        let mut active = ACTIVE_CHILD
            .lock()
            .map_err(|_| "process lock unavailable")?;
        let stdout = active
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or("team stdout unavailable")?;
        std::thread::spawn(move || bounded_output(stdout))
    };
    let stderr_reader = {
        let mut active = ACTIVE_CHILD
            .lock()
            .map_err(|_| "process lock unavailable")?;
        let stderr = active
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or("team stderr unavailable")?;
        std::thread::spawn(move || bounded_output(stderr))
    };
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            terminate_active_group();
            if let Ok(mut active) = ACTIVE_CHILD.lock() {
                if let Some(c) = active.as_mut() {
                    let _ = c.kill();
                }
            }
        }
        let status = ACTIVE_CHILD
            .lock()
            .map_err(|_| "process lock unavailable")?
            .as_mut()
            .ok_or("team child disappeared")?
            .try_wait()
            .map_err(|e| e.to_string())?;
        if let Some(status) = status {
            let _ = ACTIVE_CHILD
                .lock()
                .map_err(|_| "process lock unavailable")?
                .take()
                .ok_or("team child disappeared")?;
            terminate_active_group();
            let out = stdout_reader.join().unwrap_or_default();
            let err = stderr_reader.join().unwrap_or_default();
            ACTIVE_PGID.store(0, Ordering::SeqCst);
            if cancel.load(Ordering::SeqCst) {
                return Err("cancelled".into());
            }
            if !status.success() {
                return Err(if err.trim().is_empty() {
                    format!("{role} exited with {status}")
                } else {
                    err.chars().take(400).collect()
                });
            }
            return Ok(out.trim().to_string());
        }
        if started.elapsed() > timeout {
            terminate_active_group();
            if let Ok(mut active) = ACTIVE_CHILD.lock() {
                if let Some(child) = active.as_mut() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                *active = None;
            }
            ACTIVE_PGID.store(0, Ordering::SeqCst);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err("timeout".into());
        }
        std::thread::sleep(Duration::from_millis(180));
    }
}

fn skill_prompt(role: &TeamRole, cwd: &str) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut roots = vec![PathBuf::from(cwd).join(".grok/skills")];
    if let Some(home) = home {
        roots.push(home.join(".agents/skills"));
        roots.push(home.join(".grok/skills"));
    }
    let mut sections = Vec::new();
    for name in &role.skills {
        // Team manifests name skills, never paths. Plugin-prefixed identifiers
        // can resolve by their final component when that installed skill exists.
        let candidates = [name.as_str(), name.rsplit(':').next().unwrap_or(name)];
        let found = roots.iter().find_map(|root| {
            candidates.iter().find_map(|candidate| {
                if candidate.is_empty()
                    || candidate.len() > 128
                    || !candidate
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                {
                    return None;
                }
                let path = root.join(candidate).join("SKILL.md");
                let metadata = fs::metadata(&path).ok()?;
                if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
                    return None;
                }
                fs::read_to_string(path).ok()
            })
        });
        match found {
            Some(content) => sections.push(format!("### {name}\n{content}")),
            None => sections.push(format!(
                "### {name}\n[Skill file unavailable locally; do not claim it was applied.]"
            )),
        }
    }
    if sections.is_empty() {
        "(none)".into()
    } else {
        sections.join("\n\n")
    }
}

fn build_role_prompt(
    team: &ExpertTeam,
    role: &TeamRole,
    task: &str,
    prior: &str,
    cwd: &str,
) -> String {
    format!(
        "You are {} on the {} expert team.\nRole instructions:\n{}\n\nTask:\n{}\n\nPrior role contributions (use as context; verify claims):\n{}\n\nSkill instructions loaded from local SKILL.md files:\n{}\n\nReturn a concise, evidence-aware contribution. Do not claim actions you did not perform.",
        role.name,
        team.name,
        role.instructions,
        task,
        if prior.is_empty() { "(none yet)" } else { prior },
        skill_prompt(role, cwd)
    )
}

fn write_private_artifact(path: &Path, body: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("artifact path has no parent")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
        .open(path)
        .and_then(|mut file| file.write_all(body.as_bytes()))
        .map_err(|e| e.to_string())
}

pub fn run(
    app: tauri::AppHandle,
    team_id: String,
    task: String,
    project_path: Option<String>,
) -> Result<TeamRunResult, String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("Enter a task first.".into());
    }
    if task.chars().count() > MAX_TASK_CHARS {
        return Err(format!("Task exceeds {MAX_TASK_CHARS} characters."));
    }
    let mut teams = list()?;
    let team = teams
        .drain(..)
        .find(|t| t.id == team_id)
        .ok_or("Team manifest not found. Refresh the catalog.")?;
    let cwd = project_path
        .filter(|p| PathBuf::from(p).is_dir())
        .or_else(|| std::env::var("HOME").ok())
        .ok_or("No existing project folder or home directory is available.")?;
    let cli = crate::cli_probe::probe_cli(crate::store::load_settings().manual_cli_path.as_deref())
        .path
        .ok_or("Grok Build CLI is unavailable. Configure it in Settings → Runtime.")?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = ACTIVE_CANCEL.lock().map_err(|_| "team runner busy")?;
        if active.is_some() {
            return Err("Another expert team is already running.".into());
        }
        *active = Some(cancel.clone());
    }
    let result = (|| {
        let mut notes = Vec::new();
        let total = team.roles.len();
        let mut all_roles_ok = true;
        for (i, role) in team.roles.iter().enumerate() {
            if cancel.load(Ordering::SeqCst) {
                return Ok(TeamRunResult {
                    ok: false,
                    cancelled: true,
                    artifact_path: None,
                    report: "Run cancelled.".into(),
                });
            }
            let _ = app.emit(
                "expert-team://progress",
                serde_json::json!({"phase":"role","index":i,"total":total,"role":role.name}),
            );
            let prior = notes
                .iter()
                .map(|(name, output)| format!("## {name}\n{output}"))
                .collect::<Vec<_>>()
                .join("\n\n");
            let prompt = build_role_prompt(&team, role, &task, &prior, &cwd);
            match run_one(
                &cli,
                &cwd,
                &prompt,
                &role.name,
                &cancel,
                Duration::from_secs(180),
            ) {
                Ok(out) => notes.push((role.name.clone(), out)),
                Err(e) if e == "cancelled" => {
                    return Ok(TeamRunResult {
                        ok: false,
                        cancelled: true,
                        artifact_path: None,
                        report: "Run cancelled.".into(),
                    })
                }
                Err(e) => {
                    all_roles_ok = false;
                    notes.push((role.name.clone(), format!("Role failed: {e}")));
                }
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(TeamRunResult {
                ok: false,
                cancelled: true,
                artifact_path: None,
                report: "Run cancelled before synthesis.".into(),
            });
        }
        let contributions = notes
            .iter()
            .map(|(n, t)| format!("## {n}\n{t}"))
            .collect::<Vec<_>>()
            .join("\n\n");
        let prompt = format!("Synthesize this expert team's separate role contributions into a useful answer to the task. Clearly identify unresolved disagreements and limitations.\nTask: {task}\n\n{contributions}");
        let _ = app.emit(
            "expert-team://progress",
            serde_json::json!({"phase":"synthesis","role":"synthesis"}),
        );
        let report = run_one(
            &cli,
            &cwd,
            &prompt,
            "synthesis",
            &cancel,
            Duration::from_secs(180),
        )?;
        let dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("HOME unavailable")?
            .join(".grok-app/expert-team-runs");
        let path = dir.join(format!(
            "{}-{}.md",
            team.id,
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ")
        ));
        let body = format!(
            "# {}\n\nTask: {}\n\n{}\n\n## Role contributions\n\n{}\n",
            team.name, task, report, contributions
        );
        write_private_artifact(&path, &body)?;
        Ok(TeamRunResult {
            ok: all_roles_ok,
            cancelled: false,
            artifact_path: Some(path.to_string_lossy().into_owned()),
            report,
        })
    })();
    if let Ok(mut active) = ACTIVE_CANCEL.lock() {
        *active = None;
    }
    ACTIVE_PGID.store(0, Ordering::SeqCst);
    if let Ok(mut child) = ACTIVE_CHILD.lock() {
        *child = None;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_manifest_identity_and_role_bounds() {
        let raw = r#"{"schemaVersion":1,"id":"a","name":"A","description":"","category":"","roles":[{"id":"r","name":"R","instructions":"do","skills":[]}],"workflow":"supervisor"}"#;
        let team: ExpertTeam = serde_json::from_str(raw).unwrap();
        assert!(valid_team(&team, "a"));
        assert!(!valid_team(&team, "../escape"));
        let mut duplicate = team.clone();
        duplicate.roles.push(duplicate.roles[0].clone());
        assert!(!valid_team(&duplicate, "a"));
    }

    #[test]
    fn next_role_prompt_includes_prior_contribution_and_skill_content() {
        let team = ExpertTeam {
            schema_version: 1,
            id: "team".into(),
            name: "Team".into(),
            description: String::new(),
            category: String::new(),
            workflow: "supervisor".into(),
            roles: vec![],
        };
        let role = TeamRole {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            instructions: "Review the implementation".into(),
            skills: vec![],
        };
        let prompt = build_role_prompt(&team, &role, "Fix bug", "## Architect\nUse helper X", ".");
        assert!(prompt.contains("Use helper X"));
        assert!(prompt.contains("Skill instructions loaded from local SKILL.md files"));
    }

    #[cfg(unix)]
    #[test]
    fn fake_cli_captures_output_checks_exit_and_cancels_process_tree() {
        use std::{os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "grok-team-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let cli = root.join("fake-grok");
        fs::write(&cli, "#!/bin/sh\ncase \"$2\" in fail) echo bad >&2; exit 9;; slow) sleep 20;; orphan) (sleep 20) & printf 'result:orphan'; exit 0;; esac\nprintf 'result:%s' \"$2\"\n").unwrap();
        let mut permissions = fs::metadata(&cli).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&cli, permissions).unwrap();
        let cli = cli.to_string_lossy().into_owned();
        let cwd = root.to_string_lossy().into_owned();

        assert_eq!(
            run_one_with_auth(
                &cli,
                &cwd,
                "ok",
                "test",
                &AtomicBool::new(false),
                Duration::from_secs(5),
                false
            )
            .unwrap(),
            "result:ok"
        );
        assert!(run_one_with_auth(
            &cli,
            &cwd,
            "fail",
            "test",
            &AtomicBool::new(false),
            Duration::from_secs(5),
            false
        )
        .unwrap_err()
        .contains("bad"));

        let started = Instant::now();
        assert_eq!(
            run_one_with_auth(
                &cli,
                &cwd,
                "orphan",
                "test",
                &AtomicBool::new(false),
                Duration::from_secs(5),
                false,
            )
            .unwrap(),
            "result:orphan"
        );
        assert!(started.elapsed() < Duration::from_secs(2));

        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let worker_cli = cli.clone();
        let worker_cwd = cwd.clone();
        let worker = std::thread::spawn(move || {
            run_one_with_auth(
                &worker_cli,
                &worker_cwd,
                "slow",
                "test",
                &worker_cancel,
                Duration::from_secs(5),
                false,
            )
        });
        std::thread::sleep(Duration::from_millis(150));
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(worker.join().unwrap().unwrap_err(), "cancelled");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn captured_output_is_bounded() {
        let data = vec![b'x'; MAX_CAPTURE_BYTES + 128 * 1024];
        assert_eq!(bounded_output(data.as_slice()).len(), MAX_CAPTURE_BYTES);
    }

    #[test]
    fn rejects_prompts_that_exceed_safe_argv_size() {
        let error = run_one_with_auth(
            "/does/not/run",
            ".",
            &"x".repeat(MAX_PROMPT_BYTES + 1),
            "role",
            &AtomicBool::new(false),
            Duration::from_secs(1),
            false,
        )
        .unwrap_err();
        assert!(error.contains("prompt exceeds 96 KiB"));
    }

    #[cfg(unix)]
    #[test]
    fn artifacts_are_private_and_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("runs");
        let path = dir.join("team-run.md");
        write_private_artifact(&path, "private report").unwrap();
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(write_private_artifact(&path, "replacement").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "private report");
    }
}
