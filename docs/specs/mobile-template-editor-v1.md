# 手機版模板編輯器 v1 規格

> 狀態：已實作並驗收（2026-07-15）。
> 實作 branch：`feat/mobile-template-editor`。
> 本規格只改編輯器的檢視與操作方式；相本版面資料、正式渲染與 API 契約不變。

## Verdict

Decision：在寬度小於 768px 時，模板編輯器改成「畫布優先」的滿版工作區；工具、頁面、
圖層與屬性由底部操作列開啟，不再把桌面左欄堆在畫布上方。

- 手機 `<768px`、平板 `768–1023px`、桌面 `>=1024px` 是固定斷點。
- 手機首屏必須同時看得到儲存狀態、畫布與主要操作列，不得有 document 水平捲動。
- `layout_json` 維持 794×1123 real space，Konva node 維持既有 530×750 page space；新增的
  viewport space 只用於鏡頭顯示。縮放和平移只屬於
  editor view state，不可進入 dirty、undo、save 或 DB。
- 手機選取物件後不自動打開屬性面板；使用者由底部操作列明確開啟頁面、圖層或屬性面板。
- 觸控不依賴 hover、Shift 或硬體鍵盤：多選、複製、剪下、貼上、群組與刪除都有可點擊入口。
- 平板保留左欄與手動開啟的 side drawer；桌面保留三欄、鍵盤捷徑與儲存語意。正式
  preview／PDF pixels 不得改變。

## Problem

目前 `TemplateEditor` 是固定 530px 畫布加 144px 左欄的桌面佈局。在 390×844 viewport，
document 寬 548px、畫布位於頁面約 839px 以下，使用者要先越過工具與頁面清單才能看到被裁切的
畫布。選取物件又會自動開啟約 92vw 的 inspector，遮住幾乎整個工作區。

此外，手機沒有 hover 與 Shift，多選和剪貼簿操作依賴鍵盤；單指空白拖曳會進入框選；固定尺寸的
Transformer handles 在縮小畫布後更難命中。單純對 DOM 或 canvas 加 CSS `transform` 會讓 Konva
hit testing、拖曳與座標換算偏移，因此不能作為解法。

## Scope

In scope：

- 手機專用的 compact top bar、可視 dirty／save 狀態、畫布 viewport 與 safe-area。
- 底部 dock：選取／多選、新增、頁面、圖層、屬性；頁面和工具改由 sheet 呈現。
- fit-to-viewport、縮放按鈕、雙指 pinch zoom、雙指 pan 與「適合畫面」。
- 明確的手機多選模式、selection quick actions、複製／剪下／貼上／複製一份／群組操作。
- 手機從新增 sheet 選擇類型後，立即在目前可見 page 中央建立並選取物件，關閉 sheet 並回到
  選取模式；桌面仍使用選工具後點畫布的流程。
- 適合觸控的按鈕、Transformer handles、toast／modal／sheet 與 landscape 行為。
- 單元測試、390×844 與 landscape E2E，以及 320／360／390／430px 手動尺寸驗收。

Boundary：只重組 frontend editor interaction。Backend、DB、模板修訂保護、儲存按鈕的 transaction、
頁面新增／刪除等待明確儲存等既有語意均不改變。

## Responsive Workspace Model

```text
phone editor (<768)
┌ ← 第 3/12 頁       ↶ ↷  儲存● ┐
│                                    │
│            canvas viewport         │
│        －  65%  適合畫面  ＋       │
│                                    │
├────────────────────────────────────┤
│ 選取／多選  ＋新增  頁面  圖層  屬性 │
└────────────────────────────────────┘
```

- TemplateEditor route 的手機工作區使用 `100dvh`；`App.jsx` 以精確的
  `/templates/:id/edit` route 判斷在 `<768px` 隱藏全站 Nav 並把 main padding 設為 0，其他 route 不變。
- Top bar 與 bottom dock 固定在工作區內；中間只有 canvas viewport 可平移，document 本身不捲動。
- Sheet 位於 dock 上方，使用 dialog semantics、focus trap、Escape／backdrop 關閉與可見標題；內容過長時
  只捲動 sheet body。底部 padding 使用 `env(safe-area-inset-bottom)`。
