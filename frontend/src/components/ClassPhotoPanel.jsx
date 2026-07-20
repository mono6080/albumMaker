// 全班編輯的照片面板 — 頁首（含「依檔名整批匯入」入口）＋照片格選擇區
// 純位移自 ClassEdit；點格後的「放照片」Modal 流程仍在頁面層，這裡只負責顯示與選格

import { Link } from "react-router-dom";
import { ImagePlus, Images, Users } from "lucide-react";
import PhotoSlotCard from "./PhotoSlotCard";
import { Button, Surface } from "./ui";

export default function ClassPhotoPanel({
  isProjectCompleted,
  projectId,
  studentCount,
  activePage,
  slotItems,
  selectedSlotId,
  onPickSlot,
  onOpenFilenameWizard,
}) {
  // 照片卡固定 110px 高、寬依格位長寬比（見 PhotoSlotCard），
  // 取最寬者決定格線欄寬，避免寬格位在窄欄溢出（作法同 PhotoManager）；
  // 下限墊到 4:3 橫式卡寬，讓全直式格的頁面與其他頁的方格一樣大
  const maxSlotCardWidth = slotItems.length
    ? Math.max(147, ...slotItems.map(item => Math.round(110 * item.slotW / item.slotH)))
    : 110;

  // 與個別編輯的照片格同款外觀（灰底方格＋角標）；點格開「放照片」Modal
  const slotPickerSection = slotItems.length > 0 ? (
    <div
      data-guide="class-shared-photo-slots"
      // 與個別編輯的照片格同規則：手機固定 2 格一層，sm 以上依最寬卡片自適應
      className="grid gap-3 max-sm:grid-cols-2!"
      style={{
        gridTemplateColumns: `repeat(auto-fill, minmax(min(${maxSlotCardWidth + 24}px, 100%), 1fr))`,
      }}
    >
      {slotItems.map(slotItem => {
        const isSelected = String(slotItem.slotId) === String(selectedSlotId);
        return (
          <button
            key={slotItem.slotId}
            type="button"
            onClick={() => onPickSlot(slotItem.slotId)}
            aria-pressed={isSelected}
            // 方形用 padding-bottom 百分比而非 aspect-ratio（WebKit grid 行高問題，見 PhotoManager）
            className="group relative w-full rounded-xl pb-[100%] transition-all"
            style={{
              background: isSelected ? "rgba(99,102,241,0.1)" : "#f3f4f6",
              outline: isSelected ? "2px solid #6366f1" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <PhotoSlotCard it={slotItem} url={null} nat={null} />
            </div>
            <span className="absolute bottom-1 left-0 right-0 text-center text-[10px] text-gray-400 pointer-events-none select-none">
              第{activePage + 1}頁·格{slotItem.slotIndex + 1}
            </span>
          </button>
        );
      })}
    </div>
  ) : (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-gray-200 py-10 text-sm text-gray-400">
      此頁沒有照片格，請用上方頁碼切到有照片格的頁面
    </div>
  );

  return (
    <div data-guide="class-photo-panel">
      {isProjectCompleted ? (
        <Surface className="border-emerald-200 bg-emerald-50 text-sm text-emerald-800">
          此專案已標記全班完成，照片上傳已鎖定；仍可預覽與下載，需主管或管理員退回才能修改。
        </Surface>
      ) : studentCount === 0 ? (
        <Surface>
          <div className="py-8 text-center text-gray-400">
            <Users className="mx-auto mb-3 h-10 w-10 opacity-30" />
            <p className="text-sm">此相本沒有學生快照</p>
            <p className="mt-1 text-xs">請管理員確認遷移資料，或從正確班級重新建立本期相本。</p>
            <Button as={Link} to={`/projects/${projectId}/review`} variant="primary" className="mt-4">
              <Users className="h-4 w-4" />
              回班級總覽查看
            </Button>
          </div>
        </Surface>
      ) : (
        /* 與個別編輯的照片管理同款頁首：icon＋標題＋meta＋右側動作 */
        <Surface className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Images className="w-4 h-4 text-amber-500 flex-shrink-0" />
            <h3 className="font-semibold text-gray-800 text-sm flex-shrink-0">照片管理</h3>
            <span className="text-xs text-gray-400 min-w-0">
              第 {activePage + 1} 頁・點一格放全班照片（{studentCount} 位）
            </span>
            {/* 進階入口：檔名已含頁碼與格位的整批檔案，獨立於選格流程之外；
                token 與個別編輯頁首的「多選上傳」一致（secondary/sm） */}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="ml-auto whitespace-nowrap"
              title="檔名需含姓名與格位，例如 小明1-2.jpg＝第 1 頁第 2 格"
              onClick={onOpenFilenameWizard}
            >
              <ImagePlus className="w-3.5 h-3.5" />
              依檔名整批匯入
            </Button>
          </div>

          {slotPickerSection}
        </Surface>
      )}
    </div>
  );
}
