import { useState, useRef, useEffect } from "react";
import { LayoutDashboard, Sun, Moon, LogOut, User } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
import { useTheme } from "./ThemeContext";

export default function Header() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("role");
    setMenuOpen(false);
    navigate("/login");
  };

  return (
    <header className="relative z-50 flex items-center justify-between px-6 py-3.5
      bg-white/90 dark:bg-gray-950/90 backdrop-blur-sm
      border-b border-gray-200/80 dark:border-gray-800/80
      shadow-sm sticky top-0 transition-colors duration-300">

      {/* Logo */}
      <div className="flex items-center gap-3">
        <button className="flex items-center justify-center w-8 h-8 rounded-lg
          hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
          <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none"
            viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg
            bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-sm">
            <LayoutDashboard className="w-4 h-4 text-white" />
          </div>
          <span className="text-gray-900 dark:text-white font-bold text-sm tracking-tight">
            Audit Tool
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="hidden md:flex items-center gap-1">
        {[
          { label: "Rename Images", to: "/rename" },
          { label: "Image Upload", to: "/" },
          { label: "Excel Upload", to: "/combine" },
          // { label: "Reports", to: "/reports" },
        ].map(({ label, to }) => (
          <NavLink
            key={label}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
              ${isActive
                ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800/60"
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Right */}
      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          className="flex items-center justify-center w-8 h-8 rounded-lg
            bg-gray-100 dark:bg-gray-800
            hover:bg-gray-200 dark:hover:bg-gray-700
            border border-gray-200 dark:border-gray-700
            text-gray-600 dark:text-yellow-300
            transition-all duration-200"
        >
          {theme === "light"
            ? <Moon className="w-[15px] h-[15px]" />
            : <Sun className="w-[15px] h-[15px]" />
          }
        </button>

        {/* Avatar with dropdown */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center justify-center w-8 h-8 rounded-full
              bg-gradient-to-br from-orange-400 to-orange-600
              text-white text-xs font-bold shadow-sm
              hover:shadow-md hover:scale-105 transition-all duration-150"
          >
            A
          </button>

          {/* Dropdown */}
          {menuOpen && (
            <div className="absolute right-0 top-10 w-48
              bg-white dark:bg-gray-900
              border border-gray-200 dark:border-gray-700
              rounded-xl shadow-lg overflow-hidden z-50">

              {/* Account info */}
              <div className="flex items-center gap-2.5 px-4 py-3
                border-b border-gray-100 dark:border-gray-800">
                <div className="flex items-center justify-center w-7 h-7 rounded-full
                  bg-gradient-to-br from-orange-400 to-orange-600 text-white text-xs font-bold flex-shrink-0">
                  A
                </div>
                <div>
                  <p className="text-gray-900 dark:text-white text-xs font-semibold">Admin</p>
                  <p className="text-gray-400 dark:text-gray-500 text-[10px]">Administrator</p>
                </div>
              </div>

              {/* Profile option */}
              <button
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2.5 w-full px-4 py-2.5
                  text-gray-700 dark:text-gray-300 text-xs font-medium
                  hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <User className="w-3.5 h-3.5" />
                Profile
              </button>

              {/* Logout */}
              <button
                onClick={handleLogout}
                className="flex items-center gap-2.5 w-full px-4 py-2.5
                  text-red-600 dark:text-red-400 text-xs font-medium
                  hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors
                  border-t border-gray-100 dark:border-gray-800"
              >
                <LogOut className="w-3.5 h-3.5" />
                Log out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}