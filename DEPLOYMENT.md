# 部署规则

- 本项目部署到 **阿里云 ECS**（服务器目录名 `AutokeyProject`）。
- 当用户提到“部署”“发布”“上线”或相关操作时，默认走下面的阿里云 ECS 流程。
- **不要使用、配置或建议 GitHub Pages 或 Vercel**。

## 部署目标

| 项 | 值 |
| --- | --- |
| 服务器 | `root@39.96.61.144` |
| SSH 私钥 | 仓库根目录 `OpenClaw.pem` |
| 应用目录 | `/www/wwwroot/39.96.61.144/AutokeyProject/app/` |
| 媒体目录 | `/www/wwwroot/39.96.61.144/AutokeyProject/media/` |
| 线上入口 | `https://palewinds.com/autokey/` |

## 部署步骤

在 `autokey/` 目录执行：

1. 构建前端产物：

   ```bash
   npm run build
   ```

   产物在 `autokey/dist/`（`vite.config.js` 的 `base` 已设为 `/autokey/`，与线上路径一致）。

2. 上传并原子替换线上应用目录：

   ```bash
   scp -i ../OpenClaw.pem -r dist root@39.96.61.144:/www/wwwroot/39.96.61.144/AutokeyProject/_app_new
   ssh -i ../OpenClaw.pem root@39.96.61.144 "rm -rf /www/wwwroot/39.96.61.144/AutokeyProject/app && mv /www/wwwroot/39.96.61.144/AutokeyProject/_app_new /www/wwwroot/39.96.61.144/AutokeyProject/app"
   ```

3. 同步推到 Git 存档（当前分支）：

   ```bash
   git add -A
   git commit -m "deploy: <本次改动说明>"
   git push origin <当前分支>
   ```

## 注意事项

- nginx 已把 `/autokey/` 指向上面的 `app/`，并通过 `try_files` 回退到 `index.html`，无需生成 `404.html`（那是 GitHub Pages 的做法）。
- `.env`、`OpenClaw.pem`、`node_modules`、`dist` 严禁提交到 git：`.env` 与 `dist` 已在 `.gitignore` 中忽略，`OpenClaw.pem` 是 SSH 私钥，`git add` 前务必确认不纳入版本控制。
- 部署到阿里云的同时，必须同步 push 一份到 git 作为存档。
