import { BrowserRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import { LogOut, Users } from "lucide-react";

import { AuthProvider, useAuth } from "./context/AuthContext";
import PrivateRoute from "./components/PrivateRoute";
import PwaUpdateBanner from "./components/PwaUpdateBanner";
import Login from "./pages/Login";
import TemplateList from "./pages/TemplateList";
import TemplateEditor from "./pages/TemplateEditor";
import ProjectList from "./pages/ProjectList";
import ProjectBatch from "./pages/ProjectBatch";
import ProjectReview from "./pages/ProjectReview";
import StudentEdit from "./pages/StudentEdit";
import UserManagement from "./pages/UserManagement";
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
    <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-0 flex items-center gap-1 shadow-sm">
      <Link to="/" className="flex items-center gap-2 py-4 mr-4 sm:mr-6 flex-shrink-0">
        <span className="text-xl">🎨</span>
        <span className="hidden sm:inline font-bold text-gray-900 text-sm tracking-tight">幼兒園相本系統</span>
      </Link>

      {navLinks.map(({ path, label }) => (
        <Link
          key={path}
          to={path}
          className={`px-3 sm:px-4 py-4 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
            isActive(path)
              ? "border-indigo-600 text-indigo-700"
              : "border-transparent text-gray-500 hover:text-gray-800 hover:border-gray-300"
          }`}
        >
          {label}
        </Link>
      ))}

      {/* 右側：使用者資訊 + 登出 */}
      {currentUser && (
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden sm:flex items-center gap-1.5 text-xs text-gray-500">
            <span className="font-medium text-gray-700">{currentUser.display_name}</span>
            <span className="bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
              {ROLE_LABELS[currentUser.role] ?? currentUser.role}
            </span>
          </span>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 py-1.5 px-2 rounded-lg hover:bg-gray-100 transition-colors"
            title="登出"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">登出</span>
          </button>
        </div>
      )}
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Toaster position="top-right" />
        <PwaUpdateBanner />
        <Nav />
        <main className="p-4 sm:p-8 w-full">
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

            {/* 使用者管理（admin only） */}
            <Route path="/admin/users" element={
              <PrivateRoute allowedRoles={["admin"]}>
                <UserManagement />
              </PrivateRoute>
            } />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  );
}
