use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppError(pub u16, pub String);
pub type AppResult<T> = Result<T, AppError>;
pub fn error(message: impl Into<String>) -> AppError {
    AppError(400, message.into())
}
pub fn text(value: &Value, max: usize) -> String {
    value
        .as_str()
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn path_string(value: &Path) -> String {
    value.to_string_lossy().into_owned()
}
pub fn path_key(value: &str) -> String {
    value
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}
pub const COLORS: [&str; 7] = ["blue", "green", "amber", "purple", "pink", "slate", "coral"];
pub fn categories() -> Value {
    json!([
        {"id":"frontend","name":"前端应用","color":"blue"},
        {"id":"backend","name":"后端服务","color":"green"},
        {"id":"tools","name":"工具与脚本","color":"amber"},
        {"id":"game","name":"游戏开发","color":"purple"},
        {"id":"mobile","name":"移动应用","color":"pink"},
        {"id":"other","name":"其他项目","color":"slate"}
    ])
}
pub struct Store {
    file: PathBuf,
    value: Mutex<Value>,
}
impl Store {
    pub fn open(directory: &Path, root: &Path, migration: Option<&Path>) -> AppResult<Self> {
        fs::create_dir_all(directory).map_err(|_| error("无法创建本地数据目录。"))?;
        let file = directory.join("workspace.json");
        if !file.exists() {
            if let Some(previous) = migration {
                if previous.is_file() {
                    fs::copy(previous, &file)
                        .map_err(|_| error("无法迁移原有项目数据，原文件已保留。"))?;
                }
            }
        }
        let value = if file.exists() {
            let raw = fs::read_to_string(&file)
                .map_err(|_| error("无法读取工作台数据，原文件已保留。"))?;
            let parsed: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
                .map_err(|_| error("工作台数据格式有误，原文件已保留。"))?;
            if !parsed["projects"].is_array()
                || !parsed["categories"].is_array()
                || !parsed["settings"].is_object()
            {
                return Err(error("工作台数据结构有误，原文件已保留。"));
            }
            parsed
        } else {
            json!({"version":1,"projects":[],"categories":categories(),"settings":{"roots":[path_string(root)],"maxDepth":3,"terminal":"powershell"}})
        };
        let store = Self {
            file,
            value: Mutex::new(value),
        };
        store.update(|_| Ok(()))?;
        Ok(store)
    }
    pub fn read(&self) -> Value {
        self.value.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    pub fn update<T>(&self, change: impl FnOnce(&mut Value) -> AppResult<T>) -> AppResult<T> {
        let mut locked = self.value.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = locked.clone();
        let result = change(&mut next)?;
        let temporary = self.file.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let encoded = serde_json::to_vec_pretty(&next).map_err(|_| error("无法保存项目数据。"))?;
        let write = (|| -> std::io::Result<()> {
            let mut target = fs::File::create(&temporary)?;
            target.write_all(&encoded)?;
            target.sync_all()?;
            drop(target);
            fs::rename(&temporary, &self.file)
        })();
        if write.is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(AppError(
                500,
                "保存失败，请检查数据目录权限和磁盘空间。".into(),
            ));
        }
        *locked = next;
        Ok(result)
    }
}
pub fn category_id(state: &Value, value: &Value) -> AppResult<String> {
    let name = value.as_str().unwrap_or("");
    if name.is_empty() {
        return Ok("other".into());
    }
    state["categories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == name || c["name"] == name)
        .and_then(|c| c["id"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| error("分类不存在，请先创建分类。"))
}
pub fn tags(value: &Value) -> AppResult<Value> {
    let items = value
        .as_array()
        .ok_or_else(|| error("技术标签必须是数组。"))?;
    let mut tags = Vec::<String>::new();
    for value in items {
        let tag = text(value, 30);
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag)
        }
        if tags.len() >= 6 {
            break;
        }
    }
    Ok(json!(tags))
}
