# 行為保持型結構重構 v1 規格

> 狀態：已鎖定（2026-07-15）；frontend/editor 與 backend repo-reality review 均為 lock-ready。
> 基線 commit：`9b6ed36`；實作 branch：`refactor/structural-optimization-v1`。
> 本規格只改程式結構、重複計算與載入邊界；產品功能、資料與輸出契約不變。

## Verdict

Decision：以可回退的小切片拆解編輯器、一般前端與後端的責任聚集，並移除已證明無消費者的
相容層；所有外部行為由既有測試、characterization tests 與實際瀏覽器操作釘住後才搬動。

- 不做一次性 rewrite。既有 import 面先由 barrel／facade 相容，再逐步搬 consumer。
- 優先處理同時改善結構與 runtime 的兩點：layout graph 每份 layout 只建一次，以及 camera／gesture
  不再使整個 `TemplateEditor` 每幀重 render。
- 模板仍由使用者明確按儲存；新增／刪除頁面只改前端 draft，儲存前不得更新 DB。
- PhotoManager 保留自動儲存產品行為，但改為不可 abort、單航班序列化；已開始的 upload 不因新操作取消。
- 不以檔案行數作成功條件；成功條件是依賴方向、單一責任、無重複工作與行為驗收。

本 phase 不建立 generic repository、leaf plugin、mega context、schema-driven router 或通用 workflow framework。

## Problem

- `TemplateEditor` 同時持有文件、history、selection、commands、素材分析、camera、Konva scene 與三種
  responsive shell；camera／group transform 的 transient state 會牽動整頁 render。
- `layoutGroups.js` 混合 contract、validation、graph、query、geometry、command 與 transform；多個 query
  會各自重建並驗證同一份 graph。
- `PhotoManager` 自行維護 debounce、dirty snapshot、upload/retry、mapping 與完成回寫，進行中的 save
  沒有序列化契約。
- 後端 route 普遍承擔 transaction、Storage 與 use-case；`project_service.py`、`storage.py`、
  `roster_service.py` 與 template sync plan 各自混合多個生命週期。
- 大型測試檔、API 相容 barrel、未使用元件與重複 guide generator 增加搜尋與修改面積。

## Scope

In scope：

- 前端 foundation：死碼／舊 barrel、API domain、roles／permissions、測試檔、共用小型 primitives。
- 編輯器 domain：layout group 模組邊界、單次 editor model、Canvas 邊界、node preview lifecycle、
  selection／clipboard／shortcut／document hooks 與重複 chrome。
- 照片流程：transform／payload pure helpers、共用 retry、序列化 photo autosave、Wizard 與 modal 分責。
- 一般頁面：Class／Student 共用排版殼、ProjectReview 分責、route lazy loading 與顯式 prefetch。
- 後端：paths/config、Storage adapters、project/roster/export services、route use-cases、layout validator／
  traversal 分責，以及 typed template sync plan。
- 測試與工具：unit／pytest 分檔、正式 snapshot 測資 API、guide generation 共用基礎設施、文件同步。

Boundary：本 phase 可新增內部 modules、hooks、dataclasses 與測試 helper；不得新增或刪除產品 API、DB
column/table、layout 欄位、storage key 規則、角色能力或使用者可見操作。

## Architecture Model

### Frontend editor

```text
TemplateEditor（route orchestration）
├─ useTemplateEditorDocument（load/draft/history/explicit save/CAS）
├─ useEditorSelection（selection/hover/isolation/reconcile）
├─ editor commands（pure layout operations + thin UI adapters）
├─ TemplateCanvas（camera/stage/gesture ownership）
│  └─ CanvasArtwork（memoized model + CanvasNode preview lifecycle）
└─ Editor chrome（topbar/workspace/inspector/mobile shell）
```

`editorLayoutModel.js` 的 `buildEditorLayoutModel(layout)` 對同一 immutable `pageLayout` identity，由
`TemplateEditor` 的 `useMemo` 每次 render tree只建立一次；不建立全域 WeakMap cache。Model至少持有既有
graph、root/visible render nodes與flattened leaves。內部分模組只import concrete module，不經barrel互引；
graph-aware query不得再驗證，舊 layout-based exports暫留相容 wrapper。

