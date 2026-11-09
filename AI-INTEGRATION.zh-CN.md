# 外部 AI 接入约定

[English](AI-INTEGRATION.md) · [简体中文](AI-INTEGRATION.zh-CN.md) · [返回 README](README.zh-CN.md)

栖点只管理本地项目记录，不执行模型推理。先确认用户授权的目录范围，检查真实项目，再通过本地 CLI 或 HTTP API 登记。不要修改、移动或删除项目源码。

## Windows 桌面版 CLI

保持栖点窗口打开，通过子进程执行程序，并捕获 stdout 与 stderr：

```powershell
.\LocalSpace.exe categories
.\LocalSpace.exe list
.\LocalSpace.exe category "个人实验" --color blue
.\LocalSpace.exe add "D:\Projects\my-app" --category frontend --name "我的应用" --description "一个已有的 React 应用" --tags "React,TypeScript"
.\LocalSpace.exe scan "D:\Projects" --depth 3
.\LocalSpace.exe scan "D:\Projects" --depth 3 --import
```

从其他目录调用时，使用 exe 的绝对路径。`--name`、`--description`、`--category` 和 `--tags` 均可省略。分类名称最多 30 字符，简介最多 300 字符，最多 6 个技术标签。

使用子进程参数数组传递路径和文字，避免拼接 shell 命令，以正确保留空格、引号和非 ASCII 文字。命令返回 JSON；操作失败时退出状态为 `1`，错误写入 stderr。

`add` 只登记已有目录。重复路径返回错误，因此应先读取已有记录。通过 `categories` 获取分类 ID 或名称；批量扫描先查看预览，确认范围后再使用 `--import`，不额外遍历用户授权范围之外的目录。

## HTTP API

桌面服务默认地址为 `http://127.0.0.1:4319`。实际地址记录在 `%LOCALAPPDATA%\LocalSpace\session.json` 的 `url` 中；应用正常关闭后会移除自己创建的会话文件。

先请求 `GET /api/state` 获取 `token`，修改数据时携带以下请求头：

```text
Content-Type: application/json
X-LocalSpace-Token: <token>
```

`POST /api/projects` 的请求体示例：

```json
{
  "path": "D:\\Projects\\my-app",
  "category": "frontend",
  "description": "一个已有的 React 应用",
  "tags": ["React", "TypeScript"],
  "source": "agent"
}
```

| 方法 | 路径 | 用途 |
| :--- | :--- | :--- |
| GET | `/api/state` | 项目、分类、设置与会话令牌 |
| GET / POST | `/api/projects` | 列出项目 / 登记已有目录 |
| PATCH / DELETE | `/api/projects/:id` | 修改信息 / 移除登记 |
| POST | `/api/projects/:id/open` | `action` 为 `folder`、`cmd` 或 `powershell` |
| GET / POST | `/api/categories` | 列出 / 创建分类 |
| PATCH / DELETE | `/api/categories/:id` | 修改 / 删除分类 |
| POST | `/api/scan` | 通过 `roots: string[]`、`maxDepth: 0..6` 预览目录 |
| POST | `/api/import` | 通过 `scanId`、`ids: string[]` 导入选中结果 |
| PATCH | `/api/settings` | 更新默认终端、扫描根目录或深度 |

扫描预览有效期为 30 分钟。重复路径返回 `409`，无效参数返回 `400`，预览过期返回 `410`。错误格式为 `{ "error": "原因" }`。Windows 下按真实路径忽略大小写去重。

栖点不需要模型 API Key，也不会向 AI 服务发送项目目录和源码。

## 源码 / 网页版 CLI

`node scripts/localspace.mjs` 支持相同命令。使用网页服务前，先运行 `npm start` 或 `npm run dev`：

```powershell
npm run projects -- list --url http://127.0.0.1:4318
npm run projects -- scan "D:\Projects" --depth 3 --url http://127.0.0.1:4318
```

未指定 `--url` 时，CLI 会优先发现正在运行的桌面会话，否则回退到 `4318` 端口的网页服务。也可通过 `LOCALSPACE_URL` 指定本机 HTTP 地址。桌面会话发现使用标准的 `%LOCALAPPDATA%\LocalSpace\session.json` 路径。
