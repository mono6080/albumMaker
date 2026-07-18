---
name: import-office-template
description: 把園所的 Word 相本範本（.docm，含巨集）匯入成系統裡的 Template + TemplatePage，重現照片格、對話泡泡貼圖、文字位置與圖層順序
trigger: /import-office-template
---

# /import-office-template

把 `scripts/import_office_template.py` 的機械性抽取工作跟人工複核步驟串起來。
腳本負責把 docm 轉 PDF、抽照片格/貼圖/文字、組 layout_json；這份 skill 負責
「腳本做不到、需要人眼判斷」的部分——頁面分組是否正確、貼圖有沒有殘留碎片、
算圖跟原稿像不像。

## 什麼時候用

使用者要把 `110上 銜接 成長冊模板` 這類資料夾底下某個主題的 `.docm` 檔匯入成
系統模板時。一次只處理一個主題資料夾。

## 前置知識（先讀，不要重新踩雷）

- **同一個 xref 在同一頁可能貼了不只一次**：Word 常常重複使用同一張裝飾素材
  （例如一頁兩個對話泡泡用的是同一張圖），PDF 裡就是同一個 xref 出現兩次、
  transform 不同。收集貼圖座標時絕對不能用「以 xref 當 key 的字典」（`{im["xref"]:
  im["transform"] ...}`），後貼的實例會把先貼的實例直接覆蓋掉，導致每頁固定
  少一個貼圖、肉眼在縮圖上完全看不出來（曾經真的因此漏掉範例甲每一頁的
  一個對話泡泡）。腳本已改成收集「實例清單」而非「xref 字典」，貼圖檔名也
  帶實例序號（`p{page}_img{xref}_{si}.png`）避免同 xref 多實例互相覆蓋存檔。
  懷疑哪裡漏貼圖時，先跑
  `Counter(im["xref"] for im in page.get_image_info(xrefs=True))` 看有沒有
  count > 1 的 xref。
- **貼圖清單裡常有完全透明的隱藏殘留物件，不是腳本 bug**：docm 原作者常用
  「透明度調到 0%」隱藏舊版設計草稿，而不是真的刪除形狀，Word 匯出 PDF 後
  這些形狀仍是完整的 image XObject，只是 SMask 整張全零（實測範例甲四頁
  裡有 8 個這種殘留物件，幾乎每頁都有 2-3 個）。腳本用 `is_effectively_invisible()`
  （`alpha.mean() < 2`）自動過濾，不用人工介入；但如果懷疑漏判，直接用
  `doc.extract_image(smask_xref)` 檢查該 xref 的 SMask min/max/mean 是不是都是 0
  （這才是「真的完全看不到」的判斷依據，不要只看 RGB）。
- **年份浮水印（如「2021.」）這類固定日期章，不要用貼圖素材，改成
  `text_labels` 裡 `text_role: "static"` 的固定文字**：這類日期章原檔是烙在
  圖片裡的文字（例如黑色 70% 透明度），不是可編輯內容，但用貼圖處理的話沒辦法
  簡單換顏色/换年份，且每個模板都要重新產生一次圖檔素材很麻煩。用
  `scripts/replace_sticker_with_static_text.py` 直接換成純文字元素（見步驟
  4b），前端圖層清單會正確標成「固定文字」而不是「老師可填文字」。**這不是
  `text_bubbles`**（那個功能已棄用，見下一條）——`text_labels` 加
  `text_role: "static"` 是後端既有、目前仍在維護的機制
  （`backend/services/element_renderers.py` 的 `_text_label_is_fillable()`、
  frontend `utils/textLabelRoles.js`）。**日期字串要問使用者，不要寫死。**
- **不要用矩陣分解重建旋轉**：貼圖的仿射矩陣要嘛直接 warp（腳本已經這樣做），
  要嘛用 docx 原生的 `rot` 屬性，兩者都不用「拆解成 x/y/width/height/rotation
  再交給 resize+rotate 重建」——這條路對非正方形＋大角度旋轉的素材驗證過會
  跑位，肉眼看起來像對、實際疊起來會位移。
- **`text_bubbles`（氣泡框）在這個系統是棄用功能，絕對不要用** ——包括拿它來
  模擬照片黑框這種 hack。照片邊框就老實用 `border: false` + `shadow_enabled: true`
  （純陰影、無邊框線），不要硬湊黑色描邊。
