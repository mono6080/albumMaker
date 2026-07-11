import { Eye, Pencil } from "lucide-react";
import { SegmentedControl } from "./ui";

const DEFAULT_TABS = [
  { value: "edit", label: "編輯", icon: Pencil },
  { value: "preview", label: "預覽", icon: Eye },
];

export default function PanelSwitcher({ value, onChange, tabs = DEFAULT_TABS }) {
  // 四個以上分頁在窄螢幕塞不下 icon＋文字（標籤會被截斷），改為純文字
  const compactTabs = tabs.length >= 4
    ? tabs.map(tab => ({ value: tab.value, label: tab.label }))
    : tabs;
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-4 bg-white px-4 py-2 sm:-mx-8 sm:px-8 lg:hidden">
      <SegmentedControl
        value={value}
        onChange={onChange}
        options={compactTabs}
        className="w-full"
      />
    </div>
  );
}
