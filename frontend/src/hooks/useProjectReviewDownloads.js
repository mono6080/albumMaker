// 班級總覽的下載動作:單生/全班的 PDF、頁面圖片與上傳照片 ZIP。
// 渲染前置(帶班老師先補渲)與下載觸發在此;手機圖片分享拆在 useMobileImageShare。
// 交件閘門判斷一律走 utils/reviewCompletion,與按鈕 disabled 同一來源。

import { useState } from "react";
import toast from "react-hot-toast";

import { renderStudent } from "../api/projectApi";
import { renderClient } from "../api/authApi";
import {
  buildDownloadAllImagesZipUrl,
  buildDownloadAllPhotosArchiveUrl,
  buildDownloadAllZipUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildDownloadStudentPhotosArchiveUrl,
} from "../api/urls";
import {
  downloadApiBlob,
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
  reloadProject,
  projectLoadSequence,
  canRender,
}) {
  const [rendering, setRendering] = useState({});
  const [renderingImages, setRenderingImages] = useState({});
  const [renderingAll, setRenderingAll] = useState(false);
  const [renderingAllImages, setRenderingAllImages] = useState(false);
  const [renderAllProgress, setRenderAllProgress] = useState(null);
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

  const handleDownloadOne = async (studentId) => {
    if (!ensureStudentCompleted(studentId)) return;
    setRendering(previous => ({ ...previous, [studentId]: true }));
    try {
      const studentRecord = project.students.find(student => student.id === studentId);
      if (!studentRecord?.output_filename && !canRender) {
        toast.error("尚未產生檔案，請由帶班老師先完成產生");
        return;
      }
      if (canRender) {
        await renderStudent(projectId, studentId);
        await reloadProject();
      }
      await downloadApiBlob(
        renderClient,
        buildDownloadPdfUrl(projectId, studentId, effectiveMode),
        "album.pdf",
      );
    } catch {
      showRetryToast(canRender ? "產生失敗" : "下載失敗", () => handleDownloadOne(studentId));
    } finally {
      setRendering(previous => ({ ...previous, [studentId]: false }));
    }
  };

  const handleDownloadOneImages = async (studentId) => {
    if (!ensureStudentCompleted(studentId)) return;
    setRenderingImages(previous => ({ ...previous, [studentId]: true }));
    try {
      const studentRecord = project.students.find(student => student.id === studentId);
      if (!studentRecord) return;
      if (!studentRecord.output_filename && !canRender) {
        toast.error("尚未產生檔案，請由帶班老師先完成產生");
        return;
      }

      if (isMobileDevice()) {
        await mobileShare.shareStudentImages(studentRecord);
        return;
      }

      if (canRender) {
        await renderStudent(projectId, studentId);
        await reloadProject();
      }
      await downloadApiBlob(
        renderClient,
        buildDownloadImagesZipUrl(projectId, studentId, effectiveMode),
        "album-images.zip",
      );
    } catch {
      showRetryToast("產生圖片失敗", () => handleDownloadOneImages(studentId));
    } finally {
      setRenderingImages(previous => ({ ...previous, [studentId]: false }));
    }
  };

  // 逐位渲染;單人失敗不中斷整批,失敗者再自動補渲一輪。
  const renderAllStudentsWithRetry = async (students, onProgress) => {
    const failedStudents = [];
    for (let studentIndex = 0; studentIndex < students.length; studentIndex++) {
      onProgress?.(studentIndex + 1, students.length);
      try {
        await renderStudent(projectId, students[studentIndex].id);
      } catch {
        failedStudents.push(students[studentIndex]);
      }
    }
    const stillFailed = [];
    for (const studentRecord of failedStudents) {
      try {
        await renderStudent(projectId, studentRecord.id);
      } catch {
        stillFailed.push(studentRecord);
      }
    }
    return stillFailed;
  };

  const handleDownloadAll = async () => {
    if (!ensureProjectCompleted()) return;
    const students = project.students;
    if (!students.length) return;
    setRenderingAll(true);
    setRenderAllProgress({ current: 0, total: students.length });
    try {
      if (canRender) {
        const stillFailed = await renderAllStudentsWithRetry(
          students,
          (current, total) => setRenderAllProgress({ current, total }),
        );
        await reloadProject();
        if (stillFailed.length > 0) {
          showRetryToast(`${stillFailed.map(student => student.name).join("、")} 產生失敗`, handleDownloadAll);
          return;
        }
      } else {
        const renderedCount = students.filter(student => student.output_filename).length;
        if (renderedCount === 0) {
          toast.error("目前沒有已產生的檔案可下載");
          return;
        }
        if (renderedCount < students.length) {
          toast(`將下載已產生的 ${renderedCount}/${students.length} 位學生檔案`);
        }
      }
      triggerNativeDownload(buildDownloadAllZipUrl(projectId, effectiveMode));
      toast.success("已開始下載，請留意瀏覽器的下載列");
    } catch {
      showRetryToast("批次產生失敗", handleDownloadAll);
    } finally {
      setRenderingAll(false);
      setRenderAllProgress(null);
    }
  };

  const handleDownloadAllImages = async () => {
    if (!ensureProjectCompleted()) return;
    const students = project.students;
    if (!students.length) return;
    setRenderingAllImages(true);
    setRenderAllImagesProgress({ current: 0, total: students.length });
    try {
      const downloadableStudents = canRender
        ? students
        : students.filter(student => student.output_filename);
      if (downloadableStudents.length === 0) {
        toast.error("目前沒有已產生的檔案可下載");
        return;
      }
      if (isMobileDevice()) {
        await mobileShare.shareAllImages(
          downloadableStudents,
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
        return;
      }

      if (canRender) {
        const stillFailed = await renderAllStudentsWithRetry(
          students,
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
        await reloadProject();
        if (stillFailed.length > 0) {
          showRetryToast(`${stillFailed.map(student => student.name).join("、")} 產生失敗`, handleDownloadAllImages);
          return;
        }
      } else if (downloadableStudents.length < students.length) {
        toast(`將下載已產生的 ${downloadableStudents.length}/${students.length} 位學生檔案`);
      }
      triggerNativeDownload(buildDownloadAllImagesZipUrl(projectId, effectiveMode));
      toast.success("已開始下載，請留意瀏覽器的下載列");
    } catch {
      showRetryToast("批次產生圖片失敗", handleDownloadAllImages);
    } finally {
      setRenderingAllImages(false);
      setRenderAllImagesProgress(null);
    }
  };

  // 上傳照片 ZIP:不套交件閘門、無需渲染前置,直接原生下載(手機同樣走原生下載)。
  // 原生下載無完成事件可等,busy 狀態以短暫延遲解除,僅防連點。
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
    renderAllProgress,
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