- **Sticker 要同時有 `path` 跟 `filename` 兩個欄位**——後端渲染吃 `path`，前端
  `StickerNode.jsx` 是用 `sticker.filename` 組 URL 抓圖，漏了 `filename` 貼圖
  在編輯器裡就是空的（渲染 API 卻是正常的，因為兩邊用的欄位不同，不會馬上
  發現）。
- **模板預設文字一律用** `{name}的文字標題的文字標題的文字標題的文字標題`
  ——不要把 docm 或 PDF 裡量到的實際文案當範本預設值，那是特定一次匯出的
  內容，不是模板該有的通用預留字。
- **圖層順序**：照片格跟貼圖的 `z_index` 用 PDF content stream 裡 `/ImageN Do`
  出現的順序（腳本已處理），文字固定疊在自己那張泡泡貼圖正上方
  （`z_index = 該貼圖.z_index + 0.5`），不要交給前端預設的
  `{photo:0, bubble:100, text:200, sticker:300}` base 順序，那個順序會讓
  sticker 蓋住 text。
- **文字框高度不能用固定倍數猜**：預留字樣 `PLACEHOLDER_TEXT` 長度固定，但
  每個對話泡泡的框寬是照原始文案（通常比預留字樣短很多）量出來的——框越窄，
  同樣的預留字樣要排的行數就越多。腳本用 `estimate_placeholder_height()` 直接
  呼叫後端渲染引擎的 `get_font`/`wrap_text` 量出真正的行數再決定框高，不要
  改回「乘固定倍數」，那樣窄框會裁切文字，肉眼在小張截圖上很容易沒發現。
- **貼圖清單裡不是所有東西都真的是裝飾**：docm 匯出的 PDF 有時會殘留「照片格
  本體美術稿」的重複圖層（灰底或色塊底＋斗大數字/「個人照」「團體照」字樣，
  跟真正的 `photo_slot` 位置對不上，原因未知，懷疑是 Word 匯出時對部分形狀
  重新算位置），以及尺寸異常大的「假白字」（例如某些版型 logo 旁的年份用了
  跟對話泡泡文字一樣的白色、但字級破 50pt）。腳本用
  `looks_like_placeholder_card()`（低色彩標準差＋高不透明面積比例）跟文字
  span 的字級上限（10~30pt）過濾掉這兩類，但這是啟發式規則，換一個版型的
  視覺風格就可能失效——**每一批新模板都要重新過一次「合成算圖 vs 原稿」的
  肉眼比對，不能因為上一批模板抓對了就假設這批也一定對**。
  **`looks_like_placeholder_card()` 只能當輔助信號，不能單獨判定**：低色彩
  標準差＋高不透明面積比例這個特徵，純色填滿的裝飾泡泡（例如範例乙
  裡一個純咖啡色＋白色虛線邊框的泡泡貼圖，本身沒有烙數字）也會符合，會被
  誤判成殘留卡而刪掉。腳本已加上「尺寸要跟某個 `photo_slot` 差在 15% 以內」
  的必要條件（`matches_photo_size`），兩個條件都成立才會過濾——單獨改
  `looks_like_placeholder_card()` 的門檻不會解決這類誤判，要連著尺寸比對一起看。
- **說明文字（對話泡泡文案）偵測不能假設固定顏色**：`detect_caption_regions()`
  一開始硬性只認白色（`#FFFFFF`）文字 span，範例丙（橘色/藍色文案）跟
  感官世界1月（藍色文案）都因此直接抓到 0 個 `text_labels`，肉眼看縮圖時
  「有泡泡、有背景色」很容易誤判成正常，要點開泡泡才會發現裡面沒有可編輯
  文字層。已改成「文字 span 有沒有跟任何一張貼圖的可視範圍（優先用
  `sticker_visual_bounds`，不是原始 bbox）重疊」來判斷是不是說明文字，不再
  限定顏色，並用該群組裡最常見的顏色（`Counter` 取最多）當這個 `text_label`
  的 `font_color`。**每一批新模板核對時，除了看文字位置對不對，也要看文字
  顏色是不是跟原稿一致**，不能只看「有沒有文字」。
