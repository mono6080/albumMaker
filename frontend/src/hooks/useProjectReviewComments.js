import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";

import { apiClient } from "../api/authApi";
import { getApiErrorMessage } from "../utils/apiError";

export default function useProjectReviewComments(projectId, setConfirmModal) {
  const [comments, setComments] = useState([]);
  const [newCommentText, setNewCommentText] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const loadComments = useCallback(async () => {
    try {
      const response = await apiClient.get(`/projects/${projectId}/comments`);
      setComments(response.data);
    } catch {
      // 留言不是頁面主流程，載入失敗不阻擋班級總覽。
    }
  }, [projectId]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  const handleSubmitComment = async () => {
    if (!newCommentText.trim()) return;
    setIsSubmittingComment(true);
    try {
      await apiClient.post(
        `/projects/${projectId}/comments`,
        new URLSearchParams({ content: newCommentText.trim() }),
      );
      setNewCommentText("");
      await loadComments();
    } catch (error) {
      toast.error(getApiErrorMessage(error, "留言失敗"));
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const handleDeleteComment = (commentId) => {
    setConfirmModal({
      message: "確定刪除這則留言？刪除後無法復原。",
      confirmLabel: "刪除",
      confirmVariant: "danger",
      onConfirm: async () => {
        try {
          await apiClient.delete(`/projects/${projectId}/comments/${commentId}`);
          await loadComments();
        } catch (error) {
          toast.error(getApiErrorMessage(error, "刪除失敗"));
        }
      },
    });
  };

  return {
    comments,
    newCommentText,
    setNewCommentText,
    isSubmittingComment,
    handleSubmitComment,
    handleDeleteComment,
  };
}
