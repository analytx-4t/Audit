import { useState } from "react";
import { Monitor, FileText, Receipt, Download, Zap, ImageIcon } from "lucide-react";
import UploadCard from "./UploadCard";
import ExcelUpload from "./ExcelUpload";
import Loader from "./loader";

const Backend = import.meta.env.VITE_BACKEND;

function ImageUpload() {
  const [loading, setLoading] = useState(false);
  const [excelBlob, setExcelBlob] = useState<Blob | null>(null);
  const [filesMap, setFilesMap] = useState<Record<number, File[]>>({});

  const imageCards = [
    { id: 1, title: "Car Image",         subtitle: "Vehicle photos & docs",    icon: Monitor,  accentColor: "blue"   as const },
    { id: 2, title: "Sales / Insurance", subtitle: "Policy & sales documents", icon: FileText, accentColor: "violet" as const },
    { id: 3, title: "Purchase Invoice",  subtitle: "Transaction receipts",     icon: Receipt,  accentColor: "rose"   as const },
  ];

  const handleCardFiles = (cardId: number, cardFiles: File[]) => {
    setFilesMap((prev) => ({ ...prev, [cardId]: cardFiles }));
  };

  const files = Object.values(filesMap).flat();
  const cardsWithFiles = Object.keys(filesMap).filter((k) => filesMap[Number(k)]?.length > 0).length;

  const handleExtract = async () => {
    if (files.length === 0) return;
    setLoading(true);
    setExcelBlob(null);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      const res = await fetch(`${Backend}/api/extract`, { method: "POST", body: formData });
      if (!res.ok) throw new Error("Failed");
      setExcelBlob(await res.blob());
    } catch {
      alert("Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = () => {
    if (!excelBlob) return;
    const url = window.URL.createObjectURL(excelBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "result.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  };

  if (loading) return <Loader />;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-gray-100
      dark:from-gray-950 dark:via-gray-900 dark:to-gray-950
      relative overflow-hidden transition-colors duration-300">

      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-blue-100/50 dark:bg-blue-900/10 blur-3xl" />
        <div className="absolute top-1/2 -right-40 w-[500px] h-[500px] rounded-full bg-violet-100/50 dark:bg-violet-900/10 blur-3xl" />
        <div className="absolute -bottom-40 left-1/3 w-[500px] h-[500px] rounded-full bg-rose-100/40 dark:bg-rose-900/10 blur-3xl" />
      </div>

      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-12">

        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-4
            bg-blue-100 dark:bg-blue-500/20
            border border-blue-300 dark:border-blue-500/40
            text-xs text-blue-800 dark:text-blue-300 font-semibold">
            <ImageIcon className="w-3.5 h-3.5" />
            Image Upload
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white tracking-tight">
            Upload Required Files
          </h1>
          <p className="text-gray-500 dark:text-white/40 mt-2 text-base">
            Upload images, PDFs, or Excel files for each category below
          </p>

          {files.length > 0 && (
            <div className="mt-6 max-w-xs mx-auto">
              <div className="flex justify-between text-xs mb-2 text-gray-400 dark:text-white/30">
                <span>Files ready</span>
                <span className="font-semibold text-gray-700 dark:text-white/60">
                  {files.length} file{files.length > 1 ? "s" : ""}
                </span>
              </div>
              <div className="h-2 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 via-violet-500 to-rose-500 rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${Math.min((cardsWithFiles / 3) * 100, 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          {imageCards.map((card) => (
            <UploadCard
              key={card.id}
              title={card.title}
              subtitle={card.subtitle}
              icon={card.icon}
              accentColor={card.accentColor}
              types={["image", "pdf", "excel", "any"]}
              onFilesChange={(cardFiles) => handleCardFiles(card.id, cardFiles)}
            />
          ))}
        </div>

        {(files.length > 0 || excelBlob) && (
          <div className="flex justify-center gap-3 mt-2">
            {files.length > 0 && (
              <button
                onClick={handleExtract}
                disabled={loading}
                style={{ opacity: loading ? 0.7 : 1 }}
                className="flex items-center gap-2 px-6 py-3 rounded-xl
                  bg-blue-500 hover:bg-blue-400
                  text-white text-sm font-semibold
                  shadow-lg shadow-blue-500/40
                  transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5"
              >
                <Zap className="w-4 h-4" />
                {loading ? "Processing…" : "Extract Data"}
              </button>
            )}

            {excelBlob && !loading && (
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-6 py-3 rounded-xl
                  bg-emerald-500 hover:bg-emerald-400
                  text-white text-sm font-semibold
                  shadow-lg shadow-emerald-500/40
                  transition-all duration-150 active:scale-[0.98] hover:-translate-y-0.5"
              >
                <Download className="w-4 h-4" />
                Download Zip
              </button>
            )}
          </div>
        )}

        <p className="mt-8 text-center text-gray-400 dark:text-white/20 text-xs">
          Supported: JPG, PNG, PDF, XLS, XLSX and more · Multiple files per category
        </p>
      </main>

      {excelBlob && <ExcelUpload />}
    </div>
  );
}

export default ImageUpload;