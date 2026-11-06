# pi-router-picker

Pi 扩展：把 **OpenAI 兼容 router**（llama.cpp router / vLLM / SGLang / 各家代理聚合）变成 Pi 的
实时模型目录，并提供按机器前缀分级的两级选模菜单。

- 每次 catalog refresh 都会从 `GET {baseUrl}/models` 拉取 router 当前提供的模型；router 挂了就用上次列表兜底，不会把目录清空。
- `/pick` 一级菜单是 id 的第一段前缀（例如 `gpu01/`、`nas01/`、`api01/`），Enter 进入二级选具体模型，Esc 逐级后退。
- 元数据（reasoning / contextWindow / cost / thinkingLevelMap）以 `~/.pi/agent/models.json` 或 `$ROUTER_MODEL_DEFS`
  指向的私有文件为准；包里那份只是占位符示例，不含任何真实路由器清单、机器命名或 baseUrl。

## 安装

### 1) 装成 Pi 包（推荐，适合第二台电脑）

```bash
pi install git:github.com/<you>/pi-router-picker        # 或 npm:@zhoudians/pi-router-picker
# 本地开发时：
pi install ./src/pi-router-picker
```

装完在 TUI 里执行一次 `/reload`（builtin 命令，会重载 extensions/skills/themes）。

### 3) 开发者：把仓库软链进扩展目录（本机开发只维护一份源码）

```bash
for f in router-picker.ts router-models.json; do
  ln -s "$PWD/extensions/$f" ~/.pi/agent/extensions/$f
done
```

Pi 会跟随软链，`import.meta.url` 旁边的示例元数据也照常解析得到。

### 2) 单文件拷过去（不想装包）

```bash
cp extensions/router-picker.ts extensions/router-models.json ~/.pi/agent/extensions/
```

两个文件必须放在一起：扩展用 `import.meta.url` 旁边的 `./router-models.json` 作为默认元数据来源。

## 配置（三层叠加，后者覆盖前者）

| 项 | 环境变量 | models.json 里的位置 | 说明 |
|---|---|---|---|
| provider id | `ROUTER_PROVIDER_ID` | providers 只有 1 个 key 时自动用它 | 默认 `router` |
| baseUrl | `ROUTER_BASE_URL` | `providers.<id>.baseUrl` | 必填，不带结尾 `/` |
| apiKey | `ROUTER_API_KEY` | `providers.<id>.apiKey`（支持 `$ENV`/`${ENV}`） | 必填，否则跳过注册 |
| 元数据 | `ROUTER_MODEL_DEFS=/path/x.json`，置空串禁用 | `providers.<id>.models` | 两者都优先于包内占位符示例 `extensions/router-models.json` |

**第二台电脑最小配置：**

```bash
export ROUTER_BASE_URL=http://your.router.local:3425/v1
export ROUTER_API_KEY=sk-your-router-key
pi
```

不用碰 `models.json` 也能用；有 `models.json` 条目时它优先于包内示例，方便你按机器微调。

参考模板见 `models.example.json`（把 `REPLACE_WITH_YOUR_PROVIDER_ID` 换成你的 provider id）。

## 上传前注意（脱敏清单）

仓库里 **不含** 这些，别提交进去（已在 `.gitignore` 里）：

- `~/.pi/agent/models.json` —— apiKey 是明文写的
- `~/.pi/agent/auth.json`、`settings.json`、sessions/

包内 `extensions/router-models.json` 只有 `gpu01/ api01/` 这类占位符模型和 `your.router.local`
占位域名，不含真实模型清单、机器命名或 baseUrl。你自己调好的元数据请留在不提交的 `~/.pi/agent/models.json`
里（或私有文件 + `ROUTER_MODEL_DEFS=/path/private-models.json`），整份示例删掉也不影响功能：
router 上新出现的 id 会自动继承同前缀模板，兜底默认是 `contextWindow 128K / maxTokens 16K / reasoning false`。

## 已知行为与限制

- Pi 在注册扩展 provider **之前**就跑过首轮 catalog refresh，所以本扩展在 `session_start` 里强制刷一次
  （和内置 llama.cpp 扩展同样的做法）；刷新超时 15s，失败只提示、不换模型。
- router 的 `GET /v1/models` 需要鉴权时会返回 401，本扩展带上解析出来的凭据（优先用 Pi 已解析的
  `ctx.credential.key`）。
- 新出现但没在元数据里的模型走兜底模板（同前缀模型的 reasoning/contextWindow/cost → 否则 128K/16K/false），
  想精确就在 `models.json` 加一条同名 entry，下次刷新自动生效。
- `PI_OFFLINE=1` 时不发网络请求，列表等同静态元数据（离线可用）。
- 用环境变量提供 baseUrl/apiKey 时，会把它们显式交给 Pi 的 provider 配置（Pi 会拒绝「没有任何认证方式」
  的 provider，请求鉴权也依赖它）；从 `models.json` 读到时则不覆盖，保持 models.json 权威。
- 官方 `llama.cpp` 集成（`/login llama.cpp` + `/llama`）能加载/卸载 GGUF；本扩展只做「列出并选择」，
  不负责加载模型。
