// 路由保護元件
// 未登入導向 /login；角色不符顯示無權限提示

import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

/**
 * @param {React.ReactNode} children - 受保護的頁面元件
 * @param {string[]} [allowedRoles]  - 允許存取的角色清單；省略表示任何已登入用戶皆可
 */
export default function PrivateRoute({ children, allowedRoles }) {
  const { currentUser, isLoading } = useAuth();

  // 等待 token 驗證完成，避免短暫閃爍跳轉
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
        驗證中...
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
