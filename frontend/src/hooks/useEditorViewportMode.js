import { useEffect, useState } from "react";

export const EDITOR_VIEWPORT_MODE = {
  PHONE: "phone",
  TABLET: "tablet",
  DESKTOP: "desktop",
};

export const EDITOR_VIEWPORT_QUERY = {
  phone: "(max-width: 767.98px)",
  tablet: "(min-width: 768px) and (max-width: 1023.98px)",
  desktop: "(min-width: 1024px)",
};

function getEditorViewportMode() {
  if (typeof window === "undefined") return EDITOR_VIEWPORT_MODE.DESKTOP;
  if (window.matchMedia(EDITOR_VIEWPORT_QUERY.phone).matches) {
    return EDITOR_VIEWPORT_MODE.PHONE;
  }
  if (window.matchMedia(EDITOR_VIEWPORT_QUERY.desktop).matches) {
    return EDITOR_VIEWPORT_MODE.DESKTOP;
  }
  return EDITOR_VIEWPORT_MODE.TABLET;
}

export default function useEditorViewportMode() {
  const [viewportMode, setViewportMode] = useState(getEditorViewportMode);

  useEffect(() => {
    const phoneQuery = window.matchMedia(EDITOR_VIEWPORT_QUERY.phone);
    const desktopQuery = window.matchMedia(EDITOR_VIEWPORT_QUERY.desktop);
    const handleViewportChange = () => setViewportMode(getEditorViewportMode());

    handleViewportChange();
    phoneQuery.addEventListener("change", handleViewportChange);
    desktopQuery.addEventListener("change", handleViewportChange);
    return () => {
      phoneQuery.removeEventListener("change", handleViewportChange);
      desktopQuery.removeEventListener("change", handleViewportChange);
    };
  }, []);

  return viewportMode;
}
