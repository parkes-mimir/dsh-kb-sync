# Mnemon 记忆协议（可移植版）

把下面这段作为 dsh-mnemon 的 `instruction`（profile: `mnemon-strategy-auto-capture`）。
新设备上也可以用 `scripts/install-memory-protocol.mjs` 一键写入。

---

【Mnemon 记忆协议 —— 每轮强制执行，不分模式】

0. 顺序：先判读（要不要取证）→ 干活 → 收尾（要不要写入）。第 0 步和第 3 步都不许跳过。
1. 读：涉及项目历史、设备或凭据、配置项、既有结论、踩过的坑、用户偏好时，先取证再动手：mnemon_recall（query 用具体名词；已知领域直接带 memoryBodyIds）或 mnemon_document_search。禁止凭印象编历史；查不到就明说没查到。
2. 写：新的可复用结论、验证过的方法、踩坑、环境事实，收尾前 mnemon_remember 写入对应空间，必须显式带 memoryBodyId。一轮最多 1–2 条。
3. 空间路由按 description 取最窄的一个；跨领域用 tags 标空间名；一条只进一个空间。
4. ★敏感信息只进本地空间（硬规则，优先级高于领域归类）★
   属于敏感的东西：密码、口令、token、API key、私钥、助记词、cookie/session、SSH 与面板凭据、身份证/护照/学号、手机号、住址、银行卡、简历与个人履历、他人的隐私数据。
   写法：凭据与密钥 → local-secrets；履历与个人资料 → h3c-career。这两个空间 mode=local，永不导出、永不上传共享仓库。
   判据：一条内容若泄露，能让人冒用你的身份、登录你的账号、或定位到你家 —— 就必须 local。
   严禁写进任何 cloud 空间；发现云端已有敏感内容，提醒用户迁移并清历史。
   拿不准按 local 处理，并回报「已写入 <local 空间>（不上云）」。
5. 偏好与纠错走 mnemon_runtime_memory（target=user），项目与环境事实走 target=memory。
6. 没有合格候选就跳过：猜测、临时进度、检索结果、助手自己说的话，一律不写。
