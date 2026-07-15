export function getUploadStatusLabel(status) {
  if (!status) return "";
  if (status.retrying) return "重試中";
  if (status.phase === "processing") return "處理中";
  if (status.phase === "saving") return "整理結果中";
  return "上傳中";
}
