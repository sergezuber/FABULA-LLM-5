// FABULA-LLM-5 — native macOS shell.
// Own dock icon + own window via WKWebView. Starts the FABULA engine server (headless) + SearXNG,
// then loads the local web UI. Uses NO external browser, so quitting this app can never
// touch the user's main Chrome/Safari. On quit it stops only the engine server IT started.

import Cocoa
import WebKit
import UserNotifications

let PORT = 4096
let URLSTR = "http://127.0.0.1:\(PORT)/"
// DB-free readiness probe. The root `/` is DB-gated (it goes through per-instance bootstrap), so
// polling it keeps the launcher waiting on the database — forever if the DB wedges. /global/health
// answers as soon as the port is bound and touches no DB.
let HEALTHURL = "http://127.0.0.1:\(PORT)/global/health"
let HOME = NSHomeDirectory()
// The engine binary. Overridable via FABULA_ENGINE; otherwise `fabula` (the shim setup.sh installs),
// falling back to the raw engine CLI from PATH (PATH_PREFIX below covers the common install locations).
let ENGINE = ProcessInfo.processInfo.environment["FABULA_ENGINE"] ?? "$(command -v fabula || command -v mimo || echo fabula)"
// Optional helper script to start a local SearXNG instance (web search backend).
// Not shipped with the repo — point FABULA_SEARXNG_START at your own script if you have one.
let SEARXNG_START = ProcessInfo.processInfo.environment["FABULA_SEARXNG_START"]
    ?? "\(HOME)/searxng-stack/start-searxng.sh"
// The repo checkout (scripts/, plugin/, prompts/ live here). Resolved at runtime so the app
// works wherever the repo was cloned: FABULA_HOME env → the .app bundle's parent directory
// (app/build.sh puts the bundle in the repo root) → common clone locations.
let PROJECT_DIR: String = {
    if let env = ProcessInfo.processInfo.environment["FABULA_HOME"], !env.isEmpty { return env }
    let bundleParent = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
    for candidate in [bundleParent, "\(HOME)/FABULA-LLM-5", "\(HOME)/GitHub/FABULA-LLM-5"] {
        if FileManager.default.fileExists(atPath: "\(candidate)/scripts/manage-cli.ts") { return candidate }
    }
    return bundleParent
}()
// Serve from a clean, neutral workspace — NOT from inside a huge repo checkout, where a
// large number of uncommitted files makes the "Git changes" panel render-hang the whole UI.
// The user opens any specific project via the GUI's "Open project" button.
let WORKSPACE_DIR = "\(HOME)/FABULA"

// GUI apps launched from Finder/LaunchServices do NOT inherit the user's shell PATH
// (~/.zshrc etc.), so bare `bun`/`fabula`/`node` are not found — the Plugins menu then
// shows "(could not load plugins — is bun installed?)". Prepend the common install
// dirs so every shell-out resolves these tools regardless of the login shell config.
let PATH_PREFIX = "export PATH=\"$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH\"; "

@discardableResult
func shell(_ cmd: String) -> Int32 {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = ["-lc", PATH_PREFIX + cmd]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return -1 }
    p.waitUntilExit()
    return p.terminationStatus
}

// Like shell() but captures stdout (used by the Plugins menu to read scripts/manage-cli.ts JSON).
func shellOut(_ cmd: String) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = ["-lc", PATH_PREFIX + cmd]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = Pipe()
    do { try p.run() } catch { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return String(data: data, encoding: .utf8) ?? ""
}

func stripAnsi(_ s: String) -> String {
    return s.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
}

