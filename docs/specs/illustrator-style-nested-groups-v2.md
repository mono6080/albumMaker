# Illustrator 式通用巢狀群組與素材文字捷徑 v2 規格

> 狀態：規格鎖定後實作。取代 v1 的「只允許一層 text/sticker 群組」限制；不做舊資料批次遷移。

## Verdict

Decision：群組是所有可編輯畫布物件共用的結構能力，並允許任意深度巢狀；素材圖片與文字的
關聯不是特殊物件類型，只是一個「分析素材後建立／重設普通文字框」的操作捷徑。

- 可群組的 direct node：`photo`、`bubble`、`text`、`sticker`、`group`。
- Group 只保存 direct children、scope 內圖層位置與 selection axis；所有 leaf 的 world geometry 仍是
  唯一權威。Group 不保存 bounds、matrix、scale 或額外 frame。
- 同一物件只能有一個 direct parent；groups 必須形成無環 forest，巢狀深度不設產品上限。
- 雙擊一次只進入或退出一層 isolation；使用者不會因 child 的 Undo/Redo 被踢出仍存在的群組。
- 群組等比縮放會調整所有 descendant leaf 的位置與外框尺寸，但所有文字排版數值保持原值；
  `text` 與 `bubble` 的字級、字距、行高、陰影數值在拖曳預覽和 commit 後都不可放大縮小。
- 圖層不相鄰也可群組；新群組占用所選 direct nodes 中最上層物件的原位置。
- `Ctrl/Cmd+G` 是 scope-aware toggle：多選時群組；只選一個完整 group 時解除該 group。
- 拖拉多選框只選目前 isolation scope 的 direct nodes；巢狀 group 視為一個 node。
- 素材文字捷徑只可改文字框 `x/y/width/height/rotation` 或新增普通文字，不得改素材比例／尺寸、
  媒體 key、字級或文字內容；link metadata 不參與 renderer，也不把 group 變成特殊類型。

不要在 v2 建 parent affine matrix、shear、非等比 group transform、持續同步 constraint、文字 auto-fit、
安全區或啟動時 migration。Leaf 在 isolation 內仍可使用既有的自由 resize 行為。

## Problem

v1 把 group 限制成 root 上的一層 `text + sticker` 組合，資料驗證、selection 與 renderer 都把它視為
特例。這會讓 photo、bubble 與既有 group 無法參與同一套編輯操作，也使「素材分析」被誤認為群組
本身的語意。

真正需要的是兩個正交能力：

1. 通用結構群組：管理 scope、圖層、選取與批次 transform，可遞迴包含任意 editable node。
2. 素材文字捷徑：一次性分析 sticker，建立或重設普通 text frame；之後各 child 仍可獨立編輯。

如果兩者共用一個特殊物件模型，之後任意 regroup、nested isolation 或 ungroup 都會再次遇到
「誰擁有 geometry」與「圖片是否應配合文字變形」的衝突。

## Scope

In scope：

- `photo_slots[]`、`text_bubbles[]`、`text_labels[]`、`stickers[]` 與 group 的任意混合巢狀群組。
- 同 scope 點選、Shift 多選、拖拉 marquee、多選鍵盤位移、group/ungroup/delete/reorder。
- 遞迴 group bounds、move、rotate、uniform scale，以及固定 typography 的即時 preview。
- isolation path、雙擊逐層進出、Escape／breadcrumb、scope-aware layer/property panels。
- `Ctrl/Cmd+G` toggle 與 editable target 防呆。
- 每個 command/gesture 原子 history；Undo/Redo 後保留仍有效的 isolation 與 direct selection。
- v1 read compatibility、v2 save validation、前後端相同遞迴 traversal、正式 preview/render/copy。
- 素材分析建立文字、連結既有文字並符合素材、重設 linked text，以及 async stale guard。
- 受保護素材的既有 auth/read path、key、bytes、revision 與 ACL 不變。

Boundary：group 只協調結構與使用者明確觸發的 transform。Isolation 內編輯一個 child 不會帶動 sibling；
link 只保留「可再次重設這個文字框」的 relation，不持續同步，也不保證文字內容 fit。

「所有物件」在本 phase 指目前 editor 已可直接編輯的四種 layout leaf；page background、footer、
selection handles、guides 與 renderer-only decoration 不是 group node。

