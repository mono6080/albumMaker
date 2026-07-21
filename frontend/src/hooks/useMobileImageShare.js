// 手機圖片分享:逐頁抓預覽 JPG 組成 File 後走 Web Share API。
// 準備完成後先直接嘗試開分享面板;瀏覽器因使用者手勢逾時拒絕(failed)時,
// 保留草稿退回「再按一次開始分享」的兩段式,其餘失敗原因直接提示不留草稿。

import { useLayoutEffect, useState } from "react";
import toast from "react-hot-toast";

import { renderClient } from "../api/authApi";
import {
  appendPreviewCacheVersion,
  buildStudentPagePreviewUrl,
} from "../api/urls";
import {
  createFileFromBlob,
  fetchApiBlob,
  getShareFailureMessage,
  isMobileDevice,
  shareFiles,
} from "../utils/browserFiles";

export default function useMobileImageShare({
  projectId,
  project,
  getVisiblePageIndexes,
  projectLoadSequence,
}) {
  const [imageShareDrafts, setImageShareDrafts] = useState({});
  const [allImagesShareDraft, setAllImagesShareDraft] = useState(null);

  // 專案內容更新後,先前準備的分享檔已過期。
  useLayoutEffect(() => {
    setImageShareDrafts({});
    setAllImagesShareDraft(null);
  }, [projectLoadSequence]);

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

  // 開啟已備妥的分享;成功後由呼叫端負責清草稿
  const openPreparedShare = async (draft, onShared) => {
    const shareResult = await shareFiles(draft.files, draft.title);
    if (shareResult === "shared") {
      onShared();
      toast.success("已開啟分享");
    } else if (shareResult !== "cancelled") {
      toast.error(getShareFailureMessage(shareResult));
    }
  };

  // 準備檔案後立即嘗試分享;僅手勢逾時(failed)時存草稿等第二次點擊
  const prepareAndShare = async (students, title, onProgress, saveDraft) => {
    const files = await buildShareImageFiles(students, Date.now(), onProgress);
    if (!files.length) {
      toast.error("沒有可分享的頁面");
      return;
    }
    const shareResult = await shareFiles(files, title);
    if (shareResult === "shared") {
      toast.success("已開啟分享");
      return;
    }
    if (shareResult === "cancelled") return;
    if (shareResult === "failed") {
      saveDraft({ files, title });
      toast("圖片已準備好，請再按一次開始分享");
      return;
    }
    toast.error(getShareFailureMessage(shareResult));
  };

  const shareStudentImages = async (studentRecord, onProgress) => {
    const preparedShare = imageShareDrafts[studentRecord.id];
    if (preparedShare?.files?.length) {
      await openPreparedShare(preparedShare, () => {
        setImageShareDrafts(previous => {
          const next = { ...previous };
          delete next[studentRecord.id];
          return next;
        });
      });
      return;
    }
    await prepareAndShare(
      [studentRecord],
      `${studentRecord.name} 相冊圖片`,
      onProgress,
      draft => setImageShareDrafts(previous => ({
        ...previous,
        [studentRecord.id]: draft,
      })),
    );
  };

  const shareAllImages = async (students, onProgress) => {
    if (allImagesShareDraft?.files?.length) {
      await openPreparedShare(allImagesShareDraft, () => setAllImagesShareDraft(null));
      return;
    }
    await prepareAndShare(
      students,
      `${project.name} 全部圖片`,
      onProgress,
      setAllImagesShareDraft,
    );
  };

  return {
    shareStudentImages,
    shareAllImages,
    isAllImagesShareReady: isMobileDevice() && allImagesShareDraft?.files?.length > 0,
    isImageShareReady: studentId =>
      isMobileDevice() && imageShareDrafts[studentId]?.files?.length > 0,
  };
}
