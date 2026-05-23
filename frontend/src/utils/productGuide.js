import { driver } from "driver.js";

function resolveGuideElement(selector) {
  const elements = Array.from(document.querySelectorAll(selector));
  return elements.find(element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }) ?? null;
}

export function startProductGuide(guideSteps) {
  const steps = guideSteps
    .map(step => ({ ...step, resolvedElement: resolveGuideElement(step.element) }))
    .filter(step => step.resolvedElement)
    .map(({ resolvedElement, title, description, side, align, ...stepOptions }) => {
      const driverOptions = { ...stepOptions };
      delete driverOptions.element;
      return {
        ...driverOptions,
        element: resolvedElement,
        popover: { title, description, side, align },
        disableActiveInteraction: driverOptions.disableActiveInteraction ?? false,
      };
    });

  if (steps.length === 0) return;

  driver({
    steps,
    showProgress: true,
    animate: true,
    overlayColor: "rgba(15, 23, 42, 0.62)",
    stagePadding: 6,
    stageRadius: 8,
    popoverClass: "album-guide-popover",
    nextBtnText: "下一步",
    prevBtnText: "上一步",
    doneBtnText: "完成",
  }).drive();
}
