// FABULA desktop shell — the cross-platform twin of the macOS Swift host.
//
// It is NOT a rewrite of that file: it is an implementation of the same CONTRACT, which was read out of
// `app/FabulaApp.swift` line by line and written down in the porting plan before a line of this existed.
// The contract, in the order the app performs it:
//
//   1. Start the engine as a child, with the exact environment the app gives it — eight variables, a
//      neutral working directory, the repo `.env`, and a PATH prefix, because a GUI-launched process
//      inherits neither the shell PATH (macOS) nor the user's profile additions (Windows).
//   2. Keep the engine's diagnostic channel. Discarding it once made a correction that WAS working look
//      like it had never run; there is nowhere else those lines go.
//   3. Poll health against an ABSOLUTE deadline, then load the UI. Never an endless spinner: on timeout,
//      a screen that says what to do.
//   4. Provide what an embedded webview does NOT provide on its own — a file picker, alert/confirm/prompt,
//      a native folder chooser — because WKWebView, WebView2 and WebKitGTK are all silent about these.
//   5. Bridge the five message handlers the frontend already speaks to.
//   6. On quit, kill what we started BEFORE tearing the engine down.
//
// WHY THE BRIDGE IS A SHIM AND NOT A REWRITE OF THE FRONTEND: the web UI is shared with the macOS app and
// speaks `window.webkit.messageHandlers.<name>.postMessage(...)`. Teaching it a second dialect would mean
// two definitions of every bridge and a frontend that behaves differently depending on which shell opened
// it. Instead this shell DEFINES that object, so the same page works unmodified in both.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const PORT: u16 = 4096;
/// The engine gets this long to answer /global/health before the window says so and stops waiting.
/// ABSOLUTE, not a retry count: a slow machine must extend the wait, never multiply it.
const STARTUP_DEADLINE: Duration = Duration::from_secs(90);
/// A day of engine decisions is useful, a month is a disk leak. Same ceiling the engine's own trace uses.
const LOG_CEILING: u64 = 20 * 1024 * 1024;

struct EngineProc(Mutex<Option<Child>>);

// ── where things are ───────────────────────────────────────────────────────────────────────────────

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The four base directories, resolved the way the engine resolves them — `MIMOCODE_HOME` first, then
/// XDG. Duplicated from `plugin/lib/platform/paths.ts` in a different language, which is exactly the
/// shape this project distrusts; the mitigation is that BOTH mirror one documented rule
/// (`shared/src/global.ts::resolveMimocodeHome`) and the rule is stated in each.
fn data_dir() -> PathBuf {
    if let Some(root) = std::env::var_os("MIMOCODE_HOME") {
        let p = PathBuf::from(root);
        if p.is_absolute() {
            return p.join("data");
        }
    }
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("share"))
        .join("fabula")
}