## Group Domain Model

### 單一 world geometry 與 flat registry

Leaves 繼續存在於既有四個 arrays，以現有 `x/y/width/height/rotation` 為唯一 world geometry。
Groups 存在 layout 頂層 flat registry；巢狀只由 `{type:"group",id}` ref 表達：

```text
root forest
├─ photo leaf
└─ group A
   ├─ bubble leaf
   └─ group B
      ├─ sticker leaf
      └─ text leaf
```

```jsonc
{
  "group_contract": "nested-world-v2",
  "groups": [
    {
      "id": "group-b",
      "z_index": 0,
      "selection_rotation": 0,
      "children": [
        { "type": "sticker", "id": 8 },
        { "type": "text", "id": 9 }
      ]
    },
    {
      "id": "group-a",
      "z_index": 4,
      "selection_rotation": 0,
      "children": [
        { "type": "bubble", "id": 3 },
        { "type": "group", "id": "group-b" }
      ]
    }
  ],
  "material_text_links": [
    { "kind": "material-text-v1", "material_id": 8, "text_id": 9 }
  ]
}
```

`z_index` 只在 group 是 root 時參與排序；被 parented 時忽略。Leaf 被 parented 時同樣忽略自己的
`z_index`。每個 group 的 `children[]` 順序是該 scope 由下到上的 direct internal stacking。
Registry array 順序不是 parenthood 或 stacking 的權威，只用作穩定 tie-break。

Root forest 由所有沒有 parent 的 leaves 與 groups 組成。Root sorting 依有效 `z_index`，碰撞時固定使用
legacy leaf type rank／原 collection index／group registry index。Structural command 可把目前 root order
正規化成連續整數；validator 與讀取不得靜默修改 request 或 persisted layout。

### Validation 與 graph invariants

- 有非空 `groups[]` 或 `material_text_links[]` 時必須有 contract。`flat-world-v1` 只允許 v1 group-local
  links；top-level links 必須是 `nested-world-v2`。兩個 arrays 都空／缺少時可省略 contract；最後一個
  group 消失但仍有 top-level link 時只移除 `groups`，保留 v2 marker。兩者都消失才移除 marker。
- v2 child type 只能是 `photo|bubble|text|sticker|group`；leaf ref 必須存在於對應 collection，group ref
  必須存在於 registry。
- Leaf ID 在自己的 type collection canonicalize 後唯一；group ID canonicalize 後唯一。`1` 與 `"1"`
  視為同 ID，boolean、空字串、NaN、Infinity 非法；原始 ID 型別不被改寫。
- 每個 ref 最多出現在一個 group 的 direct children；同 group 不可重複 ref。每個 persisted group 至少
  兩個 direct children。
- Group 不可引用自己；整張 graph 必須 acyclic。Validator、traversal、flatten、bounds、descendant query
  與 subtree mutation 都用 iterative DFS／明確 visiting state，不能因惡意深度造成無限遞迴或 call-stack
  overflow；產品不設深度上限。UI artwork 先 flatten leaves/render paths，不建立與資料深度等量的 React
  recursion；active direct group control才包其 flattened descendant leaves。
- Group 禁止持久化 `x/y/width/height/rotation/bounds/scale/matrix/transform`。未知 legacy 欄位保留，
  但不能參與 bounds、transform 或 renderer。
- v2 link 只可存在 layout 頂層 `material_text_links[]`；group record 不得新寫入 `links`。Endpoint 必須
  是頁內既有 `sticker` 與 `text` leaf；全頁同一 sticker 或 text endpoint 最多參與一條
  `material-text-v1` link。Link 不可指向 group，也不要求兩端同 parent／同 subtree。
- v1 layout 照 v1 child/type/link 規則讀取，是 v2 的合法一層子集；不在 load/save 時改 contract。
  第一次 group structural／素材文字 command 以單一 layout commit 升級為 v2，並把所有合法 v1
  `group.links[]` hoist 到頂層；升級後移除 group-local links且不得改 endpoints 或 leaves。
- Save error 保持 `422 {"detail":{"code":"invalid_layout_group","errors":[...]}}`；每項 error 維持
  `path/group_id/child_type/child_id/message` shape，cycle error 必須指出造成 back-edge 的 child path。

