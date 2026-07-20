# API 契約與權限

> Owns：認證機制、角色權限矩陣、端點清單、API 層注意事項。
> 資料形狀見 [核心資料模型](data-model.md)與[版面資料模型](layout-data-model.md)；
> 渲染行為見 [rendering.md](rendering.md)。

---

## 認證機制

- **JWT**：python-jose HS256，7 天有效期；payload 含 `sub`（user_id）、`username`、`role`、`exp`
- **傳遞方式**：HttpOnly Cookie `access_token` 為主（前端唯一方式，SameSite=Lax，
  `PRODUCTION=1` 時加 Secure）；`Authorization: Bearer` 為輔（API 工具用）。
  `get_current_user` 先讀 Cookie、再 fallback Bearer
- **密碼**：bcrypt **直接呼叫**（`hashpw` / `checkpw`），不透過 passlib —
  passlib 與 bcrypt 4.x+ 不相容會炸啟動。requirements 裡的 passlib 禁止使用
- **速率限制**：`POST /api/auth/login` 以 slowapi 依 IP 限 10 次/分鐘，超限回 429
- **role=none 拒絕登入**；密碼建立與重設最短 8 字元
- **SECRET_KEY**：環境變數；`PRODUCTION=1` 未設定則拒絕啟動
- 授權輔助：`Depends(get_current_user)` 驗登入、`Depends(require_role("admin", ...))`
  驗角色（不符回 403）；專案層級由 `services/project_access_service.py` 的
  `assert_project_readable` / `assert_project_writable` 統一判斷，路由 `_helpers.py`
  只保留相容 re-export

## 角色權限矩陣

| 能力 | admin | art_team | supervisor | teacher | none |
|------|:-:|:-:|:-:|:-:|:-:|
| 模板管理（建/編/刪） | ✓ | ✓ | — | — | — |
| 看已歸班專案 | 全部 | 全部（唯讀） | 目前任教班級 ∪ 主管 scope | 目前任教班級 ∪ 主管 scope | — |
| 看待遷移未歸班專案 | ✓ | — | — | — | — |
| 建立班級相本 | ✓ | — | 當班主教 | 當班主教 | — |
| 編輯專案內容 | ✓ | — | 目前任教班級 | 目前任教班級 | — |
| 退回全班完成 | ✓ | — | 校／部門 scope | 校／部門 scope | — |
| 審閱留言 | ✓ | ✓ | 主管 scope；否則唯讀 | 主管 scope；否則唯讀 | — |
| 完整（列印）畫質 PDF | ✓ | — | — | — | — |
| 學期彙整匯出 | ✓ | — | — | — | — |
| 學期進度檢視 | 全部 | — | 校／部門 scope（唯讀） | 校／部門 scope（唯讀） | — |
| 使用者管理 | ✓ | — | — | — | — |
| 園所設定／編班／相本遷移與轉交 | ✓ | — | — | — | — |
| 自己範圍的目前班級（唯讀） | ✓ | — | 任教班級 ∪ 主管 scope | 任教班級 ∪ 主管 scope | — |
| 登入 | ✓ | ✓ | ✓ | ✓ | 拒絕 |

- 前端旗標集中在 `hooks/usePermissions.js`（`canManageTemplates` /
  `canEditProject(project)` / `canReadProject(project)` / `canDownloadPrint` /
  `canComment` / `canManageUsers`），頁面守衛在 `PrivateRoute` + `allowedRoles`；
  後端以 `require_role` / `assert_project_*` 為準，兩邊必須一致
- 專案 `permissions.can_read/can_edit/can_reopen/can_comment` 由後端 object policy 計算；前端不得再用
  角色或 `owner_id` fallback。刪除或緊急停權 user 時，組織 scope／班級編制會結束，owned projects
  以 audited transfer 過繼給執行 admin，歷史姓名快照保留
- 非 admin 下載 PDF 時 `mode` 一律強制降為 `screen`