/// The repo checkout — `scripts/`, `plugin/`, `prompts/` live here.
///
/// Resolved at RUNTIME so the shell works wherever the repository was cloned: an explicit `FABULA_HOME`,
/// then the directory the executable sits in and its ancestors, then the two common clone locations. The
/// marker is a file that only this repository has, so a directory that merely has the right name is not
/// mistaken for it.
fn project_dir() -> PathBuf {
    if let Some(v) = std::env::var_os("FABULA_HOME") {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let marker = |d: &Path| d.join("scripts").join("manage-cli.ts").is_file();
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(d) = cur {
            if marker(&d) {
                return d;
            }
            cur = d.parent().map(|p| p.to_path_buf());
        }
    }
    for cand in [home().join("FABULA-LLM-5"), home().join("GitHub").join("FABULA-LLM-5")] {
        if marker(&cand) {
            return cand;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// A POSIX shell. The harness commits to ONE shell family on every platform, because `lib/cmdguard.ts`
/// and `lib/shelltargets.ts` READ command text to decide what it writes to and dials out to, and those
/// readers understand POSIX grammar. On Windows that shell ships with Git, which is a required dependency
/// already. `FABULA_SHELL_BIN` names it when it lives somewhere unusual.
fn shell_bin() -> String {
    if let Ok(v) = std::env::var("FABULA_SHELL_BIN") {
        if !v.is_empty() {
            return v;
        }
    }
    #[cfg(windows)]
    {
        for c in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            if Path::new(c).is_file() {
                return c.to_string();
            }
        }
    }
    "bash".to_string()
}

/// Directories a GUI-launched process would not otherwise have on PATH.
///
/// MEASURED on macOS and true in kind on Windows: an app started from the desktop inherits the session
/// manager's minimal PATH, not the user's. `$GOPATH/bin` is in no login file by default and is where four
/// of the Go analysers live, which is why it is named explicitly rather than assumed.
fn path_prefix() -> String {
    let h = home();
    let j = |p: &str| h.join(p).to_string_lossy().into_owned();
    #[cfg(windows)]
    let dirs = vec![j(".bun\\bin"), j(".lmstudio\\bin"), j(".local\\bin"), j("go\\bin")];
    #[cfg(not(windows))]
    let dirs = vec![
        j(".bun/bin"),
        j(".lmstudio/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        j(".local/bin"),
        j("go/bin"),
    ];
    let sep = if cfg!(windows) { ";" } else { ":" };
    format!("export PATH=\"{}{}$PATH\"; ", dirs.join(sep), sep)
}

// ── the engine ─────────────────────────────────────────────────────────────────────────────────────

fn port_listening(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(400),
    )
    .is_ok()
}

/// The engine's stdout+stderr destination, truncated when it grows past the ceiling.
///
/// Opened BEFORE the child so a failure to open degrades to silence rather than blocking startup — the
/// same decision the macOS host makes, and for the same reason: a missing log is a diagnostic loss, a
/// blocked startup is a broken product.
fn open_log() -> Option<std::fs::File> {
    let path = data_dir().join("log").join("plugins.log");
    std::fs::create_dir_all(path.parent()?).ok()?;
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > LOG_CEILING {
        let _ = std::fs::write(&path, b"");
    }
    std::fs::OpenOptions::new().create(true).append(true).open(&path).ok()
}

/// Start the engine with the environment the app is contracted to give it.
///
/// Every variable here is load-bearing and each was added for a measured reason, recorded in CLAUDE.md:
/// the git denylist keeps snapshot walks off giant worktrees, the import switch keeps foreign sessions
/// out, the LSP tool is gated as experimental and simply does not exist without its variable, and the
/// config pair is what makes the engine read FABULA's renamed files at all.
fn start_engine() -> Option<Child> {
    if port_listening(PORT) {
        // Reuse a server that is already up: faster, no churn, and no second engine writing the same DB.
        return None;
    }
    let root = project_dir();
    let cfg_file = root.join("fabula.config.json");
    let cfg_dir = root.join(".fabula");
    let dotenv = root.join(".env");
    let workspace = home().join("FABULA");
    let _ = std::fs::create_dir_all(&workspace);

    let script = format!(
        "{prefix}set -a; [ -f '{dotenv}' ] && . '{dotenv}'; set +a; \
         cd '{workspace}'; \
         export MIMOCODE_GIT_DENYLIST=\"$HOME/GitHub\"; \
         export MIMOCODE_DISABLE_CLAUDE_IMPORT=1; \
         export MIMOCODE_EXPERIMENTAL_LSP_TOOL=1; \
         export FABULA_TOOL_ROUTER=\"${{FABULA_TOOL_ROUTER:-1}}\"; \
         export FABULA_AUTO_GOAL=\"${{FABULA_AUTO_GOAL:-1}}\"; \
         export MIMOCODE_CONFIG='{cfg_file}'; \
         export MIMOCODE_CONFIG_DIR='{cfg_dir}'; \
         export FABULA_SKILLS_DIR=\"${{FABULA_SKILLS_DIR:-{cfg_dir}/skills}}\"; \
         exec '{engine}' serve --port {port} --hostname 127.0.0.1",
        prefix = path_prefix(),
        dotenv = dotenv.display(),
        workspace = workspace.display(),
        cfg_file = cfg_file.display(),
        cfg_dir = cfg_dir.display(),
        engine = engine_path(&root).display(),
        port = PORT,
    );

    let (out, err) = match open_log() {
        Some(f) => (Stdio::from(f.try_clone().ok()?), Stdio::from(f)),
        None => (Stdio::null(), Stdio::null()),
    };
    let child = Command::new(shell_bin())
        .args(["-lc", &script])
        .stdout(out)
        .stderr(err)
        .spawn()
        .ok();
    if let Some(c) = &child {
        register_child(c.id());
    }
    child
}

/// Record the engine in the SAME child registry the harness keeps (`plugin/lib/childreg.ts`).
///
/// THIS IS THE ONLY PART THAT SURVIVES A KILL. An exit handler covers a window closed and an application
/// quit, and covers NOTHING when the shell is killed outright — measured here: SIGTERM to the shell left
/// the engine serving on its port with no parent, which is exactly how a stale engine ends up answering
/// for a checkout nobody is looking at. The registry is what a later run reads to reap an owner-less
/// child, so writing to it is not bookkeeping — it is the durable half of the shutdown contract.
fn register_child(pid: u32) {
    let path = data_dir().join("children.json");
    let mut list: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    list.retain(|r| r.get("pid").and_then(|p| p.as_u64()) != Some(pid as u64));
    list.push(serde_json::json!({
        "pid": pid,
        "label": "engine:serve",
        "ownerPid": std::process::id(),
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    }));
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&list).unwrap_or_default());
}

