// 路由載入函式同時供 React.lazy 與專案卡片預載使用；import() Promise 由瀏覽器模組快取去重。
export const loadClassEditRoute = () => import("./pages/ClassEdit");
export const loadStudentEditRoute = () => import("./pages/StudentEdit");
export const loadProjectReviewRoute = () => import("./pages/ProjectReview");

export function prefetchProjectWorkspaceRoutes() {
  void Promise.allSettled([
    loadClassEditRoute(),
    loadStudentEditRoute(),
    loadProjectReviewRoute(),
  ]);
}
