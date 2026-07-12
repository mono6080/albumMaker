// driver.js 動態載入：只有使用者按下「製作教學」才需要，首屏省 ~20KB parse
let _driverPromise = null;
function loadDriver() {
  if (!_driverPromise) _driverPromise = import("driver.js").then(m => m.driver);
  return _driverPromise;
}

function resolveGuideElement(selector) {
  const elements = Array.from(document.querySelectorAll(selector));
  return elements.find(element => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }) ?? null;
}

// 等待動態步驟的元素出現（例如 onBeforeStep 開了 Modal 後的下一個 render）
async function waitForGuideElement(selector, timeoutMs = 1500) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const element = resolveGuideElement(selector);
    if (element) return element;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  return null;
}

/**
 * 啟動產品導覽。
 *
 * 步驟除了 element/title/description/side/align 之外，支援：
 * - onBeforeStep：進入該步驟前執行（前進與後退都會跑），用來把元素「變出來」
 *   （例如開 Modal、切換分配方式）；元素會在執行後輪詢等待出現。
 * - options.onFinish：導覽結束（完成或中途關閉）時執行，用來收拾狀態（例如關 Modal）。
 */
export function startProductGuide(guideSteps, { onFinish } = {}) {
  // 靜態步驟：現在找不到元素就略過；動態步驟（有 onBeforeStep）保留給執行時開出元素
  const steps = guideSteps.filter(step => step.onBeforeStep || resolveGuideElement(step.element));

  if (steps.length === 0) return;

  loadDriver().then(driver => startLoadedGuide(driver, steps, { onFinish }));
}

function startLoadedGuide(driver, steps, { onFinish } = {}) {
  const driverSteps = steps.map(step => ({
    // 延遲解析：動態步驟的元素在 onBeforeStep 之後才存在
    element: () => resolveGuideElement(step.element) ?? undefined,
    popover: { title: step.title, description: step.description, side: step.side, align: step.align },
    disableActiveInteraction: step.disableActiveInteraction ?? false,
  }));

  const runBeforeStep = async (index) => {
    const step = steps[index];
    if (!step?.onBeforeStep) return;
    await step.onBeforeStep();
    await waitForGuideElement(step.element);
  };

  const driverObj = driver({
    steps: driverSteps,
    showProgress: true,
    animate: true,
    overlayColor: "rgba(15, 23, 42, 0.62)",
    stagePadding: 6,
    stageRadius: 8,
    popoverClass: "album-guide-popover",
    nextBtnText: "下一步",
    prevBtnText: "上一步",
    doneBtnText: "完成",
    // 接管前進/後退：先跑目標步驟的 onBeforeStep、等元素出現再移動
    onNextClick: () => {
      const activeIndex = driverObj.getActiveIndex() ?? 0;
      runBeforeStep(activeIndex + 1).then(() => driverObj.moveNext());
    },
    onPrevClick: () => {
      const activeIndex = driverObj.getActiveIndex() ?? 0;
      runBeforeStep(activeIndex - 1).then(() => driverObj.movePrevious());
    },
    // onDestroyed 在 active element 狀態缺失時不會觸發（driver.js 1.4 行為），
    // 改用無條件先觸發的 onDestroyStarted：先收拾（onFinish）再自行 destroy
    onDestroyStarted: () => {
      onFinish?.();
      driverObj.destroy();
    },
  });

  // 第一步也可能是動態步驟
  runBeforeStep(0).then(() => driverObj.drive());
}