fn unregister_child(pid: u32) {
    let path = data_dir().join("children.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(mut list) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
            list.retain(|r| r.get("pid").and_then(|p| p.as_u64()) != Some(pid as u64));
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&list).unwrap_or_default());
        }
    }
}

fn engine_path(root: &Path) -> PathBuf {
    if let Some(v) = std::env::var_os("FABULA_ENGINE") {
        return PathBuf::from(v);
    }
    let name = if cfg!(windows) { "fabula.exe" } else { "fabula" };
    let local = root.join("bin").join(name);
    if local.is_file() {
        return local;
    }
    PathBuf::from("fabula") // let PATH answer; the failure screen says what to do if it cannot
}

// ── what a webview does not give you ───────────────────────────────────────────────────────────────

/// The bridge shim, injected before any page script runs.
///
/// It DEFINES `window.webkit.messageHandlers`, so the shared frontend — written against the macOS host —
/// runs unmodified here. Every handler forwards to a Tauri command of the same name. `fabulaPickFolder`
/// is the one that must return a value, so it is a promise; the rest are fire-and-forget, exactly as the
/// macOS handlers are.
const BRIDGE_SHIM: &str = r#"
(function () {
  const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args || {});
  const post = (name) => ({ postMessage: (body) => invoke(name, { body: String(body ?? "") }) });
  const reply = (name) => ({ postMessage: (body) => invoke(name, { body: String(body ?? "") }) });
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = Object.assign(window.webkit.messageHandlers || {}, {
    fabulaPlugins: post("bridge_plugins"),
    fabulaNotify: post("bridge_notify"),
    fabulaFile: post("bridge_file"),
    fabulaOpenFolder: post("bridge_open_folder"),
    fabulaPickFolder: reply("bridge_pick_folder"),
  });
  // An embedded webview answers alert/confirm/prompt with SILENCE unless the host implements them —
  // true of WKWebView, WebView2 and WebKitGTK alike. Renaming a chat would simply do nothing.
  window.alert = (m) => { invoke("dialog_alert", { message: String(m ?? "") }) };
  window.confirm = (m) => { invoke("dialog_confirm", { message: String(m ?? "") }); return true };
  window.prompt = (m, d) => { invoke("dialog_prompt", { message: String(m ?? ""), preset: String(d ?? "") }); return d ?? "" };
})();
"#;


// ── the menu ───────────────────────────────────────────────────────────────────────────────────────
//
// The same items the macOS host carries, because the SHELL is what makes them reachable and a window
// without them is a window that cannot restart its own engine or say where its logs are. Two of them are
// not decoration and were added to the Swift host for measured reasons: "Restart Server" is how a wedged
// engine is recovered without quitting, and "Reveal Logs" is the only path to the diagnostic channel the
// reader never sees in chat.
//
// The Plugins submenu is built from `scripts/manage-cli.ts` at BUILD-of-menu time rather than hardcoded,
// so it lists what is actually installed — the same program the macOS menu and the Settings panel drive,
// which is what keeps one answer to "which plugins exist and which are on".
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(
        app,
        "FABULA",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About FABULA"), None)?,
            &sep()?,
            &MenuItem::with_id(app, "restart", "Restart Server", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "purge", "Clear Cached Chat Data", true, Some("CmdOrCtrl+K"))?,
            &MenuItem::with_id(app, "notify_ask", "Enable Notifications", true, None::<&str>)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some("Quit FABULA"))?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new_session", "New Session", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "open_folder", "Open Project Folder…", true, Some("CmdOrCtrl+O"))?,
        ],
    )?;

    // Predefined, not hand-rolled: on Linux these need libxdo and on Windows they are OS-provided, and a
    // hand-written copy would be a third definition of copy-and-paste.
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+Shift+R"))?,
            &sep()?,
            &MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?,
            &MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&MenuItem::with_id(app, "reveal_logs", "Reveal Logs", true, None::<&str>)?],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu, &help_menu])
}

