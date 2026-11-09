use crate::store::{error, path_string, AppResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path};
use windows_sys::Win32::UI::Shell::ShellExecuteW;

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}
pub fn open_project(directory: &str, action: &str) -> AppResult<()> {
    let resolved = dunce::canonicalize(directory)
        .map_err(|_| error("项目文件夹已移动或无法访问，请更新项目路径。"))?;
    if !resolved.is_dir() {
        return Err(error("项目文件夹已不存在。"));
    }
    let location = path_string(&resolved);
    let (file, parameters) = match action {
        "folder" => (location.clone(), String::new()),
        "cmd" => ("cmd.exe".into(), "/D /K".into()),
        "powershell" => {
            let encoded = STANDARD.encode(location.as_bytes());
            let script=format!("Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded}')))");
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            (
                "powershell.exe".into(),
                format!("-NoLogo -NoExit -EncodedCommand {}", STANDARD.encode(bytes)),
            )
        }
        _ => return Err(error("请选择文件夹、CMD 或 PowerShell。")),
    };
    let operation = wide("open");
    let file = wide(&file);
    let args = wide(&parameters);
    let directory = wide(&location);
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            args.as_ptr(),
            directory.as_ptr(),
            1,
        )
    };
    if (result as isize) <= 32 {
        return Err(error("无法打开，请确认资源管理器或终端程序可用。"));
    }
    Ok(())
}
pub fn choose_directory(english: bool) -> String {
    rfd::FileDialog::new()
        .set_title(if english {
            "Choose a project folder"
        } else {
            "选择项目目录"
        })
        .pick_folder()
        .map(|p| path_string(&p))
        .unwrap_or_default()
}
pub fn valid_directory(value: &str) -> AppResult<String> {
    if !Path::new(value).is_absolute() {
        return Err(error("请填写项目文件夹的完整绝对路径。"));
    }
    let path =
        dunce::canonicalize(value).map_err(|_| error("无法访问项目文件夹，请检查路径和权限。"))?;
    if !path.is_dir() {
        return Err(error("请选择一个文件夹。"));
    }
    Ok(path_string(&path))
}