若 persisted **group topology/contract** 繞過 validator 且不合法，前後端都對該頁執行一次 whole-page
legacy flat fallback：忽略全部 groups、每個 leaf 依舊 traversal 恰好一次並記 warning。不得部分套用
graph 造成漏畫、重畫或 stack 不同；editor 此時不提供 group selection/query，直到資料被合法覆寫。

若 group topology 合法、只有 `material_text_links` malformed，renderer 仍使用合法 group traversal並忽略
所有 links、記獨立 warning；因 link 不參與 pixels，不可為了 relation error 改變 stacking。Strict PUT仍
對任一 topology/link error回422；editor可顯示群組但禁用素材捷徑／save並提示先移除失效 relation。

### Scope、建組與解除群組

Scope 是 `root` 或某個 group 的 direct children。建組只接受同一 scope 的至少兩個 direct nodes；
不得跨 isolation 層偷偷 reparent descendant。

建組演算法（scope order 由下到上）：

1. 按目前 scope order 排 selected refs，保留為新 group `children[]`。
2. 新 group ref 放在「最上層 selected ref」的原 slot；其他 selected refs 從 scope 移除。
3. 所有 unselected refs 維持彼此順序。因此夾在非相鄰 selected refs 間的 unselected node 會落在新
   group 下方；這是使用者指定且可預期的 pixel-order 變化。
4. Root scope 正規化 root z；nested scope 只改 parent `children[]`。新 group
   `selection_rotation = 0`，group id 必須頁內唯一。
5. 整個 operation 一筆 history；除必要 `z_index` metadata 外，所有 descendant leaf geometry、style、
   path、revision 與 ID 不變。

Ungroup 只解除所選的完整 direct group：在 parent `children[]` 同一 slot 以該 group 的 direct children
依序取代；root ungroup 同理插回 group 的 root slot並正規化 z。Leaves、nested child groups、geometry
與 layout-level material-text links 全保留。Ungroup 不遞迴 flatten。

Delete group 會刪除整個 descendant subtree 的 group records 與 leaf records，但不刪 storage bytes。
Delete leaf／subgroup 後清理 endpoint 已不存在的 layout-level links；空 group 移除；只剩一個 direct child 的 group 立即以唯一
child 取代並移除，向 ancestor 遞迴 collapse，直到 forest 再次符合至少兩 child invariant。Collapse
在觸發它的同一 command/history snapshot 內完成。

### Bounds 與 transforms

Group 沒有持久化 geometry。Bounds 對所有 descendant leaf 的**可見 control frame**旋轉後四角，在
target group 的 `selection_rotation` 軸上求聯集；不計 shadow、stroke、bubble tail overflow 或 selection
UI。Pivot 是該 oriented bounds 中心。Nested child group 的 bounds 不再當幾何加入，避免同一 leaf
重複計算。

Photo 是必要的 type-specific geometry adapter：`photo_slot_dimension_mode=content-box-v1` 時，stored
`x/y/width/height` 是 content box，但 group bounds/transform 必須使用包含左右上 border 與不對稱底邊的
`getPhotoFrameRect` 可見 frame。寫回 transformed frame 時：frame-box mode 直接保存 frame；content-box
mode 以固定 insets 反推 content box。Border/insets 不隨 group scale；若 target frame 反推後低於既有
direct-editor content minimum（目前 `60×40`）則拒絕該 transform，不能 clamp 某一 child 後造成整組比例
失真。前後端 bounds fixture 必須使用同一 design tokens／dimension-mode contract。

- Move：所有 descendant leaf `x/y += delta`；group rotation metadata 不變。
- Rotate：所有 descendant leaf center 繞 target pivot 旋轉 delta，leaf `rotation += delta`；target group
  與其所有 descendant group 的 `selection_rotation += delta`，ancestor group rotation 不變。
- Uniform scale：所有 descendant leaf center 相對 pivot 等比乘 scale；leaf
  `x/y/width/height` 寫回；leaf rotation 與所有 group selection rotation 不變。
- 所有 geometry 與 angle commit 四捨五入至 0.001；angle 正規化至 `[-180,180)`。
- 同一 descendant leaf 在任何 operation 只能更新一次；scale 必須 finite 且 `> 0`。
- Group transformer 只顯示四角等比 handles 與 rotation；禁止 side-handle nonuniform scale/shear。