- **同一個對話泡泡可能被偵測成兩組文字、產生重複的 `text_labels`**：文案
  換行時，行與行的間距如果剛好落在「行高判斷門檻」的邊界附近（實測 14.65pt
  vs 舊門檻 `0.8 * font_size` = 14.4pt，只差一點點就沒合併），會被拆成兩組，
  兩組各自往上找最近的泡泡貼圖時又找到同一個，於是同一顆泡泡上疊了兩個
  座標完全相同的文字框（肉眼在編輯器裡幾乎看不出來，因為疊在一起）。已把
  行距合併門檻從 `0.8 * font_size` 放寬到 `1.1 * font_size`，並額外加一層
  `seen_backing_ids` 防呆——同一個貼圖 id 已經配過一個文字框就跳過，兩層
  一起當保險。核對時可以直接看某一頁 `text_labels` 的數量是否等於「泡泡貼圖
  數量」，多出來的通常就是這個重複。
- **極少數日期章是烙在 PDF 原生文字層裡，不是圖片**：範例乙的
  「2021.」跟其他模板不同，不是 sticker 素材，而是 `page.get_text("dict")`
  抓得到的原生文字 span（有自己的顏色、字級），現有流程完全不會把它當成
  貼圖、背景像素或說明文字抓出來——如果只照步驟 4b 去警告清單裡找日期章的
  檔名，會找不到任何符合的圖片檔案。**目前腳本沒有自動偵測這種情況**，發現
  「logo 旁邊該有日期章、但警告清單裡的貼圖尺寸都不像日期章」時，要用
  `page.get_text("dict")` 掃該區域附近有沒有獨立的文字 span，量出 bbox 後
  按 `scale = canvas寬 / pdf寬` 換算成畫布座標，手動加一筆 `text_role: static`
  的 `text_labels`（不能套用 `replace_sticker_with_static_text.py`，因為
  那支腳本假設日期章一定是要被移除的 sticker）。這是已知限制，還沒有被
  收進腳本，見下面「已知限制」第 6 條。

## 步驟

### 0. 檔案來自下載/解壓縮時，先 Unblock

如果 docm 是從雲端硬碟下載、解壓縮出來的（帶 Windows 的 Mark-of-the-Web／
Zone.Identifier），Word 的 COM 自動化開檔會被強制卡在「受保護的檢視」，
`Documents.Open` 直接丟 `pywintypes.com_error`（訊息會提到「受保護的檢視」），
即使當下沒有任何 WINWORD.EXE 在跑也一樣。用 PowerShell 解除封鎖再重跑即可，
不用去改 Word 信任中心設定：

```powershell
Unblock-File -LiteralPath "<docm 路徑>"
```

### 1. Dry-run 抽取

```bash
python scripts/import_office_template.py "<docm 路徑>" \
    --name "<模板名稱>" --period-id <期別 id>
```

不加 `--commit` 就只會抽取到 `.tmp/office_template_preview/page{N}/`，不寫資料庫。
記下終端機印出的每頁「照片格 / 貼圖 / 文字」數量。

### 2. 跟原稿的照片數對一下

用 Word 開 docm（或看腳本轉出的 `<docm 同目錄>.generated.pdf`），數每頁真正
的照片格數量，跟 dry-run 印出的數字比對。對不上代表頁面分組（`assign_pages_by_background`
的背景圖切頁法）在某個裝飾物件上分錯頁——通常是段落錨定的 logo／日期
（page-relative 之外的元素）。用 `--force-page <media 檔名>=<page_index>`
（`page_index` 從 0 起算）修正，media 檔名去 dry-run 資料夾的 `layout.json`
裡的 `stickers[].filename` 反查對應的原始 `imageN`，或直接重跑一次腳本觀察
哪一頁多了/少了東西。

### 3. 實際合成算圖

Dry-run 資料夾裡只有素材檔，沒有合成畫面。用 backend 的 render_service 手動
跑一次合成（在 `backend/` 目錄下）：

```python
import os, sys, json
os.environ["STORAGE_BACKEND"] = "local"
os.environ["ALBUM_MAKER_UPLOADS_DIR"] = r"<repo>\.tmp\office_template_preview\page0"
sys.path.insert(0, os.getcwd())
from services.render_service import render_page
layout = json.load(open(r"<repo>\.tmp\office_template_preview\page0\layout.json", encoding="utf-8"))
render_page(layout, "測試姓名", {"photos": {}, "label_texts": {}}, page_index=0).save("preview0.png")
```

