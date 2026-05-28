import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AudioLines, Lock, LayoutDashboard, ArrowRight, Eye, EyeOff } from "lucide-react";
import { toast } from "react-toastify";
import { v4 as uuidv4 } from "uuid";

const Login: React.FC = () => {
  const navigate = useNavigate();

  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [showPassword, setShowPassword] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const loginArray = JSON.parse(import.meta.env.VITE_LOGIN_USERS || "[]");

      const user = loginArray.find(
        (u: any) => u.email === email && u.password === password
      );

      if (!user) {
        toast.error("Invalid email or password");
        setLoading(false);
        return;
      }

      localStorage.setItem("token", uuidv4());
      localStorage.setItem("role", user.role);

      toast.success("Login successful!");
      navigate("/");
    } catch (err: any) {
      toast.error("Login failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-gray-100 relative overflow-hidden flex items-center justify-center">

      {/* Background blobs — matches the rest of the app */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -right-40 w-[700px] h-[700px] rounded-full bg-emerald-100/60 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-[600px] h-[600px] rounded-full bg-blue-100/50 blur-3xl" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] rounded-full bg-violet-100/30 blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-md px-4">

        {/* Logo / Brand */}
        <div className="flex flex-col items-center mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 shadow-lg shadow-emerald-200 mb-4">
            <LayoutDashboard className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Audit Tool</h1>
          <p className="text-gray-400 text-sm mt-1">Sign in to your workspace</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow duration-300 p-8">

          {/* Card header */}
          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-900">Welcome back</h2>
            <p className="text-gray-400 text-sm mt-1">Enter your credentials to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Audit ID */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Audit ID
              </label>
              <div className="relative">
                <AudioLines className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Enter your audit ID"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-gray-50 border border-gray-200
                    text-gray-900 placeholder-gray-400 text-sm
                    focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent focus:bg-white
                    transition-all duration-200"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-600 uppercase tracking-wider">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" />
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder="Enter your password"
                  className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-gray-50 border border-gray-200
                    text-gray-900 placeholder-gray-400 text-sm
                    focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent focus:bg-white
                    transition-all duration-200"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={loading}
                style={{ opacity: loading ? 0.7 : 1 }}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl
                  bg-emerald-600 hover:bg-emerald-700
                  text-white text-sm font-semibold
                  shadow-lg shadow-emerald-200
                  transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5 hover:shadow-xl"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin w-4 h-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    Signing in…
                  </>
                ) : (
                  <>
                    Get Started
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Footer note */}
        <p className="text-center text-gray-400 text-xs mt-6">
          Secure audit workspace · All data encrypted
        </p>
      </div>
    </div>
  );
};

export default Login;