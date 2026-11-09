use crate::store::{error, AppError, AppResult};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
};

pub fn request(
    base: &str,
    route: &str,
    method: &str,
    payload: Option<Value>,
    token: &str,
) -> AppResult<Value> {
    let url = url::Url::parse(base).map_err(|_| error("无效的本地服务地址。"))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "http" || !["localhost", "127.0.0.1", "[::1]"].contains(&host) {
        return Err(error("仅支持本机 HTTP 地址。"));
    }
    let port = url.port_or_known_default().unwrap_or(4319);
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        std::time::Duration::from_millis(1500),
    )
    .map_err(|_| error("无法连接本地工作台，请先打开 LocalSpace.exe。"))?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(240)));
    let body = payload.map(|p| p.to_string()).unwrap_or_default();
    let message=format!("{method} {route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-LocalSpace-Token: {token}\r\n\r\n{body}",body.len());
    stream
        .write_all(message.as_bytes())
        .map_err(|_| error("无法发送本地请求。"))?;
    let mut raw = String::new();
    stream
        .take(16_000_000)
        .read_to_string(&mut raw)
        .map_err(|_| error("读取本地服务响应失败。"))?;
    let (headers, body) = raw
        .split_once("\r\n\r\n")
        .ok_or_else(|| error("本地服务响应无效。"))?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);
    let result: Value =
        serde_json::from_str(body).map_err(|_| error("本地服务未返回有效 JSON。"))?;
    if status >= 400 {
        return Err(AppError(
            status,
            result["error"]
                .as_str()
                .unwrap_or("请求未完成。")
                .to_string(),
        ));
    }
    Ok(result)
}
pub fn run(args: &[String], data_dir: &Path) -> AppResult<Value> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    if ["help", "--help", "-h"].contains(&command) {
        return Ok(
            json!({"usage":["LocalSpace.exe list","LocalSpace.exe categories","LocalSpace.exe add \"E:\\Projects\\demo\" --category frontend --description \"项目简介\"","LocalSpace.exe category \"分类名称\" --color blue","LocalSpace.exe scan \"E:\\Projects\" --depth 3 --import"],"note":"先打开工作台窗口。命令只登记已有目录，不会创建或修改项目文件。"}),
        );
    }
    let mut options = HashMap::<String, String>::new();
    let mut positional = Vec::new();
    let mut import = false;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--import" {
            import = true
        } else if args[i].starts_with("--") {
            let key = args[i].trim_start_matches("--").to_owned();
            i += 1;
            if i >= args.len() {
                return Err(error(format!("--{key} 需要一个值。")));
            }
            options.insert(key, args[i].clone());
        } else {
            positional.push(args[i].clone())
        }
        i += 1;
    }
    let session: Value = std::fs::read_to_string(data_dir.join("session.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(json!({}));
    let base = options
        .get("url")
        .cloned()
        .or_else(|| std::env::var("LOCALSPACE_URL").ok())
        .unwrap_or_else(|| {
            session["url"]
                .as_str()
                .unwrap_or("http://127.0.0.1:4319")
                .into()
        });
    let state = request(&base, "/api/state", "GET", None, "")?;
    let token = state["token"].as_str().unwrap_or("");
    match command {
        "list" => Ok(json!({"projects":state["projects"]})),
        "categories" => Ok(json!({"categories":state["categories"]})),
        "category" => {
            let name = positional
                .first()
                .or(options.get("name"))
                .ok_or_else(|| error("请填写分类名称。"))?;
            let value = request(
                &base,
                "/api/categories",
                "POST",
                Some(
                    json!({"name":name,"color":options.get("color").map(String::as_str).unwrap_or("blue")}),
                ),
                token,
            )?;
            Ok(json!({"category":value["category"]}))
        }
        "add" => {
            let path = positional
                .first()
                .or(options.get("path"))
                .ok_or_else(|| error("请填写已有项目的绝对路径。"))?;
            let mut payload = json!({"path":path,"source":"agent"});
            for key in ["name", "category", "description"] {
                if let Some(value) = options.get(key) {
                    payload[key] = json!(value)
                }
            }
            if let Some(tags) = options.get("tags") {
                payload["tags"] = json!(tags
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>())
            }
            let result = request(&base, "/api/projects", "POST", Some(payload), token)?;
            Ok(json!({"project":result["project"]}))
        }
        "scan" => {
            let depth = options
                .get("depth")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(3);
            let mut payload = json!({"maxDepth":depth});
            if let Some(root) = positional.first().or(options.get("root")) {
                payload["roots"] = json!([root])
            }
            let scan = request(&base, "/api/scan", "POST", Some(payload), token)?;
            if !import {
                return Ok(scan);
            }
            let ids: Vec<Value> = scan["projects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| p["imported"] != true)
                .map(|p| p["id"].clone())
                .collect();
            if ids.is_empty() {
                return Ok(
                    json!({"added":0,"skipped":scan["projects"].as_array().unwrap().len(),"warnings":scan["warnings"]}),
                );
            }
            let result = request(
                &base,
                "/api/import",
                "POST",
                Some(json!({"scanId":scan["scanId"],"ids":ids})),
                token,
            )?;
            Ok(
                json!({"added":result["added"],"skipped":result["skipped"],"warnings":scan["warnings"]}),
            )
        }
        _ => Err(error("未知命令，请使用 LocalSpace.exe help。")),
    }
}