四頁都跑一次，用 Read 工具開圖，跟同一份 docm 轉出的 PDF 頁面（or 用
`fitz.open(pdf).load_page(n).get_pixmap()`）並排比對：

- 照片格位置/旋轉/大小是否跟原稿一致
- 對話泡泡的形狀、位置、旋轉是否跟原稿一致（不是矩形/沒有跑位）
- 有沒有「同一個視覺元素被拆成好幾個小貼圖」的殘影（常見在 logo、日期字樣附近）

### 4. 換成統一 logo 素材——腳本印出警告就一定要處理，不可以略過

腳本會自動掃描 docx 裡 title 含「Derni／logo／商標／品牌」關鍵字的物件，
dry-run 跟 `--commit` 完成時都會印，而且會把該頁**全部貼圖**（不只 title 命中
的那個）連檔名帶尺寸一起列出來——logo 美術稿常被 Word 拆成好幾個 PDF image
xref（icon、文字、日期章），只有其中一個會被 title 關鍵字抓到，日期章這類
碎片沒有命名、不會單獨被偵測到，所以印警告時直接列該頁全部貼圖，不要只處理
title 命中的那一個：

```
⚠ 偵測到品牌標／logo，換成統一素材了嗎？（這步不會自動做，SKILL.md 有換法）
   第 4 頁：DerniMark（image13.png）
      這頁全部貼圖（logo 美術稿常被拆成好幾個，日期章這類碎片不一定有命名，一併核對）：
      p3_img78_2.png(203x156), p3_img27_3.png(238x304), p3_img82_5.png(110x64)
```

**看到這個警告，一定要把列出來的每個貼圖都打開看過，不能只處理 title 命中的
那個**（這個檢查就是因為漏做過一次才加的）。

**警告印的頁碼本身可能是錯的，不能直接信**：品牌錨點的頁碼是用另一套獨立的
啟發式（docx 段落錨定位置）算出來的，跟真正決定貼圖歸在哪一頁的
`assign_pages_by_background`（背景圖比對）是兩條不同邏輯，兩者可能對不上
（範例丁就真的遇到：警告說 logo 在「第4頁」，但那頁列出的唯一貼圖其實只是
一個對話泡泡形狀，logo 真正的三個碎片——圖案、日期——全部在「第3頁」的
sticker 清單裡）。**看到警告後，先用下面指令印出 dry-run 每一頁真正的
sticker 清單，肉眼比對哪一頁才是 logo 真正在的頁面，不要照警告印的頁碼直接
下手**：

```python
import json
for i in range(4):
    layout = json.load(open(rf'.tmp\office_template_preview\page{i}\layout.json', encoding='utf-8'))
    print(i, [(s['filename'], s['width'], s['height']) for s in layout['stickers']])
```

logo 通常跟其他頁的裝飾貼圖比明顯偏「品牌感」（有專有名詞字型/彩色圖標），
日期章通常是全頁最小的貼圖（比如 90x30 這種扁長條）。

**對話框文字有時會誤配到日期章這種小貼圖上，長出一個沒有泡泡背景、位置離譜的
黑字文字框**：`find_backing_sticker()` 只找「最近的貼圖」當文字的靠山，
沒有排除掉像日期章這種明顯不是對話泡泡形狀的小貼圖。如果某個文字span在原始
PDF裡其實是被別的不透明圖層完全蓋住、肉眼看不到的殘留文字（同類型於前面提到
的隱藏透明貼圖，只是這次是文字不是圖片），一旦它剛好跟日期章的小 bbox 重疊，
就會被誤判成「配對到日期章當泡泡」的合法 caption，生出一個大小/位置都不合理
的 text_label（寬度通常遠小於日期章、但高度被撐得很高，因為是照文字本身的
行數換算的）。**核對算圖時如果看到 logo/日期附近多出一團跟頁面設計對不上的
黑字，先檢查它的 `text_labels` 裡對應項的 z_index 是不是等於「日期章那個
sticker 的 z_index + 0.5」——是的話直接刪掉這個 text_label，不用另外找
原因**（見下面「這一輪修過的坑」）。

步驟：

1. 用 `--commit` 建好模板後，把警告列出的每個 filename 都用 Read 工具打開
   （`backend/uploads/templates/tmpl{id}/stickers/{filename}`），肉眼判斷
   哪個是 logo 圖層、哪個是日期章（通常是一小張黑色半透明數字，見步驟 4b）、
   哪些是無關的裝飾（例如照片陰影、葉子花紋）。