Camera live state、單一Stage、`#page-camera`、camera sibling Transformer、zoom toolbar與全部visual/control
nodes由 `TemplateCanvas` 擁有。它提供穩定 imperative surface：`fit()`、`zoomBy(factor)`、
`getViewportCenterPagePoint()`與只讀camera snapshot。pointer／pinch frame只更新Konva/ref，不更新
`TemplateEditor` state；只有gesture end可向父層提交一次layout。既有group雙節點id、inverse typography
compensation、`data-guide` selectors、跨頁camera保留及767/768/1024 selection不重置契約不變。

### Photo save lifecycle

```text
dirty snapshot → debounce → serialize behind active run
→ upload pending files（不可 abort，有限重試，立即寫入snapshot格位）
→ update server shadow → reconcile desired mapping
→ if newer dirty exists, run again
```

- 每個pending file有stable `pendingUploadId`；每格另存最後已知server-shadow binding。同一學生同一時間最多
  一個run。upload回應即使已stale也先更新snapshot格位shadow，再由最新desired items產生mapping，補償
  upload期間的move/delete/replace；不能只忽略stale response。
- 新操作不覆蓋進行中snapshot，也不取消已開始upload；回寫UI以token identity guard，較新dirty排下一輪。
- upload POST與mapping PUT任一revision conflict都以`projectId/studentId/revision`為pause key，保留pending
  token、dirty與server shadow，觸發既有revision recovery；新revision載入後才resume。
- `isBusy`從dirty進入debounce起直到clean/conflict，ScopeSwitcher沿用現況阻擋。`beforeunload`仍提示；
  本phase不新增SPA modal。unmount時取消timer但立即把queued snapshot交給framework-neutral coordinator，
  active/queued request以原session key完成、停止React callbacks，不得silent drop或回寫新學生畫面。
- coordinator接受fake upload/mapping/retry scheduler，Node unit以deferred promises驗證single-flight、latest-wins、
  stale-slot補償、retry、conflict pause與detached completion；Playwright再驗一個真實延遲收斂案例。

### Backend layering

```text
router（dependency + HTTP mapping）
→ use-case service（permission order + transaction + locks）
→ domain/persistence/storage helpers
```

- `app_paths.py` 是 backend path 的 owner；renderer 與 Storage 都依賴它，Storage 不得反向 import renderer。
- `storage.py` 保留 `StorageAdapter`、Local/R2 adapter 與 `get_storage` 的相容 exports；實作分至
  base/cache/local/r2/factory modules。env 仍在呼叫時讀取，不建立 import-time frozen settings singleton。
- `project_service.py` 先作 facade；archive、output key、label merge、student render、export 分模組。
- route 下移不得改變鎖前／鎖內重新授權、refresh、rollback、commit 或 storage cleanup 的既有順序。
- template sync 的鎖前 plan 與鎖內重算保留兩次；只把隱含 dict state 改為 dataclass 與純計算步驟。
- 後端 mutation inventory、path monkeypatch、module DAG、lock owner、typed sync state 與 render fingerprint
  的精確契約見 [後端重構契約附錄](structural-refactor-v1-backend-contracts.md)。附錄是實作前置條件。

## Data/API/Save Contracts

- DB schema、migration list、OpenAPI path/method、request/response body、status code與 Cookie/Bearer 行為不變。
- `layout_json`、group v1/v2、world geometry、正式 render order 與 malformed fallback 依
  [巢狀群組 v2](illustrator-style-nested-groups-v2.md)；不得加入 editor model/camera state。
- 手機 viewport、touch、save 與 breakpoint 依
  [手機版模板編輯器 v1](mobile-template-editor-v1.md)。
- PIL／Konva compensation、design tokens 與 output naming 值不改。因 traversal source 拆檔，render
  pipeline fingerprint 允許一次性改變並使既有 preview cache失效；新 source 必須全部進 fingerprint。
