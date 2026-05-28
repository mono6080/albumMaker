import { AlignCenter, AlignLeft, AlignRight } from "lucide-react";
import { SegmentedControl } from "./ui";

const TEXT_ALIGN_OPTIONS = [
  { value: "left", label: "置左", icon: AlignLeft },
  { value: "center", label: "置中", icon: AlignCenter },
  { value: "right", label: "置右", icon: AlignRight },
];

export default function TextAlignControl({
  value,
  onChange,
  onScheduleSave,
  className = "",
}) {
  const handleChange = (nextValue) => {
    onChange(nextValue);
    onScheduleSave?.();
  };

  return (
    <div className={`flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <span className="text-xs font-medium text-gray-400">文字對齊</span>
      <SegmentedControl
        value={value}
        onChange={handleChange}
        options={TEXT_ALIGN_OPTIONS}
        size="sm"
        className="w-full sm:w-48"
      />
    </div>
  );
}