Uniform scale 的固定 typography 契約：只修改 leaf frame geometry，所有非 geometry style 欄位
byte-for-byte 保留。至少包含 `font_size`、`letter_spacing`、`line_height`、text shadow offset/blur、
bubble `border_width/border_radius`、字型、顏色與內容。拖曳中的 Konva parent scale 必須對 target subtree
內所有 `text` 與 `bubble` typography 做 inverse-scale compensation，讓 gesture preview 與 commit 後
畫面一致；gesture 結束後清除 transient scale，不能把補償值寫入 layout。

### Isolation、selection 與 history

Isolation 是 editor view state，不保存到 layout：

```text
isolationPath: [] | [rootGroupId, ..., currentGroupId]
selection: current scope 的 direct refs[]
gesture: idle | marquee | transforming(target,beforeSnapshot,transientTransform)
```

- Root 單擊任何 descendant pixel，只選其 root direct node；若是 group，整組選取。
- 雙擊 group pixel 一次只 push 該 direct group，並選中 hit path 的下一個 direct child；不得跳過層級。
- Isolation 中雙擊 direct child group 同理 push 一層。雙擊 current group oriented bounds 外面 pop 一層，
  消費該事件並在 parent scope 選取剛退出的 group；不順便選外面的另一物件。
- 雙擊 current group bounds 內的空白不退出。Escape 在沒有未提交 gesture 時 pop 一層；breadcrumb/back
  也 pop 一層。Touch/keyboard 另提供「進入群組」／Enter 與「上一層」按鈕。
- Isolation 中只有 current group 的 direct nodes listening；更深 group 是單一 selectable node，外部
  nodes 淡化且不可選／拖。
- Click selection、marquee、isolation、hover、pending analysis 不進 history。每個 group/ungroup/delete/
  reorder/material-link/reset、一次完整 drag/transform、一次鍵盤 nudge各是一筆 atomic snapshot。
- Undo/Redo restore layout 後，先找舊 path 由深到淺仍存在的最深 group；若存在，依 restored graph
  重建它目前的完整 ancestor path並保留 isolation。只有所有舊 path groups 都不存在才回 root。
  Selection 只保留仍是 restored current scope direct child 的 refs；其餘清除，不因 selection 失效退出。
- 取消尚未 commit 的 gesture 恢復 before snapshot 且零 history；Undo/Redo 在 isolation 內不得呼叫
  unconditional `clearSelection/exitIsolation` callback。

### Marquee 與快捷鍵

Marquee 只在 Stage 空白開始，超過 4 display-pixel drag threshold 才啟動，並以 canvas coordinates
計算，避免 zoom 改變命中語意。命中 current scope 的每個 direct node：leaf 使用旋轉後四角，group
使用 oriented derived bounds；polygon 與 selection rect 有任何面積交集即命中。Root/current scope 的
group 只回傳 group ref，不回傳 descendants。

- 無 modifier：mouseup 以 marquee hits 取代 selection；空框清除。
- Shift：與原 selection 做 stable union；仍只保留 current scope direct refs。
- Marquee overlay 不 listening、不入 layout/history；click/transform handle/drag node 不可誤啟動。
- 多選後 Arrow keys 依既有步距移動每個 selected direct node；若包含 group，移動其 subtree；同一 leaf
  不可能因 direct-scope invariant 被更新兩次。

`Ctrl+G`（Windows/Linux）／`Cmd+G`（macOS）規則：

- current scope 有 2 個以上 direct refs：建立普通 group，完成後只選新 group。
- current scope 只選 1 個 direct group ref：解除該 group，完成後選被插回的 direct children。
- 其他 selection：no-op；不得把「目前正在 isolation 的 group」因 child selection 而解除。
- `input/textarea/select/contenteditable` 或既有 inline text edit focus 中不得攔截；handled 時才
  `preventDefault`。按鍵不自動進出 isolation。

### Layer order

Layer panel 顯示 current scope 的 direct order；group 可展開顯示 nested tree，但 reorder target 永遠是
current scope direct ref。Root reorder 把 group subtree 當一個 block並正規化 root z；isolation reorder
只改 current group `children[]`。Renderer 以相同遞迴 tree depth-first 畫 leaf，每個 leaf 恰好一次。