2. logo 換成統一素材：

   ```bash
   python scripts/replace_template_sticker.py --template-id <id> --page <頁碼> \
       --remove <logo 的 filename> --add-file "<統一 logo 檔案路徑>"
   ```

   不給 `--x/--y/--width/--height` 時會自動用被移除貼圖的外框、依新素材的
   原始長寬比算高度（不會變形）——**但這個外框是原始 logo 在這個模板裡的
   尺寸，不代表「合適的尺寸」**，範例甲就曾經因為沿用原框大小換出一個
   偏大的 logo，之後又手動縮小過一次。換完一定要跟旁邊其他元素（日期章、
   頁面留白）比對大小是否協調，不要直接相信自動算出來的框。
3. 重新整理編輯器截圖確認 logo 已經換成新版本、**大小跟頁面比例協調**（不是
   只有「有換掉」就好）。

如果同一個視覺元素（不一定是 logo）被拆成好幾個小貼圖殘影，也是用同一支
`replace_template_sticker.py`（`--remove` 可以給多次）處理。

### 4b. logo 旁的年份浮水印——換成固定文字，日期用問的、不要寫死

logo 附近常有一個「2021.」之類的年份日期章，原始檔案是烙在圖片裡的文字（不是
可編輯內容）。這個檔案通常就在步驟 4 警告印出的「這頁全部貼圖」清單裡（尺寸
明顯比 logo 小、比較扁，例如 110x64）——用 Read 工具打開確認內容是日期文字後，
不要重新產生圖片素材去換，改用 `replace_sticker_with_static_text.py` 換成
`text_labels` 裡 `text_role: "static"` 的固定文字元素：

```bash
python scripts/replace_sticker_with_static_text.py --template-id <id> --page <頁碼> \
    --remove <日期章的 filename> --text "<日期>" --font-color "#FFFFFF" \
    --x <沿用原貼圖座標> --y <...> --width <...> --height <...>
```

**日期字串一定要問使用者，不要在腳本或呼叫程式碼裡寫死**——同一批模板通常
共用同一個日期，整批只問一次、答案套用到每個模板即可，不要每個模板各自猜一個
值。這不是 `text_bubbles`（那個已棄用，見前置知識），`text_role: "static"` 是
後端仍在維護、前端會正確標成「固定文字」的機制。

**白字加陰影/描邊不是預設動作，只有背景真的太淡才要加**：`--shadow`
只在「logo／日期換上去之後，實測那個座標附近的背景像素顏色，發現跟白字
對比度不夠」時才加，不能看到白色文字就順手加陰影當保險。判斷方式是直接
用 PIL 在合成後的畫面上 `img.getpixel((x, y))` 量 logo/日期實際座標附近的
背景色，RGB 都接近 250+（例如範例甲那次量到 (255,255,253)）才算「太
淡」，其他量到米色/黃色/淺橘色底（例如範例丙 (238,216,156)、範例乙
(253,245,224)）都是實測後確認純白字可讀、不需要加陰影。加陰影前一定要先
換算圖看一次「不加陰影」的樣子，不要預先假設會看不清楚。

**背景在同一個 logo 範圍內可能不是單一顏色，只採樣一個點會誤判**：範例丁
那次 logo 框裡上半部是純色背景、下半部剛好疊在背景圖裡一朵白雲裝飾上，
只採樣 logo 正中央那一點量到的是藍色（誤判「不需要陰影」），但下緣的「erni」
字樣跟日期章整個疊在白雲上、完全看不見。**背景本身就是原稿設計的一部分，
不是均勻的色塊——logo/日期框至少要在四個角＋中心分別採樣，任一點落在
「太淡」門檻就要加陰影，不能只信中心點**。加了陰影之後記得跟旁邊沒有白雲
的區域也看一次，確認陰影在純色背景上不會顯得多餘或太搶眼（這次範例丁
藍色背景那半邊有陰影也還好看，沒有違和）。

