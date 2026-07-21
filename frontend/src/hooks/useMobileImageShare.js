// 手機圖片分享:逐頁抓預覽 JPG 組成 File 後走 Web Share API。
// 分享面板必須在使用者手勢有效期內開啟;全班檔案量大、點擊當下才抓必逾時,
// 因此全班在交件閘門解鎖後由背景預抓備妥,一按即開分享面板。
// 個別學生仍是點擊當下現抓,手勢逾時拒絕(failed)時保留草稿退回
// 「再按一次開始分享」的兩段式,其餘失敗原因直接提示不留草稿。

import { useLayoutEffect, useRef, useState } from "react";
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
  // 全班分享檔建置中的 promise:背景預抓與點擊共用同一份,避免重複抓整批檔案
  const allImagesBuildRef = useRef(null);
  // 點擊時才掛上的進度回報;背景預抓期間為 null(不顯示進度)
  const allImagesProgressRef = useRef(null);
  // 最新載入序號:舊序號的建置完成後不得寫入草稿
  const latestSequenceRef = useRef(projectLoadSequence);

  // 專案內容更新後,先前準備的分享檔已過期。
  useLayoutEffect(() => {
    latestSequenceRef.current = projectLoadSequence;
    setImageShareDrafts({});
    setAllImagesShareDraft(null);
    allImagesBuildRef.current = null;
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

  // 建置全班分享草稿;同時只跑一份,完成後寫入 state 供按鈕顯示「開始分享」
  const buildAllImagesDraft = (students) => {
    if (!allImagesBuildRef.current) {
      const sequenceAtStart = projectLoadSequence;
      const title = `${project.name} 全部圖片`;
      allImagesBuildRef.current = (async () => {
        try {
          const files = await buildShareImageFiles(
            students,
            Date.now(),
            (current, total) => allImagesProgressRef.current?.(current, total),
          );
          if (latestSequenceRef.current !== sequenceAtStart || !files.length) return null;
          const draft = { files, title };
          setAllImagesShareDraft(draft);
          return draft;
        } catch (error) {
          allImagesBuildRef.current = null;
          throw error;
        }
      })();
    }
    return allImagesBuildRef.current;
  };

  // 交件閘門解鎖後於背景預抓,失敗不打擾使用者(點擊時會再重抓一次)
  const prefetchAllImagesShare = (students) => {
    if (!isMobileDevice() || !students?.length) return;
    if (allImagesShareDraft?.files?.length || allImagesBuildRef.current) return;
    buildAllImagesDraft(students).catch(() => {});
  };

  const shareAllImages = async (students, onProgress) => {
    let draft = allImagesShareDraft?.files?.length ? allImagesShareDraft : null;
    if (!draft) {
      allImagesProgressRef.current = onProgress;
      try {
        draft = await buildAllImagesDraft(students);
      } finally {
        allImagesProgressRef.current = null;
      }
    }
    if (!draft?.files?.length) {
      toast.error("沒有可分享的頁面");
      return;
    }
    const shareResult = await shareFiles(draft.files, draft.title);
    if (shareResult === "shared") {
      // 草稿保留:檔案在專案內容更新前仍有效,再按一次可直接重開分享
      toast.success("已開啟分享");
      return;
    }
    if (shareResult === "cancelled") return;
    if (shareResult === "failed") {
      toast("圖片已準備好，請再按一次開始分享");
      return;
    }
    toast.error(getShareFailureMessage(shareResult));
  };

  return {
    shareStudentImages,
    shareAllImages,
    prefetchAllImagesShare,
    isAllImagesShareReady: isMobileDevice() && allImagesShareDraft?.files?.length > 0,
    isImageShareReady: studentId =>
      isMobileDevice() && imageShareDrafts[studentId]?.files?.length > 0,
  };
}
