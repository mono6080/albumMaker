# Illustrator 式群組與素材文字框輔助 v1 規格

> 狀態：已實作的相容基線；通用與巢狀行為由 `illustrator-style-nested-groups-v2.md` 取代。
> 基線 `fab0732`，實作 branch `feat/illustrator-style-groups`。
> 舊 safe-area / text-owned-background 實驗不構成相容契約。

## Verdict

Decision：文字與圖片仍是兩個獨立 child；group 是結構、選取與圖層單位，不是第三套幾何。

- Root 單擊任一 child 選取整組；雙擊或按 Enter 進入 isolation，才可分別編輯 child。
- Group / Link / Ungroup 不得修改 child 的位置、尺寸、旋轉、比例、樣式、ID 或媒體 key。
- 這三個結構命令不得改變有效 stacking；只有在建立／解除群組或調整 root 圖層時，才可正規化
  `z_index` 這項排序 metadata，且正規化前後 pixels 必須相同。
- Group 不保存 `x/y/width/height/scale`；bounds 每次由 children 的 world geometry 推導。
- Root group 只允許移動、旋轉與四角等比縮放；進入 isolation 後，圖片可自由拉寬或壓扁。
- 沒有安全區、frame、fit mode 或持續同步 constraint。
- 圖片分析只是一個明確命令，用來建立普通文字框，或重設已連結文字框的幾何。
- 分析、連結或文字放不下時，都不得自動改變圖片比例、字級或內容。
- v1 只支援一層、非巢狀的 text / sticker 群組；migration 延後到本功能驗收後。

不要在 v1 建 parent affine matrix、nested group、shear、auto-fit 或通用 constraint system。

## Problem

baseline 把 `text_labels` 與 `stickers` 當成互不相關的 root elements。若把兩者硬合成一個
「附著底圖文字物件」，會失去 Illustrator 式的獨立 child 編輯，也會重新產生文字框、
素材框、group 外框誰是權威的問題。

另一方面，圖片素材常有可放文字的留白；自動分析仍有價值，但它只能是一次性的建框工具。
分析結果不能留在 layout 裡控制 renderer，也不能在之後悄悄拉伸圖片來配合文字。

## Scope

In scope：

- Shift 多選 text / sticker、Group、Ungroup 與 optional material-text link。
- Root group selection、雙擊／Enter isolation、Escape／breadcrumb 離開。
- Group move、rotate、uniform scale；isolation child 自由 move/resize/rotate。
- Group root z-order、child internal order、layer list 與 atomic undo/redo。
- 圖片分析後一鍵建立文字框；對 linked text 一鍵重設幾何。
- Layout save validation、前後端相同 render-tree、template copy、preview/render parity。
- 受保護圖片只讀分析；操作前後 media key 與 ACL 不變。

Boundary：group 管理 membership、root stacking、selection 與使用者明確觸發的 transform；它不讓
children 永久保持相對位置，也不保證文字 fit。Isolation 內改一個 child 不會帶動另一個。

## Group Domain Model

### 單一幾何權威

Children 繼續存在於既有 `text_labels[]`、`stickers[]`，並以現有
`x/y/width/height/rotation` 作為唯一 world geometry。`groups[]` 只引用 `(type,id)`。

```text
root render tree
├─ standalone element
└─ group（不畫像素）
   ├─ sticker ref → 既有 sticker renderer
   └─ text ref    → 既有 text renderer
```

Group bounds 使用所有 child 旋轉後四角，在 `selection_rotation` 座標軸內求聯集；bounds 不儲存。
`selection_rotation` 建組時為 0，rotate 後正規化至 `[-180,180)`；只決定 editor 外框方向，不參與
正式 renderer。Bounds 不計入 shadow/selection stroke，pivot 是該 oriented bounds 的中心。

### 建立、解除與生命週期

- Group 至少選 2 個未被群組的 text/sticker；child ID 與所有欄位逐值不變。
- 被選 children 必須在目前 root render order 相鄰；否則拒絕並提示先調整圖層，避免建組改畫面。
- Group 的 `z_index` 取該連續區塊位置，children 順序沿用原 render order；若既有 root
  `z_index` 有碰撞，先按 baseline 的穩定 render order 正規化為連續整數，畫面順序不得變。
