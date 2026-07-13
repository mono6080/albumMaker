// 路由保護元件
// 未登入導向 /login；角色不符顯示無權限提示

import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * @param {React.ReactNode} children - 受保護的頁面元件
 * @param {string[]} [allowedRoles]  - 允許存取的角色清單；省略表示任何已登入用戶皆可
 */
export default function PrivateRoute({ children, allowedRoles }) {
  const { currentUser, isLoading, authError, refreshSession } = useAuth();

  // 等待 token 驗證完成，避免短暫閃爍跳轉
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        驗證中...
      </div>
    );
  }

  if (authError && !currentUser) {
    return (
      <div className="flex min-h-[20rem] flex-col items-center justify-center gap-3 px-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-100 text-2xl" aria-hidden="true">
          {navigator.onLine ? "⚠️" : "📡"}
        </div>
        <h1 className="font-semibold text-gray-900">
          {navigator.onLine ? "目前無法連上系統" : "目前沒有網路連線"}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-gray-500">
          您的登入狀態沒有被清除。請確認網路或稍後重試。
        </p>
        <button
          type="button"
          onClick={refreshSession}
          className="min-h-11 rounded-xl bg-indigo-600 px-5 text-sm font-medium text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          重新連線
        </button>
      </div>
    );
  }

  if (!currentUser) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && !allowedRoles.includes(currentUser.role)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-gray-500 font-medium">您沒有存取此頁面的權限</p>
        <p className="text-sm text-gray-400">目前角色：{currentUser.role}</p>
      </div>
    );
  }

  return children;
}
