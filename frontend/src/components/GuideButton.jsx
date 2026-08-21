import { CircleHelp } from "lucide-react";

import { Button } from "./ui";
import { responsiveActionItemClass } from "./ResponsiveActionGroup";

/**
 * 「製作教學」導覽按鈕。
 *
 * 相本工作頁、班級總覽與相本編輯器共用同一顆；窄螢幕縮成「教學」兩個字，
 * 三處的外觀與縮寫規則必須一致。
 */
export default function GuideButton({ onStart }) {
  return (
    <Button
      type="button"
      onClick={onStart}
      variant="secondary"
      size="touch"
      className={responsiveActionItemClass}
    >
      <CircleHelp className="w-4 h-4" />
      <span className="hidden sm:inline">製作教學</span>
      <span className="sm:hidden">教學</span>
    </Button>
  );
}
