// 單頁渲染預覽圖子元件
// 依 timestamp 更新觸發重新載入，避免切頁時觸發不必要的渲染

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { buildStudentPagePreviewUrl } from "../api/urls";

export default function PagePreview({ projectId, studentId, pageIndex, timestamp }) {
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    setIsLoaded(false);
  }, [projectId, studentId, pageIndex, timestamp]);

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-gray-200 shadow-sm"
      style={{ aspectRatio: "794 / 1123" }}
    >
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
          <Loader2 className="w-5 h-5 text-gray-300 animate-spin" />
        </div>
      )}
      <img
        key={timestamp}
        src={`${buildStudentPagePreviewUrl(projectId, studentId, pageIndex)}?t=${timestamp}`}
        alt={`第 ${pageIndex + 1} 頁`}
        className="w-full h-full object-cover"
        onLoad={() => setIsLoaded(true)}
        onError={() => setIsLoaded(true)}
      />
    </div>
  );
}
