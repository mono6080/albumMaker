import { createElement, forwardRef } from "react";

function cn(...classes) {
  return classes.filter(Boolean).join(" ");
}

const buttonBaseClass =
  "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg text-center font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40";

// 色彩語意約定：indigo＝主要動作/導航、violet(review)＝班級總覽相關、
// emerald(success)＝下載 PDF 與完成狀態、sky(info)＝圖片相關、red＝破壞性
const buttonVariantClass = {
  primary: "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700",
  secondary: "border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100",
  neutral: "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50",
  archive: "border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100",
  success: "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700",
  successSoft: "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
  info: "bg-sky-600 text-white shadow-sm hover:bg-sky-700",
  infoSoft: "border border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100",
  review: "bg-violet-600 text-white shadow-sm hover:bg-violet-700",
  reviewSoft: "border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
  dangerSoft: "border border-red-200 bg-red-50 text-red-600 hover:bg-red-100",
  ghost: "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
};

const buttonSizeClass = {
  xs: "min-h-8 px-2 py-1 text-xs",
  sm: "min-h-9 px-3 py-1.5 text-sm",
  md: "min-h-10 px-4 py-2 text-sm",
  lg: "min-h-11 px-5 py-2.5 text-sm",
  touch: "min-h-12 px-3 py-2.5 text-sm sm:px-4",
};

function getButtonClassName({
  variant = "neutral",
  size = "md",
  fullWidth = false,
  className = "",
} = {}) {
  return cn(
    buttonBaseClass,
    buttonVariantClass[variant] ?? buttonVariantClass.neutral,
    buttonSizeClass[size] ?? buttonSizeClass.md,
    fullWidth && "w-full",
    className,
  );
}

export const Button = forwardRef(function Button(
  {
    as = "button",
    type,
    variant = "neutral",
    size = "md",
    fullWidth = false,
    className = "",
    ...props
  },
  ref,
) {
  const ButtonComponent = as;
  const buttonType = ButtonComponent === "button" ? (type ?? "button") : type;
  return createElement(
    ButtonComponent,
    {
      ref,
      type: buttonType,
      className: getButtonClassName({ variant, size, fullWidth, className }),
      ...props,
    },
  );
});

// IconButton 的 variant 一律是「淡色 tint」（非實心），與 Button 的同名 variant 視覺權重不同
const iconButtonVariantClass = {
  neutral: "text-gray-400 hover:bg-gray-100 hover:text-gray-600",
  primary: "text-indigo-500 hover:bg-indigo-50 hover:text-indigo-700",
  success: "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700",
  info: "text-sky-600 hover:bg-sky-50 hover:text-sky-700",
  danger: "text-gray-400 hover:bg-red-50 hover:text-red-500",
  subtle: "text-gray-300 hover:bg-gray-100 hover:text-gray-600",
};

const iconButtonSizeClass = {
  xs: "h-8 w-8",
  sm: "h-9 w-9",
  md: "h-10 w-10",
  touch: "h-11 w-11",
};

