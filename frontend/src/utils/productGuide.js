import { driver } from "driver.js";

export function startProductGuide(guideSteps) {
  const steps = guideSteps
    .filter(step => document.querySelector(step.element))
    .map(({ element, title, description, side, align, ...stepOptions }) => ({
      ...stepOptions,
      element,
      popover: { title, description, side, align },
      disableActiveInteraction: stepOptions.disableActiveInteraction ?? false,
    }));

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