## Data/Schema/API Contracts

### 素材文字捷徑

分析 API 與 protected-media contract 沿用 v1：

`POST /api/templates/{template_id}/pages/{page_id}/material-text-box-suggestion`

Payload 仍為 `sticker_id/path/source_revision/request_token`，response 仍為 `suggested|unavailable` 加
normalized box、digest、token。Backend 只使用 `StorageAdapter.open_image()` 讀取；端點零 DB/storage
寫入，不改 ACL、metadata、公開狀態、URL 或 media bytes。既有 admin/art_team auth、namespace、404、
409、422 與 stale response 規則全部保留。

捷徑不是 topology command，不會自動建組、解除群組或改變 z-order。UI 建立既有 pair 時只接受同一
current scope 的 ordinary `sticker` leaf 與 `text` leaf；已存在的 layout-level link 可在 endpoints
之後被任意 regroup／ungroup 後繼續重設：

- 「從素材建立文字」：分析 sticker，在 sticker 的 current direct scope 新增 ordinary text leaf，以
  suggestion 投影所得 `x/y/width/height/rotation` 建框；文字放在 sticker 的正上一層並保存 layout-level
  link，其他 siblings 相對順序不變。
- 「連結／符合素材」：分析 sticker，把既有 text 的 `x/y/width/height/rotation` 重設為 suggestion；
  保存或重用 layout-level link，不改兩端 parent 或 sibling order。
- 「重新分析並重設」：由 link 找到 endpoints，只改 linked text 的五個 geometry 欄位。
- Group/layer UI 不因 link 改名稱或 type；Property panel 可在 endpoint 上顯示「素材文字捷徑」badge。
- Group／Ungroup 不新增、搬移或刪除 link；只有 unlink、endpoint delete 或 subtree delete 才移除 relation。

任何捷徑都不得修改 sticker 的 `x/y/width/height/rotation/path/filename/asset_revision`，不得維持圖片
原始比例的自動校正，也不得因文字放不下而變更素材比例、文字內容、字級、字距、行高或陰影。
Suggestion 只決定 frame；若內容仍 overflow，允許顯示非阻擋提示，由使用者自行改 frame/內容。

Projection、digest 與 stale guard 沿用 v1：normalized rect 投影到 sticker **目前** world
width/height/rotation；response 回來時 page/sticker/path/revision/geometry/request sequence 任一改變即丟棄，
零 layout/history mutation。Layout 不保存 normalized box、confidence、detector 或安全區。

### Atomic API/save boundary

Frontend 所有 pure command 收完整 layout並回完整 immutable layout；一個 UI command 只呼叫一次
`commitPageLayout`。Backend save validator 不修資料。Suggestion request 與 layout save 不是同一交易；
只有有效 response 回到仍相符的 editor state 時才產生一筆 local layout history，之後由既有 explicit
save flow持久化。

## Reference Config or Example

Scope order：

```text
0 sticker-A  [selected]
1 photo-X
2 group-B    [selected]
3 text-Y
```

執行 Group 後：

```text
0 photo-X
1 group-new  children=[sticker-A, group-B]
2 text-Y
```

`group-new` 占原最上層 selected `group-B` 的 slot；`photo-X` 因而在整組下方。`group-B` 保持 nested，
不會被 flatten；所有 leaves 的 world geometry/style/path 不變。

若把包含 `font_size=20` 的 text 與 `font_size=18` 的 bubble 連同 sticker 一起放大 1.5 倍，三者 frame
與相對中心乘 1.5，但兩個 `font_size` 仍分別是 20 與 18；drag preview、mouseup、save/reload 與正式
renderer 必須一致。

## Compatibility

- 沒有 groups 的 legacy layout 讀取、儲存、preview、render、template copy 與 override 行為不變。
- `flat-world-v1` 非空 groups 繼續通過 validator/render；editor 第一次 structural/material-text mutation
  才整份升級 `nested-world-v2` 並 hoist v1 links，不是 startup/load migration，也不猜測新 group。
- Existing leaf arrays 與 IDs 不搬移；project/student/static/empty/alignment overrides 繼續直接命中。
- Sticker path rewrite、asset revision、protected GET 路由與 media auth 不變。Group/link/delete 不刪共用
  storage bytes；analysis call log 只允許 read/open。
