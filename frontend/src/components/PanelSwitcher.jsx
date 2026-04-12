const DEFAULT_TABS = [
  { value: "edit", label: "✏️ 編輯" },
  { value: "preview", label: "👁 預覽" },
];

export default function PanelSwitcher({ value, onChange, tabs = DEFAULT_TABS }) {
  return (
    <div className="sticky top-0 z-10 flex bg-white border-b border-gray-100 lg:hidden mb-4 -mx-4 sm:-mx-8 px-4 sm:px-8 py-2 shadow-sm">
      <div className="flex w-full bg-gray-100 rounded-xl p-0.5">
        {tabs.map(tab => (
          <button
            key={tab.value}
            onClick={() => onChange(tab.value)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
              value === tab.value ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}