- 手機同一時間只開一個 `add | pages | layers | properties` sheet。選取變化不會隱式切換 sheet。
- 平板保留全站 Nav、160px 左欄與 side drawer；選取物件不自動打開 drawer。桌面沿用固定
  inspector 與三欄工作區。切換斷點時關閉 transient sheet／drawer，但保留 selection 與 active tab。
- 手機／平板使用單列 compact top bar：返回、截斷模板名、頁碼、undo、redo 與 save 永遠可見；
  教學、雙頁預覽、照片總數放入更多操作。Template usage banner 可壓成摘要，但 repair alert 仍直接可操作。

## Canvas Viewport Contract

### 座標與狀態

```text
real space:      794 × 1123（layout_json）
page space:      CANVAS_DISPLAY_WIDTH × CANVAS_DISPLAY_HEIGHT（530 × 750）
viewport space:  可用工作區 CSS px
fitZoom:         min(1, (viewportWidth - 24) / 530, (viewportHeight - 24) / 750)
camera zoom:     min(fitZoom, 0.5) .. 3.0
view transform:  translate(viewX, viewY) · scale(cameraZoom)
```

- Konva `Stage` 尺寸等於可用 viewport，不縮放 Stage 本身。背景與版面 nodes 放在 `page-camera`
  Group 下，內層以 530×750 clip 還原舊 Stage 天然裁切邊界；`Transformer` 是 camera 的 sibling overlay，
  保持螢幕像素大小，camera 更新後必須 `forceUpdate()`。不得使用 CSS transform。
- Node 的 `x/y/width/height/rotation` 維持 logical canvas 座標。新增、框選與空白點擊必須先使用
  viewport root 的 inverse absolute transform，把 pointer 換回 logical coordinate，再走既有 real/display
  換算。不得把縮放後的 screen coordinate 直接寫入 layout。
- Add／marquee／double-click 只接受 page coordinate 落在 `[0,530] × [0,750]` 的事件；灰色 workspace
  點擊只取消選取或供 camera gesture，不能建立負座標物件。Marquee 的 4px 啟動門檻以 viewport px 計算。
- `fit` 以 12px gutter 完整置中畫布並把 zoom 設為 fitZoom；fit mode 的 viewport 尺寸或方向改變時
  重新計算，保留選取與資料。manual mode resize 保留原 viewport 中心下的 page point 再 clamp。
- Pinch 以兩指中點作為不動點更新 zoom；兩指平移只更新 viewX/viewY。合理 clamp 必須仍允許看見
  畫布四角，不能把畫布永久推離 viewport。
- Clamp 規則：若縮放後 page 加兩側 gutter 小於 viewport，該軸固定置中；否則 position 限制在
  `[viewportSize - contentSize - 12, 12]`，讓四邊可到達又不會把整頁推失。
- 頁面切換保留 camera；reload/remount 回 fit。100% 是 manual zoom=1，適合畫面回 fit mode。
- `fitZoom/cameraZoom/viewX/viewY/openSheet/multiSelectMode` 全部是 view state，不得呼叫 layout commit、
  設 dirty、建立 history snapshot 或傳到 API。

### Gesture arbitration

- 一指在未鎖定物件上：沿用物件 move／resize／rotate；手勢結束後只產生一筆既有 history。
- 兩指：只做 viewport pan／zoom；開始時取消尚未成立的 marquee，不可改任何物件。
- 若第一指已開始 node drag 或 Transformer transform，第二指不得中途接管 camera；等所有 touch lift
  才可開始下一個 gesture，避免 `onDragEnd` 提交半步 layout。Camera gesture 期間暫停 scene／Transformer
  listening，結束後抑制緊接著的 click。
- 一指在空白處：手機一般選取模式只取消選取，多選模式才可框選；桌面保留原有 marquee。
- 多選模式下點擊物件採 additive selection，再點一次可移除；Layer list 使用相同語意，不依賴 Shift。
- 手機新增 sheet 的 command 取 viewport 中心，經 camera inverse transform 得到 page coordinate，
  將新物件 clamp 在 page 內後立即 commit 一筆、選取並關 sheet；不留下 crosshair placement mode。

