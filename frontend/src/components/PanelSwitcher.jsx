import { Eye, Pencil } from "lucide-react";
import { SegmentedControl } from "./ui";

const DEFAULT_TABS = [
  { value: "edit", label: "編輯", icon: Pencil },
  { value: "preview", label: "預覽", icon: Eye },
];

export default function PanelSwitcher({ value, onChange, tabs = DEFAULT_TABS }) {
  return (
    <div className="sticky top-0 z-10 flex bg-white border-b border-gray-100 lg:hidden mb-4 -mx-4 sm:-mx-8 px-4 sm:px-8 py-2 shadow-sm">
      <SegmentedControl
        value={value}
        onChange={onChange}
        options={tabs}
        className="w-full"
      />
    </div>
  );
}
