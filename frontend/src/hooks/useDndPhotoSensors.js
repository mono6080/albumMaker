import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";

// 照片拖曳共用的 dnd-kit sensor 設定：
// 滑鼠移動 4px 啟動（避免單純點擊被誤判為拖曳）；
// 觸控長按 250ms 啟動（與捲動手勢區分，超過門檻才進入拖曳模式）。
export function useDndPhotoSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
}
