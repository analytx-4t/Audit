import { useState, useRef, useCallback } from "react";
import JSZip from "jszip";
import { ImageIcon, UploadCloud, X, Download, RefreshCw } from "lucide-react";

const Backend = import.meta.env.VITE_BACKEND || "http://localhost:5000";

const VEHICLE_OPTIONS = [
  { value: "two_wheeler", label: "2 Wheeler" },
  { value: "four_wheeler", label: "4 Wheeler" },
  { value: "commercial_equipment", label: "Commercial Equipment" },
  { value: "commercial_vehicle", label: "Commercial Vehicles" },
];

interface ImageEntry {
  file: File;
  preview: string;
  newName: string;
}

function padIndex(i: number) {
  return String(i).padStart(3, "0");
}

function getExtension(filename: string) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot) : "";
}

function replaceExtension(filename: string, newExt: string) {
  const dot = filename.lastIndexOf(".");
  return (dot >= 0 ? filename.slice(0, dot) : filename) + newExt;
}

// Crops + converts to greyscale + normalizes contrast, matching what the OCR
// pipeline used to do right before upload — now done here at rename time.
async function processImageForOcr(file: File, vehicleType: string, newName: string) {
  try {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("vehicle_type", vehicleType);

    const res = await fetch(`${Backend}/api/process-image`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error(`Processing failed (${res.status})`);

    const wasProcessed = res.headers.get("X-Image-Processed") === "true";
    const blob = await res.blob();
    return {
      name: wasProcessed ? replaceExtension(newName, ".jpg") : newName,
      blob,
    };
  } catch (err) {
    console.error(`Failed to process ${file.name}, using original:`, err);
    return { name: newName, blob: file };
  }
}

export default function RenameImages() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [vehicleType, setVehicleType] = useState(VEHICLE_OPTIONS[1].value);
  const inputRef = useRef<HTMLInputElement>(null);

  const buildEntries = useCallback((files: File[]): ImageEntry[] => {
    return files.map((file, i) => ({
      file,
      preview: URL.createObjectURL(file),
      newName: `IMG_${padIndex(i + 1)}${getExtension(file.name)}`,
    }));
  }, []);

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming) return;
      const imageFiles = Array.from(incoming).filter((f) =>
        f.type.startsWith("image/")
      );
      if (!imageFiles.length) return;
      setImages((prev) => {
        const merged = [...prev.map((e) => e.file), ...imageFiles];
        // revoke old previews to avoid leaks
        prev.forEach((e) => URL.revokeObjectURL(e.preview));
        return buildEntries(merged);
      });
    },
    [buildEntries]
  );

  const removeImage = (index: number) => {
    setImages((prev) => {
      URL.revokeObjectURL(prev[index].preview);
      const next = prev.filter((_, i) => i !== index);
      prev.forEach((e) => URL.revokeObjectURL(e.preview));
      return buildEntries(next.map((e) => e.file));
    });
  };

  const clearAll = () => {
    images.forEach((e) => URL.revokeObjectURL(e.preview));
    setImages([]);
  };

  const downloadZip = async () => {
    if (!images.length) return;
    setDownloading(true);
    try {
      const zip = new JSZip();
      const processed = await Promise.all(
        images.map((entry) => processImageForOcr(entry.file, vehicleType, entry.newName))
      );
      processed.forEach(({ name, blob }) => zip.file(name, blob));

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "renamed_images.zip";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 py-10 px-4 transition-colors duration-300">
      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
            Rename Images
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Upload photos — they'll be renamed to IMG_001, IMG_002…, cropped
            and cleaned up for OCR, and packaged into a ZIP for download.
          </p>
        </div>

        {/* Vehicle type selector */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
            Vehicle type (determines how images are cropped)
          </p>
          <div className="grid grid-cols-2 gap-2">
            {VEHICLE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setVehicleType(option.value)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${vehicleType === option.value
                  ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:border-emerald-400 dark:bg-emerald-500/20 dark:text-emerald-300"
                  : "border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-white/10 dark:bg-white/5 dark:text-gray-200 dark:hover:bg-white/10"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`
            relative flex flex-col items-center justify-center gap-3
            border-2 border-dashed rounded-2xl cursor-pointer select-none
            py-14 px-6 transition-all duration-200
            ${dragging
              ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
              : "border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-emerald-400 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20"
            }
          `}
        >
          <div className={`
            flex items-center justify-center w-14 h-14 rounded-2xl
            transition-colors duration-200
            ${dragging ? "bg-emerald-100 dark:bg-emerald-900/40" : "bg-gray-100 dark:bg-gray-800"}
          `}>
            <UploadCloud className={`w-7 h-7 ${dragging ? "text-emerald-600" : "text-gray-400 dark:text-gray-500"}`} />
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              {dragging ? "Drop images here" : "Click or drag images here"}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              PNG, JPG, JPEG, WEBP, GIF — multiple files supported
            </p>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
            onClick={(e) => ((e.target as HTMLInputElement).value = "")}
          />
        </div>

        {/* Action bar */}
        {images.length > 0 && (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-semibold text-gray-900 dark:text-white">{images.length}</span>{" "}
              image{images.length !== 1 ? "s" : ""} ready
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                  text-gray-600 dark:text-gray-400
                  bg-gray-100 dark:bg-gray-800
                  hover:bg-gray-200 dark:hover:bg-gray-700
                  transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Clear all
              </button>
              <button
                onClick={downloadZip}
                disabled={downloading}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold
                  bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400
                  text-white transition-colors shadow-sm"
              >
                <Download className="w-3.5 h-3.5" />
                {downloading ? "Processing…" : "Download ZIP"}
              </button>
            </div>
          </div>
        )}

        {/* Image grid */}
        {images.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {images.map((entry, i) => (
              <div
                key={i}
                className="relative group rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800
                  bg-white dark:bg-gray-900 shadow-sm"
              >
                {/* Thumbnail */}
                <div className="aspect-square bg-gray-100 dark:bg-gray-800 overflow-hidden">
                  <img
                    src={entry.preview}
                    alt={entry.newName}
                    className="w-full h-full object-cover"
                  />
                </div>

                {/* Name info */}
                <div className="px-2.5 py-2 space-y-0.5">
                  <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                    {entry.file.name}
                  </p>
                  <div className="flex items-center gap-1">
                    <ImageIcon className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                    <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 truncate">
                      {entry.newName}
                    </p>
                  </div>
                </div>

                {/* Remove button */}
                <button
                  onClick={() => removeImage(i)}
                  className="absolute top-1.5 right-1.5 flex items-center justify-center
                    w-5 h-5 rounded-full
                    bg-black/50 hover:bg-red-500 text-white
                    opacity-0 group-hover:opacity-100 transition-all duration-150"
                >
                  <X className="w-3 h-3" />
                </button>

                {/* Index badge */}
                <div className="absolute top-1.5 left-1.5
                  bg-black/50 text-white text-[9px] font-bold
                  px-1.5 py-0.5 rounded-md">
                  {padIndex(i + 1)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {images.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-8 text-gray-400 dark:text-gray-600">
            <ImageIcon className="w-10 h-10" />
            <p className="text-sm">No images uploaded yet</p>
          </div>
        )}
      </div>
    </div>
  );
}