`teacher`／`supervisor` 是可參與園所編制的操作帳號族群，不是互斥職務。一個帳號可在不改
`User.role` 的情況下同時具有 `ClassroomTeacherAssignment` 與
`OrganizationSupervisorAssignment`：active 任教區間授予該班讀寫與主教建立權，active
主管區間授予範圍讀取、退回完成與主管報表權。沒有對應 active 指派就沒有該項能力；
`admin`、`art_team`、`none` 的既有語意不受此規則擴張。

## 圖片端點認證

所有圖片與預覽 GET 端點都必須掛 `get_current_user`；專案照片與預覽另外執行
`assert_project_readable`。同源 `<img src>` 雖不帶 Bearer header，仍會自動帶上
HttpOnly Cookie，因此不需要為了圖片顯示而公開幼兒照片。

## 端點清單

除登入與 health check 外，所有端點都需要登入。

### 認證 `/api/auth`

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/login` | 登入（form），JWT 寫入 HttpOnly Cookie |
| POST | `/logout` | 清除 Cookie |
| GET | `/me` | 當前使用者資訊 |

### 使用者 `/api/users`（除 `/me/settings` 外皆 admin）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET / POST | `/` | 列出 / 建立帳號（JSON body；不在此處設定組織權限） |
| POST | `/import` | .xlsx 批次建立 |
| PATCH | `/me/settings` | 更新自己的 UI 偏好（字體縮放） |
| PATCH | `/{user_id}` | 改顯示名／角色／重設密碼（JSON body） |
| DELETE | `/{user_id}` | 刪除（不能刪自己；專案過繼給執行者） |

改成非操作角色時，若仍有 active 班級編制或主管 scope 會拒絕；`teacher` 與 `supervisor`
之間切換不必解除編制。改成 `role=none` 是緊急停權，
會在同一 transaction 結束上述組織關係、處理 owned projects，並以
`auth_version` 讓既有登入立即失效。

### 模板 `/api/templates`（寫入操作皆 admin / art_team）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/departments` | 固定部門清單 |
| GET / POST / PATCH | `/periods`、`/periods/{id}` | 期別查詢 / 建立 / 更新（狀態屬期別）；建立可帶 `academic_term_id` 接到草稿或目前正式學期 |
| GET / POST | `/` | 模板摘要清單 / 建立（可複製既有模板） |
| GET / PATCH / DELETE | `/{id}` | 詳情（含頁面）/ 改名或移動期別 / 刪除 |
| PUT | `/{id}/pages` | 原子儲存完整頁面快照；必帶 `expected_revision` + `expected_page_ids`。既有專案遇結構變更先回 409 影響摘要／`change_hash`，確認重送後同 transaction 依 page id 搬移內容 |
| POST | `/{id}/pages` | 舊版相容新增頁（deprecated；編輯器不呼叫）；既有專案遇 409 可用 `confirm_project_sync=true&project_sync_change_hash=…` query 重送 |
| PUT / DELETE | `/{id}/pages/{page_id}/layout`、`…/pages/{page_id}` | 舊版相容更新／刪頁（deprecated；正式儲存走完整 snapshot）；支援相同 confirmation query |
| POST / GET | `/{id}/pages/{page_id}/background` | 上傳 / 取得背景圖；上傳必帶 `expected_revision` query，版本不符回 409 且不寫 DB/storage，成功才同步 template revision、既有專案與輸出失效 |
| POST / GET 🔓 | `/{id}/stickers`、`/{id}/stickers/{filename}` | 上傳 / 取得貼圖；上傳回傳內容版本 key 與 EXIF 校正後像素的 `asset_revision`，按模板儲存前不覆寫既有貼圖 |
| POST | `/{id}/pages/{page_id}/material-text-box-suggestion` | admin/art_team 只讀分析貼圖，回傳一次性 normalized 文字框建議；不寫 DB/storage |
| GET | `/{id}/pages/{page_id}/preview` | 單頁預覽 PNG（姓名佔位） |
| GET | `/{id}/spread-preview/{start_page_index}` | 雙頁跨頁預覽 PNG |

