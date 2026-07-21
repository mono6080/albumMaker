// 班級總覽的下載動作:單生/全班的 PDF、頁面圖片與上傳照片 ZIP。
// 後端在標記完成時背景渲染、下載端點又以內容指紋保證最新,
// 前端不再於下載前逐位渲染;桌機下載一律走原生下載(下載列立即出現、
// 邊收邊存,不經 axios blob 佔記憶體);手機圖片分享拆在 useMobileImageShare。
// 交件閘門判斷一律走 utils/reviewCompletion,與按鈕 disabled 同一來源。

import { useEffect, useState } from "react";
import toast from "react-hot-toast";

import {
  buildDownloadAllImagesZipUrl,
  buildDownloadAllPhotosArchiveUrl,
  buildDownloadAllZipUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildDownloadStudentPhotosArchiveUrl,
} from "../api/urls";
import {
  isMobileDevice,
  triggerNativeDownload,
} from "../utils/browserFiles";
import {
  isProjectDeliverableUnlocked,
  isStudentDeliverableUnlocked,
} from "../utils/reviewCompletion";
import { showRetryToast } from "../utils/retryToast";
import useMobileImageShare from "./useMobileImageShare";

export default function useProjectReviewDownloads({
  projectId,
  project,
  effectiveMode,
  getVisiblePageIndexes,
  projectLoadSequence,
}) {
  const [rendering, setRendering] = useState({});
  const [renderingImages, setRenderingImages] = useState({});
  // 原生下載無完成事件可等,全班 ZIP 的 busy 狀態以短暫延遲解除,僅防連點
  const [renderingAll, setRenderingAll] = useState(false);
  const [renderingAllImages, setRenderingAllImages] = useState(false);
  // 手機全班分享的抓圖進度(桌機原生下載無進度可回報)
  const [renderAllImagesProgress, setRenderAllImagesProgress] = useState(null);
  // 上傳照片 ZIP 的防連點狀態(後端串流打包,無進度可回報)
  const [downloadingPhotos, setDownloadingPhotos] = useState({});
  const [downloadingAllPhotos, setDownloadingAllPhotos] = useState(false);

  const mobileShare = useMobileImageShare({
    projectId,
    project,
    getVisiblePageIndexes,
    projectLoadSequence,
  });

  // 手機且交件閘門解鎖後,背景預抓全班分享檔,讓「全部圖片」一按即開分享面板
  const { prefetchAllImagesShare } = mobileShare;
  useEffect(() => {
    if (!project || !isMobileDevice() || !isProjectDeliverableUnlocked(project)) return;
    prefetchAllImagesShare(project.students);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectLoadSequence]);

  // 單生交件閘門:與卡片按鈕 disabled 同一 predicate,此處是 UI 被繞過時的最後防線
  const ensureStudentCompleted = (studentId) => {
    const studentRecord = project?.students.find(student => student.id === studentId);
    if (isStudentDeliverableUnlocked(project, studentRecord)) return true;
    toast.error("請先標記此學生完成，再下載 PDF 或圖片");
    return false;
  };

  // 全班交件閘門:只看全班標記完成;未達時提示已標記 n/N
  const ensureProjectCompleted = () => {
    if (isProjectDeliverableUnlocked(project)) return true;
    const completedStudentCount = project?.students.filter(student => student.completed_at).length ?? 0;
    const studentTotal = project?.students.length ?? 0;
    toast.error(`已標記完成 ${completedStudentCount}/${studentTotal} 位，交件 ZIP 需全班標記完成`);
    return false;
  };

  const handleDownloadOne = (studentId) => {
    if (!ensureStudentCompleted(studentId)) return;
    if (rendering[studentId]) return;
    setRendering(previous => ({ ...previous, [studentId]: true }));
    triggerNativeDownload(buildDownloadPdfUrl(projectId, studentId, effectiveMode));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => {
      setRendering(previous => ({ ...previous, [studentId]: false }));
    }, 3000);
  };

  const handleDownloadOneImages = async (studentId) => {
    if (!ensureStudentCompleted(studentId)) return;
    if (renderingImages[studentId]) return;

    if (isMobileDevice()) {
      const studentRecord = project.students.find(student => student.id === studentId);
      if (!studentRecord) return;
      setRenderingImages(previous => ({ ...previous, [studentId]: true }));
      try {
        await mobileShare.shareStudentImages(studentRecord);
      } catch {
        showRetryToast("分享圖片失敗", () => handleDownloadOneImages(studentId));
      } finally {
        setRenderingImages(previous => ({ ...previous, [studentId]: false }));
      }
      return;
    }

    setRenderingImages(previous => ({ ...previous, [studentId]: true }));
    triggerNativeDownload(buildDownloadImagesZipUrl(projectId, studentId, effectiveMode));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => {
      setRenderingImages(previous => ({ ...previous, [studentId]: false }));
    }, 3000);
  };

  const handleDownloadAll = () => {
    if (!ensureProjectCompleted()) return;
    if (renderingAll || !project.students.length) return;
    setRenderingAll(true);
    triggerNativeDownload(buildDownloadAllZipUrl(projectId, effectiveMode));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => setRenderingAll(false), 3000);
  };

  const handleDownloadAllImages = async () => {
    if (!ensureProjectCompleted()) return;
    const students = project.students;
    if (!students.length) return;

    if (isMobileDevice()) {
      setRenderingAllImages(true);
      setRenderAllImagesProgress({ current: 0, total: students.length });
      try {
        await mobileShare.shareAllImages(
          students,
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
      } catch {
        showRetryToast("準備分享圖片失敗", handleDownloadAllImages);
      } finally {
        setRenderingAllImages(false);
        setRenderAllImagesProgress(null);
      }
      return;
    }

    if (renderingAllImages) return;
    setRenderingAllImages(true);
    triggerNativeDownload(buildDownloadAllImagesZipUrl(projectId, effectiveMode));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => setRenderingAllImages(false), 3000);
  };

  // 上傳照片 ZIP:不套交件閘門、無需渲染前置,直接原生下載(手機同樣走原生下載)。
  const handleDownloadOnePhotos = (studentId) => {
    if (downloadingPhotos[studentId]) return;
    setDownloadingPhotos(previous => ({ ...previous, [studentId]: true }));
    triggerNativeDownload(buildDownloadStudentPhotosArchiveUrl(projectId, studentId));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => {
      setDownloadingPhotos(previous => ({ ...previous, [studentId]: false }));
    }, 3000);
  };

  const handleDownloadAllPhotos = () => {
    if (downloadingAllPhotos) return;
    setDownloadingAllPhotos(true);
    triggerNativeDownload(buildDownloadAllPhotosArchiveUrl(projectId));
    toast.success("已開始下載，請留意瀏覽器的下載列");
    setTimeout(() => setDownloadingAllPhotos(false), 3000);
  };

  return {
    rendering,
    renderingImages,
    renderingAll,
    renderingAllImages,
    renderAllImagesProgress,
    isBatchRendering: renderingAll || renderingAllImages,
    isAllImagesShareReady: mobileShare.isAllImagesShareReady,
    isImageShareReady: mobileShare.isImageShareReady,
    downloadingPhotos,
    downloadingAllPhotos,
    handleDownloadOne,
    handleDownloadOneImages,
    handleDownloadAll,
    handleDownloadAllImages,
    handleDownloadOnePhotos,
    handleDownloadAllPhotos,
  };
}
