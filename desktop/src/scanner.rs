use crate::store::{error, now, path_key, path_string, AppResult};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::SystemTime,
};
use uuid::Uuid;
const MARKERS: [&str; 18] = [
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "project.godot",
    "pubspec.yaml",
    "Package.swift",
    "CMakeLists.txt",
    "Makefile",
    ".git",
    "build.sbt",
    "mix.exs",
];
fn small_file(path: &Path, max: u64) -> String {
    fs::metadata(path)
        .ok()
        .filter(|m| m.len() <= max)
        .and_then(|_| fs::read_to_string(path).ok())
        .unwrap_or_default()
}
fn solution(name: &str) -> bool {
    [".sln", ".csproj", ".fsproj", ".uproject", ".xcodeproj"]
        .iter()
        .any(|ext| name.to_lowercase().ends_with(ext))
}
fn ignored(name: &str) -> bool {
    name.starts_with('.')
        || [
            "node_modules",
            "vendor",
            "target",
            "dist",
            "build",
            "coverage",
            "__pycache__",
            "venv",
            "env",
            "$recycle.bin",
            "system volume information",
            "windows",
            "program files",
            "program files (x86)",
        ]
        .contains(&name.to_lowercase().as_str())
}
fn description(category: &str) -> &str {
    match category {
        "frontend" => "本地前端应用。",
        "backend" => "本地服务项目。",
        "tools" => "本地工具与脚本。",
        "game" => "本地游戏开发项目。",
        "mobile" => "本地移动应用。",
        _ => "本地开发项目。",
    }
}
pub fn inspect(directory: &Path, allow_unknown: bool) -> AppResult<Option<Value>> {
    let resolved = dunce::canonicalize(directory)
        .map_err(|_| error("无法访问项目文件夹，请检查路径和权限。"))?;
    if !resolved.is_dir() {
        return Err(error("请选择一个文件夹。"));
    }
    let entries: Vec<_> = fs::read_dir(&resolved)
        .map_err(|_| error("无法读取项目文件夹。"))?
        .filter_map(Result::ok)
        .collect();
    let names: HashSet<String> = entries
        .iter()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let mut found: Vec<String> = MARKERS
        .iter()
        .filter(|m| names.contains(**m))
        .map(|m| m.to_string())
        .collect();
    found.extend(names.iter().filter(|n| solution(n)).cloned());
    if found.is_empty() && !allow_unknown {
        return Ok(None);
    }
    let name = resolved
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path_string(&resolved));
    let mut summary = String::new();
    let mut tags = Vec::<String>::new();
    let mut category = "other";
    let mut language = "项目";
    if names.contains("package.json") {
        let pkg: Value = serde_json::from_str(&small_file(&resolved.join("package.json"), 128_000))
            .unwrap_or(json!({}));
        summary = pkg["description"]
            .as_str()
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(150)
            .collect();
        let mut deps = HashMap::new();
        for key in ["dependencies", "devDependencies"] {
            if let Some(map) = pkg[key].as_object() {
                for (key, value) in map {
                    deps.insert(key.as_str(), value);
                }
            }
        }
        for (key, label) in [
            ("next", "Next.js"),
            ("react", "React"),
            ("vue", "Vue"),
            ("nuxt", "Nuxt"),
            ("svelte", "Svelte"),
            ("@angular/core", "Angular"),
            ("electron", "Electron"),
            ("express", "Express"),
            ("fastify", "Fastify"),
            ("typescript", "TypeScript"),
            ("vite", "Vite"),
        ] {
            if deps.contains_key(key) {
                tags.push(label.into())
            }
        }
        language = if deps.contains_key("typescript") || names.contains("tsconfig.json") {
            "TypeScript"
        } else {
            "JavaScript"
        };
        if tags.is_empty() {
            tags.push("Node.js".into())
        }
        category = if tags.iter().any(|t| {
            [
                "React", "Vue", "Next.js", "Nuxt", "Svelte", "Angular", "Vite",
            ]
            .contains(&t.as_str())
        }) {
            "frontend"
        } else {
            "backend"
        };
    } else if names.contains("pom.xml")
        || names.contains("build.gradle")
        || names.contains("build.gradle.kts")
    {
        language = "Java";
        category = "backend";
        let maven = names.contains("pom.xml");
        tags.push(if maven { "Maven" } else { "Gradle" }.into());
        let file = if maven {
            "pom.xml"
        } else if names.contains("build.gradle") {
            "build.gradle"
        } else {
            "build.gradle.kts"
        };
        let build = small_file(&resolved.join(file), 128_000).to_lowercase();
        if [
            "spigot",
            "paper-api",
            "bukkit",
            "minecraft",
            "fabric",
            "forge",
        ]
        .iter()
        .any(|s| build.contains(s))
        {
            category = "game";
            tags.push("Minecraft".into())
        } else if build.contains("spring") {
            tags.push("Spring".into())
        }
    } else if names.contains("pyproject.toml") || names.contains("requirements.txt") {
        language = "Python";
        category = "tools";
        tags.push("Python".into());
        let deps = small_file(
            &resolved.join(if names.contains("pyproject.toml") {
                "pyproject.toml"
            } else {
                "requirements.txt"
            }),
            128_000,
        )
        .to_lowercase();
        if deps.contains("fastapi") {
            tags.push("FastAPI".into());
            category = "backend"
        } else if deps.contains("django") {
            tags.push("Django".into());
            category = "backend"
        }
    } else if names.contains("Cargo.toml") {
        language = "Rust";
        tags.extend(["Rust".into(), "Cargo".into()]);
        category = "tools"
    } else if names.contains("go.mod") {
        language = "Go";
        tags.push("Go".into());
        category = "backend"
    } else if names.contains("pubspec.yaml") {
        language = "Dart";
        tags.push("Flutter".into());
        category = "mobile"
    } else if names.contains("Package.swift") || found.iter().any(|s| s.ends_with(".xcodeproj")) {
        language = "Swift";
        tags.push("Swift".into());
        category = "mobile"
    } else if names.contains("project.godot") || found.iter().any(|s| s.ends_with(".uproject")) {
        language = "游戏";
        tags.push(
            if names.contains("project.godot") {
                "Godot"
            } else {
                "Unreal"
            }
            .into(),
        );
        category = "game"
    } else if found.iter().any(|s| {
        [".sln", ".csproj", ".fsproj"]
            .iter()
            .any(|e| s.ends_with(e))
    }) {
        language = "C#";
        tags.push(".NET".into());
        category = "backend"
    } else if names.contains("CMakeLists.txt") {
        language = "C++";
        tags.push("CMake".into());
        category = "tools"
    } else if names.contains("composer.json") {
        language = "PHP";
        tags.push("PHP".into());
        category = "backend"
    } else if names.contains("Gemfile") {
        language = "Ruby";
        tags.push("Ruby".into());
        category = "backend"
    }
    if ["minecraft", "skywars", "bedwars", "spigot", "voxel"]
        .iter()
        .any(|s| name.to_lowercase().contains(s))
    {
        category = "game"
    }
    if tags.is_empty() {
        tags.push(
            if names.contains(".git") {
                "Git"
            } else {
                "本地项目"
            }
            .into(),
        )
    }
    tags.truncate(4);
    let mut git_dir = resolved.join(".git");
    if git_dir.is_file() {
        let pointer = small_file(&git_dir, 4096);
        if let Some(target) = pointer.strip_prefix("gitdir: ") {
            git_dir = resolved.join(target.trim())
        }
    }
    let head = small_file(&git_dir.join("HEAD"), 4096);
    let head = head.trim();
    let branch = head
        .strip_prefix("ref: refs/heads/")
        .map(str::to_owned)
        .unwrap_or_else(|| head.chars().take(7).collect());
    let mut modified = fs::metadata(&resolved)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::now());
    for marker in found.iter().filter(|s| s.as_str() != ".git").take(4) {
        if let Ok(time) = fs::metadata(resolved.join(marker)).and_then(|m| m.modified()) {
            modified = modified.max(time)
        }
    }
    let date: chrono::DateTime<chrono::Utc> = modified.into();
    Ok(Some(
        json!({"id":Uuid::new_v4().to_string(),"name":name,"path":path_string(&resolved),"description":if summary.is_empty(){description(category).to_string()}else{summary},"categoryId":category,"tags":tags,"language":language,"branch":branch,"markers":found,"updatedAt":date.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"addedAt":now(),"lastOpenedAt":null,"starred":false,"archived":false,"source":"local"}),
    ))
}
struct Scan {
    projects: Vec<Value>,
    warnings: Vec<String>,
    visited: HashSet<String>,
    directories: usize,
    truncated: bool,
}
impl Scan {
    fn visit(&mut self, directory: &Path, depth: u64, max_depth: u64) {
        if self.projects.len() >= 600 || self.directories >= 10_000 {
            self.truncated = true;
            return;
        }
        if !self.visited.insert(path_key(&path_string(directory))) {
            return;
        }
        self.directories += 1;
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                self.warnings
                    .push(format!("无法读取 {}", path_string(directory)));
                return;
            }
        };
        let entries: Vec<_> = entries.filter_map(Result::ok).collect();
        let marked = entries.iter().any(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            MARKERS.contains(&name.as_str()) || solution(&name)
        });
        if marked {
            match inspect(directory, false) {
                Ok(Some(project)) => self.projects.push(project),
                Err(_) => self
                    .warnings
                    .push(format!("无法识别 {}", path_string(directory))),
                _ => {}
            }
            return;
        }
        if depth >= max_depth {
            return;
        }
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                && !ignored(&name)
            {
                self.visit(&entry.path(), depth + 1, max_depth);
                if self.projects.len() >= 600 || self.directories >= 10_000 {
                    self.truncated = true;
                    break;
                }
            }
        }
    }
}
pub fn scan(roots: &Value, max_depth: u64) -> AppResult<Value> {
    let raw = roots
        .as_array()
        .filter(|r| !r.is_empty() && r.len() <= 12)
        .ok_or_else(|| error("请填写 1–12 个扫描目录。"))?;
    let mut normalized = Vec::new();
    for root in raw {
        let raw = root
            .as_str()
            .ok_or_else(|| error("扫描目录必须是完整路径。"))?;
        if !Path::new(raw).is_absolute() {
            return Err(error("扫描目录必须是完整的绝对路径。"));
        }
        let resolved = dunce::canonicalize(raw)
            .map_err(|_| error(format!("无法访问目录：{raw}，请检查路径和权限。")))?;
        if !resolved.is_dir() {
            return Err(error("请选择文件夹。"));
        }
        if !normalized.contains(&resolved) {
            normalized.push(resolved)
        }
    }
    let mut result = Scan {
        projects: vec![],
        warnings: vec![],
        visited: HashSet::new(),
        directories: 0,
        truncated: false,
    };
    for root in &normalized {
        result.visit(root, 0, max_depth)
    }
    if result.truncated {
        result
            .warnings
            .push("已达到本次扫描上限（600 个项目 / 10000 个目录），可缩小范围继续扫描。".into())
    }
    Ok(
        json!({"projects":result.projects,"roots":normalized.iter().map(|p|path_string(p)).collect::<Vec<_>>(),"directoryCount":result.directories,"warnings":result.warnings,"truncated":result.truncated}),
    )
}