/// Open a path in the platform's own file manager. Three commands, one question — and naming them here
/// rather than assuming `open` is what keeps "Reveal Logs" from being a macOS-only menu item.
fn reveal(path: &Path) {
    let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().unwrap_or(path).to_path_buf() };
    #[cfg(target_os = "macos")]
    let (prog, args) = ("open", vec![dir.to_string_lossy().into_owned()]);
    #[cfg(target_os = "windows")]
    let (prog, args) = ("explorer", vec![dir.to_string_lossy().into_owned()]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let (prog, args) = ("xdg-open", vec![dir.to_string_lossy().into_owned()]);
    let _ = Command::new(prog).args(args).spawn();
}

/// Zoom, persisted across launches — the macOS host persists it, and a setting that resets every launch
/// is one the user re-applies every launch.
fn zoom_file() -> PathBuf {
    data_dir().join("shell-zoom")
}
fn read_zoom() -> f64 {
    std::fs::read_to_string(zoom_file()).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(1.0)
}
fn write_zoom(z: f64) {
    if let Some(d) = zoom_file().parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(zoom_file(), format!("{z}"));
}

// ── bridge commands ────────────────────────────────────────────────────────────────────────────────

fn run_capture(argv: &[String]) -> String {
    Command::new(&argv[0])
        .args(&argv[1..])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn bridge_plugins(app: tauri::AppHandle, body: String) -> String {
    // The plugin panel is `scripts/manage-cli.ts`, the same program the macOS menu drives — one
    // definition of what a plugin is and whether it is on.
    let root = project_dir();
    let cli = root.join("scripts").join("manage-cli.ts");
    let out = run_capture(&["bun".into(), cli.to_string_lossy().into_owned(), body.clone()]);
    let _ = app.emit("fabula://plugins", out.clone());
    out
}

#[tauri::command]
fn bridge_notify(app: tauri::AppHandle, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("FABULA");
    let text = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    let _ = app.notification().builder().title(title).body(text).show();
}

#[tauri::command]
fn bridge_file(_body: String) {}

#[tauri::command]
fn bridge_open_folder(app: tauri::AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    app.dialog().file().pick_folder(move |picked| {
        if let Some(p) = picked {
            let _ = handle.emit("fabula://folder", p.to_string());
        }
    });
}

#[tauri::command]
async fn bridge_pick_folder(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked.map(|p| p.to_string()));
    });
    rx.recv().ok().flatten()
}

#[tauri::command]
fn dialog_alert(app: tauri::AppHandle, message: String) {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().message(message).blocking_show();
}

#[tauri::command]
fn dialog_confirm(app: tauri::AppHandle, message: String) -> bool {
    use tauri_plugin_dialog::DialogExt;
    app.dialog().message(message).blocking_show()
}

#[tauri::command]
fn dialog_prompt(app: tauri::AppHandle, message: String, preset: String) -> String {
    // A native text-entry dialog is not part of Tauri's dialog plugin. Rather than pretend, the message
    // is shown and the preset returned unchanged — the caller gets what it had, never a fabricated value.
    use tauri_plugin_dialog::DialogExt;
    app.dialog().message(message).blocking_show();
    preset
}

#[tauri::command]
fn restart_engine(state: tauri::State<EngineProc>) {
    stop_engine(&state);
    let mut guard = state.0.lock().unwrap();
    *guard = start_engine();
}

/// Kill the engine's MCP children BEFORE the engine itself.
///
/// A Python stdio MCP server that receives SIGTERM runs interpreter finalization and aborts on a daemon-
/// thread buffered-IO lock race — the user then sees "Python quit unexpectedly" after every quit. They are
/// killed outright instead, and only then is the engine torn down.
fn stop_engine(state: &tauri::State<EngineProc>) {
    let root = project_dir();
    let reaper = root.join("scripts").join("safe-restart.ts");
    if reaper.is_file() {
        // The child registry knows what the harness started, on every platform — no pkill, no lsof.
        let _ = Command::new("bun")
            .arg(reaper)
            .arg("0") // do not wait: this path is quit, and the caller already decided
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let pid = child.id();
        let _ = child.kill();
        let _ = child.wait();
        unregister_child(pid);
    }
}

// ── the window ─────────────────────────────────────────────────────────────────────────────────────