### Touch geometry

- 主要可點擊目標最小 44×44 CSS px；小圖示可保留視覺尺寸，但 hit area 不可更小。
- Transformer 留在 camera 外後使用固定 screen-space handle；coarse pointer 顯示 12–14px anchor，
  hit area 至少 44px，desktop 維持 8px。單物件 `boundBoxFunc` 的最小 page 尺寸換算必乘 camera zoom；
  多選 resize factor 保持無因次。不得改變輸出物件 geometry。
- 畫布外框、選取外框與 UI chrome 是 editor-only，不進 preview 或 PDF。

## Editor Commands and Save Contract

- Top bar 儲存沿用目前明確 `handleSave`；頁面新增／刪除只修改前端 draft，不能自動寫 DB。
- Dirty 指示只反映 layout draft 與既有 template metadata；viewport 或 sheet 操作不會變成未儲存。
- 手機 contextual action rail 位於 dock 上方並由 layout 預留空間，橫向內部捲動；呼叫既有 command
  handlers，不另寫第二套 copy／cut／paste／group 演算法。手機不再 mount 現有 32px canvas overlay；
  任一 viewport 只 mount 一份 PropertyPanel 與 LayerListPanel，避免重複 id、focus 與表單 state。
- Paste 沒有可用 clipboard snapshot 時 disabled；cut／delete 繼續遵守 locked element 與 isolation 規則。
- 儲存成功、失敗及 revision conflict 的訊息在 top bar／toast 可見，且不被 bottom dock 或 safe-area 遮住。
- Sheet 共用既有 `useDialogA11y`：`role="dialog"`、`aria-modal="true"`、focus trap、Escape/backdrop/X
  關閉及 focus return。背景在開啟時不可接受 pointer，sheet body 自行捲動。

## Reference Interaction

在 390×844 直向手機開啟 12 頁模板：

1. 首屏顯示第 1 頁畫布、頁碼、dirty 狀態、儲存與 bottom dock；`scrollWidth === innerWidth`。
2. 點「新增」開 sheet，點文字後立即在可見 page 中央建立並選取，sheet 關閉且維持選取模式。
3. 開多選，依序點文字與貼圖，contextual actions 顯示群組、複製、剪下與刪除，不需 Shift。
4. 雙指放大並平移查看右下角；dirty 與 undo 數量不變。點「適合畫面」恢復完整置中。
5. 點「屬性」才開 inspector；關閉後選取仍保留。點儲存後才更新 DB。

## Compatibility

- 不新增或修改 API、ORM、migration、`layout_json` 欄位及 template revision 格式。
- 不修改 `CANVAS_REAL_*`、PIL⇄Konva 補償、正式 renderer、preview cache 或 PDF pipeline。
- 既有 layout 在手機／桌面載入後 deep-equal；只操作 viewport 再儲存時 request layout 不得出現 view state。
- 768–1023px 的 drawer 改為明確開啟、不再因選取自動彈出；>=1024px 的 static inspector、快捷鍵、
  hover、marquee 與三欄排列不回歸。
- 現有 Ctrl/Cmd+C/X/V、undo／redo、group isolation、locked／hidden element 行為繼續共用同一命令層。
- 手機 browser back 不得直接離開含未儲存 draft 的編輯器；既有未儲存保護行為保持有效。

## Implementation Slices

1. **Viewport geometry 與 pure helpers**
   - 在 `utils/canvasCamera.js` 定義 fit、zoom-at-point、pan clamp、viewport↔page pointer 轉換與 unit tests；
     `hooks/useCanvasCamera.js` 負責 ResizeObserver 與 fit/manual lifecycle，且不依賴 layout。
   - 範圍閉合包含 resize／orientation recompute、非 dirty 保證；不含工作區 UI。