**Logo 的陰影模糊半徑要用「最終顯示大小」反推，不能直接套源檔像素數字**：
logo 素材（`derni_logo_white.png`）是 1867px 寬的高解析度圖，但實際貼到頁面
上通常只顯示 200~300px 寬（縮小 7~10 倍）。如果模糊半徑是憑感覺在源檔上抓一個
數字（例如「18px」），縮小 7~10 倍之後在頁面上只剩不到 2px，`render_sticker()`
裡的 `Image.resize(..., Image.LANCZOS)` 會把這種幾乎沒有寬度的漸層壓成一條
清晰的細邊界，肉眼看起來就是「描邊」而不是「暈開的陰影」——即使拿同一個檔案
在源解析度下直接看，明明是柔和的，一縮小到頁面實際尺寸就走樣。**正確做法是
反過來，先決定「最終顯示要多少 px 的柔邊」，再除以縮放比例反推源檔該用多少
模糊半徑**：

```python
from PIL import Image, ImageFilter

def make_shadow_logo(source_path, orig_box_width, orig_source_width,
                      target_blur_final=10, target_close_final=2, opacity=0.5):
    logo = Image.open(source_path).convert('RGBA')
    Ws, Hs = logo.size
    scale = orig_box_width / orig_source_width  # 顯示大小 / 源檔大小

    close_r = max(1, round(target_close_final / scale))  # 先閉合細縫，見上面「文字框大小」那條
    blur_r = target_blur_final / scale                   # 模糊半徑反推
    pad = int(blur_r * 3)                                 # 留白，公式見下

    canvas = Image.new('RGBA', (Ws + 2*pad, Hs + 2*pad), (0, 0, 0, 0))
    canvas.alpha_composite(logo, (pad, pad))
    alpha = canvas.split()[-1]
    closed = alpha.filter(ImageFilter.MaxFilter(close_r*2+1)).filter(ImageFilter.MinFilter(close_r*2+1))
    blurred = closed.filter(ImageFilter.GaussianBlur(blur_r))

    shadow_layer = Image.new('RGBA', canvas.size, (20, 20, 20, 0))
    shadow_layer.putalpha(blurred.point(lambda a: int(a * opacity)))
    out = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    out.alpha_composite(shadow_layer)
    out.alpha_composite(canvas)
    return out, scale, Ws + 2*pad, Hs + 2*pad, pad
```

`target_blur_final=10`（畫布像素）比文字陰影的 `blur=3` 大很多，是刻意的——
logo 本身面積比文字大，太貼邊的模糊在這個尺度下一樣會被壓成細線，10px 這個
數字是實測跟文字陰影放在同一頁比對後，視覺上「暈開程度看起來搭」的結果，不是
硬性標準，換一個明顯更大/更小的 logo 尺寸時要重新目視比對調整。

套用完 `make_shadow_logo()` 拿到的圖之後，**新的顯示位置/大小要照這個公式
換算，不能沿用換 logo 之前的 x/y/width/height**（因為畫布多了 `pad` 圈留白）：

```python
new_x = orig_x - pad * scale
new_y = orig_y - pad * scale
new_width = (Ws + 2*pad) * scale
new_height = (Hs + 2*pad) * scale
```

換完一定要用 `render_page()` 產生實際頁面大小的圖、裁切 logo 那一小塊局部
放大 2 倍看（不要只看縮圖裡一整頁的樣子，尺寸太小肉眼分不出「柔邊」跟
「細線」的差別），確認是真的暈開而不是一圈硬邊。

### 5. 正式建立

確認 dry-run 的算圖沒問題後，加 `--commit` 重跑：

```bash
python scripts/import_office_template.py "<docm 路徑>" \
    --name "<模板名稱>" --period-id <期別 id> \
    --force-page <確認過的修正...> --commit
```

### 6. 在真正的編輯器裡再看一次

啟動 backend（`uvicorn main:app --port 8765 --reload`）與 frontend
（`npm run dev`），用 playwright 登入、開 `/templates/{new_id}/edit`，逐頁截圖
確認：

- 氣泡框（`text_bubbles`）數量是 0
- 貼圖數量、圖層清單順序看起來合理（文字在自己那張貼圖之上）
- 照片格沒有奇怪的白色邊框（那是系統原生 `border:true` 的樣式，不該出現）
- **文字沒有被裁切**：點開每個 `text_labels`，確認預留字樣完整顯示、沒有
  超出框外或被蓋住
- **終端機印過的 logo 警告都處理完了**（見上面步驟 4），不是只看到警告就
  略過

## 已知限制（不會自動處理，需要人判斷）

