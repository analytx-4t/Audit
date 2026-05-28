import { useRef, useState, useEffect } from "react";
import { Upload, X, CheckCircle2, FileSpreadsheet, FileText, Image as ImageIcon, File } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface UploadCardProps {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accentColor: "blue" | "violet" | "rose" | "emerald" | "amber";
  types: ("image" | "excel" | "pdf" | "any")[];
  onFilesChange?: (files: File[]) => void;
}

function UploadCard({ title, subtitle, icon: Icon, accentColor, types, onFilesChange }: UploadCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (selectedFiles.length === 0) setShowPreview(false);
  }, [selectedFiles]);

  const accent = {
    blue: {
      iconText: "text-blue-600 dark:text-blue-400",
      iconBg: "bg-blue-100 dark:bg-blue-500/20",
      dragBorder: "border-blue-500",
      dragBg: "bg-blue-50 dark:bg-blue-500/10",
      btnBg: "bg-blue-500 hover:bg-blue-400",
      btnShadow: "shadow-blue-400/40",
      badge: "bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-500/40",
      hoverRing: "hover:ring-blue-200 dark:hover:ring-blue-500/20",
      successBg: "bg-blue-50 dark:bg-blue-500/10",
      successBorder: "border-blue-200 dark:border-blue-500/30",
      checkColor: "text-blue-500 dark:text-blue-400",
    },
    violet: {
      iconText: "text-violet-600 dark:text-violet-400",
      iconBg: "bg-violet-100 dark:bg-violet-500/20",
      dragBorder: "border-violet-500",
      dragBg: "bg-violet-50 dark:bg-violet-500/10",
      btnBg: "bg-violet-500 hover:bg-violet-400",
      btnShadow: "shadow-violet-400/40",
      badge: "bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300 border border-violet-300 dark:border-violet-500/40",
      hoverRing: "hover:ring-violet-200 dark:hover:ring-violet-500/20",
      successBg: "bg-violet-50 dark:bg-violet-500/10",
      successBorder: "border-violet-200 dark:border-violet-500/30",
      checkColor: "text-violet-500 dark:text-violet-400",
    },
    rose: {
      iconText: "text-rose-600 dark:text-rose-400",
      iconBg: "bg-rose-100 dark:bg-rose-500/20",
      dragBorder: "border-rose-500",
      dragBg: "bg-rose-50 dark:bg-rose-500/10",
      btnBg: "bg-rose-500 hover:bg-rose-400",
      btnShadow: "shadow-rose-400/40",
      badge: "bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-500/40",
      hoverRing: "hover:ring-rose-200 dark:hover:ring-rose-500/20",
      successBg: "bg-rose-50 dark:bg-rose-500/10",
      successBorder: "border-rose-200 dark:border-rose-500/30",
      checkColor: "text-rose-500 dark:text-rose-400",
    },
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
      successBorder: "border-emerald-200 dark:border-emerald-500/30",
      checkColor: "text-emerald-500 dark:text-emerald-400",
    },
    amber: {
      iconText: "text-amber-600 dark:text-amber-400",
      iconBg: "bg-amber-100 dark:bg-amber-500/20",
      dragBorder: "border-amber-500",
      dragBg: "bg-amber-50 dark:bg-amber-500/10",
      btnBg: "bg-amber-500 hover:bg-amber-400",
      btnShadow: "shadow-amber-400/40",
      badge: "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-500/40",
      hoverRing: "hover:ring-amber-200 dark:hover:ring-amber-500/20",
      successBg: "bg-amber-50 dark:bg-amber-500/10",
      successBorder: "border-amber-200 dark:border-amber-500/30",
      checkColor: "text-amber-500 dark:text-amber-400",
    },
  }[accentColor];

  const isValid = (file: File) => {
    if (types.includes("any")) return true;
    if (types.includes("image") && file.type.startsWith("image/")) return true;
    if (types.includes("excel") && file.name.match(/\.(xls|xlsx)$/i)) return true;
    if (types.includes("pdf") && file.type === "application/pdf") return true;
    return false;
  };

  const handleFiles = (incoming: File[]) => {
    const valid = incoming.filter(isValid);
    const updated = [...selectedFiles, ...valid];
    setSelectedFiles(updated);
    onFilesChange?.(updated);
  };

  const removeFile = (index: number) => {
    const updated = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(updated);
    onFilesChange?.(updated);
  };

  const getFileIcon = (file: File) => {
    if (file.type.startsWith("image/")) return <ImageIcon className="w-4 h-4" />;
    if (file.type === "application/pdf") return <FileText className="w-4 h-4" />;
    if (file.name.match(/\.(xls|xlsx)$/i)) return <FileSpreadsheet className="w-4 h-4" />;
    return <File className="w-4 h-4" />;
  };

  const getFileLabel = () => {
    const hasImage = selectedFiles.some((f) => f.type.startsWith("image/"));
    const hasPdf = selectedFiles.some((f) => f.type === "application/pdf");
    const hasExcel = selectedFiles.some((f) => f.name.match(/\.(xls|xlsx)$/i));
    const parts = [];
    if (hasImage) parts.push("Images");
    if (hasPdf) parts.push("PDFs");
    if (hasExcel) parts.push("Excel Files");
    return parts.length === 1 ? parts[0] : parts.length ? "Files" : "Files";
  };

  return (
    <>
      <div className={`relative flex flex-col rounded-2xl
        border border-gray-200 dark:border-white/[0.07]
        bg-white dark:bg-white/[0.04]
        p-6 shadow-sm hover:shadow-md dark:hover:shadow-lg
        ring-4 ring-transparent ${accent.hoverRing}
        transition-all duration-300`}>

        {/* Header */}
        <div className="flex items-start justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${accent.iconBg}`}>
              <Icon className={`w-5 h-5 ${accent.iconText}`} />
            </div>
            <div>
              <h3 className="text-gray-900 dark:text-white font-semibold text-[15px] leading-tight">{title}</h3>
              <p className="text-gray-400 dark:text-white/40 text-xs mt-0.5">{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selectedFiles.length > 0 && <CheckCircle2 className={`w-5 h-5 ${accent.checkColor}`} />}
            <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${accent.badge}`}>All types</span>
          </div>
        </div>

        {/* Body */}
        {selectedFiles.length > 0 ? (
          <div
            onClick={() => setShowPreview(true)}
            className={`rounded-xl border-2 ${accent.successBorder} ${accent.successBg} p-4 cursor-pointer hover:opacity-80 transition min-h-[140px] flex flex-col justify-center`}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${accent.iconBg}`}>
                <Icon className={`w-4 h-4 ${accent.iconText}`} />
              </div>
              <div>
                <p className="text-gray-800 dark:text-white text-sm font-semibold">
                  {selectedFiles.length} {getFileLabel()} Selected
                </p>
                <p className="text-gray-400 dark:text-white/40 text-xs">Click to view all files</p>
              </div>
              <CheckCircle2 className={`w-5 h-5 ml-auto ${accent.checkColor}`} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selectedFiles.slice(0, 3).map((file, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full
                  bg-white dark:bg-white/10
                  border border-gray-200 dark:border-white/10
                  text-xs text-gray-600 dark:text-white/70 max-w-[130px]">
                  {getFileIcon(file)}
                  <span className="truncate">{file.name}</span>
                </span>
              ))}
              {selectedFiles.length > 3 && (
                <span className="px-2 py-0.5 rounded-full bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 text-xs text-gray-500 dark:text-white/50">
                  +{selectedFiles.length - 3} more
                </span>
              )}
            </div>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              if (e.dataTransfer.files) handleFiles(Array.from(e.dataTransfer.files));
            }}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed min-h-[140px] cursor-pointer transition-all duration-200
              ${isDragging
                ? `${accent.dragBorder} ${accent.dragBg} scale-[1.01]`
                : "border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20 hover:bg-gray-50 dark:hover:bg-white/[0.03]"}`}
          >
            <Upload className="w-7 h-7 text-gray-300 dark:text-white/20 mb-2" />
            <p className="text-gray-600 dark:text-white/60 text-sm font-medium">
              {isDragging ? "Drop files here" : "Click to upload"}
            </p>
            <p className="text-gray-400 dark:text-white/30 text-xs mt-1">Images, PDF, Excel · Multiple allowed</p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="*/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(Array.from(e.target.files));
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />

        {/* Vivid button - works in both light and dark */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-xl
            text-sm font-semibold text-white
            ${accent.btnBg} shadow-lg ${accent.btnShadow}
            transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5 hover:shadow-xl`}
        >
          <Upload className="w-4 h-4" />
          {selectedFiles.length > 0 ? "Add More Files" : "Local Upload"}
        </button>
      </div>

      {/* Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-white/10 rounded-2xl w-full max-w-3xl max-h-[80vh] overflow-auto shadow-2xl">
            <div className="flex justify-between items-center px-6 py-4
              border-b border-gray-100 dark:border-white/10
              sticky top-0 bg-white dark:bg-gray-900 rounded-t-2xl z-10">
              <div>
                <h3 className="font-bold text-gray-900 dark:text-white text-base">Uploaded Files</h3>
                <p className="text-gray-400 dark:text-white/40 text-xs mt-0.5">
                  {selectedFiles.length} file{selectedFiles.length > 1 ? "s" : ""} · hover to remove
                </p>
              </div>
              <button onClick={() => setShowPreview(false)}
                className="flex items-center justify-center w-8 h-8 rounded-full
                  bg-gray-100 dark:bg-white/10 hover:bg-gray-200 dark:hover:bg-white/20 transition-colors">
                <X className="w-4 h-4 text-gray-600 dark:text-white/70" />
              </button>
            </div>
            <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
              {selectedFiles.map((file, index) => (
                <div key={index} className="relative group rounded-xl overflow-hidden
                  border border-gray-200 dark:border-white/10
                  bg-gray-50 dark:bg-white/5">
                  {file.type.startsWith("image/") ? (
                    <img src={URL.createObjectURL(file)} alt="preview" className="w-full h-32 object-cover" />
                  ) : file.type === "application/pdf" ? (
                    <iframe src={URL.createObjectURL(file)} className="w-full h-32" title="pdf-preview" />
                  ) : file.name.match(/\.(xls|xlsx)$/i) ? (
                    <div className="w-full h-32 flex flex-col items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                      <FileSpreadsheet className="w-8 h-8 text-emerald-600 dark:text-emerald-400 mb-1" />
                      <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium">Excel File</span>
                    </div>
                  ) : (
                    <div className="w-full h-32 flex flex-col items-center justify-center bg-gray-100 dark:bg-white/5">
                      <File className="w-8 h-8 text-gray-400 dark:text-white/30 mb-1" />
                      <span className="text-xs text-gray-500 dark:text-white/40">File</span>
                    </div>
                  )}
                  <div className="px-2 py-1.5 bg-white dark:bg-white/5 border-t border-gray-100 dark:border-white/10">
                    <p className="text-xs text-gray-600 dark:text-white/70 truncate">{file.name}</p>
                    <p className="text-[10px] text-gray-400 dark:text-white/30">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                  <button
                    onClick={() => removeFile(index)}
                    className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 rounded-full
                      bg-white/90 dark:bg-black/60 shadow border border-gray-200 dark:border-white/20
                      opacity-0 group-hover:opacity-100 transition-opacity">
                    <X className="w-3 h-3 text-red-500" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default UploadCard;