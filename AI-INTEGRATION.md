# External AI integration

[English](AI-INTEGRATION.md) · [简体中文](AI-INTEGRATION.zh-CN.md) · [Back to README](README.md)

LocalSpace manages local project records; it does not run model inference. Inspect real projects only within the directories authorized by the user, then register them through the local CLI or HTTP API. Do not modify, move, or delete their source files.

## Windows desktop CLI

Keep the LocalSpace window open. Invoke the executable as a subprocess and capture stdout and stderr:

```powershell
.\LocalSpace.exe categories
.\LocalSpace.exe list
.\LocalSpace.exe category "Experiments" --color blue
.\LocalSpace.exe add "D:\Projects\my-app" --category frontend --name "My app" --description "An existing React application" --tags "React,TypeScript"
.\LocalSpace.exe scan "D:\Projects" --depth 3
.\LocalSpace.exe scan "D:\Projects" --depth 3 --import
```

Use an absolute path to the executable when calling from another directory. `--name`, `--description`, `--category`, and `--tags` are optional. Category names are limited to 30 characters, descriptions to 300 characters, and tags to six entries.

Pass paths and free text as a subprocess argument array rather than concatenating a shell command. This preserves spaces, quotes, and non-ASCII text. Commands return JSON; operational failures exit with status `1` and write errors to stderr.

`add` registers an existing directory. Duplicate paths return an error, so list existing records first. Read `categories` to obtain category IDs or names. Preview a scan before importing it, and stay within the user's approved directory scope.

## HTTP API

The desktop service defaults to `http://127.0.0.1:4319`. Its actual address is stored as `url` in `%LOCALAPPDATA%\LocalSpace\session.json`. The application removes its own session file when it exits normally.

First request `GET /api/state` to obtain `token`. Include these headers when changing data:

```text
Content-Type: application/json
X-LocalSpace-Token: <token>
```

Example body for `POST /api/projects`:

```json
{
  "path": "D:\\Projects\\my-app",
  "category": "frontend",
  "description": "An existing React application",
  "tags": ["React", "TypeScript"],
  "source": "agent"
}
```

| Method | Path | Purpose |
| :--- | :--- | :--- |
| GET | `/api/state` | Projects, categories, settings, and the session token |
| GET / POST | `/api/projects` | List projects / register an existing directory |
| PATCH / DELETE | `/api/projects/:id` | Update metadata / remove a record |
| POST | `/api/projects/:id/open` | Open with `action`: `folder`, `cmd`, or `powershell` |
| GET / POST | `/api/categories` | List / create categories |
| PATCH / DELETE | `/api/categories/:id` | Update / delete a category |
| POST | `/api/scan` | Preview directories with `roots: string[]` and `maxDepth: 0..6` |
| POST | `/api/import` | Import selected results using `scanId` and `ids: string[]` |
| PATCH | `/api/settings` | Update the default terminal, scan roots, or scan depth |

Scan previews expire after 30 minutes. Duplicate paths return `409`, invalid input returns `400`, and expired previews return `410`. Errors use `{ "error": "reason" }`. On Windows, project paths are deduplicated by their real, case-insensitive path.

LocalSpace does not require a model API key or send project directories and source code to an AI service.

## Source / web CLI

`node scripts/localspace.mjs` supports the same commands. Start `npm start` or `npm run dev` before using the web service:

```powershell
npm run projects -- list --url http://127.0.0.1:4318
npm run projects -- scan "D:\Projects" --depth 3 --url http://127.0.0.1:4318
```

Without `--url`, the CLI discovers a running desktop session first and otherwise falls back to the web service at port `4318`. `LOCALSPACE_URL` can also select a loopback HTTP address. The desktop session lookup uses the standard `%LOCALAPPDATA%\LocalSpace\session.json` location.
