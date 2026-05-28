import { useRef, useState } from "react";
import { Upload, X, CheckCircle2, Image as ImageIcon, Download, Loader2 } from "lucide-react";
import JSZip from "jszip";
import { saveAs } from "file-saver";
import { toast } from "react-toastify";

interface RenameImageCardProps {
  title: string;
  subtitle: string;
}

interface RenamedFile {
  file: File;
  newName: string;
}

export default function RenameImageCard({ title, subtitle }: RenameImageCardProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const accent = {
    iconText: "text-emerald-600 dark:text-emerald-400",
    iconBg: "bg-emerald-100 dark:bg-emerald-500/20",
    dragBorder: "border-emerald-500",
    dragBg: "bg-emerald-50 dark:bg-emerald-500/10",
    btnBg: "bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700",
    btnBgSecondary: "bg-gray-200 dark:bg-white/10 hover:bg-gray-300 dark:hover:bg-white/20",
    btnShadow: "shadow-emerald-400/40",
    badge: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-500/40",
    hoverRing: "hover:ring-emerald-200 dark:hover:ring-emerald-500/20",
    successBg: "bg-emerald-50 dark:bg-emerald-500/10",
    successBorder: "border-emerald-200 dark:border-emerald-500/30",
    checkColor: "text-emerald-500 dark:text-emerald-400",
  };

  const isValid = (file: File) => {
    return file.type.startsWith("image/");
  };

  const handleFiles = (incoming: File[]) => {
    const valid = incoming.filter(isValid);
    if (valid.length === 0 && incoming.length > 0) {
      toast.error("Please upload only image files");
      return;
    }
    const updated = [...selectedFiles, ...valid];
    setSelectedFiles(updated);
  };

  const removeFile = (index: number) => {
    const updated = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(updated);
  };

  const getRenamedFiles = (): RenamedFile[] => {
    return selectedFiles.map((file, index) => {
      const ext = file.name.split(".").pop() || "";
      const newName = `image${index + 1}.${ext}`;
      return { file, newName };
    });
  };

  const handleDownload = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Please upload at least one image");
      return;
    }

    setIsDownloading(true);
    try {
      const zip = new JSZip();
      const renamedFiles = getRenamedFiles();

      for (const { file, newName } of renamedFiles) {
        zip.file(newName, file);
      }

      const blob = await zip.generateAsync({ type: "blob" });
      saveAs(blob, "renamed-images.zip");
      toast.success(`Downloaded ${selectedFiles.length} renamed image(s)`);
    } catch (error) {
      console.error(error);
      toast.error("Failed to create ZIP file");
    } finally {
      setIsDownloading(false);
    }
  };

  const handleClear = () => {
    setSelectedFiles([]);
  };

  return (
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
            <ImageIcon className={`w-5 h-5 ${accent.iconText}`} />
          </div>
          <div>
            <h3 className="text-gray-900 dark:text-white font-semibold text-[15px] leading-tight">
              {title}
            </h3>
            <p className="text-gray-400 dark:text-white/40 text-xs mt-0.5">
              {subtitle}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedFiles.length > 0 && (
            <CheckCircle2 className={`w-5 h-5 ${accent.checkColor}`} />
          )}
          <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${accent.badge}`}>
            Images
          </span>
        </div>
      </div>

      {/* Upload Area */}
      {selectedFiles.length > 0 ? (
        <div>
          <div
            className={`rounded-xl border-2 ${accent.successBorder} ${accent.successBg} p-4 cursor-pointer hover:opacity-80 transition min-h-[140px] flex flex-col justify-center`}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${accent.iconBg}`}>
                <ImageIcon className={`w-4 h-4 ${accent.iconText}`} />
              </div>
              <div>
                <p className="text-gray-800 dark:text-white text-sm font-semibold">
                  {selectedFiles.length} Image{selectedFiles.length > 1 ? "s" : ""} Ready
                </p>
                <p className="text-gray-400 dark:text-white/40 text-xs">To be renamed and downloaded</p>
              </div>
              <CheckCircle2 className={`w-5 h-5 ml-auto ${accent.checkColor}`} />
            </div>

            {/* File Preview */}
            <div className="flex flex-wrap gap-1.5">
              {selectedFiles.slice(0, 3).map((file, i) => {
                const ext = file.name.split(".").pop();
                const newName = `image${i + 1}.${ext}`;
                return (
                  <div key={i} className="relative group">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full
                      bg-white dark:bg-white/10
                      border border-gray-200 dark:border-white/10
                      text-xs text-gray-600 dark:text-white/70">
                      <ImageIcon className="w-3 h-3" />
                      <span className="truncate max-w-[100px]">{newName}</span>
                    </span>
                    <button
                      onClick={() => removeFile(i)}
                      className="absolute -top-2 -right-2 flex items-center justify-center w-5 h-5 rounded-full
                        bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity
                        hover:bg-red-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
              {selectedFiles.length > 3 && (
                <span className="px-2 py-0.5 rounded-full bg-white dark:bg-white/10 border border-gray-200 dark:border-white/10 text-xs text-gray-500 dark:text-white/50">
                  +{selectedFiles.length - 3} more
                </span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files) {
              handleFiles(Array.from(e.dataTransfer.files));
            }
          }}
          className={`relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed
            min-h-[176px] cursor-pointer transition-all duration-200
            ${
              isDragging
                ? `${accent.dragBorder} ${accent.dragBg} scale-[1.01]`
                : "border-gray-200 dark:border-white/10 hover:border-gray-300 dark:hover:border-white/20 hover:bg-gray-50 dark:hover:bg-white/[0.03]"
            }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                handleFiles(Array.from(e.target.files));
              }
            }}
          />

          <div className="flex flex-col items-center gap-3 p-8 text-center select-none">
            <div className={`flex items-center justify-center w-12 h-12 rounded-2xl ${accent.iconBg}`}>
              <Upload className={`w-5 h-5 ${accent.iconText}`} />
            </div>
            <div>
              <p className="text-gray-700 dark:text-white/70 text-sm font-medium">
                {isDragging ? "Drop your images here" : "Click to upload or drag & drop"}
              </p>
              <p className="text-gray-400 dark:text-white/30 text-xs mt-1">
                Support all image formats (JPG, PNG, GIF, WebP, etc.)
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-4 flex gap-2">
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg
            text-xs font-medium text-white
            ${accent.btnBg} ${accent.btnShadow}
            transition-all duration-200 active:scale-95
            disabled:opacity-50 disabled:cursor-not-allowed`}
          disabled={isDownloading}
        >
          <Upload className="w-4 h-4" />
          Add More
        </button>

        <button
          onClick={handleDownload}
          disabled={selectedFiles.length === 0 || isDownloading}
          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg
            text-xs font-medium
            ${
              selectedFiles.length === 0 || isDownloading
                ? `${accent.btnBgSecondary} text-gray-500 dark:text-white/40 cursor-not-allowed`
                : `${accent.btnBg} text-white ${accent.btnShadow}`
            }
            transition-all duration-200 active:scale-95`}
        >
          {isDownloading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Download ZIP
            </>
          )}
        </button>

        {selectedFiles.length > 0 && (
          <button
            onClick={handleClear}
            className={`flex items-center justify-center px-3 py-2.5 rounded-lg
              text-xs font-medium text-gray-600 dark:text-white/60
              ${accent.btnBgSecondary}
              transition-all duration-200 active:scale-95`}
            title="Clear all files"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
