import { BrowserRouter, Routes, Route, Link, useLocation } from "react-router-dom";
import { Toaster } from "react-hot-toast";
import TemplateList from "./pages/TemplateList";
import TemplateEditor from "./pages/TemplateEditor";
import ProjectList from "./pages/ProjectList";
import ProjectBatch from "./pages/ProjectBatch";
import ProjectReview from "./pages/ProjectReview";
import StudentEdit from "./pages/StudentEdit";
import './App.css';

function Nav() {
  const loc = useLocation();
  const isActive = (path) => loc.pathname.startsWith(path);
  return (
    <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-0 flex items-center gap-1 shadow-sm">
      <Link to="/" className="flex items-center gap-2 py-4 mr-4 sm:mr-6 flex-shrink-0">
        <span className="text-xl">🎨</span>
        <span className="hidden sm:inline font-bold text-gray-900 text-sm tracking-tight">幼兒園相本系統</span>
      </Link>
      {[
        { path: "/templates", label: "模板" },
        { path: "/projects", label: "相本專案" },
      ].map(({ path, label }) => (
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
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" />
      <Nav />
      <main className="p-4 sm:p-8 w-full">
        <Routes>
          <Route path="/" element={<ProjectList />} />
          <Route path="/templates" element={<TemplateList />} />
          <Route path="/templates/:id/edit" element={<TemplateEditor />} />
          <Route path="/projects" element={<ProjectList />} />
          <Route path="/projects/:id/batch" element={<ProjectBatch />} />
          <Route path="/projects/:id/review" element={<ProjectReview />} />
          <Route path="/projects/:projectId/students/:studentId/edit" element={<StudentEdit />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
