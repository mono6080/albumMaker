# API 契約與權限

> Owns：認證機制、角色權限矩陣、端點清單、API 層注意事項。
> 資料形狀見 [data-model.md](data-model.md)；渲染行為見 [rendering.md](rendering.md)。

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
  驗角色（不符回 403）；專案層級用 `_helpers.py` 的
  `assert_project_readable` / `assert_project_writable`

## 角色權限矩陣

| 能力 | admin | art_team | supervisor | teacher | none |
|------|:-:|:-:|:-:|:-:|:-:|
| 模板管理（建/編/刪） | ✓ | ✓ | — | — | — |
| 看專案 | 全部 | 全部（唯讀） | 管轄老師的 | 自己的 | — |
| 建立/編輯專案 | ✓ | — | 自己的 | 自己的 | — |
| 審閱留言 | ✓ | ✓ | ✓ | 唯讀 | — |
| 完整（列印）畫質 PDF | ✓ | — | — | — | — |
| 名冊配對與學期彙整匯出 | ✓ | — | — | — | — |
| 學期進度檢視 | 全部 | — | 管轄老師的（唯讀） | — | — |
| 使用者管理 | ✓ | — | — | — | — |
| 登入 | ✓ | ✓ | ✓ | ✓ | 拒絕 |

- 前端旗標集中在 `hooks/usePermissions.js`（`canManageTemplates` /
  `canCreateProject` / `canEditProject(ownerUserId)` / `canDownloadPrint` /
  `canComment` / `canManageUsers`），頁面守衛在 `PrivateRoute` + `allowedRoles`；
  後端以 `require_role` / `assert_project_*` 為準，兩邊必須一致
- 隱藏假設：專案內容 owner 獨佔（art_team / 非管轄 supervisor 不能寫）、
  模板 art_team 獨佔；刪除 user 時其專案過繼給執行刪除的 admin
- 非 admin 下載 PDF 時 `mode` 一律強制降為 `screen`

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
| GET / POST | `/` | 列出 / 建立（teacher 須指定至少一位主管；JSON body） |
| POST | `/import` | .xlsx 批次建立 |
| PATCH | `/me/settings` | 更新自己的 UI 偏好（字體縮放） |
| PATCH | `/{user_id}` | 改顯示名/角色/主管/重設密碼（JSON body） |
| DELETE | `/{user_id}` | 刪除（不能刪自己；專案過繼給執行者） |

### 模板 `/api/templates`（寫入操作皆 admin / art_team）

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/departments` | 固定部門清單 |
| GET / POST / PATCH | `/periods`、`/periods/{id}` | 期別查詢 / 建立 / 更新（狀態屬期別） |
| GET / POST | `/` | 模板摘要清單 / 建立（可複製既有模板） |
| GET / PATCH / DELETE | `/{id}` | 詳情（含頁面）/ 改名或移動期別 / 刪除 |
| PUT | `/{id}/pages` | 原子儲存完整頁面快照；必帶 `expected_revision` + `expected_page_ids`。既有專案遇結構變更先回 409 影響摘要／`change_hash`，確認重送後同 transaction 依 page id 搬移內容 |
| POST | `/{id}/pages` | 舊版相容新增頁（deprecated；編輯器不呼叫） |
| PUT / DELETE | `/{id}/pages/{page_id}/layout`、`…/pages/{page_id}` | 舊版相容更新／刪頁（deprecated；正式儲存走完整 snapshot） |
| POST / GET | `/{id}/pages/{page_id}/background` | 上傳 / 取得背景圖；上傳必帶 `expected_revision` query，版本不符回 409 且不寫 DB/storage，成功才同步 template revision、既有專案與輸出失效 |
| POST / GET 🔓 | `/{id}/stickers`、`/{id}/stickers/{filename}` | 上傳 / 取得貼圖；上傳回傳內容版本 key 與 EXIF 校正後像素的 `asset_revision`，按模板儲存前不覆寫既有貼圖 |
| POST | `/{id}/pages/{page_id}/material-text-box-suggestion` | admin/art_team 只讀分析貼圖，回傳一次性 normalized 文字框建議；不寫 DB/storage |
| GET | `/{id}/pages/{page_id}/preview` | 單頁預覽 JPEG（姓名佔位） |
| GET | `/{id}/spread-preview/{start_page_index}` | 雙頁跨頁預覽 |

### 專案 `/api/projects`

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/` | 依角色過濾的專案清單 |
| GET | `/archive` | 30 天封存區 |
| POST | `/` | 建立（自動設 owner） |
| GET / PATCH / DELETE | `/{id}` | 詳情（含學生）/ 改名（失效舊輸出）/ 軟刪封存 |
| POST | `/{id}/restore` | 復原封存 |
| POST | `/{id}/complete` | 標記全班完成（owner/admin）：內容端點（名單/照片/文字/頁面跳過）對非 admin 回 403，渲染與下載不擋 |
| POST | `/{id}/reopen` | 退回全班完成（admin 或管轄該 owner 的 supervisor） |
| POST | `/{id}/students/batch` | 批次加學生 |
| POST | `/{id}/students/copy` | 從既有專案複製學生名單（沿用名冊連結，同名跳過） |
| PUT / DELETE | `/{id}/students/{sid}` | 改名（失效舊輸出）/ 刪除（清除該生照片與輸出） |
| PATCH | `/{id}/students/{sid}/pages/{page}/skip` | 頁面跳過旗標 |
| POST | `/{id}/students/{sid}/pages/{page}/photos/{slot}` | 上傳單張照片 |
| POST | `/{id}/photos/shared/pages/{page}/slots/{slot}` | 共用照片套用全體 |
| POST | `/{id}/photos/batch/pages/{page}/slots/{slot}` | 依 mapping 批次分配 |
| GET | `…/photos/{slot}`、`…/photos/{slot}/thumbnail` | 照片原圖 / 縮圖 |
| PUT | `/{id}/students/{sid}/photos/mapping` | 更新照片位移縮放對應 |
| GET / PUT | `/{id}/label_texts` | 專案層級對應文字 |
| PUT | `/{id}/students/{sid}/pages/{page}/texts` | 學生單頁文字 |
| PUT | `/{id}/batch/texts` | 批次更新多學生文字 |
| GET / POST | `/{id}/comments` | 留言清單 / 新增（admin, art_team, supervisor） |
| DELETE | `/{id}/comments/{cid}` | 刪留言（自己的；admin 可刪全部） |
| GET | `/{id}/preview/{page}`、`/{id}/students/{sid}/preview/{page}` | 預覽 JPEG |
| POST | `/{id}/students/{sid}/render`、`/{id}/render/all` | 渲染單一 / 全體 |
| GET | `/{id}/students/{sid}/pdf?mode=print\|screen` | 下載 PDF（非 admin 強制 screen） |
| GET | `…/{sid}/images`、`…/{sid}/images/{page_number}` | 學生圖片 ZIP / 單張 |
| GET | `/{id}/download/all`、`/{id}/download/all/images` | 全體 PDF / 圖片 ZIP |