- Ungroup 在 group 位置依 child order 放回 root；world geometry、ID、style、path 不變。若 group
  曾移過 root 圖層，只重排必要的 root `z_index` 以保留目前 stacking。
- 每個 child 最多屬於一個 group；v1 禁止 group child 與 cycle。
- 刪 child 時同步刪 link；群組只剩一個 child 時自動 ungroup；空 group 不可保存。
- Delete group 刪除 group 與 children，但不刪 storage bytes；Ungroup 是保留 children 的獨立命令。

### Root group transform

所有操作以 gesture 開始時推導的 group pivot 為準，結束時一次寫回全部 child：

```text
move:    child.x/y += delta
rotate:  child center 繞 pivot 旋轉 delta；child.rotation += delta
scale:   child center 相對 pivot 等比乘 scale；child width/height 乘 scale
```

Root uniform scale 是使用者明確的 Illustrator 式 artwork scale，因此 text 的 `font_size`、
`letter_spacing`、文字陰影 offset/blur 等長度型 style 也乘 scale。Group/link/analysis 不執行
這套 scale。精確 allowlist 是 `font_size`、`letter_spacing`、`text_shadow_offset_x`、
`text_shadow_offset_y`、`text_shadow_blur`；dimensionless `line_height` 不變。Geometry/style commit
四捨五入至 0.001。Isolation 中拉文字框只改框，不改 font size。

Root 禁止非等比 group scale：對旋轉 child 非等比縮放會產生現有 rectangle schema 無法表示的
shear。圖片要改比例，必須進 isolation 後調整該 sticker；不做比例鎖定或自動復原。

### Isolation state

Isolation 是 editor view state，不存 layout：

```text
scope: root | isolation(groupId)
selection: none | standalone(type,id) | group(groupId) | child(groupId,type,id)
gesture: idle | transforming(target,beforeSnapshot,transientTransform)
analysis: idle | pending(pageId,stickerId,path,assetRevision,geometrySignature,requestSequence,optionalGroupId)
```

- Root 單擊 grouped child 選 group；雙擊 grouped child 進 isolation 並選該 child。
- Touch 與鍵盤另提供「進入群組」按鈕／Enter，不只依賴雙擊。
- Isolation 只讓該 group children listening；其他元素淡化且不可選。
- Escape 先取消未提交 gesture，再退出 isolation，最後才取消 root selection。
- Selection/isolation/hover/loading 不進 undo；每個完整 command 或 gesture 只進一筆 history。

### Layer order

Root renderer 先排 standalone elements 與 groups；grouped children 不可再以 root element 渲染。
Group 內依 `children[]` 先後繪製。Root layer move 把 group 當一個 block；isolation layer move
只調整 child order。Group 建立本身不允許改變任何 pixel stacking。

## Data/Schema/API Contracts

```jsonc
{
  "group_contract": "flat-world-v1",
  "groups": [{
    "id": 9001,
    "z_index": 12,
    "selection_rotation": 0,
    "children": [
      { "type": "sticker", "id": 101 },
      { "type": "text", "id": 202 }
    ],
    "links": [{
      "kind": "material-text-v1",
      "material_id": 101,
      "text_id": 202
    }]
  }],
  "stickers": [{
    "id": 101, "x": 80, "y": 700, "width": 620, "height": 180,
    "rotation": 0, "path": "templates/tmpl7/stickers/bubble.png", "filename": "bubble.png",
    "asset_revision": "sha256:..."
  }],
  "text_labels": [{
    "id": 202, "x": 150, "y": 745, "width": 480, "height": 90,
    "rotation": 0, "text": "{name}今天完成了挑戰！", "font_size": 20
  }]
}
```

Validation：

- `group_contract` 有 groups 時必須是 `flat-world-v1`；舊 layout 省略兩者合法。
- Group id 頁內唯一；不接受持久化 bounds、scale、matrix 或 nested group ref。
- Element/group ID 只能是非空字串或有限整數；canonical key 為 `${type}:${String(id)}`。每個既有
  collection 在 canonicalize 後都必須唯一，`1` 與 `"1"` 視為碰撞並以 422 拒絕，輸出仍保留原型。