- Template save 維持 full-page snapshot + revision/CAS；save request 進行中產生的新 draft 必須保留。
- project/student 文字 autosave 的 debounce/abort/flush 行為不改；photo upload 使用本規格的不可 abort
  序列化契約，不直接套用現有 abortable `useAutoSave`。
- Storage local/R2 env、cache、namespace、path traversal、proxy/redirect policy 與 immutable photo key 不變。
- deprecated template page endpoints 本 phase 不刪；測資改走 snapshot API 後只留 compatibility tests。

## Parallel Ownership

| Lane | 擁有範圍 | 禁止同波次修改 |
|---|---|---|
| Editor | `TemplateEditor`、canvas/editor components、layout group frontend domain、editor E2E | API、一般頁面、backend |
| Frontend core | API、permissions/roles、PhotoManager/Wizard、Class/Student/Review、unit harness、App routes | editor domain、backend |
| Backend | `backend/`、`tests/`、backend contract scripts | frontend、guide generators |
| Integrator | 本 spec、文件地圖、跨 lane 文件、guide generators、最終 gates | 不在 agent 執行中改其 owned files |

Agent 不得 commit、不得 stage、不得修改 `.agents/`、`output/`、`teacher-overview.xlsx`、local DB、cache、
screenshots 或其他既有 untracked files。每個 agent 回報 touched files、targeted gates 與未解風險，由
integrator 統一 review、整合與 commit。

### Shared-worktree execution safety

- Wave 0先把unit runner拆成穩定harness + domain files；之後Editor擁有editor/layout unit files，Frontend
  core擁有其餘unit files與harness，兩lane不得同改同一測試檔。
- 平行frontend agent使用lane-specific `--outDir ../.tmp/refactor-build/<lane>`；canonical `frontend/dist`
  只由integrator build。平行backend pytest設定獨立`ALBUM_MAKER_TEST_TMPDIR=.tmp/pytest-<lane>`。
- Playwright、dev server、canonical build、完整unit/pytest及guide generation由integrator序列執行；agent
  不得搶5173/8765或共用`.tmp/e2e`。
- E2E supervisor必須獨占固定ports；5173/8765被非supervisor程序占用時啟動前明確失敗，不允許Vite
  自動改到5174後仍測舊server。

## Reference Module Map

- `layoutGroupContractGraph.js`：constants、canonical refs、validation、graph build。
- `layoutGroupQueries.js`：graph-aware scope／ancestry／descendant／render queries。
- `layoutGroupGeometry.js`：bounds、rotation、projection、frame adapters。
- `layoutGroupCommands.js`：group／ungroup／reorder／link／delete／transform。
- `layoutGroups.js`：相容 re-export，不新增邏輯。
- `photoSaveModel.js`／`usePhotoAutoSave.js`：pure snapshot/payload 與 serialized orchestration。
- `storage_base.py`、`storage_cache.py`、`storage_local.py`、`storage_r2.py`：adapter 實作；`storage.py` facade。
- `project_archive_service.py`、`output_keys.py`、`student_render_service.py`、`project_export_service.py`。
- `roster_identity_service.py`、`semester_render_service.py`、`semester_export_service.py`。

名稱可在實作前因現有 seam 微調，但責任不可重新合併成另一個 God module。

## Compatibility

- 舊 import 先由 facade/barrel 保持；同一 slice 搬完全部 repo consumers 且全案搜尋為零後才刪相容層。
- 前端可刪項目必須同時通過 import graph 與全案名稱搜尋；動態 URL／public asset 不以 import graph判死。
- 已證明可刪清單限於：`SlotFramePreview.jsx`、`SlotLayoutPreview.jsx`、React `Offline.jsx`、
  `api/index.js`、PhotoManager改直引後的`api.js`、未消費API wrappers/default exports、Login死角色常數、
  `useLayoutHistory.saveDirtyLayouts`、合併後的`App.css`，以及file service的`save_uploaded_file`／
  `rename_photo_to_slot`。新增刪除候選必須重新review，不可擴張此清單。