func portListening(_ port: Int) -> Bool {
    return shell("lsof -nP -iTCP:\(port) -sTCP:LISTEN >/dev/null 2>&1") == 0
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, NSMenuDelegate, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var engineProc: Process?        // only set if WE started the server
    var pollTimer: Timer?
    var pluginsMenu: NSMenu?        // native plugin manager (enable/disable + install deps)
    // UI language for the Plugins menu labels. The injected web panel reports the app's current locale via
    // the fabulaPlugins bridge (action "lang"); until then, default from the system language.
    var uiLang: String = UserDefaults.standard.string(forKey: "fabulaLang")
        ?? ((Locale.preferredLanguages.first?.hasPrefix("ru") == true) ? "ru" : "en")

    // UNUserNotificationCenter ABORTS the process (NSInternalInconsistencyException → SIGABRT) when
    // LaunchServices cannot resolve the bundle — e.g. a bundle without Info.plist/CFBundleIdentifier,
    // or the raw binary run outside a bundle. Gate every touch of the framework on a resolvable
    // identity so a broken/naked bundle degrades to "no system notifications" instead of a crash.
    let canUseSystemNotifications = Bundle.main.bundleIdentifier != nil

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMenu()
        startBackend()
        buildWindow()
        startPolling()
        // System notifications (agent finished / permission asked / errors — toggles in Settings).
        if canUseSystemNotifications {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        } else {
            NSLog("FABULA: no bundle identifier — system notifications disabled (rebuild the bundle with app/build.sh)")
        }
    }

    // MARK: - System notifications (fabulaNotify bridge)
    func deliverNotification(title: String, body: String, href: String) {
        guard canUseSystemNotifications else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        if !body.isEmpty { content.body = body }
        if !href.isEmpty { content.userInfo = ["href": href] }
        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // Click on a notification: activate the app and deep-link the webview back to the session.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let href = response.notification.request.content.userInfo["href"] as? String ?? ""
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            if !href.isEmpty, let wv = self.webView {
                let js = "location.href = '\(href.replacingOccurrences(of: "'", with: "\\'"))'"
                wv.evaluateJavaScript(js, completionHandler: nil)
            }
            completionHandler()
        }
    }

    // Show banners even while the app is frontmost (the web side already filters focused-view cases).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1220, height: 840)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "FABULA-LLM-5"
        window.center()
        window.setFrameAutosaveName("FabulaMainWindow")

        let cfg = WKWebViewConfiguration()
        // PERSISTENT store keeps lightweight UI state (layout) across launches — measured: NO chat text,
        // empty IndexedDB; all sessions live in the engine's database, never lost. On launch we deliberately
        // land on the projects HOME (see landHomeJS) rather than auto-restoring one project, so you pick
        // from ALL recent projects instead of being dropped into the empty default. Chat response bodies
        // that WebKit would disk-cache are wiped on quit by wipeWebCache() (applicationWillTerminate), so
        // deleted chats leave no recoverable trace.
        cfg.websiteDataStore = .default()
        // Rebrand the embedded web UI: replace any leftover upstream wordmark/title with
        // FABULA-LLM-5. Only TEXT NODES are touched — never attributes, ids, theme names,
        // localStorage keys or CSS vars (those keep the app working).
        // SAFE rebrand: CSS-only + window title. We must NOT mutate the DOM that React
        // controls (text-node edits / node insertion crash React → blank page). CSS and
        // document.title are invisible to React, so the app renders normally.
        // Rebrand only — the freeze is fixed at the source (the engine's MIMOCODE_DISABLE_GIT flag on the
        // server), so no fetch interception is needed. CSS never mutates React's DOM.
        let rebrand = """
        (function(){
          var s=document.createElement('style');
          s.textContent=
            // FABULA design tokens (Item 7): a semantic ROLE layer + DOMAIN families (git/diff/terminal/
            // context), so every injected surface themes off named tokens, never raw hex. Values match the
            // app's own probed dark UI; accent is FABULA's OWN teal (not a competitor's blue).
            `:root{`+
              `--fab-bg:#121212;--fab-surface:#191919;--fab-elevated:#1c1c1c;--fab-border:#282828;`+
              `--fab-fg:#ededed;--fab-fg-muted:#a0a0a0;--fab-fg-subtle:#707070;`+
              `--fab-accent:#5bbf9f;--fab-on-accent:#0b0b0d;--fab-warn:#c08e52;--fab-danger:#e0736b;`+
              `--fab-switch-on:#ede8e4;--fab-switch-border-on:#5f5d5c;--fab-thumb:#121212;--fab-thumb-border:#4d4c4a;`+
              // domain: git status
              `--fab-git-added:#7fe0b0;--fab-git-modified:#f2cf7f;--fab-git-deleted:#e0736b;--fab-git-untracked:#8fb8f0;`+
              // domain: diff
              `--fab-diff-added:#14342a;--fab-diff-added-fg:#7fe0b0;--fab-diff-removed:#3a1414;--fab-diff-removed-fg:#f08f8f;`+
              // domain: terminal ANSI (subset)
              `--fab-term-bg:#0f0f0f;--fab-term-fg:#d0d0d0;--fab-term-red:#e0736b;--fab-term-green:#7fe0b0;--fab-term-yellow:#f2cf7f;--fab-term-blue:#8fb8f0;`+
              // domain: context-window breakdown segments
              `--fab-ctx-1:#5bbf9f;--fab-ctx-2:#8fb8f0;--fab-ctx-3:#b9a5f5;--fab-ctx-4:#f2cf7f;--fab-ctx-5:#f0a0c0;--fab-ctx-6:#7fe0b0;--fab-ctx-7:#a0a0a0;`+
            `}`+
            `svg[viewBox="0 0 234 42"]{display:none!important}`+
            `div:has(> svg[viewBox="0 0 234 42"])::before{content:"FABULA-LLM-5";display:block;`+
            `font:800 60px/1 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:2px;`+
            `opacity:.13;text-align:center;margin:0 auto 14px;color:var(--color-text-base,#cfcfd4)}`+
            `[data-fp]{color:transparent!important;position:relative;white-space:nowrap;overflow:hidden}`+
            `[data-fp]::before{content:attr(data-fp);position:absolute;left:0;top:50%;transform:translateY(-50%);`+
            `color:var(--color-text-base,#cfcfd4);font-family:inherit;direction:ltr}`+
            // Cut the legacy Help button (it linked to external vendor pages; removed at source too).
            `[aria-label="Help"],[aria-label="Помощь"]{display:none!important}`+
            `#fabOv,#fabOv *{pointer-events:auto!important}`+
            // Rebrand any visible upstream brand text → "FABULA-LLM-5" via a safe CSS overlay (defensive; sources are already rebranded).
            `[data-ocb]{color:transparent!important;position:relative}`+
            `[data-ocb]::before{content:attr(data-ocb);position:absolute;inset:0;color:var(--color-text-base,#cfcfd4);font:inherit;white-space:inherit;text-align:inherit;direction:ltr}`;
          (document.head||document.documentElement).appendChild(s);
          function t(){try{document.title='FABULA-LLM-5';}catch(e){}}
          t();
          document.addEventListener('DOMContentLoaded',t);
          [500,1500,3500].forEach(function(ms){setTimeout(t,ms);});
          // The Plugins panel shows full file:// URIs for each plugin. Show only the clean basename
          // (like the MCP tab does) via a data-attribute + CSS ::before — we never touch React's text
          // node (that would crash it), only add a safe attribute. Full path stays in the tooltip.
          function fixPaths(){
            try{
              var nodes=document.querySelectorAll('*');
              for(var i=0;i<nodes.length;i++){
                var el=nodes[i];
                if(el.childElementCount!==0)continue;
                var tx=(el.textContent||'').trim();
                if(/\\/(\\.config\\/)?(fabula|mimocode)\\/(plugin|.*\\.ts)/.test(tx)||/file:\\/\\/.*(fabula|mimocode)\\/plugin/.test(tx)){
                  var base=((tx.split('/').pop())||tx).replace(/\\.[tj]sx?$/,'').replace(/^fabula-/,'');
                  if(el.getAttribute('data-fp')!==base){el.setAttribute('data-fp',base);el.title=tx;}
                } else if(tx.indexOf('OpenCode')>=0){
                  var ocb=tx.replace(/OpenCode/g,'FABULA-LLM-5');
                  if(el.getAttribute('data-ocb')!==ocb){el.setAttribute('data-ocb',ocb);}
                }
              }
            }catch(e){}
          }
          var fpQ=false;
          function fpSched(){if(fpQ)return;fpQ=true;setTimeout(function(){fpQ=false;fixPaths();},400);}
          try{new MutationObserver(fpSched).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
          [800,2000,4000].forEach(function(ms){setTimeout(fixPaths,ms);});
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: rebrand, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // Default the embedded web UI to English. The engine auto-detects the language from navigator.language
        // (= the macOS system locale, e.g. Russian) unless a preference is stored. We override navigator's
        // language to English and seed the stored preference ONLY when unset — so an explicit choice in
        // Settings ▸ General ▸ Language still wins and persists (localStorage is not wiped on quit).
        let langDefault = """
        (function(){
          try{var EN=['en-US','en'];
            Object.defineProperty(navigator,'languages',{get:function(){return EN;},configurable:true});
            Object.defineProperty(navigator,'language',{get:function(){return 'en-US';},configurable:true});
          }catch(e){}
          // NOTE: we deliberately do NOT write localStorage 'opencode.global.dat:language' — that key is owned
          // by the Settings ▸ Language picker (the engine's persisted store). Touching it would clobber the user's
          // choice on every launch. The English DEFAULT comes from the navigator override above + the cookie
          // seed below; the picker fully owns and persists any explicit choice (localStorage + oc_locale cookie,
          // neither of which is wiped on quit).
          try{if(!/(^|;\\s*)oc_locale=/.test(document.cookie)){
            document.cookie='oc_locale=en; Path=/; Max-Age=31536000; SameSite=Lax';}
          }catch(e){}
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: langDefault, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // NOTE: the web-injected "Open folder" row inside the engine's "Open project" dialog was REMOVED (it made
        // the dialog look off). Opening an arbitrary folder is done via the native menu File ▸ Open Folder… (⌘O),
        // which calls openFolder() → NSOpenPanel → loads file://…/. The fabulaOpenFolder bridge handler is kept
        // (harmless, unused now) in case we re-add a cleaner entry point later.
        cfg.userContentController.add(self, name: "fabulaOpenFolder")
        // On launch, land on the projects HOME ("Recent projects" — shows ALL projects) instead of being
        // dropped into the last/pinned project. The engine's SPA auto-opens the last project from these two
        // localStorage keys; clearing them at document-start (a FULL page load only — opening a project
        // in-app is SPA navigation and is NOT affected) makes it show the home. Verified: clearing BOTH
        // is required (just one isn't enough). Data is untouched — sessions live in the DB and the home's
        // recent-projects list is server-backed.
        let landHomeJS = """
        (function(){try{
          localStorage.removeItem('opencode.global.dat:globalSync.project');
          localStorage.removeItem('opencode.global.dat:server');
        }catch(e){}})();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: landHomeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // IN-WINDOW Plugins panel: a floating "🧩 Plugins" button opens an overlay listing every plugin
        // with an on/off switch + dependency health, plus Check/Install-deps and Restart-server buttons.
        // It's a self-contained overlay appended to <body> (never touches React's DOM), backed by
        // scripts/manage-cli.ts + install-deps.ts through the fabulaPlugins bridge (see didReceive).
        // Complements the menu-bar Plugins menu for users who expect the control inside the window.
        cfg.userContentController.add(self, name: "fabulaPlugins")
        // System notifications: the web notify() hands {title, body, href} to this bridge.
        cfg.userContentController.add(self, name: "fabulaNotify")
        cfg.userContentController.add(self, name: "fabulaFile")
        // Native folder picker WITH REPLY: the web platform.openDirectoryPickerDialog posts here and
        // awaits the chosen absolute path (or null on cancel). This makes EVERY "choose folder" in the
        // app open the real Finder-style NSOpenPanel (navigate + click + "New Folder"), not a typed
        // path list. Reply-handlers need the WKScriptMessageHandlerWithReply conformance.
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "fabulaPickFolder")
        let pluginsPanelJS = """
        (function(){
          if(window.__fabInit)return; window.__fabInit=1;
          var cbs={},n=0,F="-apple-system,BlinkMacSystemFont,sans-serif",ov,hint,lastLang='';
          window.__fabulaPanelCB=function(id,val){var f=cbs[id];if(f){delete cbs[id];f(val);}};
          function call(a,x){return new Promise(function(res){var id=++n;cbs[id]=res;
            try{window.webkit.messageHandlers.fabulaPlugins.postMessage(Object.assign({action:a,cb:id},x||{}));}catch(e){res('');}});}
          function post(a,x){try{window.webkit.messageHandlers.fabulaPlugins.postMessage(Object.assign({action:a},x||{}));}catch(e){}}
          function E(t,c,x){var e=document.createElement(t);if(c)e.style.cssText=c;if(x!=null)e.textContent=x;return e;}
          function isRu(){
            try{var l=localStorage.getItem('opencode.global.dat:language')||'';if(/ru|рус/i.test(l))return true;if(/en/i.test(l))return false;}catch(e){}
            var b=(document.body&&document.body.innerText)||'';return b.indexOf('Провайдеры')>=0||b.indexOf('Настройки')>=0||b.indexOf('Основные')>=0||b.indexOf('Модели')>=0;
          }
          var TX={ru:{title:'Плагины',head:'Плагины — управление',check:'Проверить зависимости',install:'Доустановить',restart:'↻ Перезапустить сервер',loading:'Загрузка…',fail:'Не удалось загрузить список.',miss:'⚠ не хватает: ',opt:'опционально нет: ',saved:'Сохранено. Нажми «↻ Перезапустить сервер», чтобы применить.',checking:'Проверяю…',installing:'Устанавливаю… это может занять время',restarting:'Перезапуск сервера…',noOff:'Менеджер выключить нельзя',fail2:'Не удалось: ',pmode:'Режим доступа:',pmodeSet:'Режим: '},
                 en:{title:'Plugins',head:'Plugins — manage',check:'Check dependencies',install:'Install missing',restart:'↻ Restart server',loading:'Loading…',fail:'Could not load the list.',miss:'⚠ missing: ',opt:'optional missing: ',saved:'Saved. Click "↻ Restart server" to apply.',checking:'Checking…',installing:'Installing… this can take a while',restarting:'Restarting server…',noOff:'Manager cannot be disabled',fail2:'Failed: ',pmode:'Permission mode:',pmodeSet:'Mode: '}};
          function L(){return isRu()?TX.ru:TX.en;}
          function reportLang(){var l=isRu()?'ru':'en';if(l!==lastLang){lastLang=l;post('lang',{value:l});}}
          function mkbtn(t,fn){var b=E('button','flex:1;background:var(--fab-surface);color:var(--fab-fg);border:none;box-shadow:0 0 0 1px var(--fab-border),0 1px 2px rgba(0,0,0,.08);border-radius:6px;height:32px;padding:0 12px;cursor:pointer;font:500 13px '+F,t);b.__fabClick=fn;return b;}
          function openPanel(){
            var d=L();
            // Re-create the panel if the UI language changed since it was built — otherwise the cached
            // header/buttons would stay in the old language while the rows re-render in the new one.
            if(ov&&ov.__lang!==(isRu()?'ru':'en')){try{ov.remove();}catch(_){}ov=null;}
            if(ov){ov.style.display='flex';load();return;}
            ov=E('div','position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;font:14px '+F+';pointer-events:auto');
            ov.id='fabOv';
            ov.__lang=isRu()?'ru':'en';
            

            var p=E('div','width:600px;max-width:92vw;max-height:88vh;display:flex;flex-direction:column;background:var(--fab-surface);color:var(--fab-fg);border:none;border-radius:10px;box-shadow:0 0 0 1px var(--fab-border),0 36px 80px rgba(0,0,0,.35),0 13px 29px rgba(0,0,0,.25),0 6px 14px rgba(0,0,0,.2);overflow:hidden');
            var h=E('div','display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--fab-border)');
            h.appendChild(E('div','font:500 16px '+F+';color:var(--fab-fg)',d.head));
            var x=E('button','background:none;border:none;color:var(--fab-fg-subtle);font-size:20px;cursor:pointer;line-height:1','×');x.__fabClick=function(){ov.style.display='none';};
            h.appendChild(x);p.appendChild(h);
            hint=E('div','display:none;padding:9px 18px;background:var(--fab-elevated);color:var(--fab-fg-muted);font:12px '+F+';border-bottom:1px solid var(--fab-border)');p.appendChild(hint);
            var body=E('div','padding:4px 14px;overflow:auto;flex:1;overscroll-behavior:contain');body.id='fabBody';body.appendChild(E('div','padding:24px;text-align:center;color:#888',d.loading));p.appendChild(body);
            var out=E('pre','display:none;margin:0;padding:10px 16px;max-height:170px;overflow:auto;background:var(--fab-bg);color:var(--fab-fg-muted);font:11px ui-monospace,Menlo,monospace;white-space:pre-wrap;border-top:1px solid var(--fab-border)');out.id='fabOut';p.appendChild(out);
            // Permission-mode picker (Item 6 surfaced in the UI): default / plan / acceptEdits / bypass.
            var pm=E('div','display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--fab-border)');
            pm.appendChild(E('div','font:600 12px '+F+';color:var(--fab-fg-muted);flex:none',d.pmode));
            var pmWrap=E('div','display:flex;gap:5px;flex-wrap:wrap');
            var MODES=['default','plan','acceptEdits','bypass'];
            function paintModes(cur){Array.prototype.forEach.call(pmWrap.children,function(c){var on=c.getAttribute('data-m')===cur;
              c.style.background=on?'var(--fab-accent)':'transparent';c.style.color=on?'var(--fab-on-accent)':'var(--fab-fg-muted)';c.style.borderColor=on?'var(--fab-accent)':'var(--fab-border)';});}
            MODES.forEach(function(m){var b=E('button','font:600 11px '+F+';padding:3px 9px;border-radius:6px;border:1px solid var(--fab-border);background:transparent;color:var(--fab-fg-muted);cursor:pointer',m);
              b.setAttribute('data-m',m);b.__fabClick=function(){call('pmode',{mode:m}).then(function(s){var mm=m;try{mm=JSON.parse(s).mode;}catch(_){}paintModes(mm);hint.textContent=d.pmodeSet+mm;hint.style.display='block';});};pmWrap.appendChild(b);});
            pm.appendChild(pmWrap);p.appendChild(pm);
            call('pmode',{}).then(function(s){var mm='default';try{mm=JSON.parse(s).mode;}catch(_){}paintModes(mm);});
            var f=E('div','display:flex;gap:9px;padding:12px 16px;border-top:1px solid var(--fab-border)');
            f.appendChild(mkbtn(d.check,function(){deps('check',d.checking);}));
            f.appendChild(mkbtn(d.install,function(){deps('install',d.installing);}));
            f.appendChild(mkbtn(d.restart,function(){call('restart');hint.style.display='none';var o=document.getElementById('fabOut');if(o){o.style.display='block';o.textContent=d.restarting;}}));
            p.appendChild(f);ov.appendChild(p);document.body.appendChild(ov);load();
          }
          // Capability-tag chips — the SAME tags as the session timeline and the README table; styled
          // quiet-monochrome (1px var(--fab-border) ring, muted mono text) to match the app's own design language.
          function row(p){
            var d=L(),ru=isRu();
            var nm=(ru?p.nameRu:p.name)||p.name||p.id;
            var ds=(ru?p.descRu:p.description)||p.description||'';
            var r=E('div','display:flex;align-items:flex-start;gap:12px;padding:12px 6px;border-bottom:1px solid var(--fab-border)');
            var i=E('div','flex:1;min-width:0');
            var tt=E('div','display:flex;align-items:center;gap:7px;flex-wrap:wrap');
            tt.appendChild(E('span','font:500 14px '+F+';color:var(--fab-fg)',nm));
            (p.tags||[]).forEach(function(t){
              tt.appendChild(E('span','font:500 11px ui-monospace,Menlo,monospace;letter-spacing:.2px;padding:1px 7px;border-radius:4px;border:1px solid var(--fab-border);color:var(--fab-fg-muted)',t));});
            i.appendChild(tt);
            i.appendChild(E('div','font:13px '+F+';color:var(--fab-fg-subtle);margin-top:3px;line-height:1.5',ds));
            var warn=p.missingRequired&&p.missingRequired.length,opt=p.missingOptional&&p.missingOptional.length;
            if(warn||opt)i.appendChild(E('div','font:12px '+F+';margin-top:4px;color:'+(warn?'var(--fab-warn)':'var(--fab-fg-subtle)'),warn?d.miss+p.missingRequired.join(', '):d.opt+p.missingOptional.join(', ')));
            r.appendChild(i);
            var on=p.enabled;
            var sw=E('div','width:28px;height:16px;border-radius:3px;flex:none;position:relative;margin-top:3px;cursor:pointer;box-sizing:border-box;transition:background .15s,border-color .15s;border:1px solid '+(on?'var(--fab-switch-border-on)':'var(--fab-border)')+';background:'+(on?'var(--fab-switch-on)':'var(--fab-elevated)'));
            var kn=E('div','position:absolute;top:-1px;left:0;width:16px;height:16px;border-radius:2px;box-sizing:border-box;background:var(--fab-bg);box-shadow:0 1px 2px rgba(0,0,0,.08);transition:transform .15s,border-color .15s;border:1px solid '+(on?'transparent':'var(--fab-thumb-border)')+';transform:translateX('+(on?'12px':'-1px')+')');
            sw.appendChild(kn);
            if(p.id==='manage'){sw.style.opacity='.4';sw.title=d.noOff;}
            else sw.__fabClick=function(){var nv=!on;call('toggle',{id:p.id,enabled:nv}).then(function(s){
              if((s||'').indexOf('\\"ok\\":true')<0){hint.textContent=d.fail2+(s||'').slice(0,140);hint.style.display='block';return;}
              on=nv;sw.style.background=nv?'var(--fab-switch-on)':'var(--fab-elevated)';sw.style.borderColor=nv?'var(--fab-switch-border-on)':'var(--fab-border)';kn.style.transform=nv?'translateX(12px)':'translateX(-1px)';kn.style.borderColor=nv?'transparent':'var(--fab-thumb-border)';hint.textContent=d.saved;hint.style.display='block';});};
            r.appendChild(sw);return r;
          }
          function load(){call('list').then(function(s){var dd;try{dd=JSON.parse(s);}catch(e){dd=null;}
            var body=document.getElementById('fabBody');if(!body)return;body.innerHTML='';
            if(!dd||!dd.plugins){body.appendChild(E('div','padding:20px;color:#f88',L().fail));return;}
            dd.plugins.forEach(function(p){body.appendChild(row(p));});});}
          function deps(kind,msg){var o=document.getElementById('fabOut');o.style.display='block';o.textContent=msg;
            call(kind).then(function(s){o.textContent=s||'—';o.scrollTop=0;if(kind==='install')load();});}
          // Inject a "Plugins" item into the Settings dialog's Kobalte Tabs nav (clone an existing tab's styling).
          function setLabel(node,txt){for(var i=0;i<node.childNodes.length;i++){var c=node.childNodes[i];
            if(c.nodeType===3){if(c.textContent.trim()){c.textContent=txt;return true;}}else if(c.nodeType===1&&setLabel(c,txt))return true;}return false;}
          var PUZZLE='M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z';
          // Enumerate every Kobalte tablist on the page (an ancestor holding >=2 [role=tab]).
          function fabTabLists(){var seen=[],out=[],all=document.querySelectorAll('[role=\\"tab\\"]');
            for(var i=0;i<all.length;i++){var row=all[i];
              while(row.parentElement&&row.parentElement!==document.body&&row.parentElement.querySelectorAll('[role=\\"tab\\"]').length<2)row=row.parentElement;
              var list=row.parentElement;if(list&&seen.indexOf(list)<0){seen.push(list);out.push(list);}}return out;}
          function fabListText(list){var t='',ts=list.querySelectorAll('[role=\\"tab\\"]');for(var i=0;i<ts.length;i++)t+=' '+(ts[i].textContent||'');return t;}
          // The Settings dialog's tablist has these tabs; the top-bar Servers popover has MCP/LSP/Plugins.
          function fabIsSettings(list){return /Провайдеры|Providers|Модели|Models|Основные|General|Горячие|Keyboard/i.test(fabListText(list));}
          function fabIsServer(list){return /\\bMCP\\b/i.test(fabListText(list));}
          // Hide the engine's native raw-name "Plugins" tab in the Servers popover — our Settings ▸ Plugins
          // panel supersedes it (MCP/LSP stay). Style-only → safe, never mutates React's tree.
          function hideNativePlugins(){var lists=fabTabLists();
            for(var i=0;i<lists.length;i++){var list=lists[i];if(!fabIsServer(list))continue;
              var ts=list.querySelectorAll('[role=\\"tab\\"]');
              for(var j=0;j<ts.length;j++){var t=ts[j];if(t.id==='fabNavTab'||(t.closest&&t.closest('#fabNavTab')))continue;
                if(/^\\s*(\\d+\\s*)?(Плагины|Plugins)\\s*$/i.test((t.textContent||'').trim())){
                  var wrap=t;while(wrap.parentElement&&wrap.parentElement!==list)wrap=wrap.parentElement;wrap.style.display='none';
                  var pid=t.getAttribute('aria-controls');if(pid){var pn=document.getElementById(pid);if(pn)pn.style.display='none';}}}}}
          function injectNav(){
            reportLang();
            // The web UI now ships a native ZCode-style Settings ▸ Plugins tab at SOURCE
            // (settings-plugins.tsx + /fabula/plugins engine routes) — no injection needed.
            return;
            hideNativePlugins();
            // Inject ONLY into the Settings dialog's tablist — NEVER the Servers popover (cloning its
            // "Plugins" tab is exactly what produced the "PluginsPlugins" duplicate).
            var lists=fabTabLists(),settings=null;
            for(var i=0;i<lists.length;i++){if(fabIsSettings(lists[i])&&!fabIsServer(lists[i])){settings=lists[i];break;}}
            var ex=document.getElementById('fabNavTab');
            if(ex){if(settings&&ex.parentElement===settings)return;try{ex.remove();}catch(_){}}
            if(!settings)return; // no Settings dialog open → do not inject anywhere
            var tabs=settings.querySelectorAll('[role=\\"tab\\"]');
            var lastBtn=tabs[tabs.length-1];
            // walk lastBtn up to its direct-child-of-settings wrapper (the ROW), clone that
            var row=lastBtn;while(row.parentElement&&row.parentElement!==settings)row=row.parentElement;
            var w=row.cloneNode(true);
            w.id='fabNavTab';try{w.removeAttribute('data-value');}catch(_){}w.style.cursor='pointer';
            var inner=w.querySelector('[role=\\"tab\\"]')||w;
            ['data-selected','aria-selected','aria-controls','id','tabindex'].forEach(function(a){try{inner.removeAttribute(a);}catch(_){}});
            var svg=w.querySelector('svg');   // swap cloned icon for a consistent monochrome line-style puzzle icon
            if(svg){svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.innerHTML='<path d=\\"'+PUZZLE+'\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"/>';}
            if(!setLabel(w,L().title))w.appendChild(document.createTextNode(L().title));
            settings.appendChild(w);
            inner.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();try{inner.setAttribute('data-selected','');}catch(_){}openPanel();});
            for(var i=0;i<tabs.length;i++)tabs[i].addEventListener('click',function(){try{inner.removeAttribute('data-selected');}catch(_){}if(ov)ov.style.display='none';});
          }
          var q=false;function schedule(){if(q)return;q=true;setTimeout(function(){q=false;injectNav();},300);}
          try{new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}
          [800,2000,4000].forEach(function(ms){setTimeout(function(){injectNav();reportLang();},ms);});
          document.addEventListener('DOMContentLoaded',reportLang);

        })();
        """
        // Input isolation for the Plugins panel — MUST be a separate atDocumentStart script.
        // Kobalte's dismiss/focus layers register window/document listeners when the page bundle
        // loads (i.e. before documentEnd); same-phase listeners fire in registration order, so the
        // only way to reliably run FIRST is to register before any page script executes. While the
        // panel overlay (#fabOv) is visible: wheel drives the list's scrollTop directly (native
        // scroll-chaining leaked into the Settings list), presses never propagate past
        // window-capture nor yield focus, and clicks are dispatched through the panel's own
        // el.__fabClick handlers — outer dialog layers never observe the panel's input.
        let panelShieldJS = """
        (function(){
          if(window.__fabShield)return;window.__fabShield=1;
          function ovEl(){var o=document.getElementById('fabOv');return(o&&o.style.display!=='none')?o:null;}
          window.addEventListener('wheel',function(e){
            var ov=ovEl();if(!ov)return;
            e.preventDefault();e.stopPropagation();
            var o=document.getElementById('fabOut');
            var t=(o&&o.style.display!=='none'&&o.contains(e.target))?o:document.getElementById('fabBody');
            if(t)t.scrollTop+=e.deltaY;
          },{passive:false,capture:true});
          function guard(e){
            var ov=ovEl();if(!ov||!ov.contains(e.target))return;
            e.stopPropagation();
            var tid=e.target&&e.target.id;
            if((e.type==='pointerdown'||e.type==='mousedown')&&tid!=='fabBody'&&tid!=='fabOut')e.preventDefault();
            if(e.type==='click'){
              e.preventDefault();
              var n=e.target;
              while(n){if(n.__fabClick){n.__fabClick(e);return;}if(n===ov)break;n=n.parentElement;}
              if(e.target===ov)ov.style.display='none';
            }
          }
          ['pointerdown','mousedown','pointerup','mouseup','touchstart','click','focusin'].forEach(function(t){
            window.addEventListener(t,guard,{capture:true});
          });
        })();
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: panelShieldJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.addUserScript(
            WKUserScript(source: pluginsPanelJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        webView = WKWebView(frame: rect, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        applyZoom() // restore the persisted ⌘±/⌘0 interface scale
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        showLoading("Starting FABULA-LLM-5…")
    }

    func showLoading(_ msg: String) {
        let html = """
        <html><body style="background:#0b0b0d;color:#cfcfd4;font:16px -apple-system;
        display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
        <div style="text-align:center"><div style="font-size:22px;margin-bottom:8px">FABULA-LLM-5</div>
        <div style="opacity:.7">\(msg)</div></div></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func startBackend() {
        // SearXNG (shared infra) — start if down, leave running.
        if !portListening(8888) && FileManager.default.fileExists(atPath: SEARXNG_START) {
            shell("nohup bash '\(SEARXNG_START)' >/tmp/searxng.log 2>&1 &")
        }
        // Reuse a server that is already up (fast, no churn, no extra folder-access prompts);
        // only start our own if none is running.
        if portListening(PORT) { engineProc = nil; return }
        startServer()
    }

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        // MIMOCODE_GIT_DENYLIST (engine flag, replaces the old blanket MIMOCODE_DISABLE_GIT):
        // the engine's git/snapshot walks are unbearably slow on giant worktrees (~/GitHub,
        // tens of thousands of files — 14s per open). Denylisting just those paths keeps them
        // instant while every normal project gets full git: per-turn file diffs, the
        // "N files changed · Undo" bar, Review turn diffs and message revert.
        // Source ~/GitHub/FABULA-LLM-5/.env so ANY of the engine's 112 built-in providers lights up
        // when its API key is present (ZHIPU_API_KEY→zai-coding-plan, NVIDIA_API_KEY→nvidia,
        // OPENAI/GROQ/DEEPSEEK/…). Drop a key in .env → that provider works.
        // Local models need no key — the engine auto-discovers anything loaded in LM Studio / Ollama.
        let dotenv = "\(PROJECT_DIR)/.env"
        // Point the engine at FABULA's renamed config + config dir (the engine's default names are
        // mimocode.json/.mimocode; FABULA ships fabula.config.json + .fabula, loaded via these env
        // contracts — MIMOCODE_CONFIG loads any config path, MIMOCODE_CONFIG_DIR adds a project config
        // dir, FABULA_SKILLS_DIR is where save_skill writes). No mimo-named file ships in the repo.
        let cfgFile = "\(PROJECT_DIR)/fabula.config.json"
        let cfgDir = "\(PROJECT_DIR)/.fabula"
        p.arguments = ["-lc", PATH_PREFIX + "set -a; [ -f '\(dotenv)' ] && . '\(dotenv)'; set +a; mkdir -p '\(WORKSPACE_DIR)'; cd '\(WORKSPACE_DIR)'; export MIMOCODE_GIT_DENYLIST=\"$HOME/GitHub\"; export MIMOCODE_DISABLE_CLAUDE_IMPORT=1; export MIMOCODE_EXPERIMENTAL_LSP_TOOL=1; export FABULA_TOOL_ROUTER=\"${FABULA_TOOL_ROUTER:-1}\"; export FABULA_AUTO_GOAL=\"${FABULA_AUTO_GOAL:-1}\"; export MIMOCODE_CONFIG='\(cfgFile)'; export MIMOCODE_CONFIG_DIR='\(cfgDir)'; export FABULA_SKILLS_DIR=\"${FABULA_SKILLS_DIR:-\(cfgDir)/skills}\"; ENG=\(ENGINE); exec \"$ENG\" serve --port \(PORT) --hostname 127.0.0.1"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); engineProc = p } catch { engineProc = nil }
    }

    // Poll the DB-FREE /global/health route off the main thread with an ABSOLUTE wall-clock
    // deadline. On health 200 → load the UI (`/`). If health never answers within the deadline,
    // stop polling and show an actionable failure screen — never an endless spinner.
    func startPolling() { startupBegan = Date(); startupFailed = false; checkReady(0) }
    func checkReady(_ attempt: Int) {
        if startupFailed { return }
        guard let health = URL(string: HEALTHURL), let ui = URL(string: URLSTR) else { return }
        if let began = startupBegan, Date().timeIntervalSince(began) > STARTUP_DEADLINE {
            startupFailed = true
            showStartupFailure()
            return
        }
        var req = URLRequest(url: health); req.timeoutInterval = 3; req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        URLSession.shared.dataTask(with: req) { [weak self] _, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if self.startupFailed { return }
                if let h = resp as? HTTPURLResponse, h.statusCode == 200 {
                    self.navRetries = 0
                    self.webView.load(URLRequest(url: ui))
                } else {
                    if attempt == 8 { self.showLoading("Starting the local server… this can take a moment.") }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { self.checkReady(attempt + 1) }
                }
            }
        }.resume()
    }

    // Shown when the engine never becomes healthy within STARTUP_DEADLINE — an actionable screen
    // (restart / copy diagnostics / reboot advice) instead of an endless "Starting…" spinner.
    func showStartupFailure() {
        let deadline = Int(STARTUP_DEADLINE)
        let html = """
        <html><body style="background:#0b0b0d;color:#cfcfd4;font:15px/1.5 -apple-system;
        display:flex;height:100vh;align-items:center;justify-content:center;margin:0;text-align:center">
        <div style="max-width:520px;padding:0 24px">
          <div style="font-size:22px;margin-bottom:10px">FABULA-LLM-5</div>
          <div style="opacity:.85;margin-bottom:6px">Не удалось запустить локальный сервер за \(deadline)&nbsp;с.</div>
          <div style="opacity:.6;font-size:13px;margin-bottom:20px">Обычно помогает перезапуск движка. Если повторяется — в системе могли остаться «залипшие» процессы движка (их снимает только перезагрузка Mac).</div>
          <button onclick="R()" style="background:#e08a2e;color:#111;border:0;border-radius:8px;padding:10px 18px;font:600 14px -apple-system;cursor:pointer;margin:4px">Перезапустить движок</button>
          <button onclick="D()" style="background:#26262b;color:#cfcfd4;border:0;border-radius:8px;padding:10px 18px;font:600 14px -apple-system;cursor:pointer;margin:4px">Скопировать диагностику</button>
          <div id="d" style="opacity:.45;font-size:11px;margin-top:18px;white-space:pre-wrap;user-select:text"></div>
        </div>
        <script>
          function R(){try{window.webkit.messageHandlers.fabulaPlugins.postMessage({action:'restart'});}catch(e){}}
          var diag='FABULA startup timeout: :\(PORT)/global/health did not return 200 within \(deadline)s';
          function D(){try{navigator.clipboard.writeText(diag);}catch(e){}document.getElementById('d').textContent=diag;}
        </script>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    @objc func restartServer() {
        // SIGKILL the engine's MCP children BEFORE killing the engine — else the orphaned Python stdio
        // MCP servers hit stdin EOF and crash in interpreter finalization (see applicationWillTerminate),
        // popping a "Python quit unexpectedly" dialog on every ⌘⇧R.
        for pid in shellOut("lsof -ti tcp:\(PORT) 2>/dev/null").split(whereSeparator: { $0.isNewline }) {
            shell("pkill -9 -P \(pid) >/dev/null 2>&1")
        }
        shell("lsof -ti tcp:\(PORT) | xargs kill -9 >/dev/null 2>&1")
        engineProc = nil
        showLoading("Restarting server…")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            self?.startServer()
            self?.startPolling()
        }
    }

    // ── Web→native bridge input allowlists (SECURITY: these values are interpolated into a shell) ──
    static let PMODES: Set<String> = ["default", "plan", "acceptEdits", "bypass"]
    static func isSafePluginId(_ s: String) -> Bool {
        // plugin ids are kebab/underscore tokens (e.g. "reproduce-gate", "change-quiz"); no shell metachars.
        return !s.isEmpty && s.count <= 64 && s.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }

    /// Is a URL the trusted local engine origin (http://127.0.0.1:<PORT>)?
    static func isTrustedOrigin(_ url: URL) -> Bool {
        return url.scheme?.lowercased() == "http" && url.host == "127.0.0.1" && (url.port ?? 80) == PORT
    }

    // SECURITY (origin lock): the app webview hosts the trusted engine UI AND the native bridges
    // (fabulaPlugins/pmode/pickFolder/notify). If it ever navigated to an off-origin page, that page
    // could postMessage into those bridges. Keep navigation on the local origin; send any external
    // link to the real browser instead of loading it into this privileged webview.
    func webView(_ wv: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.allow); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if Self.isTrustedOrigin(url) || scheme == "about" || scheme == "blob" || scheme == "data" || scheme == "file" {
            decisionHandler(.allow); return
        }
        if scheme == "http" || scheme == "https" { NSWorkspace.shared.open(url) } // external → real browser
        decisionHandler(.cancel)
    }

    // Open target=_blank links: same-origin in this view, EXTERNAL links in the real browser (never in
    // this privileged webview — see the origin-lock note above).
    func webView(_ wv: WKWebView, createWebViewWith config: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.isTrustedOrigin(url) { wv.load(URLRequest(url: url)) }
            else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // WKWebView does NOT open an HTML <input type="file"> picker unless the app provides this. Without it
    // the "Attach file (⌘U)" button silently does nothing. Show the native macOS picker
    // and hand the chosen files back to the page.
    func webView(_ wv: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { resp in completionHandler(resp == .OK ? panel.urls : nil) }
    }

    // WKWebView also silently ignores JS alert()/confirm()/prompt() unless these are implemented.
    // The "All chats" panel uses prompt() (Rename) and confirm() (Delete), so wire them to native NSAlerts.
    func webView(_ wv: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.runModal(); completionHandler()
    }
    func webView(_ wv: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ wv: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        tf.stringValue = defaultText ?? ""
        a.accessoryView = tf
        completionHandler(a.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
    }

    // If the page fails to load (server still warming up), retry a few times.
    var navRetries = 0
    // L0 startup watchdog state: absolute deadline so an engine that never becomes healthy shows an
    // actionable failure screen instead of an endless "Starting the local server" spinner.
    var startupBegan: Date? = nil
    var startupFailed = false
    let STARTUP_DEADLINE: TimeInterval = 25
    func retryLoad() {
        guard navRetries < 15 else { showLoading("Could not reach the local server on :\(PORT)."); return }
        navRetries += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            guard let u = URL(string: URLSTR) else { return }
            self?.webView.load(URLRequest(url: u))
        }
    }
    func webView(_ wv: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webView(_ wv: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webView(_ wv: WKWebView, didFinish navigation: WKNavigation!) { navRetries = 0 }

    // Full native menu bar (reference-client parity): App / File / Edit (with Undo-Redo) /
    // View (zoom + full screen) / Plugins / Window / Help.
    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About FABULA", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        // Restart Server on ⌘⌥R (option, NOT shift): ⌘⇧R was unreliable — it collided with the "Reload"
        // item's "r" key and/or was swallowed by the web UI before the native menu saw it.
        let rs = NSMenuItem(title: "Restart Server", action: #selector(restartServer), keyEquivalent: "r")
        rs.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(rs)
        let snap = NSMenuItem(title: "Save UI Snapshot", action: #selector(saveSnapshot), keyEquivalent: "s")
        snap.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(snap)
        let wipe = NSMenuItem(title: "Clear Cached Chat Data", action: #selector(clearCachedChatData), keyEquivalent: "k")
        wipe.keyEquivalentModifierMask = [.command, .shift]
        appMenu.addItem(wipe)
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide FABULA-LLM-5", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit FABULA-LLM-5", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // File — new session (forwarded into the webview), native folder picker, close window.
        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "New Session", action: #selector(newSession), keyEquivalent: "n")
        // Native folder picker — browse to choose ANY folder as a project, or use the dialog's
        // "New Folder" button to CREATE one. The engine's web "Open project" only offers a text search.
        file.addItem(withTitle: "Open Folder…", action: #selector(openFolder), keyEquivalent: "o")
        file.addItem(NSMenuItem.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        // Edit — undo/redo first (first-responder selectors reach the WKWebView), then clipboard.
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(redo)
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        // View — reload, zoom (persisted), full screen.
        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(NSMenuItem.separator())
        view.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        view.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        view.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        view.addItem(NSMenuItem.separator())
        let fs = NSMenuItem(
            title: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(fs)
        viewItem.submenu = view

        // Plugins menu — enable/disable each FABULA plugin (✓ = on) + install/check dependencies.
        // Rebuilt from scripts/manage-cli.ts every time it opens (NSMenuDelegate).
        let plugItem = NSMenuItem(); main.addItem(plugItem)
        let plugMenu = NSMenu(title: "Plugins")
        plugMenu.delegate = self
        self.pluginsMenu = plugMenu
        plugItem.submenu = plugMenu
        plugItem.title = "Plugins"
        rebuildPluginsMenu()

        // Standard Window menu (Minimize / Zoom / Bring All to Front).
        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(NSMenuItem.separator())
        window.addItem(
            withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = window
        NSApp.windowsMenu = window

        // Help — about + quick access to the engine logs folder.
        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "About FABULA", action: #selector(showAbout), keyEquivalent: "")
        help.addItem(withTitle: "Check for Updates…", action: #selector(checkUpdates), keyEquivalent: "")
        help.addItem(withTitle: "Export Logs (Finder)", action: #selector(revealLogs), keyEquivalent: "")
        helpItem.submenu = help
        NSApp.helpMenu = help

        NSApp.mainMenu = main
    }

    @objc func showAbout() { NSApp.orderFrontStandardAboutPanel(nil) }

    // Source-managed build: no update feed to poll — report the running versions and point to
    // the rebuild path instead of silently doing nothing.
    @objc func checkUpdates() {
        let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "?"
        var engineVersion = "?"
        if let out = try? runCapture("/opt/homebrew/bin/mimo --version") {
            engineVersion = out.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let alert = NSAlert()
        alert.messageText = "FABULA \(appVersion)"
        alert.informativeText = "Движок: \(engineVersion)\n\nЭта сборка управляется исходниками — обновление выполняется пересборкой (см. README проекта). Автоматической проверки обновлений нет by design."
        alert.alertStyle = .informational
        alert.runModal()
    }

    private func runCapture(_ command: String) throws -> String {
        let task = Process()
        task.launchPath = "/bin/zsh"
        task.arguments = ["-c", command]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        try task.run()
        task.waitUntilExit()
        return String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    @objc func revealLogs() {
        let dir = NSString(string: "~/.local/share/fabula/log").expandingTildeInPath
        NSWorkspace.shared.open(URL(fileURLWithPath: dir, isDirectory: true))
    }

    // File ▸ New Session forwards ⌘N into the web UI's global command (session.new.global).
    @objc func newSession() {
        let js = "document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:true,bubbles:true}))"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // View ▸ Zoom — WKWebView.pageZoom, persisted across launches.
    var zoomLevel: CGFloat = {
        let saved = UserDefaults.standard.double(forKey: "fabulaZoom")
        return saved > 0 ? CGFloat(saved) : 1.0
    }()

    func applyZoom() {
        webView?.pageZoom = zoomLevel
        UserDefaults.standard.set(Double(zoomLevel), forKey: "fabulaZoom")
    }

    @objc func zoomIn() {
        zoomLevel = min(2.0, zoomLevel + 0.1)
        applyZoom()
    }

    @objc func zoomOut() {
        zoomLevel = max(0.5, zoomLevel - 0.1)
        applyZoom()
    }

    @objc func zoomReset() {
        zoomLevel = 1.0
        applyZoom()
    }

    @objc func reload() { webView.reload() }

    // Save a pixel-perfect PNG of the current UI (WKWebView.takeSnapshot needs no screen-recording
    // permission — it renders the web view itself). Used for documentation screenshots.
    @objc func saveSnapshot() {
        let cfg = WKSnapshotConfiguration()
        webView.takeSnapshot(with: cfg) { img, _ in
            guard let img = img, let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: URL(fileURLWithPath: "/tmp/fabula-ui.png"))
        }
    }

    // Open a folder as a project via the native macOS picker (Finder-style; its "New Folder"
    // button lets you CREATE a project too). The engine opens any folder at /<base64url(path)>/session,
    // verified empirically — so we just navigate the webview there.
    @objc func openFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = "Open Project"
        panel.message = "Choose (or create) a folder to open as a FABULA project"
        guard panel.runModal() == .OK, let dir = panel.url else { return }
        let b64url = Data(dir.path.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        guard let u = URL(string: "\(URLSTR)\(b64url)/session") else { return }
        webView.load(URLRequest(url: u))
    }

    // Native folder picker that RETURNS the chosen path to JS (async reply). Used by
    // platform.openDirectoryPickerDialog so every "choose folder" surface (workspace chip, Home,
    // sidebar Open project, onboarding, plugin import) opens the real Finder-style panel and the
    // caller decides what to do with the path.
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "fabulaPickFolder" else { replyHandler(nil, "unknown"); return }
        let body = message.body as? [String: Any]
        let multiple = (body?["multiple"] as? Bool) ?? false
        let title = (body?["title"] as? String) ?? ""
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = multiple
        panel.canCreateDirectories = true
        panel.prompt = "Open"
        if !title.isEmpty { panel.message = title }
        if panel.runModal() == .OK {
            let paths = panel.urls.map { $0.path }
            if multiple { replyHandler(paths, nil) } else { replyHandler(paths.first as Any?, nil) }
        } else {
            replyHandler(nil, nil) // cancel → null, not an error
        }
    }

    // Bridge: the injected "Open Folder" row in the web dialog posts here → show the native picker.
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "fabulaOpenFolder" { openFolder(); return }
        // File actions bridge: the web file context menu posts {action: "reveal"|"openExternal", path}.
        if message.name == "fabulaFile" {
            guard let b = message.body as? [String: Any],
                  let action = b["action"] as? String,
                  let path = b["path"] as? String, !path.isEmpty else { return }
            let url = URL(fileURLWithPath: path)
            switch action {
            case "reveal": NSWorkspace.shared.activateFileViewerSelecting([url])
            case "openExternal": NSWorkspace.shared.open(url)
            default: break
            }
            return
        }
        // System notifications bridge: the web UI's notify() posts {title, body, href} here.
        // Delivered via UNUserNotificationCenter; clicking deep-links the webview back to href.
        if message.name == "fabulaNotify" {
            guard let b = message.body as? [String: Any] else { return }
            let title = (b["title"] as? String) ?? "FABULA"
            let body = (b["body"] as? String) ?? ""
            let href = (b["href"] as? String) ?? ""
            deliverNotification(title: title, body: body, href: href)
            if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }
            return
        }
        // In-window Plugins panel bridge: run scripts/manage-cli.ts / install-deps.ts and hand the raw
        // output back to the injected panel via window.__fabulaPanelCB(cb, result). Shell-outs block, so
        // they run off the main thread; the JS callback is invoked back on the main thread.
        if message.name == "fabulaPlugins" {
            guard let b = message.body as? [String: Any], let action = b["action"] as? String else { return }
            if action == "restart" { restartServer(); return }
            if action == "lang" {
                if let v = b["value"] as? String, v != uiLang {
                    uiLang = v; UserDefaults.standard.set(v, forKey: "fabulaLang")
                    DispatchQueue.main.async { self.rebuildPluginsMenu() }
                }
                return
            }
            guard let cb = b["cb"] as? Int else { return }
            let id = (b["id"] as? String) ?? ""
            let enabled = (b["enabled"] as? Bool) ?? false
            let mc = "bun '\(PROJECT_DIR)/scripts/manage-cli.ts'"
            let ins = "bun '\(PROJECT_DIR)/scripts/install-deps.ts'"
            let cmd: String
            let mode = (b["mode"] as? String) ?? ""
            let dir = (b["dir"] as? String)?.replacingOccurrences(of: "'", with: "") ?? ""
            // SECURITY: web-supplied values reach /bin/bash -lc. A single quote in `id`/`mode` would
            // break out of the quoting → arbitrary shell (RCE) from any origin the webview can reach.
            // Validate against strict allowlists; a malformed value drops the request (never shells).
            switch action {
            case "list":    cmd = "\(mc) list --json 2>/dev/null"
            case "toggle":
                guard Self.isSafePluginId(id) else { return }
                cmd = "\(mc) \(enabled ? "enable" : "disable") '\(id)' 2>&1"
            case "check":   cmd = "\(ins) --list 2>&1"
            case "install": cmd = "\(ins) --all 2>&1 | tail -60"
            case "pmode":
                guard mode.isEmpty || Self.PMODES.contains(mode) else { return }
                cmd = "\(mc) pmode \(mode.isEmpty ? "" : "'\(mode)'") 2>/dev/null"
            case "git":     cmd = dir.isEmpty ? "echo '{\\\"repo\\\":false}'" : "bash '\(PROJECT_DIR)/scripts/git-status.sh' '\(dir)' 2>/dev/null"
            default: return
            }
            DispatchQueue.global(qos: .userInitiated).async {
                let out = stripAnsi(shellOut(cmd))
                // Encode the arbitrary output as a JSON string literal so it injects safely into JS.
                let arr = (try? JSONSerialization.data(withJSONObject: [out])).flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
                DispatchQueue.main.async {
                    self.webView.evaluateJavaScript("window.__fabulaPanelCB(\(cb), \(arr)[0])", completionHandler: nil)
                }
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    // Privacy: wipe WebKit's on-disk cache / IndexedDB / service-worker / offline residue (where
    // chat response bodies could otherwise be recovered) while KEEPING localStorage — that holds
    // only lightweight UI state (last project, layout), so the last session still restores.
    func wipeWebCache(blocking: Bool) {
        let types: Set<String> = [
            WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeOfflineWebApplicationCache, WKWebsiteDataTypeIndexedDBDatabases,
            WKWebsiteDataTypeServiceWorkerRegistrations,
        ]
        var done = false
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { done = true }
        if blocking {
            // removeData's completion fires on the main queue, so we PUMP the run loop (a semaphore
            // would deadlock) until it finishes, capped so quitting can't hang.
            let deadline = Date().addingTimeInterval(5)
            while !done && Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
        }
    }

    // Explicit privacy control: drop cached chat data now (live sessions stay in the DB; reload re-fetches).
    @objc func clearCachedChatData() { wipeWebCache(blocking: false); webView.reload() }

    // ── Plugins menu (manage plugins right here, at any time) ───────────────────────────────────────────
    func menuNeedsUpdate(_ menu: NSMenu) { if menu === pluginsMenu { rebuildPluginsMenu() } }

    @objc func rebuildPluginsMenu() {
        guard let menu = pluginsMenu else { return }
        menu.removeAllItems()
        let json = shellOut("bun '\(PROJECT_DIR)/scripts/manage-cli.ts' list --json --fast 2>/dev/null")
        let ru = uiLang == "ru"
        if let d = json.data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
           let plugins = obj["plugins"] as? [[String: Any]] {
            menu.addItem(withTitle: ru ? "Нажмите на плагин, чтобы включить/выключить:" : "Click a plugin to turn it on/off:", action: nil, keyEquivalent: "").isEnabled = false
            for p in plugins {
                let id = p["id"] as? String ?? ""
                let name = ((ru ? p["nameRu"] : p["name"]) as? String) ?? (p["name"] as? String ?? id)
                let desc = ((ru ? p["descRu"] : p["description"]) as? String) ?? ""
                let tags = (p["tags"] as? [String] ?? []).joined(separator: " · ")
                let on = p["enabled"] as? Bool ?? true
                let it = NSMenuItem(title: tags.isEmpty ? name : "\(name)  [\(tags)]", action: #selector(togglePlugin(_:)), keyEquivalent: "")
                it.state = on ? .on : .off
                it.representedObject = id
                it.target = self
                if !desc.isEmpty { it.toolTip = desc }   // hover to see what the plugin is for
                menu.addItem(it)
            }
        } else {
            menu.addItem(withTitle: ru ? "(не удалось загрузить плагины — установлен ли bun?)" : "(could not load plugins — is bun installed?)", action: nil, keyEquivalent: "")
        }
        menu.addItem(.separator())
        let chk = NSMenuItem(title: ru ? "Проверить зависимости…" : "Check dependencies…", action: #selector(checkAllDeps), keyEquivalent: ""); chk.target = self; menu.addItem(chk)
        let ins = NSMenuItem(title: ru ? "Доустановить недостающие…" : "Install missing dependencies…", action: #selector(installAllDeps), keyEquivalent: ""); ins.target = self; menu.addItem(ins)
    }

    @objc func togglePlugin(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        let nowOn = sender.state == .on
        let out = shellOut("bun '\(PROJECT_DIR)/scripts/manage-cli.ts' \(nowOn ? "disable" : "enable") '\(id)' 2>&1")
        rebuildPluginsMenu()
        let ru = uiLang == "ru"
        if out.contains("cannot disable") {
            let a = NSAlert(); a.messageText = ru ? "Менеджер плагинов нельзя выключить." : "The plugin manager can't be disabled."; a.runModal(); return
        }
        let a = NSAlert()
        a.messageText = ru ? "Плагин «\(id)» \(nowOn ? "выключен" : "включён")." : "Plugin \"\(id)\" \(nowOn ? "disabled" : "enabled")."
        a.informativeText = ru ? "Перезапустить сервер, чтобы применить изменение?" : "Restart the server to apply the change?"
        a.addButton(withTitle: ru ? "Перезапустить" : "Restart now"); a.addButton(withTitle: ru ? "Позже" : "Later")
        if a.runModal() == .alertFirstButtonReturn { restartServer() }
    }

    @objc func checkAllDeps() {
        let out = shellOut("bun '\(PROJECT_DIR)/scripts/install-deps.ts' --list 2>&1")
        let a = NSAlert(); a.messageText = "Plugin dependencies"
        a.informativeText = out.isEmpty ? "Could not run the checker (is bun installed?)." : stripAnsi(out)
        a.runModal()
    }

    @objc func installAllDeps() {
        let confirm = NSAlert()
        confirm.messageText = "Install missing dependencies?"
        confirm.informativeText = "Installs every plugin's missing dependencies (required + optional). May download packages and take a while."
        confirm.addButton(withTitle: "Install"); confirm.addButton(withTitle: "Cancel")
        if confirm.runModal() != .alertFirstButtonReturn { return }
        let out = shellOut("bun '\(PROJECT_DIR)/scripts/install-deps.ts' --all 2>&1 | tail -40")
        let a = NSAlert(); a.messageText = "Dependency install finished"
        a.informativeText = stripAnsi(out).isEmpty ? "(no output)" : stripAnsi(out)
        a.runModal()
        rebuildPluginsMenu()
    }

    func applicationWillTerminate(_ note: Notification) {
        // 1) Wipe the webview's cached chat residue before we die (blocks briefly, capped at 5s).
        wipeWebCache(blocking: true)
        // 2) Stop the engine server on OUR port — whether WE started it OR reused an orphan left by a
        // previous launch. This is the fix for "I relaunched but my plugin/config change didn't apply":
        // before, a reused server (engineProc == nil) survived quit, so the next launch re-attached to the
        // STALE server (old plugins) via the `portListening(PORT)` reuse path. Now every quit frees :4096,
        // so the next launch always starts a FRESH server that loads the current plugins. Never touches
        // SearXNG (:8888) or any browser — only our own port.
        // Kill the engine's MCP subprocess children with SIGKILL BEFORE we tear the engine down. A
        // graceful stop — SIGTERM, or the engine closing their stdin as it exits — lets a Python stdio
        // MCP server (ast-grep-server, time-stdio) run interpreter finalization (Py_FinalizeEx), which
        // aborts with SIGABRT on the daemon-thread buffered-I/O lock race → the recurring "Python quit
        // unexpectedly" dialog after every quit. SIGKILL skips finalization entirely, so no crash
        // report. Cover both the engine WE started and a reused orphan found on our port.
        for pid in shellOut("lsof -ti tcp:\(PORT) 2>/dev/null").split(whereSeparator: { $0.isNewline }) {
            shell("pkill -9 -P \(pid) >/dev/null 2>&1")
        }
        if let p = engineProc, p.isRunning {
            shell("pkill -9 -P \(p.processIdentifier) >/dev/null 2>&1")
            p.terminate()
        }
        shell("lsof -ti tcp:\(PORT) | xargs kill -9 >/dev/null 2>&1")
        // 3) We own the DB, so once it closes we securely erase any deleted-chat residue (orphan
        // rows, FTS segments, freed pages via secure_delete+VACUUM, session memory, logs). Run
        // detached so quitting stays responsive; it waits for the port to free first. Runs even if
        // the server was already down, so a stale-residue scrub still happens.
        let purge = "\(PROJECT_DIR)/app/fabula-purge.sh"
        if FileManager.default.fileExists(atPath: purge) {
            shell("nohup bash -c 'for i in $(seq 1 40); do lsof -nP -iTCP:\(PORT) -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done; sleep 1; \"\(purge)\" >/tmp/fabula-purge.log 2>&1' >/dev/null 2>&1 &")
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