export function IconButton({
  label,
  title = label,
  variant = "neutral",
  size = "sm",
  className = "",
  children,
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
        iconButtonVariantClass[variant] ?? iconButtonVariantClass.neutral,
        iconButtonSizeClass[size] ?? iconButtonSizeClass.sm,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const surfaceVariantClass = {
  card: "rounded-lg border border-gray-200 bg-white shadow-sm",
  panel: "rounded-lg border border-gray-200 bg-white",
  dialog: "rounded-xl bg-white shadow-2xl",
  toolbar: "rounded-lg border border-gray-200 bg-white shadow-sm",
};

const surfacePaddingClass = {
  none: "",
  sm: "p-3",
  md: "p-4 sm:p-5",
  lg: "p-5 sm:p-6",
};

export function Surface({
  as = "div",
  variant = "card",
  padding = "md",
  className = "",
  ...props
}) {
  const SurfaceComponent = as;
  return createElement(
    SurfaceComponent,
    {
      className: cn(
        surfaceVariantClass[variant] ?? surfaceVariantClass.card,
        surfacePaddingClass[padding] ?? surfacePaddingClass.md,
        className,
      ),
      ...props,
    },
  );
}

const badgeToneClass = {
  neutral: "bg-gray-100 text-gray-600",
  primary: "bg-indigo-100 text-indigo-700",
  success: "bg-emerald-100 text-emerald-700",
  info: "bg-sky-100 text-sky-700",
  archive: "bg-slate-100 text-slate-700",
  warning: "bg-amber-100 text-amber-700",
  danger: "bg-red-100 text-red-700",
  review: "bg-violet-100 text-violet-700",
};

export function Badge({ tone = "neutral", className = "", title, children }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        badgeToneClass[tone] ?? badgeToneClass.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}

const autoSaveStatusLabel = {
  pending: "待儲存",
  saving: "儲存中",
  saved: "已儲存",
  error: "儲存失敗",
};

const autoSaveStatusClass = {
  pending: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  saving: "bg-sky-50 text-sky-700 ring-1 ring-sky-100",
  saved: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100",
  error: "bg-red-50 text-red-700 ring-1 ring-red-100",
};

export function AutoSaveStatus({ status = "idle", className = "" }) {
  const label = autoSaveStatusLabel[status];
  if (!label) return null;

  return (
    <span
      role={status === "error" ? "alert" : "status"}
      aria-live={status === "error" ? "assertive" : "polite"}
      className={cn(
        "inline-flex flex-shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        autoSaveStatusClass[status],
        className,
      )}
    >
      {label}
    </span>
  );
}

const headerIconToneClass = {
  primary: "border-indigo-100 bg-indigo-50 text-indigo-700",
  success: "border-emerald-100 bg-emerald-50 text-emerald-700",
  info: "border-sky-100 bg-sky-50 text-sky-700",
  archive: "border-slate-100 bg-slate-50 text-slate-700",
  review: "border-violet-100 bg-violet-50 text-violet-700",
};

export function PageHeader({
  icon: Icon,
  iconTone = "primary",
  title,
  subtitle,
  badge,
  meta,
  actions,
  className = "",
}) {
  return (
    <div className={cn("mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="flex min-w-0 items-center gap-3">
        {Icon && (
          <div
            className={cn(
              "flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border",
              headerIconToneClass[iconTone] ?? headerIconToneClass.primary,
            )}
          >
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          {meta && <div className="mb-1 flex min-w-0 items-center gap-1.5 text-sm text-gray-400">{meta}</div>}
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-bold text-gray-900 sm:text-2xl">{title}</h1>
            {badge}
          </div>
          {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="w-full sm:w-auto sm:flex-shrink-0">{actions}</div>}
    </div>
  );
}

export const fieldControlClass =
  "w-full min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400";

export function FormField({ label, hint, className = "", children }) {
  return (
    <label className={cn("block min-w-0", className)}>
      {label && <span className="mb-1 block text-xs font-medium text-gray-500">{label}</span>}
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

export function SegmentedControl({
  value,
  onChange,
  options,
  className = "",
  size = "md",
  disabled = false,
  style,
}) {
  const itemSizeClass = size === "sm" ? "min-h-8 px-2.5 py-1.5 text-xs" : "min-h-10 px-3 py-2 text-sm";

  return (
    <div
      className={cn("grid min-w-0 gap-1 rounded-lg bg-gray-100 p-1", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`, ...style }}
    >
      {options.map(option => {
        const Icon = option.icon;
        const isSelected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            aria-pressed={isSelected}
            data-guide={option.guideId}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
              itemSizeClass,
              isSelected ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700",
            )}
          >
            {Icon && <Icon className="h-4 w-4 flex-shrink-0" />}
            <span className="truncate">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
