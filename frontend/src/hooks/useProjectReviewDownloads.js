import { useLayoutEffect, useState } from "react";
import toast from "react-hot-toast";

import { renderStudent } from "../api/projectApi";
import { renderClient } from "../api/authApi";
import {
  appendPreviewCacheVersion,
  buildDownloadAllImagesZipUrl,
  buildDownloadAllZipUrl,
  buildDownloadImagesZipUrl,
  buildDownloadPdfUrl,
  buildStudentPagePreviewUrl,
} from "../api/urls";
import {
  createFileFromBlob,
  downloadApiBlob,
  fetchApiBlob,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
  triggerNativeDownload,
} from "../utils/browserFiles";
import { showRetryToast } from "../utils/retryToast";

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
  const [imageShareDrafts, setImageShareDrafts] = useState({});
  const [allImagesShareDraft, setAllImagesShareDraft] = useState(null);

  // 專案內容更新後，先前準備的手機分享檔已過期。
  useLayoutEffect(() => {
    setImageShareDrafts({});
    setAllImagesShareDraft(null);
  }, [projectLoadSequence]);

  const ensureProjectCompleted = () => {
    if (project?.completed_at) return true;
    toast.error("請先標記全班完成，再下載 PDF 或圖片");
    return false;
  };

  const buildShareImageFiles = async (students, requestTimestamp, onProgress) => {
    const files = [];
    for (let studentIndex = 0; studentIndex < students.length; studentIndex++) {
      const studentRecord = students[studentIndex];
      onProgress?.(studentIndex + 1, students.length);

      const visiblePageIndexes = getVisiblePageIndexes(studentRecord);
      for (const [visibleIndex, pageIndex] of visiblePageIndexes.entries()) {
        const { blob } = await fetchApiBlob(
          renderClient,
          appendPreviewCacheVersion(
            buildStudentPagePreviewUrl(projectId, studentRecord.id, pageIndex),
            requestTimestamp,
            project.template_revision,
          ),
        );
        const file = createFileFromBlob(
          blob,
          `${studentRecord.name}_page${visibleIndex + 1}.jpg`,
          "image/jpeg",
        );
        if (file) files.push(file);
      }
    }
    return files;
  };

  const handleDownloadOne = async (studentId) => {
    if (!ensureProjectCompleted()) return;
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
    if (!ensureProjectCompleted()) return;
    setRenderingImages(previous => ({ ...previous, [studentId]: true }));
    try {
      const studentRecord = project.students.find(student => student.id === studentId);
      if (!studentRecord) return;
      if (!studentRecord.output_filename && !canRender) {
        toast.error("尚未產生檔案，請由帶班老師先完成產生");
        return;
      }

      if (isMobileDevice()) {
        const preparedShare = imageShareDrafts[studentId];
        if (preparedShare?.files?.length) {
          const shareResult = await shareFiles(preparedShare.files, preparedShare.title);
          if (shareResult === "shared") {
            setImageShareDrafts(previous => {
              const next = { ...previous };
              delete next[studentId];
              return next;
            });
            toast.success("已開啟分享");
          } else if (shareResult !== "cancelled") {
            toast.error(getShareFailureMessage(shareResult));
          }
          return;
        }

        const files = await buildShareImageFiles([studentRecord], Date.now());
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        setImageShareDrafts(previous => ({
          ...previous,
          [studentId]: { files, title: `${studentRecord.name} 相冊圖片` },
        }));
        toast.success("圖片已準備好，請再按一次開始分享");
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

  // 逐位渲染；單人失敗不中斷整批，失敗者再自動補渲一輪。
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
        if (allImagesShareDraft?.files?.length) {
          const shareResult = await shareFiles(allImagesShareDraft.files, allImagesShareDraft.title);
          if (shareResult === "shared") {
            setAllImagesShareDraft(null);
            toast.success("已開啟分享");
          } else if (shareResult !== "cancelled") {
            toast.error(getShareFailureMessage(shareResult));
          }
          return;
        }

        const files = await buildShareImageFiles(
          downloadableStudents,
          Date.now(),
          (current, total) => setRenderAllImagesProgress({ current, total }),
        );
        if (!files.length) {
          toast.error("沒有可分享的頁面");
          return;
        }

        setAllImagesShareDraft({ files, title: `${project.name} 全部圖片` });
        toast.success("圖片已準備好，請再按一次開始分享");
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

  return {
    rendering,
    renderingImages,
    renderingAll,
    renderingAllImages,
    renderAllProgress,
    renderAllImagesProgress,
    isBatchRendering: renderingAll || renderingAllImages,
    isAllImagesShareReady: isMobileDevice() && allImagesShareDraft?.files?.length > 0,
    isImageShareReady: studentId => isMobileDevice() && imageShareDrafts[studentId]?.files?.length > 0,
    handleDownloadOne,
    handleDownloadOneImages,
    handleDownloadAll,
    handleDownloadAllImages,
  };
}
