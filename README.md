# 剧场灯光 Cue 表编排器（gbcuesheet）

面向剧场灯光师与舞台监督的纯前端单页应用：把一台演出的**场次**、**灯位通道**与 **Cue 提示点**串成可执行的灯光编排，记录亮度、色温与过渡时间，并在排演后导出排演表。数据全部保存在浏览器本地，不依赖任何后端服务、数据库或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:21803**

常用命令：

```bash
docker compose logs -f          # 查看日志
docker compose down             # 停止并移除容器
docker compose up -d --build    # 改动代码后重新构建
```

> 端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 `21803` → 容器 `80`）；项目名由 `COMPOSE_PROJECT_NAME` 控制（默认 `gbcuesheet`，同时作为容器名前缀 `${COMPOSE_PROJECT_NAME}-frontend`）。

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（Composition API + `<script setup>`） | 全部页面为 SFC 单文件组件 |
| 语言 | TypeScript（`strict`，无 `any`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Naive UI（暗色剧场主题） | 按需引入组件，无全局注册 |
| 构建工具 | Vite 6 | 路由级代码分割 + 依赖单独 vendor 分块 |
| 状态管理 | Pinia | 6 个 store，页面只读 store |
| 路由 | Vue Router 4（history 模式） | nginx `try_files` 做 SPA 回退 |
| 本地存储 | IndexedDB（Dexie 4 封装） | 含数据结构版本号与升级迁移逻辑 |
| 部署 | 多阶段 Dockerfile（node:20-alpine + nginx:alpine） | 构建期类型检查零错误 |

## 三、核心功能与路由

| 路由 | 页面 | 主要能力 | 消费模型 |
| --- | --- | --- | --- |
| `/sessions` | 场次编排 | 新建场次、上下调序、查看每场 Cue 数与过渡总时长、硬切衔接预警 | Session、Cue |
| `/sessions/:id/fixtures` | 灯位通道配置台 | 通道号排布、灯具编号、按灯位分组折叠、重复通道号高亮、灯位负载校验 | Fixture、Session |
| `/sessions/:id/console` | 控台配接包对账 | 导入控台包、按控台身份锚定灯具、换号/通道争用/电平缺失逐项对账 | ConsoleImportJob、Fixture、CueLevel |
| `/sessions/:id/cues` | Cue 编排时间轴 | 插入 / 复制 / 删除 Cue、拖拽调整先后、沿袭上一条参数、批量偏移过渡时间 | Cue、CueLevel |
| `/cues/:id/levels` | 通道电平编辑 | 逐通道设定亮度与色温、色温漂移检查、一键对齐基准色温 | CueLevel、Fixture |
| `/sheets` | 排演表生成与导出 | 勾选 Cue 组表、本地留存历史、预览 / 复制 / 下载纯文本 | RehearsalSheet、Cue |

核心动作闭环：**建场次 → 配灯位通道 → 插入 Cue → 设定过渡与通道电平 → 导出排演表**。

## 四、本地开发

```bash
cd frontend
npm install
npm run dev        # 开发服务 http://localhost:21803
npm run build      # 类型检查 + 生产构建（产物在 frontend/dist）
npm run preview    # 预览构建产物 http://localhost:21803
```

要求 Node.js ≥ 20。

## 五、目录结构

```
sologsb-1103/
├── docker-compose.yml          # 顶层 name: gbcuesheet，无 version 字段
├── Dockerfile                  # 多阶段：node:20-alpine 构建 + nginx:alpine 托管
├── nginx.conf                  # SPA fallback（try_files）+ gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    └── src/
        ├── main.ts                 # 启动时先把本地数据载入 Pinia，再挂载视图
        ├── App.vue                 # 暗色主题外壳 + 侧边导航 + Message/Dialog Provider
        ├── types/                  # 5 个数据模型，一模型一文件
        │   ├── session.ts  fixture.ts  cue.ts  level.ts  sheet.ts
        ├── stores/                 # Pinia：跨页状态唯一来源
        │   ├── sessionStore.ts  cueStore.ts  fixtureStore.ts
        │   ├── levelStore.ts    sheetStore.ts
        ├── components/common/      # 共享组件
        │   ├── FadeBar.vue      # 渐变条：渐亮/保持/渐暗按比例绘制
        │   ├── ChannelChip.vue  # 通道标签：通道号 + 灯位色块 + 亮度百分比
        │   ├── BlankHint.vue    # 空态引导与新建入口
        │   └── CueNoInput.vue   # Cue 编号输入与重号校验（支持 Q12.5）
        ├── hooks/
        │   ├── useCueOrder.ts        # 按 cueNo 排序、重排落库、相邻过渡汇总
        │   └── useChannelConflict.ts # 重复通道号与灯位过载检测
        ├── components/
        │   ├── common/              # FadeBar / ChannelChip / BlankHint / CueNoInput
        │   └── console/
        │       └── ConsoleReconcile.vue # 控台包对账工作台（身份 / 换号 / 争用 / 电平选定）
        ├── pages/
        │   ├── SessionList.vue  FixtureBoard.vue  ConsoleImport.vue
        │   ├── CueTimeline.vue  LevelEditor.vue   SheetList.vue
        ├── router/index.ts
        └── utils/
            ├── fade.ts             # 过渡时间格式化、色温一致性判定、排演表纯文本拼装
            ├── db.ts               # IndexedDB（Dexie）封装：版本号与升级迁移
            ├── export.ts           # 文本下载、文件名生成、剪贴板复制
            ├── cueOrder.ts         # Cue 编号解析、比较、排序与位次计算
            ├── patch.ts            # 通道冲突 / 灯位负载纯函数
            ├── consolePackage.ts   # 控台配接包解析、严格校验与 SHA-256 内容哈希
            ├── reconcile.ts        # 对账纯函数：身份锚定、差异 / 争用检测、写入计划
            └── id.ts               # 本地主键生成
```