- Child type v1 只能是 `text` / `sticker`，ref 必須存在且同一 group 不可重複。
- Child membership 全頁唯一；group 至少兩個 children，陣列順序就是 internal z-order。
- Renderer 對相同 `z_index` 使用固定 tie-break：legacy type order、原陣列 index、group array index。
  Save validator 不因舊資料重複 z 而拒絕；editor 的 group／ungroup／layer command 才把目前 root
  render order 正規化為連續整數。Grouped child 自己的 z-index 在群組期間忽略。
- Link refs 必須都是同 group children；material 是 sticker、text 是 text，兩端皆最多一條 link。
- Group / ungroup / link command 必須用單次 layout snapshot commit；不得逐 child 建多筆 history。
- Save validation 失敗固定回 `422 {"detail":{"code":"invalid_layout_group","errors":[...]}}`；每項
  error 有 `path/group_id/child_type/child_id/message`。Backend 不得修寫 request 或靜默正規化。
- 若 renderer 讀到繞過 validator 的 malformed persisted groups，前後端都忽略該頁全部 groups 並以
  legacy flat traversal 每個 child 畫一次，同時記錄 warning；不得部分套用而造成重畫或漏畫。

### 圖片分析命令

API：`POST /api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion`

Payload 精確為 `{ "sticker_id": ..., "path": "...", "source_revision": "...或null",
"request_token": "..." }`。
新上傳 sticker 回傳並保存 `asset_revision = sha256:` 加上 EXIF transpose 後 RGBA pixels 的 digest；
同檔名覆寫仍可辨識內容版本。`source_revision` 是該值；legacy sticker 可省略，backend 會回傳實際
digest，但只保證 path/geometry/request-sequence stale guard。另帶最多 128 字元的 `request_token`，
backend 原樣回傳；frontend 保存 request 當下的 `path/x/y/width/height/rotation` signature。
Backend 必須確認：使用者為 admin/art_team；
path 必須是無 traversal 的 canonical key，且屬於該 template sticker namespace；唯一 legacy 例外是
canonical sticker id 在該頁存在且 path 完全相等。若有 `source_revision`，decoded digest 不相等回
409 `asset_revision_stale`。接著只用
`StorageAdapter.open_image()` 讀取並回：

```jsonc
{
  "status": "suggested",
  "normalized_box": { "x": 0.14, "y": 0.2, "width": 0.72, "height": 0.58 },
  "confidence": 0.88,
  "detector_version": "alpha-inner-rect-v1",
  "source_revision": "sha256:...",
  "request_token": "..."
}
```

分析端點零 DB/storage 寫入，不改 ACL、metadata、公開狀態或 URL。無可靠結果回 200
`status: "unavailable"`，reason 只能是 `no_shape`、`low_confidence`、`image_too_small`；媒體不存在
回 404；非法／跨 template reference 回 422。Suggested box 各值必須 finite，`x/y >= 0`、
`width/height > 0`、`x+width <= 1`、`y+height <= 1`。

Frontend 把 normalized box 投影至 sticker **目前**的 world `width/height/rotation`；圖片即使已
非等比變形，也不得恢復 intrinsic ratio。公式是：normalized rect center 先換成 sticker local
center coordinates，再繞 sticker world center 旋轉；輸出 text 的 `x/y` 是未旋轉矩形左上角、
`width/height` 是 local dimensions、`rotation = sticker.rotation`，commit 時四捨五入至 0.001。

- 「分析圖片並建立文字框」：新增普通 text label，以 sticker 當下 root slot 建立
  `children=[sticker,text]` 的 group/link；新 text 位於 sticker 上方，原有其他 root 的相對順序
  不變。Sticker 除必要 z normalization 外所有欄位不變；整個動作一筆 undo。
- 「連結既有文字與圖片」：只建立 group/link，不呼叫分析、不調整 geometry/style 或有效
  stacking；只有上一節允許的無像素差異 z normalization。
- 「重新分析並重設文字框」：只改 linked text 的 `x/y/width/height/rotation`；保留
  id、內容、用途、字體、字級、顏色、對齊、行距、字距、陰影、z 與圖片所有欄位。