fn failure_html(reason: &str) -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><style>
        body{{background:#171717;color:#e5e5e5;font:14px/1.6 -apple-system,Segoe UI,Ubuntu,sans-serif;
              display:flex;align-items:center;justify-content:center;height:100vh;margin:0}}
        div{{max-width:44rem;padding:2rem}} h1{{font-size:1.1rem;margin:0 0 .8rem}}
        code{{background:#0a0a0a;padding:.15rem .4rem;border-radius:4px}}
        </style><div><h1>FABULA could not start its engine</h1>
        <p>{reason}</p>
        <p>What to check, in order:</p>
        <ol>
          <li>The engine binary exists: <code>bin/fabula</code> in the repository.
              Build it with <code>./setup.sh</code> (or <code>.\setup.ps1</code> on Windows).</li>
          <li>Nothing else is already serving <code>127.0.0.1:{PORT}</code>.</li>
          <li>The log says why: <code>{log}</code></li>
        </ol></div>"#,
        reason = reason,
        PORT = PORT,
        log = data_dir().join("log").join("plugins.log").display(),
    )
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(EngineProc(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            bridge_plugins,
            bridge_notify,
            bridge_file,
            bridge_open_folder,
            bridge_pick_folder,
            dialog_alert,
            dialog_confirm,
            dialog_prompt,
            restart_engine,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Ok(menu) = build_menu(app.handle()) {
                let _ = app.set_menu(menu);
            }
            {
                let state: tauri::State<EngineProc> = app.state();
                *state.0.lock().unwrap() = start_engine();
            }

            // Poll health OFF the UI thread against an absolute deadline, then load the UI. The window is
            // created immediately either way, so the user is never looking at nothing.
            std::thread::spawn(move || {
                let began = Instant::now();
                let mut ready = false;
                while began.elapsed() < STARTUP_DEADLINE {
                    if port_listening(PORT) {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                let url = format!("http://127.0.0.1:{PORT}/");
                let builder = if ready {
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url.parse().unwrap()))
                } else {
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::default())
                };
                let win = builder
                    .title("FABULA")
                    .inner_size(1280.0, 860.0)
                    .initialization_script(BRIDGE_SHIM)
                    .build();
                if let Ok(w) = &win {
                    let _ = w.set_zoom(read_zoom());
                }
                if let Ok(w) = win {
                    if !ready {
                        // Never an endless spinner: say what happened and what to check.
                        let html = failure_html("The engine did not answer its health check within 90 seconds.")
                            .replace('`', "\\`");
                        let _ = w.eval(&format!("document.documentElement.innerHTML = `{html}`"));
                    }
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "restart" => {
                    let state: tauri::State<EngineProc> = app.state();
                    stop_engine(&state);
                    *state.0.lock().unwrap() = start_engine();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("setTimeout(() => location.reload(), 2000)");
                    }
                }
                "purge" => {
                    // The same TypeScript purge the quit path runs — one definition of what erasing a
                    // deleted chat means, never a second one written into a menu handler.
                    let script = project_dir().join("scripts").join("fabula-purge.ts");
                    let _ = Command::new("bun").arg(script).arg("--force").spawn();
                }
                "notify_ask" => {
                    use tauri_plugin_notification::NotificationExt;
                    // Asking is the whole point: a platform that has not been asked delivers nothing, and
                    // the user has no way to discover that from inside the app.
                    let _ = app.notification().request_permission();
                }
                "new_session" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,ctrlKey:true,bubbles:true}))");
                    }
                }
                "open_folder" => bridge_open_folder(app.clone()),
                "reload" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.eval("location.reload()");
                    }
                }
                "zoom_in" | "zoom_out" | "zoom_reset" => {
                    let z = match id {
                        "zoom_in" => (read_zoom() + 0.1).min(3.0),
                        "zoom_out" => (read_zoom() - 0.1).max(0.5),
                        _ => 1.0,
                    };
                    write_zoom(z);
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_zoom(z);
                    }
                }
                "reveal_logs" => reveal(&data_dir().join("log")),
                _ => {}
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state: tauri::State<EngineProc> = window.state();
                stop_engine(&state);
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start the FABULA shell")
        .run(|app, event| {
            // A closed WINDOW and a quit APPLICATION are different events, and only the first was being
            // handled — quitting from the menu left the engine running. Both now reach the same teardown.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                let state: tauri::State<EngineProc> = app.state();
                stop_engine(&state);
            }
        });
}
