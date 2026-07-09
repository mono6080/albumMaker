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

## 圖片端點不加 auth（安全例外，勿「修正」）

`<img src>` 是瀏覽器原生請求，不帶 Authorization header。以下 GET 端點**不掛**
`get_current_user`，加上會讓外網（ngrok / 正式網域）圖片全部 401、頁面全黑：

- 模板：`pages/{page_id}/background`、`stickers/{filename}`、
  `pages/{page_id}/preview`、`spread-preview/{start_page_index}`
- 專案：`students/{sid}/pages/{p}/photos/{slot}`（含 thumbnail）、
  `preview/{page}`、`students/{sid}/preview/{page}`

資料操作端點則一律要掛認證。

## 端點清單

🔓 = 不需登入（即上節的圖片 serving）。

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
| POST | `/{id}/pages` | 新增頁 |
| PUT / DELETE | `/{id}/pages/{page_id}/layout`、`…/pages/{page_id}` | 更新版型 / 刪頁 |
| POST / GET 🔓 | `/{id}/pages/{page_id}/background` | 上傳 / 取得背景圖 |
| POST / GET 🔓 | `/{id}/stickers`、`/{id}/stickers/{filename}` | 上傳 / 取得貼圖 |
| GET 🔓 | `/{id}/pages/{page_id}/preview` | 單頁預覽 JPEG（姓名佔位） |
| GET 🔓 | `/{id}/spread-preview/{start_page_index}` | 雙頁跨頁預覽 |

### 專案 `/api/projects`

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/` | 依角色過濾的專案清單 |
| GET | `/archive` | 30 天封存區 |
| POST | `/` | 建立（自動設 owner） |
| GET / PATCH / DELETE | `/{id}` | 詳情（含學生）/ 改名 / 軟刪封存 |
| POST | `/{id}/restore` | 復原封存 |
| POST | `/{id}/students/batch` | 批次加學生 |
| PUT / DELETE | `/{id}/students/{sid}` | 改名 / 刪除 |
| PATCH | `/{id}/students/{sid}/pages/{page}/skip` | 頁面跳過旗標 |
| POST | `/{id}/students/{sid}/pages/{page}/photos/{slot}` | 上傳單張照片 |
| POST | `/{id}/photos/shared/pages/{page}/slots/{slot}` | 共用照片套用全體 |
| POST | `/{id}/photos/batch/pages/{page}/slots/{slot}` | 依 mapping 批次分配 |
| GET 🔓 | `…/photos/{slot}`、`…/photos/{slot}/thumbnail` | 照片原圖 / 縮圖 |
| PUT | `/{id}/students/{sid}/photos/mapping` | 更新照片位移縮放對應 |
| GET / PUT | `/{id}/label_texts` | 專案層級對應文字 |
| PUT | `/{id}/students/{sid}/pages/{page}/texts` | 學生單頁文字 |
| PUT | `/{id}/batch/texts` | 批次更新多學生文字 |
| GET / POST | `/{id}/comments` | 留言清單 / 新增（admin, art_team, supervisor） |
| DELETE | `/{id}/comments/{cid}` | 刪留言（自己的；admin 可刪全部） |
| GET 🔓 | `/{id}/preview/{page}`、`/{id}/students/{sid}/preview/{page}` | 預覽 JPEG |
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
| POST | `/semester-export/render-missing` | 批次補渲染缺列印 PDF 的相冊（body：`period_ids`、選填 `roster_child_ids`） |
| GET | `/semester-export/download?period_ids=…&mode=…&roster_child_ids=…` | ZIP：`班級/孩子/序號_期別-專案.pdf`（班級＝最新期別的專案），`roster_child_ids` 選填（不給＝全部），缺漏列在 `匯出說明.txt` |

其他：`GET /api/health` 健康檢查。

## API 層注意事項

- **rename 端點用 `Form(...)`**（不是 JSON body）；使用者管理端點則收 JSON body
  （Pydantic model，前端 `apiClient.post(url, params)`）
- **Query 驗證用 `pattern=`**，不用已棄用的 `regex=`
- **中文檔名下載**：`Content-Disposition` 用 RFC 5987
  `attachment; filename*=UTF-8''...` 格式
- **照片上傳並發限制**：`request_limiter.py` 的 `require_photo_upload_slot()`
  依賴注入，槽位數由環境變數控制
- **photo mapping 兩步驟協議**：先重命名所有非 null 項對齊新格位前綴（收集
  incoming 集合），再處理 null 項且只刪未被移走的檔案；順序顛倒會在跨頁互換時弄丟照片
- 安全 Headers（`X-Frame-Options: DENY` 等）由 `main.py` 的
  `SecurityHeadersMiddleware` 全域加入