### 園所管理 `/api/organization`

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/overview` | admin：園所結構、編制、名單、相本、待遷移狀態，以及目前正式學期的 `work_slots`／可用模板；owner 只從該班目前老師選擇 |
| GET | `/my-classrooms` | admin 全部；`teacher\|supervisor` 回目前任教班級與 active 主管 scope 聯集，每班含目前正式學期 `work_slots`，另回 `permissions.can_view_supervisor_reports`；其他角色 403 |
| GET | `/academic-terms` | admin／art_team：正式學期及其 ordered 期別；供模板與新學期設定使用 |
| POST / PATCH | `/campuses`、`/campuses/{id}` | 建立／更新分校；旗下仍有目前學生或老師時不可停用 |
| PUT | `/campuses/{id}/supervisors` | admin 完整替換該校全校主管與 `infant`／`academy` 部門主管；未變區間保留 |
| POST / PATCH | `/classrooms`、`/classrooms/{id}` | 建立／更新班級（分校、`infant\|academy` 部門、名稱、啟用狀態） |
| PUT | `/classrooms/{id}/teachers` | admin 以完整集合原子替換目前老師；非空集合恰有一位 `lead`，其餘為 `co_teacher`，歷史區間保留 |
| POST | `/classrooms/{id}/members/batch` | 批次加入目前名單；每筆可帶中央 `album_name`，省略時保守自動推導；單批與班級目前名單各最多 100 人，同一孩子不可同時在兩班 |
| PATCH | `/classrooms/{id}/members/{member_id}` | 改完整姓名或中央 `album_name`、標記離園、建立回班區間，或以 `target_classroom_id` 轉班 |
| POST | `/classrooms/{id}/members/album-names/auto-fill` | admin 整批替目前名單中尚未設定者安全推導中央相本稱呼；不覆蓋人工值，回 `{updated, unresolved}` |
| PATCH | `/roster-children/{id}/album-name` | admin 設定或清除中央相本稱呼；供已無 membership、但仍被既有已歸班相本引用的孩子使用 |
| POST | `/roster-children/{id}/album-name/auto-fill` | admin 單筆替空白中央稱呼安全推導；已有值不覆蓋，回 `{updated, unresolved}` |
| POST | `/classrooms/{id}/projects` | admin／當班 lead 以目前名單建立相本；body 必帶尚未開始且屬目前學期／該班／模板期別的 `work_slot_id`，owner 須為目前老師（省略採 lead） |
| GET | `/projects/{project_id}/classroom-migration-preview?classroom_id=…` | admin 讀取固定 Student 快照、目標班狀態、established identity options 與 `source_fingerprint`；零寫入且不按姓名預選 decision |
| PUT | `/projects/{project_id}/classroom` | admin 以完整 `student_identity_decisions` 顯式解析每位 Student 並歸班；可在空班以 `seed_current_roster` 全量建立目前名單 |
| POST / GET / PUT | `/term-reclassification-plans`、`/term-reclassification-plans/{id}` | admin 建立唯一全園 draft（可帶期別 ids／日期）、讀取或以 `expected_revision` 完整替換學生／老師目標；草稿同時持有目標 AcademicTerm |
| POST | `/term-reclassification-plans/{id}/validate\|apply\|cancel` | admin 驗證正式期別、學生與老師目標；以 revision + source fingerprint 原子切換目前編制、產生學期快照／工作格並啟用目標學期；或取消且不動目前狀態 |

名單成員、完整姓名、老師異動與新學期套用不改寫既有 Project 的學生快照或 owner；中央
相本稱呼是例外，修改會失效相關輸出。現在老師集合會立即決定該班所有相本讀寫權。
未歸班 Project 保持 admin-only，管理員在 overview 逐本選班，
系統不從 owner、名稱、舊主管關係或 provisional child link 推測。歸班 request shape 為：

名冊 `album_name` 最多 100 字，首尾空白會移除，空字串或 `null` 代表清除。它跟隨
`RosterChild` 跨轉班與新學期沿用，是所有已歸班既有與未來相本的唯一稱呼來源；修改後
相關學生輸出指標會失效，必須重新渲染。完整姓名與成員集合仍維持各期快照。
自動推導與跨班／跨既有相本碰撞規則見
[data-model.md 的相本稱呼](data-model.md#相本稱呼與姓名變數)。

preview response 固定回 `source_fingerprint`、`target_classroom`（含目前名單數與
`seed_allowed`）、`students`（固定快照、original provisional evidence、
`allowed_existing_roster_child_ids`）及 `established_candidates`。candidate 的 evidence 可標示
`target_membership`／`same_name_membership`（分校、部門、班級、membership id、目前在班或
已結束狀態與區間時間）、`target_project`／`same_name_project`（分校、部門、班級、相本
id／名稱／active-or-archived 狀態及可取得的期別 id／名稱），以及只說明姓名命中的
`same_name_established`。非目標班的同名候選必須帶至少一筆實際 membership 或 class-backed
Project 來源，不能只回模糊的全園同名標籤；target evidence 也帶同一組校班脈絡。evidence
只解釋為何可供人工核對，不代表已選擇 action，也不得讓後端或前端自動確認。

候選與 evidence 以穩定 id 排序並納入 `source_fingerprint`；同一狀態重開 preview 會得到相同
fingerprint。補充來源脈絡不改變可選集合：每位 Student 仍只允許目標班的 established ids，
加上全園與該 Student 正規化姓名相同的 established ids。

```json
{
  "classroom_id": 12,
  "seed_current_roster": true,
  "source_fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "confirmed_all": true,
  "student_identity_decisions": [
    {"student_id": 101, "action": "create_new"},
    {"student_id": 102, "action": "existing", "roster_child_id": 55}
  ]
}
```

`source_fingerprint` 必須原樣帶回 preview 所提供的 64 字元 opaque SHA-256 hex。
沒有任何 Student 快照的 legacy Project 在 preview 即回 422
`empty_legacy_project_migration_forbidden`，不建立 ledger、工作格連結或班級權限。

decision 集合必須與 Project Student 集合完全相等，`confirmed_all` 必須為 `true`；apply
會在 transaction 內重算 preview fingerprint，不符回 409 且零寫入。`existing` 只接受
established identity，`create_new` 一律建立新 id，不保存 provisional id。seed 是
all-or-none：`true` 只接受空的目前名單並建立解析後全體成員，`false` 完全不動名單。完整交易與 freeze 契約見
[園所名單與相本權限規格](../specs/organization-roster-management-v1.md#migration)。

`migration_status` 固定包含：

- `unassigned_project_count`：active 且未歸班的 Project 數。
- `pending_identity_student_count`：上述 Project 的 Student 數；即使舊 link 非 NULL 仍待決策。
- `archived_identity_resolution_count`：已寫入稽核 ledger 的 legacy Student resolution 數；
  只供稽核，不影響完成判定。
- `assigned_identity_anomaly_count`：active class-backed Project 中 child link 缺失／無效，或與
  同 Project 另一位 Student 共用 child id 的 Student 數。
- `archived_teacher_supervisor_link_count`：已封存的舊逐人主管關係數；不影響完成判定，
  也不會自動轉成校／部門 scope 或任何 ACL。
- `is_complete`：`unassigned_project_count` 與 `assigned_identity_anomaly_count` 皆為 0；此時
  active 待決策 Student 必然也是 0。兩種歷史 ledger count 不影響完成判定。

### 專案 `/api/projects`

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/` | 依角色過濾的專案清單 |
| GET | `/archive` | 30 天封存區 |
| GET / PATCH / DELETE | `/{id}` | 詳情（含學生）/ 改名（失效舊輸出）/ 軟刪封存 |
| POST | `/{id}/restore` | 復原封存 |
| POST | `/{id}/complete` | 標記全班完成（admin／該班目前老師）；完成後非 admin 內容寫入鎖定 |
| POST | `/{id}/reopen` | 退回全班完成（admin 或該校／部門 scope supervisor） |
| POST | `/{id}/assignment` | admin 把進度負責人轉給該班目前老師並寫 from/to/operator 快照與原因；owner 不授權 |
| GET | `/{id}/assignment-history` | admin 查詢完整負責人轉交時間線 |
| POST | `/{id}/students/album-names/auto-fill` | 未歸班 legacy 相本相容端點；已歸班回 409 `roster_album_name_authority` |
| POST | `/{id}/students/{sid}/album-name/auto-fill` | 未歸班 legacy 相本相容端點；已歸班回 409 `roster_album_name_authority` |
| PUT | `/{id}/students/{sid}/album-name` | 未歸班 legacy 相本可更新 `Student.album_name`；已歸班回 409，必須改園所名冊中央值 |
| PATCH | `/{id}/students/{sid}/pages/{page}/skip` | 頁面跳過旗標 |
| POST | `/{id}/students/{sid}/pages/{page}/photos/{slot}` | 上傳單張照片 |
| POST | `/{id}/photos/shared/pages/{page}/slots/{slot}` | 共用照片套用全體 |
| POST | `/{id}/photos/batch/pages/{page}/slots/{slot}` | 依 mapping 批次分配 |
| GET | `…/photos/{slot}`、`…/photos/{slot}/thumbnail` | 照片原圖 / 縮圖 |
| PUT | `/{id}/students/{sid}/photos/mapping` | 更新照片位移縮放對應 |
| GET / PUT | `/{id}/label_texts` | 專案層級對應文字 |
| PUT | `/{id}/students/{sid}/pages/{page}/texts` | 學生單頁文字 |
| PUT | `/{id}/batch/texts` | 批次更新多學生文字 |
| GET / POST | `/{id}/comments` | 留言清單 / 新增；讀取沿用專案 read policy，新增限 admin、art_team 或該專案 active 主管 scope |
| DELETE | `/{id}/comments/{cid}` | 刪留言（自己的；admin 可刪全部） |
| GET | `/{id}/preview/{page}`、`/{id}/students/{sid}/preview/{page}` | 預覽 PNG |
| POST | `/{id}/students/{sid}/render`、`/{id}/render/all` | 渲染單一 / 全體 |
| GET | `/{id}/students/{sid}/pdf?mode=print\|screen` | 下載 PDF（非 admin 強制 screen） |
| GET | `…/{sid}/images`、`…/{sid}/images/{page_number}` | 學生圖片 ZIP / 單張 |
| GET | `/{id}/download/all`、`/{id}/download/all/images` | 全體 PDF / 圖片 ZIP |