1. 頁面分組是啟發式規則（背景圖出現順序切頁），段落錨定的裝飾物件偶爾會
   分錯頁，需要 `--force-page`。
2. 貼圖有時會被拆成好幾個小圖層，`looks_like_placeholder_card()` 只抓得到
   「大面積實色填滿」這種特徵，不是所有殘影都符合，仍需人眼核對後用
   `replace_template_sticker.py` 合併/替換。
3. 只有 docm 輸入才有「照片格」的原生精確抽取；純 PDF 輸入目前腳本會直接
   報錯（沒有實作 stroke-rect 偵測的 fallback，因為那條路更容易踩到旋轉誤差，
   優先度較低）。
4. 說明文字偵測只認「白色（`#FFFFFF`）、字級 10~30pt」的文字 span 當對話泡泡
   文案；其他配色、或字級超出這個範圍的說明文字不會被抓成 `text_labels`，
   需要另外手動加。
5. Logo／品牌標偵測只看 docx 的 `title` 屬性有沒有含關鍵字，不會自動判斷
   「這個 logo 該不該換」——只負責提醒，換不換、換成哪個檔案永遠是人決定。
6. 日期章絕大多數是圖片素材（走步驟 4b），但極少數版型是烙在 PDF 原生文字層
   裡（範例乙的「2021.」），腳本完全不會偵測到、警告清單裡也不會出現
   對應檔名。目前是人工用 `page.get_text("dict")` 找到後手動加 `text_labels`，
   沒有收成腳本步驟，換一批新模板時要留意「警告清單裡的貼圖都對不上日期章
   尺寸」這個訊號。

## 這一輪修過的坑（別再犯）

- 一開始只用固定倍數（例如「2.4 行高」）估文字框高度，窄框配長預留字樣時
  文字會被裁切，肉眼在縮小的截圖裡沒發現——改成直接呼叫渲染引擎的
  `wrap_text` 量真正行數（見上面「文字框高度」那條）。
- 曾經批次處理好幾個模板卻忘了處理 logo 警告——現在腳本會在 dry-run 跟
  `--commit` 完成時都印出來，**印出來就要處理，不是印出來就結束**。
- 曾經因為「這批跟上一批結構很像」就跳過肉眼核對，結果同一批裡不同頁面
  用了不同顏色的殘影卡（灰底、黃底都遇過），單一顏色的啟發式規則沒抓到——
  每一頁都要看過算圖，不能用「前面幾頁都對」來推論後面也對。
- 曾經用「以 xref 為 key 的字典」收集貼圖 transform，結果同一頁重複貼同一張
  對話泡泡素材時，第二次貼的位置直接覆蓋掉第一次的，每頁固定少一個對話泡泡
  貼圖（範例甲四頁裡有三頁都中招）。截圖看起來「有貼圖、有文字」很容易
  被誤判為正常——因為另一個文字框還在，只是背後沒有泡泡背景、變成裸文字疊在
  背景上，縮圖解析度低時很難注意到。之後核對算圖要特別去數「每頁應該有幾個
  對話泡泡」跟原始 PDF 對，不能只看「有沒有貼圖」，要看「數量對不對」。
- **文字框大小要貼合貼圖「看得到的圖案」，不是素材檔案尺寸、也不能只用
  alpha bbox**：對話泡泡是「圓角矩形本體＋一個尖角尾巴」，尾巴會把 alpha
  bbox 往那個方向撐大，用固定比例從 bbox 內縮，尾巴那一側會算出「還在 bbox
  裡、其實已經超出實色本體」的框，文字疊到背景上（肉眼在整頁縮圖上很容易
  漏看，要放大到單一泡泡才看得出來）。改用**最大內接矩形**（`largest_opaque_rect`，
  直方圖法）取代 bbox，保證框一定落在實色本體內。但泡泡邊框常見一圈虛線裝飾
  （圓點中間夾透明縫隙），alpha 直接門檻化會把這圈邊框當成一堆小洞，逼矩形
  往內縮到只剩一小塊——要先用 `ImageFilter.MaxFilter`+`MinFilter` 做一次
  「閉運算」補洞，矩形才會撐到接近視覺上完整的泡泡本體大小。目前內縮比例
  `BUBBLE_PAD_X_RATIO/Y_RATIO = 0.06/0.08`，只是呼吸空間，不是安全邊界
  （安全邊界已經由最大內接矩形保證）。