- Response 回來時 group/image 不存在、path/revision 或 image geometry 已變，結果作廢並提示重試。
- Layout 不保存 normalized box、confidence 或 detector version；renderer 永遠不讀分析結果。

同一 pair/link 已存在時為 no-op；兩個 child 分屬不同 group、或任一端已有另一條 link 時以明確 UI
錯誤拒絕。Link-existing 保留兩者原 render order。v1 不做 overflow 判定，也不自動放大框、圖片，
不縮字，不阻擋既有輸出流程；文字 fit 另開一份跨 PIL/Konva measurement 規格後再做。

## Reference Config or Example

建立 group 前後，下列 child 欄位必須 deep-equal；`z_index` 另依排序正規化規則只比較有效順序：

```jsonc
{
  "sticker": ["id", "x", "y", "width", "height", "rotation", "path", "filename", "asset_revision"],
  "text": ["id", "x", "y", "width", "height", "rotation", "text", "font_size",
           "font_family", "font_color", "text_align", "line_height", "letter_spacing"]
}
```

建議框 `(0.1,0.2,0.8,0.6)` 投影到已被使用者拉成 `600×200` 並旋轉 30° 的 sticker 時，
文字框使用目前顯示尺寸得到未旋轉 local size `480×120`，中心跟著 sticker 旋轉；sticker
仍為 `600×200 / 30°`，不得改回原圖比例。

## Compatibility

- 沒有 `groups` 的既有 layout 讀取、儲存、preview、render 與 template copy 行為不變。
- `text_labels[]` 保持頂層且 ID 不變，project/student/static/empty/alignment override 繼續命中。
- `stickers[]` 保持頂層，既有 template copy path rewrite 繼續運作；groups 只引用 ID。
- 前後端各自實作相同 render-tree pure function，讀同一份 fixture；grouped child 只 render 一次。
- Renderer/group traversal 來源加入 pipeline fingerprint，project preview cache version 同步更新。
- Group/link/analysis 不改 media key；刪 group/child 也不刪可能共用的 storage bytes。
- Validator 保留未知 legacy 欄位；刪 child/group 不清 project/student override JSON 的孤兒 key。
- 舊 `frame`、`fit_mode` 或相鄰 text/sticker 不會被自動解讀為 group。
- 本 phase 不新增 startup migration；批次配對、正式 DB 改寫全部延後到功能與互動驗收完成之後。

## Implementation Slices

1. **Group contract 與 pure functions**
   - Layout validator、render-tree、group bounds、group/ungroup/link、move/rotate/uniform-scale、
     normalized-box projection、shared fixtures 與 JS/Python tests。
   - 範圍閉合包含 schema、API error shape、tests、docs；排除 UI、migration、scratch artifacts。
2. **Backend render-tree 與圖片分析**
   - Save validation、preview/print traversal、suggestion endpoint、StorageAdapter media checks、
     template copy/cache/fingerprint、auth/negative/regression tests。
   - 依賴 Slice 1 的 schema、tree node 與 projection contract，不複製另一套判斷。
3. **Editor selection/isolation/group commands**
   - Multi-select、root/group/child state machine、group control node、uniform Transformer、keyboard、
     layer/property views、atomic history 與 selection reconciliation。
   - 依賴 Slice 1 pure operations與 Slice 2 save validation。
4. **分析建立／重設文字框 UI**
   - Pending revision guard、create/link/reset commands、error copy、media invariant E2E。
   - 依賴 Slice 2 endpoint 與 Slice 3 group/isolation commands。
5. **全防線與 SSOT 文件**
   - Backend/full frontend tests、Chromium/WebKit、render parity、build/lint；更新 data-model、
     rendering、API、testing 與設計組教學，將本 spec 標為 implemented。

每個 slice 排除 DB copies、migration reports、screenshots、cache、`teacher-overview.xlsx`；
所有非 UI layout mutation 都必須是 deterministic pure operation，方便 undo 與 parity 驗證。

## Acceptance Smoke