- Frontend/backend 各自實作同契約 recursive traversal，讀 shared fixture；render pipeline fingerprint 與
  project preview cache version納入新的 traversal source，避免舊 cache 沿用 flat pixels。
- Renderer 完全忽略 selection rotation、group-local/top-level links、isolation 與 marquee，只依 recursive leaf order及 world
  geometry畫圖。
- Unknown legacy leaf/group fields 保留。舊 `frame/fit_mode/safe_area`、相鄰素材文字或位置近似不會
  被自動解讀為 group/link。
- 不新增 DB column/table；layout JSON contract 升版即可。沒有 migration、批次配對或啟動寫入。

## Implementation Slices

1. **鎖定 v2 spec 與 shared fixtures**
   - 定義 graph/schema/order/transform/isolation/top-level link contracts，建立含四 leaf types、兩層 nested group、
     non-adjacent roots 的 shared fixture。
   - Scope closure：spec、fixture、JS/Python fixture assertions；排除 migration、screenshots、cache、
     `teacher-overview.xlsx` 與任何使用者資料。

2. **Backend validator 與 recursive render traversal**
   - 擴充 `services/layout_groups.py` 接受 v1/v2、四 leaf types、group refs、cycle/membership/top-level link validation；
     `build_layout_render_tree` 與 iterator 以顯式 stack展開 nested graph，並保留 malformed whole-page fallback。
   - 更新 save/copy/render fingerprint consumers 與 targeted pytest；不得變更 suggestion endpoint的
     auth/storage semantics。
   - Dependency：消費 Slice 1 的 exact contract與 shared fixture shape；產出 renderer/save runtime API。

3. **Frontend immutable nested-group domain**
   - 擴充 validator、tree/scope/ancestry queries、bounds、group/ungroup/reorder/delete/collapse、recursive
     move/rotate/scale、photo frame adapter、layout-level material link lifecycle 與 v1-on-edit upgrade。
   - 所有 commands deterministic/immutable；新增 graph、cycle、non-adjacent/nested order、collapse、
     fixed typography、round-trip 與 parity unit tests。
   - Dependency：與 Slice 2 共用 Slice 1 fixture/order/error contract，不複製另一套語意。

4. **Editor nested isolation、marquee 與 keyboard**
   - `TemplateEditor` 改用 isolation path/direct refs；iterative flattened artwork/render paths與 active-scope
     listening；double-click one-level enter/
     outside-exit；layer/property breadcrumb；scope-aware arrows、Delete、Enter、Esc、Ctrl/Cmd+G。
   - Marquee exact intersection與 Shift union；Undo/Redo path reconciliation；selection view state不入 history。
   - Dependency：消費 Slice 3 的 scope/ancestry/command pure APIs。

5. **Group transformer 與 fixed typography preview**
   - Nested group control/bounds、move/rotate/four-corner scale；active subtree 的 text/bubble transient
     inverse-scale typography compensation，mouseup 單次 persistent commit。
   - E2E 比對 gesture中、commit後、Undo/Redo及 reload font props/frame geometry。
   - Dependency：消費 Slice 3 recursive bounds/transform APIs與 Slice 4 current-scope state。

6. **素材文字捷徑整合**
   - Create/link/reset 使用 layout-level relation及 existing suggestion API；不做 topology mutation；pending
     request stale guard、optional shortcut badge、overflow非阻擋提示。
   - Dependency：消費 Slice 2 read-only endpoint與 Slice 3 top-level link commands；不新增 renderer branch。

7. **全防線、文件與分段 commits**
   - pytest、frontend unit/lint/build、Chromium/WebKit核心 E2E、render parity、media invariants、server rebuild/
     restart；同步 data-model/rendering/API/testing與設計組操作說明。
   - 每個 commit 僅含本功能 closure；保留使用者 untracked/dirty files，不 stage test artifacts。

## Acceptance Smoke

- Schema：v1 subset可讀；v2 四 leaf/group refs可存；missing/duplicate/multi-parent/self/cycle/非法 contract/
  missing或重複 link endpoint錯誤皆 422並指到 path。惡意深 nested fixture不 hang/stack overflow。