## 六、数据存储说明

- 所有数据存放在**浏览器本地 IndexedDB**，数据库名 `gbcuesheet`，由 `src/utils/db.ts` 用 Dexie 统一封装；页面不直接读写数据库，只调用 store 的 action。
- 共 7 张表：`sessions`、`fixtures`、`cues`、`levels`、`sheets`、`appMeta`（元数据）、`importJobs`（控台配接包与对账进度）。
- **数据结构版本号**：`DB_VERSION = 3`。`version(1)` 定义初始结构；`version(2)` 新增 `updatedAt` / `sheetNo` 索引、`appMeta` 表，并在 `upgrade()` 中迁移既有数据（补齐 `updatedAt`、`orderIndex`、`holdSec`，规范化遗留排演表编号与条目快照）；`version(3)` 给 `fixtures` 增补灯具编号 `fixtureNo` 与控台身份锚点 `consoleUid`，新增 `importJobs` 表并回填既有灯具的新字段。
- 删除场次会级联清理其灯位通道、Cue、通道电平、排演表与控台导入任务；删除通道会清理对应的电平记录。
- **容器无状态**：不使用数据库服务、不挂载命名卷；换浏览器或清理站点数据即等于清空。排演表以生成时刻的快照留档，之后修改 Cue 不影响历史记录。

## 六之二、控台配接包对账（转场后）

转场换台后，把灯光控台导出的配接包导入，与本地 Cue 表对账。职责边界严格分离：

- **控台包只提供现场事实**：灯具编号（`fixtureNo`）、DMX 通道（`channel`）、各 Cue 下的亮度（`intensity`）与色温（`colorTempK`）。
- **本地 Cue 表保留编排决定**：场次、提示语、触发方式、渐亮 / 渐暗 / 保持等过渡时间一律不被读取或覆盖；本地缺少同号 Cue 时只列差异，绝不自动新建 Cue。

身份对应规则：

- 每盏控台灯带稳定身份 `uid`；首次导入按「控台通道、再灯具编号」给出本地候选，可手工改选。
- 一旦写入，本地 `Fixture.consoleUid` 锚定该身份。**重新导入沿用同一身份**，即使控台改了通道号或编号也不会按通道号硬盖到别的灯。
- 遇到**换号、通道争用、电平缺失（含本地无电平、控台黑场、控台未报色温）**，页面先并列展示控台与本地双方数据，人工选定（用控台 / 保留本地 / 跳过 / 黑场删本地）后才允许写入；争用未消解时阻断落库。
- 灯具的灯位方位、灯具类型、色纸、对焦说明等编排字段不在对账覆盖范围，始终保留本地值。

失败与重试：

- 导入任务（含配接包原文、解析结果、对账报告与人工选定进度）持久化在 `importJobs` 表；解析失败或写入失败都保留任务与进度，可随时重试同一包。
- 幂等键为「场次 id + 原文 SHA-256」：重复导入同一包（哪怕换文件名）只会打开既有任务，不重复生成记录；对账写入按 `(cueId, fixtureId)` 与灯具 id 幂等，重试不产生重复数据。

配接包格式（`gbcuesheet/console-patch` `1.0`，UTF-8 JSON）：

```json
{
  "kind": "gbcuesheet/console-patch",
  "format": "1.0",
  "source": "场馆B / 控台主机1",
  "exportedAt": "2026-10-01T19:30:00.000Z",
  "fixtures": [
    { "uid": "desk-uid-1", "fixtureNo": "L12", "channel": 12, "fixtureType": "成像灯" }
  ],
  "cues": [
    { "cueNo": "Q12.5", "levels": [ { "fixtureUid": "desk-uid-1", "intensity": 80, "colorTempK": 3200 } ] }
  ]
}
```

> `uid` 必须在包内稳定且唯一；`intensity` 取 0-100（0 表示黑场）；`colorTempK` 可省略，省略即视为该通道色温缺失，对帐时需人工确认。解析器会对结构、取值范围与引用完整性做严格校验，非法包不落任何对账记录。

## 七、容器化实现要点

- `Dockerfile` 多阶段构建：构建阶段 `node:20-alpine` 执行 `npm ci` + `npm run build`（含 `vue-tsc` 类型检查，任何类型错误都会中断镜像构建）；运行阶段 `nginx:alpine` 托管 `dist`。
- `nginx.conf` 开启 gzip（含 `text/css`、`application/javascript`、`image/svg+xml` 等），`location /` 使用 `try_files $uri $uri/ /index.html;` 支持前端路由直接访问与刷新，带 hash 的静态资源长缓存。
- `docker-compose.yml`：不写 `version:` 字段；顶层 `name: gbcuesheet` 兜底（避免中文目录名导致项目名为空）；`container_name: ${COMPOSE_PROJECT_NAME:-gbcuesheet}-frontend`；端口映射 `"${FRONTEND_PORT:-21803}:80"`。
- 首次启动前需 `cp .env.example .env`，之后 `docker compose up -d --build` 一条命令即可起服务。