- route lazy split只改 chunk boundary。Login／ProjectList 保持同步；ClassEdit／StudentEdit／ProjectReview
  lazy，專案卡片 focus/hover 可 prefetch，直接網址與 reload 必須正常。
- `render_service.UPLOADS_DIR` 可在 v1 保留 read-only alias；測試與新程式改用 path owner。
- 不改現有 storage class/function 公開名稱、template revision error shape 或前端錯誤提示語意。

## Implementation Slices

### Wave 0：基線與規格（sequential）

1. 已確認pytest `155 passed / 1 real-R2 smoke skipped`，ruff/mypy/banned-patterns、frontend lint/unit/build、
   render parity全綠；baseline `index=351204`、`TemplateEditor=466864` raw bytes，render fingerprint
   `8a8fab3a5aed60264619`。
2. 首次完整E2E為`85 passed / 1 environmental failure`：既有5173使新Vite退到5174。先修supervisor
   fixed-port ownership並重跑到86/86，才可動產品程式。
3. 鎖定本規格與後端附錄，加入文件地圖。

### Wave 0.5：測試地基（3 lanes parallel；整合驗證 sequential）

1. 修E2E fixed-port fail-fast／cleanup；不改測試情境。
2. 保留自製Node runner語意與`npm run test:unit`命令，拆出harness及api/photos/camera/groups等domain
   files；每個既有test name與數量保持，執行順序不構成契約。
3. 補後端附錄列出的Storage factory、route mutation與partial-success characterization gaps。

### Wave 1：foundation（3 lanes parallel）

1. **Editor domain foundation**：機械拆 `layoutGroups.js`、保留 exports；新增單次 editor model；移除
   derived/dead state 與重複 refs/page-key helpers。依賴現行 group v2 contract，產出 Wave 2 Canvas model。
2. **Frontend core foundation**：死碼/barrel/API domain cleanup；穩定
   permissions result；統一 roles；Student 單一文字面板。無 Editor lane dependency。
3. **Backend foundation**：刪確定死碼；抽 app paths；拆 Storage 與 project service facade；保持 imports。
   產出 Wave 2 route use-case 可消費的 service seams。

### Wave 2：runtime boundaries（3 lanes parallel）

1. **Canvas boundary**：抽 `TemplateCanvas`／`CanvasArtwork`／CanvasNode preview lifecycle；camera/gesture
   每幀留在 Canvas；保留雙節點直到個別 node parity 通過。依賴 Wave 1 editor model。
2. **Photo lifecycle**：pure transform/payload、共用 retry、serialized `usePhotoAutoSave`，再拆 Wizard／modal。
   依賴 Wave 1 unit harness，消費既有 API，不依賴 Editor lane。
3. **Backend use-cases**：project/photo/template/user routes 下移；拆 roster identity/render/export。
   依賴 Wave 1 service seams，保留 transaction/lock order。

### Wave 3：收斂（3 lanes parallel）

1. **Editor orchestration**：抽 selection/clipboard/shortcuts/material suggestion/document hooks與 chrome；
   explicit save/CAS 最後搬，且只做機械 ownership 轉移。
2. **Frontend pages/bundle**：`AlbumEditorLayout`、ProjectReview 責任拆分、confirm/period/inline primitives、
   route lazy + prefetch。依賴 Wave 2 photo hook，保留頁面資料語意。
3. **Backend hardening**：typed template sync plan、backend layout validator/render traversal 分模組、測試分檔。
   依賴 Wave 2 use-case seam；不修改 pixel renderer 演算法。

### Wave 4：tooling、文件與整合（sequential）

1. 抽 guide generation screenshot/marker/HTML/PDF primitives；情境流程仍分檔。
2. 更新 architecture/rendering/storage/testing owner 文件與 contract pins。
3. 跑全部 gates、瀏覽器 smoke、dev server health；只提交 source/docs，清除本次測試產物。

## Acceptance Smoke

