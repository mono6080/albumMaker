// 班級總覽的審閱留言面板：留言清單（admin / 作者本人可刪）＋ 新增留言輸入區
//（老師唯讀，不顯示輸入區）。留言資料與送出/刪除邏輯留在呼叫端，透過 props 傳入。

import { MessageCircle, Send, Trash2 } from "lucide-react";
import { Button, IconButton, Surface, fieldControlClass } from "./ui";

export default function ReviewCommentsPanel({
  comments,
  canComment,
  isAdmin,
  currentUser,
  newCommentText,
  isSubmittingComment,
  onChangeNewComment,
  onSubmitComment,
  onDeleteComment,
}) {
  return (
    <Surface id="review-comments" className="mt-8 scroll-mt-20" data-guide="review-comments">
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle className="w-4 h-4 text-violet-500" />
        <h3 className="font-semibold text-gray-800 text-sm">審閱意見</h3>
        {comments.length > 0 && (
          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{comments.length}</span>
        )}
      </div>

      {/* 留言清單 */}
      {comments.length === 0 ? (
        <p className="text-sm text-gray-300 text-center py-4">尚無意見</p>
      ) : (
        <div className="space-y-3 mb-4">
          {comments.map((comment) => (
            <div key={comment.id} className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-xs font-bold text-violet-600 flex-shrink-0">
                {comment.author_name?.[0] ?? "?"}
              </div>
              <div className="flex-1 bg-gray-50 rounded-xl px-3 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-medium text-gray-700">{comment.author_name}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-300">
                      {new Date(comment.created_at).toLocaleString("zh-TW", {
                        month: "numeric", day: "numeric",
                        hour: "2-digit", minute: "2-digit",
                      })}
                    </span>
                    {/* 後端允許 admin 或作者本人刪除，前端一致 */}
                    {(isAdmin || comment.author_id === currentUser?.id) && (
                      <IconButton
                        label="刪除留言"
                        onClick={() => onDeleteComment(comment.id)}
                        variant="danger"
                        size="xs"
                      >
                        <Trash2 className="w-3 h-3" />
                      </IconButton>
                    )}
                  </div>
                </div>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{comment.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 新增留言（老師唯讀，不顯示輸入區） */}
      {canComment && (
        <>
          <div className="flex gap-2 min-w-0">
            <textarea
              rows={2}
              value={newCommentText}
              onChange={(e) => onChangeNewComment(e.target.value)}
              placeholder="輸入審閱意見..."
              className={`${fieldControlClass} flex-1 resize-none`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSubmitComment();
              }}
            />
            <Button
              onClick={onSubmitComment}
              disabled={isSubmittingComment || !newCommentText.trim()}
              variant="primary"
              className="self-end"
            >
              <Send className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">送出</span>
            </Button>
          </div>
          <p className="text-xs text-gray-300 mt-1.5">Ctrl+Enter 快速送出</p>
        </>
      )}
    </Surface>
  );
}
