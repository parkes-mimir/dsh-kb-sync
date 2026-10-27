# dsh-kb-sync

把 [dsh](https://github.com/deepseek-ai) 的 mnemon 记忆空间变成**跨设备共享知识库**的插件：
每个空间可选 `local`（只留本机）或 `cloud`（双向同步），写入即推送，hub 收到推送后**主动通知**其它设备拉取。

只依赖三样东西：`dsh-mnemon`（记忆空间）、**Mnemon Native** 的 `mnemon` CLI、`git`。

---

## 前置依赖与许可证

本插件**不包含也不重分发任何上游代码**，只通过公开接口调用它们。

| 依赖 | 作用 | 许可证 | 链接 | 验证版本 |
|---|---|---|---|---|
| **DeepSeek Harness**（`@deepseek-ai/dsh-*`） | 宿主运行时；本插件注册工具、监听 `tools/result` 事件 | **MIT** | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | 0.2.1-alpha.2 |
| **dsh-mnemon** | 提供 Memory Space（记忆空间）的读写与注册表 | **MIT**（© 2026 dsh-external contributors） | [omdsh-dev/dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) | 0.5.28 |
| **Mnemon Native**（`@mnemon-dev/mnemon`） | 本地记忆库；插件通过 `mnemon` CLI 做 `store create` / `import` / `forget` | **Apache-2.0** | [mnemon-dev/mnemon](https://github.com/mnemon-dev/mnemon) | 0.2.10 |
| **git** | 传输层（push / pull / hook） | **GPL-2.0** | [git-scm.com](https://git-scm.com/) | 2.47+（hub）/ 2.55（本机） |
| **Node.js** | 运行时；读 SQLite 用内置 `node:sqlite` | **MIT** | [nodejs.org](https://nodejs.org/) | ≥ 22（本机 24.20） |

许可兼容性说明：

- 本插件用 **MIT**。MIT 与 MIT/Apache-2.0 都是宽松许可，组合分发无需开源本插件之外的代码；
- Apache-2.0 的 mnemon 只以**独立进程**（CLI）被调用，不产生衍生作品，也不要求本仓库附带其 NOTICE；
- git 是 GPL-2.0，但同样只是被 `child_process` 当外部程序执行，不链接、不随本仓库分发；
- 仓库里唯一的第三方文本是 README 中的链接与版本号，没有拷贝任何上游源码或文档正文。

---

## 它解决什么

默认的 mnemon 记忆是**单机**的：每台机器各记各的，同一件事要在不同设备上重复总结。
官方的 Pack 同步是**整库粒度**——两台设备都写过同一个空间时，合并会把空间 fork 成新的 UUID 空间，路由全乱。

本插件的做法是**洞察粒度**的并集：

- 一条记忆的身份是 `sha256(content)[:32]`，同一事实在任何设备、任何次数只存一份；
- 仓库按 `spaces/<space>/<device>.jsonl` 分片，每台设备只写自己的分片，天然无冲突；
- 空间 id 由仓库目录决定，**不会 fork**；
- 删除用 tombstone 广播，不会「删了又复活」。

---

## 事件链（没有轮询）

```
① 写入记忆
   dsh 的 tools/result 事件（mnemon_remember / forget / link / memory_body_* / document_*）
   └─ 1.5s 去抖 → git push

② hub 收到推送
   git 的 hooks/post-receive（推送落地这一刻由 git 调用）
   └─ POST /publish {rev} → 唤醒所有挂起的 /wait

③ 各设备拿到新 rev
   /wait 返回 changed=true → git pull → 应用新条目
```

- 写入来源两种都覆盖：dsh 工具事件（`tools/result`），以及**文件系统事件**（`fs.watch`/inotify，兜住 CLI、迁移脚本、其他进程直接写库）；
- 设备侧只维持**一个挂起的 HTTP 请求**，不轮询磁盘、不轮询服务端；
- 服务端只在启动时读一次 HEAD，之后完全由钩子驱动；
- 兜底的 `intervalMinutes` 对账是可选项（默认 30 分钟，设 0 关闭），不是主链路。

---

## 安装

### 1) 放进 dsh profile

```bash
git clone https://github.com/parkes-mimir/dsh-kb-sync.git ~/.dsh/plugins/dsh-kb-sync

# profile 里登记：依赖 + 软链
cd ~/.dsh/profiles/<profile>
npm pkg set dependencies.dsh-kb-sync="link:$HOME/.dsh/plugins/dsh-kb-sync"
ln -sfn "$HOME/.dsh/plugins/dsh-kb-sync" node_modules/dsh-kb-sync
```

把 `examples/cordis.patch.yml.snippet` 的内容追加到该 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: kb-sync
      name: dsh-kb-sync
      config:
        intervalMinutes: 30
        device: my-laptop
```

> ⚠️ 新插件必须写在 `- insert:` 下面。写成顶层 `- id:` 会被当作「修改已有行」，没有对应行就静默跳过。

重启 dsh 后生效。设备名 `device` 会作为分片文件名，**每台机器要不一样**。

### 2) 配服务器

```text
kb_config  action=set  remote=ssh://mnemon@10.0.0.5/home/mnemon/mnemon-sync.git  device=my-laptop
```

支持 `ssh://`、`https://`（token 走 URL 或 credential helper）以及本地绝对路径（测试用）。
设置后会立即 clone、建库、登记空间，并开始挂 `/wait`。

---

## 工具

| 工具 | 作用 |
|---|---|
| `kb_config` | `get` / `set`：remote、device、intervalMinutes、branch |
| `kb_space` | `list` / `create {space,mode,name,description}` / `mode` / `enable` / `disable` |
| `kb_status` | 每个空间的 mode、enabled、本机条数、仓库条数、missingLocal、onlyLocal、lastSync |
| `kb_sync` | 立即同步（仅 cloud + enabled） |
| `kb_pull` | 只拉不推 |

### 空间策略

- `cloud`（默认）：本地写入会上传；对端会拉到。
- `local`：**永不上传**，仓库里不会出现这个空间。
- `disable`：该空间不拉不推；重新 `enable` 后补齐（关闭期间的本地写入会补传）。

策略存在 `<dataDir>/state/kb-sync.json`，随设备本地，不进仓库。

---

## hub 搭建（自托管）

任何一台有 sshd 的 Linux 都行，推荐走 ZeroTier/Tailscale 内网。

```bash
# 服务器：专用用户 + bare 仓库
useradd -m -s /bin/bash mnemon && usermod -L mnemon
install -d -m 700 -o mnemon -g mnemon /home/mnemon/.ssh
cat >> /home/mnemon/.ssh/authorized_keys <<< 'restrict,from="10.0.0.2" ssh-ed25519 AAAA...'
chown mnemon:mnemon /home/mnemon/.ssh/authorized_keys && chmod 600 /home/mnemon/.ssh/authorized_keys
su - mnemon -c 'git init --bare --initial-branch=main ~/mnemon-sync.git'
chsh -s /usr/bin/git-shell mnemon          # 只能跑 git，拿不到 shell

# 通知服务 + post-receive 钩子
sudo ./hub/install-hub.sh /home/mnemon/mnemon-sync.git
```

最后在各设备仓库根写一份 `notify.json`（插件 pull 后自动读取）：

```json
{ "url": "http://10.0.0.5:7392", "token": "<install-hub.sh 打印的 token>" }
```

---

## 安全

- **仓库里是明文记忆**（密码、API key、本机路径）。hub 必须是自有且受控的机器；
  要更强就上 `git-crypt`（客户端加密，hub 只存密文）或给仓库单独开 LUKS 卷。
- `/wait` 只靠 token 鉴权，建议把端口限制在内网段：
  `nft add rule inet filter input ip saddr != 10.0.0.0/24 tcp dport 7392 drop`
- 设备私钥建议加 passphrase；hub 账号用 `git-shell` + `restrict,from=` 收敛爆炸半径。
- 不要把 `~/.mnemon` 交给 Syncthing/网盘：SQLite 的 `-wal`/`-shm` 按文件同步会拼出坏库。

---

## 卸载

```text
1) cordis.patch.yml 删掉 kb-sync 那段（或加 disabled: true）
2) rm ~/.dsh/profiles/<profile>/node_modules/dsh-kb-sync
   并从 package.json dependencies 删掉 dsh-kb-sync
3) 重启 dsh
```

本地记忆空间与其数据不受影响。

---

## 已知限制

- 写入到推送约 1–2 秒（去抖）；跨设备到可见取决于对端 `/wait` 的连接状态，通常 1–3 秒。
- `/wait` 55 秒超时后客户端会重新挂起（长轮询的保活，不是轮询查询）。
- 同一空间允许两地在离线时各写各的：合并后是并集，**语义重复**需要人工或定期按 `h` 去重。
- 仅同步**洞察**；hot memory（USER.md / MEMORY.md）与 Documents 暂不同步。

MIT License.