### Global gates

- `python -m pytest -q`、ruff、mypy、banned-patterns 全通過。
- frontend lint、unit、build、render parity 全通過；核心 E2E 在 Chromium 與 WebKit 通過。
- `/api/health`、登入、專案清單、Class/Student edit、Review、TemplateEditor direct URL 實際可用。
- git diff 不含 DB、cache、screenshots、`output/`、`teacher-overview.xlsx` 或使用者 untracked files。
- guide `--pdf-only` 前後的screenshot inventory、marker metadata、HTML headings與PDF頁數一致；產物只作
  驗證，不在未明確要求時stage。

### Editor/save

- 同一layout identity只建一次editor model；instrumented test中連續N次pan/pinch frame不增加
  `TemplateEditor` render count，toolbar/Transformer仍即時更新。
- 390×844 與 844×390 pinch/pan/fit 後 layout、dirty、history、save payload不變；照片／群組 resize/rotate
  在 gesture 中與放開後 control frame 不跳動。真 iPhone pinch列為最終 manual smoke。
- group/isolation/multi-select/copy/cut/paste/delete/undo/redo 與正式 pixels符合既有 v2 tests/parity。
- 新增／刪除模板頁後查 DB仍是舊頁面集合；按儲存後才以單一 snapshot 更新，revision conflict不覆寫。

### Photo/frontend

- 延遲upload POST後執行move/delete/replace，最多一個photo run；最後UI、直接讀取DB與Storage bindings
  完全一致，舊snapshot不覆蓋新state。503/網斷依既有上限重試，永久失敗可再次操作。
- upload與mapping各自延遲回revision conflict時，pending token、dirty、shadow與recovery後rerun都保留；
  unmount detached completion不觸發React state update或寫到新學生。
- Student 手機／桌機只 mount一份文字面板；Class/Student scope switch先 flush再切換。
- 直接進入 lazy routes、reload與權限拒絕結果不變；initial `index` raw bytes不得超過基線，route split後
  必須嚴格下降，TemplateEditor總功能 chunk不以拆檔假裝瘦身。
- dead exports/files全案搜尋為零；eslint不再因寬鬆 uppercase ignore漏掉未使用 role constants。

### Backend/storage/sync

- Storage local/R2/cache/path traversal/namespace/proxy tests全通過；`storage` import graph不再依賴 renderer。
- audited project/photo/template/user route只做 dependency/HTTP mapping/use-case call；transaction、locks、
  permission recheck、cleanup先後由 characterization tests釘住。
- render/cache/download filenames、keys、headers、ZIP entries與正式 pixels不變。
- template sync impact/hash、confirm、apply、concurrency、backup、rollback與manual-rescue payload同既有
  fixtures；鎖前與鎖內各prepare一次，失敗仍整筆rollback，無partial student update。
- app startup不新增 migration或改寫既有 layout/project/student資料。
- traversal source拆分後fingerprint須與基線不同一次；同一source tree重算值穩定，cache miss後輸出
  pixels/keys相同，新traversal source任一內容改變都會再次改fingerprint。

## Non-Goals

- 不新增功能、UI flow、API、DB schema、layout schema或 autosave產品策略。
- 不改 renderer pixel math、PIL/Konva補償、photo frame design tokens、字型或輸出尺寸。
- 不做 repository/DAO、domain exception hierarchy、global settings singleton、leaf plugin、affine matrix。
- 不引入 Redux、React Query、Vitest/RTL或全面 TypeScript；不替換 axios、Konva、SQLAlchemy。
- 不大改 migrations、`database.py`、`ui.jsx`或為所有按鈕建立萬用元件。
- 不把手機／平板／桌面差異塞進巨大 config；不合併語意不同的 Class/Student資料模型。
- 不移除 deprecated template page endpoints；只降低內部依賴，移除另開 phase。

## Open Questions

無產品阻擋問題。實作中若某切片必須改外部 contract 才能完成，該切片立即停止並回到規格 review，
不得以「內部重構」名義偷偷擴張範圍。
