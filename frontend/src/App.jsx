import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { LogOut, Settings as SettingsIcon } from "lucide-react";

import { AuthProvider, useAuth } from "./context/AuthContext";
import PrivateRoute from "./components/PrivateRoute";
import PwaUpdateBanner from "./components/PwaUpdateBanner";
import { Button } from "./components/ui";
import Login from "./pages/Login";
import TemplateList from "./pages/TemplateList";
import TemplateEditor from "./pages/TemplateEditor";
import ProjectList from "./pages/ProjectList";
import ProjectBatch from "./pages/ProjectBatch";
import ProjectReview from "./pages/ProjectReview";
import StudentEdit from "./pages/StudentEdit";
import UserManagement from "./pages/UserManagement";
import SettingsPage from "./pages/Settings";
import './App.css';

const ROLE_LABELS = {
  admin: "管理員",
  art_team: "設計",
  supervisor: "主管",
  teacher: "帶班老師",
  none: "無權限",
};

function Nav() {
  const loc = useLocation();
  const navigate = useNavigate();
  const { currentUser, logout } = useAuth();
  const isActive = (path) => loc.pathname.startsWith(path);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  // 登入頁不顯示 Nav
  if (loc.pathname === "/login") return null;

  const navLinks = [];
  if (currentUser?.role === "admin" || currentUser?.role === "art_team") {
    navLinks.push({ path: "/templates", label: "模板" });
  }
  if (["admin", "teacher", "supervisor", "art_team"].includes(currentUser?.role)) {
    navLinks.push({ path: "/projects", label: "相本專案" });
  }
  if (currentUser?.role === "admin") {
    navLinks.push({ path: "/admin/users", label: "使用者管理" });
  }

  return (
    <nav className="bg-white border-b border-gray-200 shadow-sm">
      <div className="flex min-w-0 items-center gap-1 px-3 sm:px-6">
        <Link to="/" className="flex min-h-12 min-w-10 flex-shrink-0 items-center justify-center gap-2 mr-1 sm:mr-3">
          <span className="text-xl leading-none">🎨</span>
          <span className="hidden lg:inline max-w-[11rem] truncate font-bold text-gray-900 text-sm tracking-tight">
            幼兒園相本系統
          </span>
        </Link>

        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain nav-scroll-x">
          <div className="flex min-w-max items-center gap-1">
            {navLinks.map(({ path, label }) => (
              <Link
                key={path}
                to={path}
                className={`px-2.5 sm:px-3 py-3.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive(path)
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {/* 右側：使用者資訊 + 登出 */}
        {currentUser && (
          <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2 pl-1 sm:pl-2">
            <span className="hidden xl:flex min-w-0 max-w-[14rem] items-center gap-1.5 text-xs text-gray-500">
              <span className="min-w-0 truncate font-medium text-gray-700">{currentUser.display_name}</span>
              <span className="flex-shrink-0 bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                {ROLE_LABELS[currentUser.role] ?? currentUser.role}
              </span>
            </span>
            <Button
              as={Link}
              to="/settings"
              variant={isActive("/settings") ? "secondary" : "ghost"}
              size="xs"
              className="flex-shrink-0"
              title="設定"
            >
              <SettingsIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="hidden lg:inline whitespace-nowrap">設定</span>
            </Button>
            <Button
              onClick={handleLogout}
              variant="ghost"
              size="xs"
              className="flex-shrink-0"
              title="登出"
            >
              <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="hidden lg:inline whitespace-nowrap">登出</span>
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}

function AppContent() {
  const loc = useLocation();
  const mainClassName = loc.pathname === "/login"
    ? "w-full flex-1"
    : "p-4 sm:p-8 w-full flex-1";

  return (
    <AuthProvider>
      <Toaster position="top-right" />
      <PwaUpdateBanner />
      <Nav />
      <main className={mainClassName}>
        <Routes>
          {/* 登入頁（公開） */}
          <Route path="/login" element={<Login />} />

          {/* 首頁依角色導向 */}
          <Route path="/" element={
            <PrivateRoute>
              <ProjectList />
            </PrivateRoute>
          } />

          {/* 模板（admin + 美學組） */}
          <Route path="/templates" element={
            <PrivateRoute allowedRoles={["admin", "art_team"]}>
              <TemplateList />
            </PrivateRoute>
          } />
          <Route path="/templates/:id/edit" element={
            <PrivateRoute allowedRoles={["admin", "art_team"]}>
              <TemplateEditor />
            </PrivateRoute>
          } />

          {/* 專案（admin + teacher + supervisor + art_team） */}
          <Route path="/projects" element={
            <PrivateRoute allowedRoles={["admin", "teacher", "supervisor", "art_team"]}>
              <ProjectList />
            </PrivateRoute>
          } />
          <Route path="/projects/:id/batch" element={
            <PrivateRoute allowedRoles={["admin", "teacher", "supervisor"]}>
              <ProjectBatch />
            </PrivateRoute>
          } />
          <Route path="/projects/:id/review" element={
            <PrivateRoute allowedRoles={["admin", "teacher", "supervisor", "art_team"]}>
              <ProjectReview />
            </PrivateRoute>
          } />
          <Route path="/projects/:projectId/students/:studentId/edit" element={
            <PrivateRoute allowedRoles={["admin", "teacher", "supervisor"]}>
              <StudentEdit />
            </PrivateRoute>
          } />

          {/* 個人設定 */}
          <Route path="/settings" element={
            <PrivateRoute>
              <SettingsPage />
            </PrivateRoute>
          } />

          {/* 使用者管理（admin only） */}
          <Route path="/admin/users" element={
            <PrivateRoute allowedRoles={["admin"]}>
              <UserManagement />
            </PrivateRoute>
          } />
        </Routes>
      </main>
    </AuthProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
