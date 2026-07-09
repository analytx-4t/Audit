import { useState } from "react";
import { Monitor, FileText, Receipt, Download, Zap, ImageIcon } from "lucide-react";
import UploadCard from "./UploadCard";
import ExcelUpload from "./ExcelUpload";
import Loader from "./loader";

const Backend = import.meta.env.VITE_BACKEND || "http://localhost:5000";

function ImageUpload() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const [excelBlob, setExcelBlob] = useState<Blob | null>(null);
  const [filesMap, setFilesMap] = useState<Record<number, File[]>>({});
  const [selectedVehicleType, setSelectedVehicleType] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");

  const vehicleOptions = [
    { value: "two_wheeler", label: "2 Wheeler" },
    { value: "four_wheeler", label: "4 Wheeler" },
    { value: "commercial_equipment", label: "Commercial Equipment" },
    { value: "commercial_vehicle", label: "Commercial Vehicles" },
  ];

  const imageCards = [
    { id: 1, title: "Image Upload", subtitle: "Select the vehicle type and upload the sticker or plate image", icon: Monitor, accentColor: "blue" as const },
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
    if (!selectedVehicleType) {
      alert("Please select the vehicle type before extracting data.");
      return;
    }
    setLoading(true);
    setExcelBlob(null);
    setProgress(null);
    try {
      // Step 1: Upload files, receive a job ID immediately
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      formData.append("vehicle_type", selectedVehicleType);
      formData.append("address", address);
      formData.append("city", city);
      formData.append("state", state);
      formData.append("pincode", pincode);
      const uploadRes = await fetch(`${Backend}/api/extract`, { method: "POST", body: formData });
      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      const { jobId, total } = await uploadRes.json();
      setProgress({ processed: 0, total });

      // Step 2: Subscribe to SSE progress stream
      await new Promise<void>((resolve, reject) => {
        const es = new EventSource(`${Backend}/api/progress/${jobId}`);
        es.onmessage = (e) => {
          const data = JSON.parse(e.data);
          if (data.status === "error") { es.close(); reject(new Error(data.error || "Processing failed")); return; }
          setProgress({ processed: data.processed, total: data.total });
          if (data.status === "done") { es.close(); resolve(); }
        };
        es.onerror = () => { es.close(); reject(new Error("Connection lost during processing")); };
      });

      // Step 3: Fetch the finished zip
      const resultRes = await fetch(`${Backend}/api/result/${jobId}`);
      if (!resultRes.ok) throw new Error("Failed to download result");
      setExcelBlob(await resultRes.blob());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      alert(msg);
    } finally {
      setLoading(false);
      setProgress(null);
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

  if (loading && progress) {
    const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
    return (
      <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center">
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-8 w-full max-w-sm mx-4 flex flex-col items-center gap-5">
          <div className="h-12 w-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <div className="text-center">
            <p className="text-gray-900 dark:text-white font-semibold text-base">Processing Images</p>
            <p className="text-gray-500 dark:text-gray-400 text-sm mt-1">
              {progress.processed} / {progress.total} images processed
            </p>
          </div>
          <div className="w-full">
            <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mb-1.5">
              <span>Progress</span>
              <span className="font-semibold text-gray-700 dark:text-white/80">{pct}%</span>
            </div>
            <div className="h-2.5 bg-gray-200 dark:bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-violet-500 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center">Please don't close this tab</p>
        </div>
      </div>
    );
  }

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
              types={card.id === 1 ? ["image"] : ["image", "pdf", "excel", "any"]}
              onFilesChange={(cardFiles) => handleCardFiles(card.id, cardFiles)}
              showVehicleSelector={card.id === 1}
              vehicleOptions={vehicleOptions}
              selectedVehicleType={selectedVehicleType}
              onVehicleTypeChange={setSelectedVehicleType}
            />
          ))}
        </div>

        <div className="mb-8 rounded-2xl border border-gray-200/70 bg-white/80 p-5 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/[0.04]">
          <h2 className="text-sm font-semibold text-gray-800 dark:text-white/80">Address Details</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-white/40">These details will be added to the extracted output.</p>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-sm text-gray-600 dark:text-gray-300">
              <span className="mb-1 block">Address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-blue-500 dark:border-white/10 dark:bg-gray-900" placeholder="Enter address" />
            </label>
            <label className="text-sm text-gray-600 dark:text-gray-300">
              <span className="mb-1 block">City</span>
              <input value={city} onChange={(e) => setCity(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-blue-500 dark:border-white/10 dark:bg-gray-900" placeholder="Enter city" />
            </label>
            <label className="text-sm text-gray-600 dark:text-gray-300">
              <span className="mb-1 block">State</span>
              <input value={state} onChange={(e) => setState(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-blue-500 dark:border-white/10 dark:bg-gray-900" placeholder="Enter state" />
            </label>
            <label className="text-sm text-gray-600 dark:text-gray-300">
              <span className="mb-1 block">Pincode</span>
              <input value={pincode} onChange={(e) => setPincode(e.target.value)} className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none ring-0 focus:border-blue-500 dark:border-white/10 dark:bg-gray-900" placeholder="Enter pincode" />
            </label>
          </div>
        </div>

        {(files.length > 0 || excelBlob) && (
          <div className="flex justify-center gap-3 mt-2">
            {files.length > 0 && (
              <button
                onClick={handleExtract}
                disabled={loading || !selectedVehicleType || files.length === 0}
                style={{ opacity: loading || !selectedVehicleType || files.length === 0 ? 0.7 : 1 }}
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