2. **Konva viewport integration**
   - 導入 viewport Stage、clipped page-camera、sibling Transformer、pointer inverse transform、
     pinch／two-finger pan、Space/middle-button desktop pan 與 coarse-pointer handles。
   - 範圍閉合包含 add/marquee/drag/transform regression tests；不改 layout schema 或 renderer。
3. **Phone workspace shell**
   - Compact top bar、route-level mobile nav 隱藏、bottom dock、safe-area、單一 controlled sheet controller；
     `EditorInspector` 接受 `bottom-sheet | side-drawer | static` presentation，不再自行根據 selection 開啟。
   - 範圍閉合包含 dialog/focus/keyboard accessibility 與 tablet/desktop compatibility。
4. **Touch command parity**
   - 明確多選、one-shot add、contextual copy/cut/paste/group/delete、44px hit targets。
   - 所有入口只接既有 command handlers；範圍閉合包含 locked/isolation/empty clipboard states。
5. **Acceptance automation and docs**
   - 新增單一 `template-editor-mobile.spec.js`，在既有 Chromium／WebKit projects 內局部設定
     390×844 touch context，不新增全域 mobile project；另測 landscape、geometry unit 與 desktop regression。
   - 更新 `rendering.md` 的已實作契約；測試指令沒改時不修改 `testing.md`。

Slices 1、3 可平行；Slice 2 依賴 Slice 1；Slice 4 依賴 Slice 3；Slice 5 在前述 slice API 固定後收斂。

## Acceptance Smoke

- 320／360／390／430px 直向與 844×390 landscape：`document.scrollWidth <= innerWidth`，無 body 水平捲動。
- 767px 顯示 phone header/dock 且隱藏 Nav/左欄；768／1023px 顯示 Nav/左欄與手動 drawer；1024px
  顯示桌面三欄/static inspector 且隱藏 mobile dock。跨斷點不得殘留 backdrop 或 body scroll lock。
- 390×844 首屏可見 top bar、畫布與 dock；畫布不被全站 nav、inspector 或左欄推到首屏之外。
- Tap 可完成 select、move、resize、rotate、add、delete、undo、redo、page switch 與明確 save。
- 不接鍵盤即可完成 additive multi-select、group、copy、cut、paste；locked/hidden/isolation 規則不回歸。
- Zoom buttons／fit、camera pure math 由自動測試驗證；真實 multi-touch pinch/pan 因 Playwright WebKit
  無可靠 multi-touch API，列為實機 manual smoke。上述操作後 layout snapshot、dirty flag、history length
  與 save payload 都不變。
- 手機選取不自動開 inspector；pages/layers/properties sheet 可明確開關並正確管理 focus。
- 所有 dock、top bar、sheet primary action 與 Transformer controls 命中區至少 44px；save 加入穩定的
  `data-dirty="true|false"`，E2E 不依賴 Tailwind 顏色 class。
- 既有 frontend build、lint、unit、TemplateEditor E2E 與 backend test suite 通過；桌面 1440px 無視覺／操作回歸。
- 保留既有 `canvas-frame`、`save-template`、`tool-*` hooks；新增 `mobile-editor-topbar`、
  `mobile-editor-dock`、`editor-canvas-viewport`、`editor-sheet`、`zoom-in/out/fit` 與
  `multi-select-toggle`，其餘測試優先使用 accessible role/name。

## Non-goals

- 不改正式相本輸出、模板資料模型、協作／presence、autosave 或 revision conflict 策略。
- 不保存每位使用者的 zoom／pan，也不跨頁保留任意 pan offset。
- 不在 v1 重做完整 inspector 欄位順序、桌面資訊架構或全站 mobile navigation。
- 不加入自由旋轉畫布、mini-map、手寫筆壓力、吸附線重寫或離線衝突合併。
- 不以 CSS scale、browser zoom 或縮小整個桌面 UI 冒充手機支援。

## Open Questions

目前沒有阻擋實作的產品問題。若 Mobile WebKit 的原生 gesture 與 Konva pointer events 有差異，
以「雙指不改 layout、單指仍可編輯、無頁面縮放」作為裁決；只在測試證明必要時加入平台分支。
