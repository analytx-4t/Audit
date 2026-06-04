import { useState, useRef, useCallback } from "react";
import { Upload, FileSpreadsheet, CheckCircle2, X, Loader2, CloudUpload, GitCompare } from "lucide-react";

const Backend = import.meta.env.VITE_BACKEND;

interface FileState {
  file: File | null;
  status: "idle" | "uploading" | "success";
}

interface UploadCardProps {
  title: string;
  subtitle: string;
  accentColor: "emerald" | "amber";
  fileState: FileState;
  onFileSelect: (file: File) => void;
  onUpload: () => void;
  onClear: () => void;
}

function UploadCard({ title, subtitle, accentColor, fileState, onFileSelect, onUpload, onClear }: UploadCardProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const accent = {
    emerald: {
      iconText: "text-emerald-600 dark:text-emerald-400",
      iconBg: "bg-emerald-100 dark:bg-emerald-500/20",
      dragBorder: "border-emerald-500",
      dragBg: "bg-emerald-50 dark:bg-emerald-500/10",
      btnBg: "bg-emerald-500 hover:bg-emerald-400",
      btnShadow: "shadow-emerald-400/40",
      badge: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/40",
      hoverRing: "hover:ring-emerald-200 dark:hover:ring-emerald-500/20",
      successBg: "bg-emerald-50 dark:bg-emerald-500/10",
      successBorder: "border-emerald-300 dark:border-emerald-500/30",
    },
    amber: {
      iconText: "text-orange-600 dark:text-orange-400",
      iconBg: "bg-orange-100 dark:bg-orange-500/20",
      dragBorder: "border-orange-500",
      dragBg: "bg-orange-50 dark:bg-orange-500/10",
      btnBg: "bg-orange-500 hover:bg-orange-400",
      btnShadow: "shadow-orange-400/40",
      badge: "bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 border border-orange-300 dark:border-orange-500/40",
      hoverRing: "hover:ring-orange-200 dark:hover:ring-orange-500/20",
      successBg: "bg-orange-50 dark:bg-orange-500/10",
      successBorder: "border-orange-300 dark:border-orange-500/30",
    },
  }[accentColor];

  const isDisabled = !fileState.file || fileState.status === "uploading" || fileState.status === "success";

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith(".xls") || file.name.endsWith(".xlsx") || file.name.endsWith(".csv"))) onFileSelect(file);
  }, [onFileSelect]);

  return (
    <div className={`relative flex flex-col rounded-2xl
      border border-gray-200 dark:border-white/[0.07]
      bg-white dark:bg-white/[0.04]
      p-6 shadow-sm hover:shadow-md
      ring-4 ring-transparent ${accent.hoverRing}
      transition-all duration-300`}>

      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${accent.iconBg}`}>
            <FileSpreadsheet className={`w-5 h-5 ${accent.iconText}`} />
          </div>
          <div>
            <h3 className="text-gray-900 dark:text-white font-semibold text-[15px] leading-tight">{title}</h3>
            <p className="text-gray-400 dark:text-white/40 text-xs mt-0.5">{subtitle}</p>
          </div>
        </div>
        <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${accent.badge}`}>.xls / .xlsx / .csv</span>
      </div>

      <div
        onClick={() => fileState.status === "idle" && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed
          min-h-[176px] cursor-pointer transition-all duration-200
          ${isDragging
            ? `${accent.dragBorder} ${accent.dragBg} scale-[1.01]`
            : fileState.status === "success"
              ? `${accent.successBorder} ${accent.successBg}`
              : "border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20 hover:bg-gray-50 dark:hover:bg-white/[0.03]"
          }`}
      >
        <input ref={inputRef} type="file" accept=".xls,.xlsx,.csv" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFileSelect(f); }} />

        {!fileState.file && fileState.status === "idle" && (
          <div className="flex flex-col items-center gap-3 p-8 text-center select-none">
            <div className={`flex items-center justify-center w-12 h-12 rounded-2xl ${accent.iconBg}`}>
              <CloudUpload className={`w-5 h-5 ${accent.iconText}`} />
            </div>
            <div>
              <p className="text-gray-700 dark:text-white/70 text-sm font-medium">
                {isDragging ? "Drop your file here" : "Click to upload or drag & drop"}
              </p>
              <p className="text-gray-400 dark:text-white/30 text-xs mt-1">Supports XLS, XLSX and CSV formats</p>
            </div>
          </div>
        )}

        {fileState.file && fileState.status === "idle" && (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <div className={`flex items-center justify-center w-12 h-12 rounded-2xl ${accent.iconBg}`}>
              <FileSpreadsheet className={`w-6 h-6 ${accent.iconText}`} />
            </div>
            <p className="text-gray-800 dark:text-white/90 text-sm font-semibold truncate max-w-[200px]">{fileState.file.name}</p>
            <p className="text-gray-400 dark:text-white/30 text-xs">{(fileState.file.size / 1024).toFixed(1)} KB · Ready to upload</p>
          </div>
        )}

        {fileState.status === "uploading" && (
          <div className="flex flex-col items-center gap-3 p-8">
            <Loader2 className={`w-7 h-7 ${accent.iconText} animate-spin`} />
            <p className="text-gray-500 dark:text-white/40 text-sm">Uploading file…</p>
          </div>
        )}

        {fileState.status === "success" && (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-500/20">
              <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <p className="text-emerald-700 dark:text-emerald-400 text-sm font-semibold">Uploaded successfully</p>
            <p className="text-gray-400 dark:text-white/30 text-xs truncate max-w-[200px]">{fileState.file?.name}</p>
          </div>
        )}

        {fileState.file && fileState.status !== "uploading" && (
          <button onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="absolute top-3 right-3 flex items-center justify-center w-6 h-6 rounded-full
              bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
            <X className="w-3 h-3 text-gray-500 dark:text-white/60" />
          </button>
        )}
      </div>

      <button
        onClick={onUpload}
        disabled={isDisabled}
        style={{ opacity: isDisabled ? 0.5 : 1, cursor: isDisabled ? "not-allowed" : "pointer" }}
        className={`mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-xl
          text-sm font-semibold text-white
          ${accent.btnBg} shadow-lg ${accent.btnShadow}
          transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5 hover:shadow-xl`}
      >
        {fileState.status === "uploading" ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</>
        ) : fileState.status === "success" ? (
          <><CheckCircle2 className="w-4 h-4" /> Uploaded</>
        ) : (
          <><Upload className="w-4 h-4" /> Upload File</>
        )}
      </button>
    </div>
  );
}

export default function ExcelUploadPage() {
  const [primaryFile, setPrimaryFile] = useState<FileState>({ file: null, status: "idle" });
  const [masterFile, setMasterFile] = useState<FileState>({ file: null, status: "idle" });
  const [comparing, setComparing] = useState(false);

  const sel = (set: React.Dispatch<React.SetStateAction<FileState>>) => (f: File) =>
    set({ file: f, status: "idle" });
  const clr = (set: React.Dispatch<React.SetStateAction<FileState>>) => () =>
    set({ file: null, status: "idle" });
  const up = (set: React.Dispatch<React.SetStateAction<FileState>>) => () => {
    set((p) => ({ ...p, status: "uploading" }));
    setTimeout(() => set((p) => ({ ...p, status: "success" })), 2000);
  };

  const bothSelected = !!primaryFile.file && !!masterFile.file;
  const bothDone = primaryFile.status === "success" && masterFile.status === "success";

  const handleCompareAndDownload = async () => {
    if (!primaryFile.file || !masterFile.file) return;
    setComparing(true);
    try {
      const formData = new FormData();
      formData.append("customFile", primaryFile.file);
      formData.append("masterFile", masterFile.file);
      const res = await fetch(`${Backend}/api/upload`, { method: "POST", body: formData });
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Compared_Result.xlsx";
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Compare failed:", err);
    } finally {
      setComparing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-gray-100
      dark:from-gray-950 dark:via-gray-900 dark:to-gray-950
      relative overflow-hidden transition-colors duration-300">

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -right-40 w-[700px] h-[700px] rounded-full bg-emerald-100/50 dark:bg-emerald-900/10 blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-[600px] h-[600px] rounded-full bg-amber-100/40 dark:bg-amber-900/10 blur-3xl" />
      </div>

      <main className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-4
            bg-emerald-100 dark:bg-emerald-500/20
            border border-emerald-300 dark:border-emerald-500/40
            text-xs text-emerald-700 dark:text-emerald-300 font-semibold">
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel Upload
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white tracking-tight">
            Upload Your Data Files
          </h1>
          <p className="text-gray-500 dark:text-white/40 mt-2 text-base">
            Upload Excel files containing sales and insurance data to get started
          </p>
        </div>

        {bothDone && (
          <div className="mb-8 flex items-center gap-3 px-5 py-4 rounded-xl
            bg-emerald-50 dark:bg-emerald-500/10
            border border-emerald-200 dark:border-emerald-500/30">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <div>
              <p className="text-emerald-900 dark:text-emerald-300 text-sm font-semibold">Both files uploaded successfully</p>
              <p className="text-emerald-600 dark:text-emerald-400/60 text-xs mt-0.5">Click Compare & Download to process your data</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <UploadCard title="Upload Your Excel File" subtitle="Primary sales data source" accentColor="emerald"
            fileState={primaryFile} onFileSelect={sel(setPrimaryFile)}
            onUpload={up(setPrimaryFile)} onClear={clr(setPrimaryFile)} />
          <UploadCard title="Upload Excel Master Sheet" subtitle="Reference / master data" accentColor="amber"
            fileState={masterFile} onFileSelect={sel(setMasterFile)}
            onUpload={up(setMasterFile)} onClear={clr(setMasterFile)} />
        </div>

        {bothSelected && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={handleCompareAndDownload}
              disabled={comparing}
              style={{ opacity: comparing ? 0.7 : 1 }}
              className="flex items-center gap-2 px-8 py-3 rounded-xl
                bg-blue-500 hover:bg-blue-400
                text-white text-sm font-semibold
                shadow-lg shadow-blue-400/40
                transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5 hover:shadow-xl"
            >
              {comparing
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing…</>
                : <><GitCompare className="w-4 h-4" /> Compare & Download</>
              }
            </button>
          </div>
        )}

        <p className="mt-6 text-center text-gray-400 dark:text-white/20 text-xs">
          Supported formats: .xls, .xlsx, .csv · Max file size: 50MB per file
        </p>
      </main>
    </div>
  );
}