### 名冊與學期匯出 `/api/roster`（admin；preview 另開放 supervisor）

名冊自動連結與待確認規則見 [data-model.md 的孩子名冊](data-model.md#孩子名冊rosterchild自動長出不需維護)。

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/semester-export?period_ids=…` | 匯出預覽：依名冊孩子分組的各期狀態 + 待確認清單（supervisor 只回管轄老師的專案） |
| PUT | `/students/{sid}/link` | 配對到既有名冊項（`roster_child_id`）或建新項（`create_new`） |
| POST | `/children/{cid}/merge/{target_cid}` | 名冊項合併（改名/誤拆修正） |
| POST | `/semester-export/render-missing` | 啟動補渲染背景 job（body：`period_ids`、選填 `roster_child_ids`），回 `job_id`；已有 job 在跑回 503 |
| GET | `/semester-export/render-missing/{job_id}` | 補渲染 job 進度：`status`（running/done/failed）、`done`/`total`、`rendered`、`errors` |
| GET | `/teacher-progress?period_ids=…` | 老師進度總覽：含尚未建專案的老師、每專案/每生照片格填滿數與空白輸出文字格數（admin 全部、supervisor 限管轄老師） |
| GET | `/teacher-overview/export?period_ids=…` | 老師進度 Excel（摘要+明細，含照片/空白文字欄；admin 全部、supervisor 限管轄老師） |
| GET | `/semester-export/download?period_ids=…&mode=…&roster_child_ids=…` | ZIP（邊壓邊送 streaming，峰值記憶體＝單一 PDF）：`孩子/期別_孩子.pdf`；`roster_child_ids` 選填（不給＝全部）；`匯出說明.txt` 含分類規則、班級對照（最新期別）、缺頁備註與缺漏清單 |

其他：`GET /api/health` 健康檢查。

## API 層注意事項

- **rename 端點用 `Form(...)`**（不是 JSON body）；使用者管理端點則收 JSON body
  （Pydantic model，前端 `apiClient.post(url, params)`）
- **Query 驗證用 `pattern=`**，不用已棄用的 `regex=`
- **中文檔名下載**：`Content-Disposition` 用 RFC 5987
  `attachment; filename*=UTF-8''...` 格式
- **照片上傳並發限制**：`request_limiter.py` 的 `require_photo_upload_slot()`
  依賴注入，槽位數由環境變數控制
- **page-index 寫入 CAS**：照片上傳／mapping、專案與學生文字、skip、批次照片／文字都必帶
  `expected_template_revision`；後端在一致鎖內比對，不符回 409，避免舊分頁在模板重排後寫錯頁。
- **photo mapping 兩步驟協議**：先寫入所有非 null binding，再統一移除 null；實體檔只在
  清除後已無任何 active reference 時刪除。照片 path 是 immutable opaque key，不因換頁／換格改名。
- 安全 Headers（`X-Frame-Options: DENY` 等）由 `main.py` 的
  `SecurityHeadersMiddleware` 全域加入
