import { Eye, Pencil } from "lucide-react";
import { SegmentedControl } from "./ui";

const DEFAULT_TABS = [
  { value: "edit", label: "編輯", icon: Pencil },
  { value: "preview", label: "預覽", icon: Eye },
];

export default function PanelSwitcher({ value, onChange, tabs = DEFAULT_TABS }) {
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-4 bg-white px-4 py-2 sm:-mx-8 sm:px-8 lg:hidden">
      <SegmentedControl
        value={value}
        onChange={onChange}
        options={tabs}
        className="w-full"
      />
    </div>
  );
}