- Schema：duplicate/missing refs、nested group、multi-membership、非法 link 皆 422 並指出 group/child。
- Group round trip：Group/Ungroup 不改 child world geometry、ID、style、path；固定字型／透明重疊
  fixture 的 backend 794×1123 PNG byte pixels 完全相同，並含一個 group 外第三元素。
- Link round trip：link/unlink 只改允許的 group/link/order metadata；child geometry/style/path 與
  backend pixels 不變。
- Z-order：相鄰 children 建組前後 pixels identical；非相鄰 selection 被明確拒絕；analysis-create
  把新 text 插在 sticker 上方且所有既有 root 的相對順序不變。
- Selection：Root 單擊任一 child 選 group；雙擊直接 isolation 並選中該 child；Enter 進入、
  breadcrumb 離開。Isolation 外元素淡化且 click/drag disabled；Esc 先取消 gesture，再退出 scope。
- Bounds：混合 0°、30°、-15° children 的 control 包住所有旋轉後四角；group rotate 更新
  `selection_rotation`，child edit 不改它，hard reload 後依同一軸重算一致。
- Transform：group move/rotate/uniform-scale 一次 undo；取消 gesture 零 mutation；無 shear。
- Manual ratio：isolation side handle 與 property width 都可自由變形；固定中心錨點時只改預期的
  x/width，height/rotation/path 不變。Save/reload/PIL 及之後 group uniform scale 都不會 snap 比例。
- Child edit：isolation 移動/縮放/旋轉 text 時 sticker byte-for-byte 不變，bounds 即時重算。
- Analysis create：只新增 text/group/link/order metadata；圖片 geometry/path/revision/ACL/bytes 不變，
  layout 不保存 normalized box/confidence/detector 或任何安全區欄位。
- Analysis reset：只改 linked text `x/y/width/height/rotation`，其餘 text、group/link、image 與
  project/student override deep-equal。
- Async：用 deferred A/B 測 create/reset；A pending 時改 path/revision/geometry 或發 B，再解 A 必須
  零 layout/history/storage mutation，有效 B 只套用一次。
- Overrides：template、project string、student object、align-only、empty、static 在 group 前後相同。
- Media：同一 key 在 admin/art_team read+browser/PIL decode 為 200，authenticated 非角色為 403、
  anonymous 為 401、cross-template 422、missing 404。Fake local/R2 adapter call log 只允許 open/exists，
  put/copy/delete/metadata 為 0，前後 checksum/key 不變；真 R2 smoke 可 env-gated。
- Parity：shared fixture 的每個 `(type,id)` traversal 恰好一次，render-tree order/world box/rotation
  精確相等；screen/print 與 flat baseline 比 pixels。Browser 比 scene geometry 與各引擎自身 screenshot
  tolerance，不要求 Chromium/WebKit 彼此逐像素相同。
- History：group、ungroup、link、analysis create/reset、每次 gesture 各一筆；一次 undo 恢復完整
  before snapshot，第二次不再拆半步，redo 恢復 final；pending/cancel 為零筆。
- Persistence：上述 group/link/order、free ratio、analysis create/reset 全部 save→hard reload→正式 render；
  reload 後回 root/no selection，layout refs、child order、media key 與 geometry 保持。
- No migration：啟動與讀舊 layout 不新增 group，不依位置猜配對，不寫 DB。
- Final gates：pytest、frontend unit/lint/build、render parity 全通過；group roundtrip、isolation 鍵鼠、
  free ratio、analysis create/reset+stale、undo 與 hard reload 同一核心 E2E 跑 Chromium/WebKit；
  worktree 無測試產物或非本功能檔案。

## Non-Goals

- 不做安全區、持久化分析框、文字自動 fit、圖片自動變比例或字級自動調整。
- 不做 nested groups、photo/bubble grouping、group non-uniform scale、shear 或 affine matrix。
- 不在 group/link 時自動對齊、置中、改圖層或分析圖片。
- 不做舊資料 migration、批次配對、正式 DB 寫入或素材 ACL 變更。
- 不要求 children 在 isolation 中保持同步；group 不是 constraint。

## Open Questions

本 v1 無阻擋實作的產品問題。未來 phase 另行決定：nested/general groups、完整 affine transform、
photo/bubble children，以及 v1 驗收後的舊資料 migration。