- Recursive parity：shared fixture 前後端 traversal `(type,id)` 與 depth-first order精確相同，每個 leaf一次；
  malformed graph whole-page fallback與 legacy flat order相同。
- Generic group：photo+bubble+text+sticker+group可在同 scope混合建組；nested round-trip不 flatten，Group/
  Ungroup 除明定 z-order變化外不改 geometry/style/path/media。
- Non-adjacent z：選第 0、2 層，新 group在原第 2 slot，selected children依 0、2 order，未選第 1層在
  group下；Undo/Redo完全還原兩種 order。
- Isolation：至少三層 nested fixture，雙擊每次只進一層；bounds內空白不退，bounds外雙擊只退一層並
  選 exited group；Escape/breadcrumb同規則，外部不可選。
- Marquee：root與isolation各測 rotated leaf/group exact hit、空框、Shift union、4px threshold；nested group
  只選 direct group ref，不洩漏 descendants。
- Shortcut：Ctrl/Cmd+G多選建 ordinary nested group、單一 group解除；input/contenteditable不觸發；
  isolation child selection不解除目前群組。
- Transform：nested outer move/rotate/scale每個 descendant只更新一次；取消零 mutation；每個 gesture一筆
  history；禁止 side-scale/shear。
- Typography：outer/inner group縮放時 text與bubble frame按比例變，font size/spacing/line-height/shadow與
  其他 style deep-equal；drag中視覺字級、commit後、Undo/Redo、save/reload一致。
- History retention：isolation中連續兩次 child nudge可逐步 undo/redo且仍留在同 group；undo刪掉 current
  nested group時退到最深仍存在 ancestor，單純 selection失效不退出。
- Photo geometry：frame-box/content-box各測 border與不對稱 bottom inset；bounds包住可見 frame，合法 transform
  可逆，低於60×40 content的整組scale被拒絕且零 mutation。
- Delete/collapse：nested leaf、inner group、outer group各測；empty/one-child records不殘留，endpoint links清理，
  storage delete call為 0。
- Material create/link/reset：只新增／改文字五個 geometry欄位與 layout-level link metadata；零 group/
  parent/order mutation；sticker geometry/path/revision/ratio/ACL/bytes不變，字級內容不變，link不影響 renderer。
- Async：A pending時變更 page/path/revision/geometry或發 B，A response零 layout/history mutation；有效 B只
  套一次。Unavailable/409/422保持可恢復且不寫 media。
- Media：同 key admin/art_team read/browser/PIL decode 200，既有非角色403、anonymous401、cross-template
  422、missing404；fake local/R2 log只允許 open/exists，put/copy/delete/metadata為0，checksum前後一致。
- Formal render：794×1123 fixture的 group metadata-only round trip pixels identical；有意 non-adjacent建組
  依新 deterministic order；screen/print/Chromium/WebKit各自符合 geometry與容差。
- Persistence：v1 untouched save保持v1；第一個 structural/material edit原子升v2並hoist links；nested groups、
  free leaf ratio、typography、top-level links save→hard reload→正式 render保持。Reload以 root/no selection開始。
- No migration：app startup與讀任何既有 layout零 DB/layout寫入、零位置猜測、零批次 group。
- Final gates：全部 pytest、frontend unit/lint/build、render parity、Chromium/WebKit核心 E2E通過；dev server
  rebuild/restart後 health與 editor可用；worktree無測試產物且不含 `teacher-overview.xlsx`。

## Non-Goals

- 不做安全區、持久化分析框、文字自動縮放／auto-fit、文字內容改寫或圖片自動符合文字。
- 不做 nonuniform group scaling、shear、affine parent matrices、clipping/mask、symbol/component或跨頁 group。
- 不做跨 scope直接建組、多人同步 selection/history或 selection state持久化；layout-level link可以跨越
  後續形成的 group邊界，但新建 link的選取仍限 current direct scope。
- 不做 page background/footer/guides grouping，也不新增 leaf plugin/type registry framework。
- 不做舊資料 migration、批次位置配對、DB schema變更、媒體 ACL/publicity變更。

## Open Questions

無阻擋實作的產品問題。v2 明確將素材文字 relation放在 layout頂層，group graph完全不知道 relation；
兩個能力可以各自建組、解除、分析、復原與演進。
