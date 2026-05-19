const MOBILE_GRID_COLUMNS = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
};

export const responsiveActionItemClass = "min-w-0 justify-center";
export const mobileVisibleHoverActionClass = "opacity-100 sm:opacity-0 sm:group-hover:opacity-100";
export const mobileVisibleNamedHoverActionClass = "opacity-100 sm:opacity-0 sm:group-hover/name:opacity-100";

export default function ResponsiveActionGroup({
  children,
  mobileColumns = 2,
  desktop = "flex",
  className = "",
}) {
  const mobileGridClass = MOBILE_GRID_COLUMNS[mobileColumns] ?? MOBILE_GRID_COLUMNS[2];
  const desktopClass = desktop === "grid"
    ? ""
    : "sm:flex sm:w-auto sm:flex-wrap sm:items-center";

  return (
    <div className={`grid w-full gap-2 ${mobileGridClass} ${desktopClass} ${className}`}>
      {children}
    </div>
  );
}
