#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
mod cli;
mod scanner;
mod store;
mod system;

use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use store::{error, AppError, AppResult};
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Icon, WindowBuilder},
};
use wry::{WebContext, WebViewBuilder, WebViewBuilderExtWindows};
const TITLE: &str = "栖点 · 本地项目";
fn option(args: &[String], key: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| pair[1].clone())
}
fn data_directory(args: &[String]) -> PathBuf {
    option(args, "--data-dir")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALSPACE_DATA_DIR").map(PathBuf::from))
        .unwrap_or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("LocalSpace")
        })
}
fn legacy_file(executable: &Path) -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let mut roots = vec![cwd];
    if let Some(parent) = executable.parent() {
        roots.extend(parent.ancestors().take(4).map(Path::to_path_buf))
    }
    roots
        .into_iter()
        .map(|root| root.join(".localspace").join("workspace.json"))
        .find(|p| p.is_file())
}
fn native_icon() -> Icon {
    let mut bytes = vec![0u8; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let inside = (5..27).contains(&x) && (9..25).contains(&y);
            let edge = inside && (!(7..25).contains(&x) || !(11..23).contains(&y));
            let tab = (6..15).contains(&x) && (6..10).contains(&y);
            if edge || tab {
                let index = (y * 32 + x) * 4;
                bytes[index..index + 4].copy_from_slice(&[54, 61, 72, 255])
            }
        }
    }
    Icon::from_rgba(bytes, 32, 32).unwrap()
}
fn report(error: &AppError, interactive: bool) {
    eprintln!("{}", json!({"error":error.1}));
    if interactive {
        rfd::MessageDialog::new()
            .set_title("栖点")
            .set_description(&error.1)
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
}
fn bootstrap(args: &[String], directory: &Path, executable: &Path) -> AppResult<(String, bool)> {
    let port = option(args, "--port")
        .or_else(|| std::env::var("LOCALSPACE_PORT").ok())
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(4319);
    let preferred = format!("http://127.0.0.1:{port}");
    if port != 0 {
        if let Ok(health) = cli::request(&preferred, "/api/health", "GET", None, "") {
            if health["desktop"] == true {
                return Ok((preferred, false));
            }
        }
    }
    let server = tiny_http::Server::http(format!("127.0.0.1:{port}")).map_err(|_| {
        error(format!(
            "本地端口 {port} 已被占用，请关闭其他栖点实例后重试。"
        ))
    })?;
    let actual_port = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| error("无法确定本地服务地址。"))?
        .port();
    let migration = if option(args, "--data-dir").is_none()
        && std::env::var_os("LOCALSPACE_DATA_DIR").is_none()
    {
        legacy_file(executable)
    } else {
        None
    };
    let workspace = migration
        .as_ref()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .or_else(|| executable.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let root = workspace.parent().unwrap_or(&workspace);
    let store = store::Store::open(directory, root, migration.as_deref())?;
    let app = Arc::new(api::NativeApp::new(
        store,
        actual_port,
        directory.to_path_buf(),
        executable.to_path_buf(),
        workspace,
    ));
    let url = format!("http://127.0.0.1:{actual_port}");
    std::fs::write(
        directory.join("session.json"),
        json!({"url":url,"pid":std::process::id(),"version":"1.1.0"}).to_string(),
    )
    .map_err(|_| error("无法保存本机会话信息。"))?;
    std::thread::spawn(move || api::serve(server, app));
    Ok((url, true))
}
fn clean_session(directory: &Path) {
    let session = directory.join("session.json");
    let value: Value = std::fs::read_to_string(&session)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(json!({}));
    if value["pid"] == std::process::id() {
        let _ = std::fs::remove_file(session);
    }
}
fn show_window(url: String, directory: PathBuf, owns_server: bool, verify: bool) -> AppResult<()> {
    let event_loop = EventLoopBuilder::<bool>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_visible(!verify)
        .with_title(TITLE)
        .with_inner_size(LogicalSize::new(1140.0, 760.0))
        .with_min_inner_size(LogicalSize::new(740.0, 500.0))
        .with_window_icon(Some(native_icon()))
        .build(&event_loop)
        .map_err(|e| error(format!("无法创建桌面窗口：{e}")))?;
    let mut context = WebContext::new(Some(directory.join("WebView2")));
    let origin = url.clone();
    let verification_script = if verify {
        r#"window.addEventListener('DOMContentLoaded',()=>{let count=0;const timer=setInterval(()=>{const search=document.querySelector('#project-search');if(search){clearInterval(timer);window.ipc.postMessage(JSON.stringify({ok:true,nativeWindowRendered:true,title:document.querySelector('h1')?.textContent,rows:document.querySelectorAll('.project-row').length}));}else if(++count>150){clearInterval(timer);window.ipc.postMessage(JSON.stringify({ok:false,error:'Native view did not finish loading'}));}},100);});"#
    } else {
        ""
    };
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(&url)
        .with_initialization_script(verification_script)
        .with_ipc_handler(move |request| {
            if verify {
                let result: Value =
                    serde_json::from_str(request.body()).unwrap_or(json!({"ok":false}));
                let ok = result["ok"] == true;
                println!("{result}");
                let _ = proxy.send_event(ok);
            }
        })
        .with_background_color((255, 255, 255, 255))
        .with_devtools(false)
        .with_default_context_menus(false)
        .with_browser_accelerator_keys(true)
        .with_navigation_handler(move |target| {
            url::Url::parse(&target)
                .ok()
                .is_some_and(|value| value.origin().ascii_serialization() == origin)
        })
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .build(&window)
        .map_err(|e| {
            error(format!(
                "无法打开界面，请确认 Microsoft Edge WebView2 Runtime 已安装。\n{e}"
            ))
        })?;
    event_loop.run(move |event, _, control_flow| {
        let _ = &webview;
        let _ = &window;
        *control_flow = ControlFlow::Wait;
        if let Event::UserEvent(ok) = event {
            if owns_server {
                clean_session(&directory)
            }
            *control_flow = ControlFlow::ExitWithCode(if ok { 0 } else { 1 });
        }
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            if owns_server {
                clean_session(&directory)
            }
            *control_flow = ControlFlow::Exit;
        }
    });
}
fn focus_existing() -> bool {
    use std::os::windows::ffi::OsStrExt;
    let name: Vec<u16> = std::ffi::OsStr::new(TITLE)
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        let hwnd = windows_sys::Win32::UI::WindowsAndMessaging::FindWindowW(
            std::ptr::null(),
            name.as_ptr(),
        );
        if !hwnd.is_null() {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, 9);
            windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
            true
        } else {
            false
        }
    }
}
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let directory = data_directory(&args);
    if let Some(port) = option(&args, "--debug-port") {
        if port.parse::<u16>().is_ok() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
    let interactive =
        args.is_empty() || args[0].starts_with("--") && args[0] != "--serve" && args[0] != "--help";
    if !interactive && args.first().is_some_and(|s| s != "--serve") {
        match cli::run(&args, &directory) {
            Ok(result) => println!("{}", serde_json::to_string_pretty(&result).unwrap()),
            Err(e) => {
                report(&e, false);
                std::process::exit(1)
            }
        }
        return;
    }
    let verify = args.iter().any(|arg| arg == "--verify-window");
    if interactive && !verify && focus_existing() {
        return;
    }
    let executable = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("LocalSpace.exe"));
    let result = (|| -> AppResult<()> {
        let (url, owns) = bootstrap(&args, &directory, &executable)?;
        if !interactive {
            println!("{}", json!({"url":url,"ready":true}));
            loop {
                std::thread::park();
            }
        }
        show_window(url, directory.clone(), owns, verify)
    })();
    if let Err(e) = result {
        report(&e, interactive && !verify);
        std::process::exit(1)
    }
}
