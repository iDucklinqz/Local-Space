use crate::{
    scanner,
    store::{
        category_id, error, now, path_key, path_string, tags, text, AppError, AppResult, Store,
        COLORS,
    },
    system,
};
use include_dir::{include_dir, Dir};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};
use uuid::Uuid;

static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../dist");
struct Preview {
    at: Instant,
    projects: Vec<Value>,
}
pub struct NativeApp {
    pub store: Store,
    pub token: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub executable: PathBuf,
    pub workspace: PathBuf,
    scans: Mutex<HashMap<String, Preview>>,
    scanning: AtomicBool,
}
impl NativeApp {
    pub fn new(
        store: Store,
        port: u16,
        data_dir: PathBuf,
        executable: PathBuf,
        workspace: PathBuf,
    ) -> Self {
        Self {
            store,
            port,
            data_dir,
            executable,
            workspace,
            token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
            scans: Mutex::new(HashMap::new()),
            scanning: AtomicBool::new(false),
        }
    }
    pub fn state(&self) -> Value {
        let mut state = self.store.read();
        state["token"] = json!(self.token);
        state["platform"] = json!("win32");
        state["workspaceRoot"] = json!(path_string(&self.workspace));
        state["desktop"] = json!(true);
        state["executablePath"] = json!(path_string(&self.executable));
        state["dataDirectory"] = json!(path_string(&self.data_dir));
        state
    }
    fn response(&self) -> Value {
        json!({"state":self.state()})
    }
    fn route(&self, method: &str, route: &str, input: Value) -> AppResult<(u16, Value)> {
        if method == "GET" {
            return match route {
                "/api/state" => Ok((200, self.state())),
                "/api/health" => Ok((
                    200,
                    json!({"ok":true,"name":"LocalSpace","version":"1.1.0","desktop":true}),
                )),
                "/api/projects" => Ok((200, json!({"projects":self.store.read()["projects"]}))),
                "/api/categories" => {
                    Ok((200, json!({"categories":self.store.read()["categories"]})))
                }
                _ => Err(AppError(404, "没有找到此接口。".into())),
            };
        }
        if method == "POST" && route == "/api/dialog/directory" {
            return Ok((200, json!({"path":system::choose_directory()})));
        }
        if method == "POST" && route == "/api/scan" {
            if self.scanning.swap(true, Ordering::SeqCst) {
                return Err(AppError(409, "已有扫描进行中，请稍后再试。".into()));
            }
            let result = (|| -> AppResult<(u16, Value)> {
                let current = self.store.read();
                let depth = input
                    .get("maxDepth")
                    .unwrap_or(&current["settings"]["maxDepth"])
                    .as_u64()
                    .filter(|d| *d <= 6)
                    .ok_or_else(|| error("扫描深度需为 0–6 的整数。"))?;
                let mut result = scanner::scan(
                    input.get("roots").unwrap_or(&current["settings"]["roots"]),
                    depth,
                )?;
                let latest = self.store.read();
                let known: HashSet<String> = latest["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|p| p["path"].as_str())
                    .map(path_key)
                    .collect();
                for project in result["projects"].as_array_mut().unwrap() {
                    project["imported"] =
                        json!(known.contains(&path_key(project["path"].as_str().unwrap_or(""))));
                    if !current["categories"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["id"] == project["categoryId"])
                    {
                        project["categoryId"] = json!("other")
                    }
                }
                let id = Uuid::new_v4().to_string();
                {
                    let mut scans = self.scans.lock().unwrap();
                    scans.retain(|_, p| p.at.elapsed().as_secs() < 1800);
                    if scans.len() >= 5 {
                        if let Some(oldest) = scans
                            .iter()
                            .min_by_key(|(_, p)| p.at)
                            .map(|(id, _)| id.clone())
                        {
                            scans.remove(&oldest);
                        }
                    }
                    scans.insert(
                        id.clone(),
                        Preview {
                            at: Instant::now(),
                            projects: result["projects"].as_array().unwrap().clone(),
                        },
                    );
                }
                self.store.update(|state|{let roots=state["settings"]["roots"].as_array_mut().unwrap();for root in result["roots"].as_array().unwrap(){if !roots.contains(root){roots.push(root.clone())}}if roots.len()>12{roots.drain(..roots.len()-12);}state["settings"]["maxDepth"]=json!(depth);state["lastScan"]=json!({"at":now(),"count":result["projects"].as_array().unwrap().len(),"directoryCount":result["directoryCount"],"roots":result["roots"]});Ok(())})?;
                result["scanId"] = json!(id);
                Ok((200, result))
            })();
            self.scanning.store(false, Ordering::SeqCst);
            return result;
        }
        if method == "POST" && route == "/api/import" {
            let scans = self.scans.lock().unwrap();
            let preview = scans
                .get(input["scanId"].as_str().unwrap_or(""))
                .filter(|p| p.at.elapsed().as_secs() < 1800)
                .ok_or_else(|| AppError(410, "扫描预览已过期，请重新扫描。".into()))?;
            let ids = input["ids"]
                .as_array()
                .filter(|i| !i.is_empty())
                .ok_or_else(|| error("请至少选择一个项目。"))?;
            let candidates: Vec<Value> = preview
                .projects
                .iter()
                .filter(|p| ids.contains(&p["id"]))
                .cloned()
                .collect();
            drop(scans);
            if candidates.is_empty() {
                return Err(error("所选项目不在本次扫描结果中。"));
            }
            let total = candidates.len();
            let added = self.store.update(|state| {
                let categories = state["categories"].clone();
                let projects = state["projects"].as_array_mut().unwrap();
                let mut added = 0;
                let mut known: HashSet<String> = projects
                    .iter()
                    .map(|p| path_key(p["path"].as_str().unwrap_or("")))
                    .collect();
                for mut project in candidates {
                    let location = project["path"].as_str().unwrap_or("");
                    if !Path::new(location).is_dir() || known.contains(&path_key(location)) {
                        continue;
                    }
                    known.insert(path_key(location));
                    project.as_object_mut().unwrap().remove("imported");
                    if !categories
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|c| c["id"] == project["categoryId"])
                    {
                        project["categoryId"] = json!("other")
                    }
                    projects.push(project);
                    added += 1
                }
                Ok(added)
            })?;
            return Ok((
                200,
                json!({"added":added,"skipped":total-added,"state":self.state()}),
            ));
        }
        if method == "POST" && route == "/api/projects" {
            let raw = input["path"].as_str().unwrap_or("");
            system::valid_directory(raw)?;
            let mut project = scanner::inspect(Path::new(raw), true)?
                .ok_or_else(|| error("无法识别项目文件夹。"))?;
            if input.get("name").is_some() {
                let name = text(&input["name"], 100);
                if !name.is_empty() {
                    project["name"] = json!(name)
                }
            }
            if input.get("description").is_some() {
                project["description"] = json!(text(&input["description"], 300))
            }
            if let Some(category) = input.get("categoryId").or_else(|| input.get("category")) {
                project["categoryId"] = json!(category_id(&self.store.read(), category)?)
            } else if !self.store.read()["categories"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["id"] == project["categoryId"])
            {
                project["categoryId"] = json!("other")
            }
            if let Some(value) = input.get("tags") {
                project["tags"] = tags(value)?
            }
            project["source"] = json!(if input["source"] == "agent" {
                "agent"
            } else {
                "manual"
            });
            self.store.update(|state| {
                let projects = state["projects"].as_array_mut().unwrap();
                if let Some(existing) = projects.iter().find(|p| {
                    path_key(p["path"].as_str().unwrap_or(""))
                        == path_key(project["path"].as_str().unwrap_or(""))
                }) {
                    return Err(AppError(
                        409,
                        format!(
                            "这个文件夹已添加为「{}」。",
                            existing["name"].as_str().unwrap_or("项目")
                        ),
                    ));
                }
                projects.push(project.clone());
                Ok(())
            })?;
            return Ok((201, json!({"project":project,"state":self.state()})));
        }
        let parts: Vec<&str> = route.trim_start_matches('/').split('/').collect();
        if parts.len() >= 3 && parts[0] == "api" && parts[1] == "projects" {
            let id = parts[2];
            let current = self.store.read();
            let project = current["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == id)
                .ok_or_else(|| AppError(404, "项目不存在，可能已被移除。".into()))?;
            if method == "POST" && parts.len() == 4 && parts[3] == "open" {
                system::open_project(
                    project["path"].as_str().unwrap_or(""),
                    input["action"].as_str().unwrap_or(""),
                )?;
                self.store.update(|state| {
                    if let Some(item) = state["projects"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .find(|p| p["id"] == id)
                    {
                        item["lastOpenedAt"] = json!(now())
                    }
                    Ok(())
                })?;
                return Ok((200, json!({"ok":true,"state":self.state()})));
            }
            if method == "PATCH" && parts.len() == 3 {
                let mut changes = json!({});
                if let Some(value) = input.get("name") {
                    let name = text(value, 100);
                    if name.is_empty() {
                        return Err(error("项目名称不能为空。"));
                    }
                    changes["name"] = json!(name)
                }
                if let Some(value) = input.get("description") {
                    changes["description"] = json!(text(value, 300))
                }
                if let Some(value) = input.get("categoryId") {
                    changes["categoryId"] = json!(category_id(&current, value)?)
                }
                if let Some(value) = input.get("tags") {
                    changes["tags"] = tags(value)?
                }
                for key in ["starred", "archived"] {
                    if let Some(value) = input.get(key) {
                        if !value.is_boolean() {
                            return Err(error("项目状态必须为布尔值。"));
                        }
                        changes[key] = value.clone()
                    }
                }
                if let Some(value) = input.get("path") {
                    changes["path"] = json!(system::valid_directory(value.as_str().unwrap_or(""))?)
                }
                self.store.update(|state| {
                    let projects = state["projects"].as_array_mut().unwrap();
                    if let Some(value) = changes["path"].as_str() {
                        if projects.iter().any(|p| {
                            p["id"] != id
                                && path_key(p["path"].as_str().unwrap_or("")) == path_key(value)
                        }) {
                            return Err(AppError(409, "该路径已被其他项目使用。".into()));
                        }
                    }
                    let target = projects
                        .iter_mut()
                        .find(|p| p["id"] == id)
                        .ok_or_else(|| AppError(404, "项目已被移除。".into()))?;
                    target
                        .as_object_mut()
                        .unwrap()
                        .extend(changes.as_object().unwrap().clone());
                    Ok(())
                })?;
                return Ok((200, self.response()));
            }
            if method == "DELETE" && parts.len() == 3 {
                self.store.update(|state| {
                    state["projects"]
                        .as_array_mut()
                        .unwrap()
                        .retain(|p| p["id"] != id);
                    Ok(())
                })?;
                return Ok((200, self.response()));
            }
        }
        if method == "POST" && route == "/api/categories" {
            let name = text(&input["name"], 30);
            if name.is_empty() {
                return Err(error("请填写分类名称。"));
            }
            let color = input["color"]
                .as_str()
                .filter(|s| COLORS.contains(s))
                .unwrap_or("blue");
            let category = json!({"id":Uuid::new_v4().to_string(),"name":name,"color":color});
            self.store.update(|state| {
                let categories = state["categories"].as_array_mut().unwrap();
                if categories
                    .iter()
                    .any(|c| c["name"].as_str().unwrap_or("").to_lowercase() == name.to_lowercase())
                {
                    return Err(AppError(409, "已存在同名分类。".into()));
                }
                categories.push(category.clone());
                Ok(())
            })?;
            return Ok((201, json!({"category":category,"state":self.state()})));
        }
        if parts.len() == 3
            && parts[0] == "api"
            && parts[1] == "categories"
            && ["PATCH", "DELETE"].contains(&method)
        {
            let id = parts[2];
            self.store.update(|state| {
                let categories = state["categories"].as_array_mut().unwrap();
                let index = categories
                    .iter()
                    .position(|c| c["id"] == id)
                    .ok_or_else(|| AppError(404, "分类不存在。".into()))?;
                if method == "DELETE" {
                    if id == "other" {
                        return Err(error("其他项目是默认分类，不能移除。"));
                    }
                    categories.remove(index);
                    for project in state["projects"].as_array_mut().unwrap() {
                        if project["categoryId"] == id {
                            project["categoryId"] = json!("other")
                        }
                    }
                } else {
                    let name = text(&input["name"], 30);
                    if name.is_empty() {
                        return Err(error("分类名称不能为空。"));
                    }
                    if categories.iter().any(|c| {
                        c["id"] != id
                            && c["name"].as_str().unwrap_or("").to_lowercase()
                                == name.to_lowercase()
                    }) {
                        return Err(AppError(409, "已存在同名分类。".into()));
                    }
                    categories[index]["name"] = json!(name);
                    if input["color"].as_str().is_some_and(|c| COLORS.contains(&c)) {
                        categories[index]["color"] = input["color"].clone()
                    }
                }
                Ok(())
            })?;
            return Ok((200, self.response()));
        }
        if method == "PATCH" && route == "/api/settings" {
            self.store.update(|state| {
                if let Some(value) = input.get("terminal") {
                    if !["powershell", "cmd"].iter().any(|s| value == s) {
                        return Err(error("默认终端无效。"));
                    }
                    state["settings"]["terminal"] = value.clone()
                }
                if let Some(value) = input.get("maxDepth") {
                    if !value.as_u64().is_some_and(|v| v <= 6) {
                        return Err(error("扫描深度需为 0–6 的整数。"));
                    }
                    state["settings"]["maxDepth"] = value.clone()
                }
                if let Some(value) = input.get("roots") {
                    let roots = value
                        .as_array()
                        .filter(|v| !v.is_empty() && v.len() <= 12)
                        .ok_or_else(|| error("请填写 1–12 个完整扫描目录。"))?;
                    if roots
                        .iter()
                        .any(|r| !r.as_str().is_some_and(|v| Path::new(v).is_absolute()))
                    {
                        return Err(error("请使用完整的扫描目录。"));
                    }
                    state["settings"]["roots"] = value.clone()
                }
                Ok(())
            })?;
            return Ok((200, self.response()));
        }
        Err(AppError(404, "没有找到此接口。".into()))
    }
}
fn header(request: &Request, name: &str) -> String {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_owned())
        .unwrap_or_default()
}
fn local_host(value: &str) -> bool {
    url::Url::parse(value)
        .ok()
        .is_some_and(|u| matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
}
fn authorize(request: &Request, app: &NativeApp) -> AppResult<()> {
    let host = header(request, "host");
    if !local_host(&format!("http://{host}")) {
        return Err(AppError(403, "仅允许通过本机地址访问。".into()));
    }
    let origin = header(request, "origin");
    if !origin.is_empty() {
        let allowed = url::Url::parse(&origin).ok().is_some_and(|u| {
            local_host(&origin)
                && (u.port_or_known_default() == Some(app.port) || u.port() == Some(5173))
        });
        if !allowed {
            return Err(AppError(403, "不允许此来源访问本地工作台。".into()));
        }
    }
    if !matches!(request.method(), Method::Get | Method::Head) {
        let supplied = header(request, "x-localspace-token");
        let valid = supplied.len() == app.token.len()
            && supplied
                .bytes()
                .zip(app.token.bytes())
                .fold(0u8, |a, (x, y)| a | (x ^ y))
                == 0;
        if !valid {
            return Err(AppError(403, "本地会话已更新，请刷新后重试。".into()));
        }
    }
    Ok(())
}
fn h(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}
fn json_response(request: Request, status: u16, value: Value) {
    let data = serde_json::to_vec(&value).unwrap_or_default();
    let response = Response::from_data(data)
        .with_status_code(StatusCode(status))
        .with_header(h("Content-Type", "application/json; charset=utf-8"))
        .with_header(h("Cache-Control", "no-store"))
        .with_header(h("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}
fn handle(mut request: Request, app: &NativeApp) {
    if let Err(error) = authorize(&request, app) {
        json_response(request, error.0, json!({"error":error.1}));
        return;
    }
    let method = request.method().as_str().to_string();
    let route = request.url().split('?').next().unwrap_or("/").to_string();
    if route.starts_with("/api/") {
        let mut raw = Vec::new();
        if !matches!(request.method(), Method::Get | Method::Head) {
            if request.body_length().is_some_and(|n| n > 256_000) {
                json_response(request, 413, json!({"error":"请求内容过大。"}));
                return;
            }
            if request
                .as_reader()
                .take(256_001)
                .read_to_end(&mut raw)
                .is_err()
                || raw.len() > 256_000
            {
                json_response(request, 413, json!({"error":"请求内容过大。"}));
                return;
            }
        }
        let input = if raw.is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_slice(&raw)
        };
        match input {
            Ok(input) => match app.route(&method, &route, input) {
                Ok((status, value)) => json_response(request, status, value),
                Err(error) => json_response(request, error.0, json!({"error":error.1})),
            },
            Err(_) => json_response(request, 400, json!({"error":"请求必须是有效的 JSON。"})),
        }
        return;
    }
    if method != "GET" && method != "HEAD" {
        json_response(request, 405, json!({"error":"不支持此请求。"}));
        return;
    }
    let relative = route.trim_start_matches('/');
    let name = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let file = ASSETS.get_file(name).or_else(|| {
        if Path::new(name).extension().is_none() {
            ASSETS.get_file("index.html")
        } else {
            None
        }
    });
    let Some(file) = file else {
        json_response(request, 404, json!({"error":"文件不存在。"}));
        return;
    };
    let mime = match file
        .path()
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    };
    let bytes = if method == "HEAD" {
        vec![]
    } else {
        file.contents().to_vec()
    };
    let response=Response::from_data(bytes).with_header(h("Content-Type",mime)).with_header(h("Cache-Control",if name.starts_with("assets/"){"public, max-age=31536000, immutable"}else{"no-cache"})).with_header(h("X-Content-Type-Options","nosniff")).with_header(h("Content-Security-Policy","default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"));
    let _ = request.respond(response);
}
pub fn serve(server: Server, app: Arc<NativeApp>) {
    for request in server.incoming_requests() {
        let app = app.clone();
        std::thread::spawn(move || handle(request, &app));
    }
}