上述五個專案 PDF／圖片下載端點都先驗證 object read capability，再要求專案已有
`completed_at`；尚未標記「全班完成」或退回修改後一律回 `409`。預覽與渲染端點不套用此
下載 gate，讓老師完成後仍能先產生最新交件檔再下載。

通用 `POST /api/projects/` 與 `PUT /api/projects/{id}/editors` 不存在；所有新相本只從
班級端點建立，協作權只由目前班級老師編制產生。舊 editor rows 僅由 startup migration
封存，普通 API、owner 轉交與帳號生命週期都不查詢或序列化。

照片、文字、skip 與 mapping 的學生頁面寫入都會驗證 `page` 落在目前模板頁數內；
負數或超界索引不寫資料。三種文字寫入只接受字串或
`{"text": string|null, "text_align": "left|center|right"}` entry，shape 錯誤回 422。

Project 的學生集合與 `Student.name` 沒有 runtime 新增、複製、刪除或改名端點；新相本
只在班級端點建立時從目前名單產生快照；舊相本只有在未歸班時可由 admin 歸班流程解析
identity，成功後同樣凍結。preview 與 apply 以外沒有 link／merge／split 入口。
完整 authority 與跨期語意見 [data-model.md 的班級名單與每期快照](data-model.md#班級名單組織權限每期快照與相本遷移)。
學生 detail／editor response 同時回傳 `name`、解析後的 `album_name` 與
`effective_album_name`。已歸班相本動態讀 `RosterChild.album_name`；未歸班 Project 即使有
provisional child link 仍讀 legacy `Student.album_name`。來源、回退與輸出失效規則見
[data-model.md 的相本稱呼](data-model.md#相本稱呼與姓名變數)。
班級目前名單與由它建立的 Project 快照最多 100 位學生；姓名最多 100 字，批次加入
目前名單最多 100 筆。容量在 organization 名單寫入與相本建立時 preflight，超限回 422
且整次零寫入；由 `tests/test_student_input_limits.py` 釘住。

### 正式學期報表 `/api/roster`（admin 全部；active 主管限校／部門 scope）

園所目前名單的穩定身分規則見
[data-model.md 的孩子名冊](data-model.md#孩子名冊rosterchild園所設定是唯一-authority)。
此 API 只讀取名冊身分作彙整，沒有 Student link、RosterChild merge 或 split mutation。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/academic-terms` | 回可報表的 `imported\|active\|closed` 學期與 ordered 期別；非 admin 只回主管 snapshot scope 內實際可見的部門期別 |
| GET | `/semester-export?academic_term_id=…&period_ids=…` | 依學期校／班與最終學生名單快照分組，回 `classroom_groups[].children[].cells[]`；cell 狀態為 ready / not_rendered / no_album / duplicate / departed / not_enrolled，身分或學期歸班異常另列 `unlinked` |
| POST | `/semester-export/render-missing` | body 必帶 `academic_term_id`、`period_ids`，可選 `roster_child_ids`；啟動全程序唯一補渲染 job，已有 job 在跑回 503 |
| GET | `/semester-export/render-missing/{job_id}` | 補渲染 job 進度：`status`（running/done/failed）、`done`/`total`、`rendered`、`errors` |
| GET | `/teacher-progress?academic_term_id=…` | 班級 × 期別工作格總覽；建立、照片／文字內容、交件鎖定三軸分開（不考慮列印 PDF），協同老師不重複產生工作 |
| GET | `/teacher-overview/export?academic_term_id=…` | 與畫面同源的摘要／班級期別／學生明細 Excel；可用 department、campus_id、classroom_id 篩選 |
| GET | `/semester-export/download?academic_term_id=…&period_ids=…&mode=…&roster_child_ids=…` | 依 `校別/班級/孩子/期別_孩子.pdf` 串流 ZIP；duplicate 不匯出並寫入說明，`roster_child_ids` 選填 |

主管呼叫 `/semester-export` 時，`period_ids` 必須全部屬於該學期且位於其主管 snapshot scope
實際可見的部門；不存在、跨學期或超出部門 scope 一律回 404，不回傳部分期別 metadata。

其他：`GET /api/health` 健康檢查。

## API 層注意事項

- **rename 端點用 `Form(...)`**（不是 JSON body）；使用者管理端點則收 JSON body
  （Pydantic model，前端 `apiClient.post(url, params)`）
- **Query 驗證用 `pattern=`**，不用已棄用的 `regex=`
- **中文檔名下載**：`Content-Disposition` 用 RFC 5987
  `attachment; filename*=UTF-8''...` 格式
- **照片處理並發限制**：上傳端點使用 `request_limiter.py` 的
  `require_photo_upload_slot()` 依賴注入；照片縮圖 cache miss 在 service 內取得同一 limiter，
  同 key 另以 single-flight 避免重複解碼。槽位數由環境變數控制
- **page-index 寫入 CAS**：照片上傳／mapping、專案與學生文字、skip、批次照片／文字都必帶
  `expected_template_revision`；後端在一致鎖內比對，不符回 409，避免舊分頁在模板重排後寫錯頁。
- **照片上傳學生身份 CAS**：單張與批次照片在鎖外解碼前捕捉
  `(student_id, project_id, created_at)`；鎖內會在任何 storage／DB 寫入前重新查核，
  學生快照 identity 已被外部 migration 替換或 SQLite 重用同一 ID 時回
  `409 student_photo_target_changed`。批次任一目標
  身份不符時整批零寫入。
- **photo mapping 兩步驟協議**：先寫入所有非 null binding，再統一移除 null；實體檔只在
  清除後已無任何 active reference 時刪除。照片 path 是 immutable opaque key，不因換頁／換格改名。
- 安全 Headers（`X-Frame-Options: DENY` 等）由 `main.py` 的
  `SecurityHeadersMiddleware` 全域加入
