# 相本個別完成 v1

## Verdict

在既有「全班完成」之上疊加學生層完成狀態:老師可逐一標記單一學生的相本
完成,完成的學生內容鎖定並立即開放**該生**的 PDF/圖片下載;任一學生完成後
全班文字整份硬鎖;全班每位學生都完成時,「全班完成」在同一 transaction 自動
成立。全班 ZIP 下載仍只由全班完成解鎖——部分完成不能下載全班 ZIP。
老師進度報表契約([academic-term-reporting-v1](academic-term-reporting-v1.md#teacher-progress-contract))不變:
`workflow_status` 仍只由 `projects.completed_at` 決定。

## Problem

- `completed_at` 只存在 Project 層,一位學生落後,全班任何人的 PDF 都不能下載。
- 老師想先交已完成的孩子,現在只能等全班到齊才按「全班完成」。
- 全班完成一鎖就是整案,無法表達「這幾位已定稿、其他人還在做」。

## Scope

- `students.completed_at` 欄位與冪等 migration。
- 標記/退回單一學生完成的端點與權限。
- 個別內容鎖、全班文字硬鎖、下載閘門的分層規則。
- 全員完成自動成立全班完成;退回的層級語意。
- 模板同步退回語意擴充到學生層。
- ProjectReview 與編輯器前端的鎖定/下載 UI。

## Domain Model

`project_students` 新增:

- `completed_at`(DateTime, nullable)——非 NULL 代表該生相本已標記完成。

migration 依慣例在 `run_migrations()` 追加、可重跑;**既有已全班完成的專案不
回填學生時間戳**,一切判斷採用下方 predicate。

有效完成 predicate(唯一判斷式,集中在 `project_access_service`,新增的
assert 函式與 `assert_project_downloadable` 同住;所有下載與內容鎖都必須
經由它,不得散落自行比對欄位):

```
student_effectively_completed = (
    student.completed_at IS NOT NULL OR project.completed_at IS NOT NULL
)
```

例外:上傳照片 ZIP(`photos/archive`)屬素材匯出、非渲染輸出,不經
`assert_*_downloadable` 閘門(見 Download Contract)。

## State Contract

### 標記單生完成

`POST /projects/{id}/students/{student_id}/complete`:

- 權限同專案內容編輯(目前任教老師、admin;`can_edit`)。
- **前置條件:該生內容必須填滿**——照片格與可填文字全數已填,計算規則與
  老師進度完全相同(同一函式,不得另寫一份:合併全班文字、排除跳頁與
  固定/不可填文字)。未填滿 → 409 `student_content_incomplete`,detail 附
  `photo_filled/photo_total/text_filled/text_total`。
- 已完成則冪等回傳既有時間戳(不重驗內容)。
- 寫入後**同一 transaction** 檢查:若全班學生 `completed_at` 皆非 NULL,
  同時寫入 `project.completed_at`(自動成立,報表即為 `submitted_locked`)。
  自動成立只由「標記完成」動作觸發。

### 退回

- **單生退回** `POST /projects/{id}/students/{student_id}/reopen`:
  - **一律只有主管/admin**(既有 `can_reopen`),不分全班完成成立前後;
    老師誤按個別完成也需主管退回。
  - 全班完成已成立時退回單生,**同時清除 `project.completed_at`**
    (不再是全員完成),其他學生的 `completed_at` 保留。
- **全班退回**(既有 `reopen_project`):清除 `project.completed_at` **與全部
  學生的 `completed_at`**——退回全班就是完整解鎖,不留殘餘個別鎖。

### 模板同步

模板同步在 `added_photo_slot_count > 0` 時,現行會清 `project.completed_at`
(`template_project_sync_service`);本契約擴充為**同時清全部學生的
`completed_at`**(新照片格對每一本都是缺格)。sync backup 的 `students_json`
必須納入 `completed_at`,供人工復原對照。

### 手動全班完成

既有 `complete_project` 保留、行為不變(不回填學生時間戳、**不驗內容**,
缺漏仍由老師進度 attention codes 呈現);下載與鎖定判斷一律走 predicate,
因此手動全班完成後單生下載照常可用。

## Write Contracts

分兩層,鎖定判斷全部使用上方 predicate:

**逐學生寫入**——目標學生已完成即擋(409,`student_completed_locked`,訊息
指引先退回該生):

- 照片上傳/刪除/搬移(`project_photo_service` 各單生入口)
- 個別文字 `update_student_label_texts`
- 跳頁 `set_page_skip`
- 相本稱呼(`project_student_service` 三個入口;批次 auto-fill 改為
  只處理未完成學生)

**跨學生寫入**:

- 全班文字 `update_project_label_texts`:**任一**學生已完成即整份硬鎖
  (409,回應列出已完成學生,指引先退回)。
- 批次文字 `batch_update_texts`:payload 含任何已完成學生 → 整批 422 拒絕,
  不做部分寫入。
- 共用照片 `upload_shared_project_photo`:
  - 指定 `student_ids` 含已完成學生 → 422。
  - 未指定(套用全班)→ 在鎖內自動排除已完成學生,回應必須揭露被跳過的
    學生(不得靜默少套)。
- `rename_project`:**完全不受完成狀態影響**(個別完成與全班完成都不擋;
  這是對現行行為的明確放寬——現行全班完成後改名會被內容鎖擋下)。理由:
  專案名稱只進輸出檔名(`build_combined_stem`)與渲染快取 token,不進相本
  內容,改名不破壞完成鎖語意。行為維持:清全部學生輸出(含已完成學生;
  有效完成的學生隨即排入背景重渲,下載端點另以指紋補渲兜底,見
  [rendering.md](../dev/rendering.md#渲染時機完成觸發背景渲染與下載前補渲))。
  權限仍是 `can_edit` 且未封存。
- 封存/復原/留言:不受個別完成影響,維持現行規則。

渲染維持不受完成狀態限制(`student_render_service` 既有契約:完成後仍須
允許產生交件檔)。

## Download Contract

- 單生 PDF、單生圖片 ZIP、單頁 JPG:該生 predicate 成立即可下載;未完成回
  409(訊息由「請先標記全班完成」改為「請先標記此學生完成」)。
- 全班 PDF ZIP、全班圖片 ZIP(`download/all*`):**只看
  `project.completed_at`**;部分完成一律 409(`class_zip_requires_full_completion`,
  訊息附「已完成 n/N 位」)。
- 上傳照片 ZIP(全班 `photos/archive`、單生 `students/{sid}/photos/archive`):
  **不套完成閘門**——只驗 object read capability,原始照片是素材、非交件;
  無任何上傳照片時 404。

## Reporting Contract

- 老師進度 `workflow_status`、content_status、attention_codes 與 Excel 全部
  不變;個別完成**不**進報表 API(見 Non-Goals)。
- 學期匯出維持只看 PDF 是否產生,與完成狀態無關。

## Frontend Contract

- ProjectReview(`StudentReviewCard`):每生「標記完成」按鈕(老師)與
  「退回」按鈕(僅主管/admin 可見,與全班退回同權限)、完成徽章與時間;單生下載按鈕以該生 predicate 解鎖;全班下載按鈕維持全班完成
  才解鎖,部分完成時顯示「已標記完成 n/N 位,交件 ZIP 需全班標記完成」。
  UI 詞彙約定:「填齊」指內容進度、「標記完成」指 completed_at 流程狀態,
  判斷式 SSOT 在 `frontend/src/utils/reviewCompletion.js`。
  「下載上傳照片」按鈕(全班與單生)不受完成狀態限制,僅依 `can_read`
  顯示與啟用。
- 進度區(`ProjectReviewProgress`)顯示標記完成 n/N(由既有學生資料前端
  計算,不新增報表 API)。
- 編輯器(ClassEdit/StudentEdit):已完成學生唯讀——擋照片上傳、文字編輯、
  跳頁切換,顯示鎖定提示;全班文字欄位在任一學生完成時鎖定,提示需先退回
  哪些學生。
- 共用照片(多人同一張)選人 UI:已完成學生不可勾選;套用全班時預先顯示
  將跳過誰。
- 改動 `frontend/src/**` 後必 build(CLAUDE.md 硬規則)。

## Acceptance Smoke

- 缺照片或缺文字的學生標記完成 → 409 `student_content_incomplete` 附計數;
  補滿後可標記;跳頁的格子不計;以全班文字補滿的格子計入已填。
- 學生 A 標記完成後:A 的照片/文字/跳頁/稱呼寫入 409;B 完全不受影響;
  A 可下載單人 PDF/圖片;全班 ZIP 409 且訊息含 n/N。
- 任一學生完成後,全班文字 PUT 409;退回該生後可改。
- 批次文字 payload 含已完成學生 → 422,無任何學生被寫入。
- 共用照片套用全班時跳過已完成學生且回應揭露;指定名單含已完成 → 422。
- 最後一位學生標記完成 → 同 transaction 寫入 `project.completed_at`,老師
  進度顯示 `submitted_locked`。
- 老師退單生一律 403(不分全班完成成立前後);主管退單生成功,且全班
  完成已成立時 `project.completed_at` 一併清除,其他學生保持完成。
- 全班退回後,全部學生 `completed_at` 清空,無殘留個別鎖。
- 手動全班完成(未逐生標記)後單生下載可用;全班退回後一切可編輯。
- 模板同步新增照片格 → 專案與全部學生的完成同時退回。
- 部分完成與全班完成後 `rename_project` 都成功、全部學生輸出清空,
  已完成學生透過「產出並下載」以新檔名重新取得 PDF;改名不解除任何
  完成狀態。
- migration 重跑無錯;既有已完成/未完成專案行為與現行完全一致。

## Non-Goals

- 老師進度 API、Excel 與學期匯出不加入個別完成欄位或狀態。
- 不引入 `partially_submitted` 等新的 workflow_status。
- 不擋園所名冊層的相本稱呼修改(名冊寫入不經專案內容鎖;下載端點的指紋
  補渲會讓下載產物跟上新稱呼,見 known-issues)。
- 不自動為既有已完成專案回填學生時間戳。
- ~~不改變渲染時機或補渲染流程。~~ 已由後續迭代取代:完成觸發背景渲染、
  下載前指紋補渲,SSOT 在
  [rendering.md](../dev/rendering.md#渲染時機完成觸發背景渲染與下載前補渲)。

## Open Questions

無。v1 以本契約直接實作。
