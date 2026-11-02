# 发布流程（Release / Publish）

本仓库**不发布到 npm registry**。发布 = 一个改了版本号、打了 tag 的 commit 推到 `main`，加上（必要时）一次市场条目 PR。

## 一、发版

```sh
# 1. 全绿再发（仓库根目录跑）
npm install --no-audit --no-fund
npm test

# 2. 改版本：package.json 的 version + CHANGELOG.md 顶部新增一节
#    规则：新增能力 → minor；只有修复 → patch；破坏兼容 → major

# 3. 提交并打标签
git add -A
git commit -m "chore: X.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z: <一句话>"
git push origin main
git push origin vX.Y.Z
```

**市场条目按仓库 URL 抓取根 `package.json`**，所以 `version` 字段就是市场页显示的版本；`description` 字段是市场列表里的简介。两者改完推送即可生效，不需要额外动作。

## 二、市场条目（要改简介或分类时）

条目在 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库的 `data/plugins/643048695__dsh-subagent-role-router.yml`：

```yaml
url: https://github.com/643048695/dsh-subagent-role-router
name: 643048695/dsh-subagent-role-router
category: model
description:
  en: "..."
  zh: "..."
```

改这个文件 → 提 PR。`category` 只能是市场既有的分类名。

## 三、推送网络

本机直连 GitHub 不通，代理在 `127.0.0.1:7890`：

```sh
git -c "http.https://github.com.proxy=http://127.0.0.1:7890" push origin main
```

`curl` 抓 raw 同理加 `-x http://127.0.0.1:7890`。

## 四、发版前自查

- [ ] `npm test` 全绿（232 项，2 项 `real-directory` 环境跳过属正常）
- [ ] `grep -rn "C:/Users\|/Users/" lib test tools package.json` 无命中（`test/no-hardcoded-paths.test.mjs` 也会拦）
- [ ] `package.json` 的 `version` 与 `CHANGELOG.md` 顶部条目一致
- [ ] 新增文件已 `git add`（CI 的 manifest job 会检查 `dsh.bundle.patch` 指向的文件存在）
- [ ] 图标仍是 `icons/plugin-icon-128.png`（市场列表用它）

## 五、CI 会做什么

`.github/workflows/ci.yml`：ubuntu / windows / macos × node 20 / 22 跑 `npm install` + `npm test`；另有一个 manifest job，断言 `package.json` 里有 `dsh.bundle.patch`、该文件存在、`main` 入口存在、patch 文件里出现了包名。任一失败就红。

## 六、装错版本时怎么回退

插件装在 `~/.dsh/profiles/desktop/plugins/dsh-subagent-role-router/`（开发时可能是 `link:`）。改坏了的处理顺序：

1. `git -C <仓库> checkout vX.Y.Z` 回到上一个 tag，重装；
2. 客户端改动只需重载：往 `~/.dsh/profiles/desktop/cordis.patch.yml` 追加一行 `#` 注释，几十秒后看 `~/.dsh/live-route-debug.log` 出现 `CLIENT_BUNDLE_LOADED`；
3. 后端（`lib/index.js`）有改动时，重载会清掉内存中的模型覆盖，先确认这不影响你手头的会话。
