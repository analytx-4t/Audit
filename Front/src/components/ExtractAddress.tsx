import { useState, useRef, useCallback, useMemo } from "react";
import {
  UploadCloud,
  FileSpreadsheet,
  Trash2,
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  RefreshCw,
  MapPin,
  CheckCircle2,
  X,
  FileText
} from "lucide-react";

const Backend = import.meta.env.VITE_BACKEND || "http://localhost:5000";

export interface AddressItem {
  id: string;
  file?: File;
  preview: string;
  filename: string;
  vehicleText: string;
  fullAddress: string;
  city: string;
  state: string;
  pincode: string;
  latitude: string;
  longitude: string;
  dateTime: string;
  rawText?: string;
}

export default function ExtractAddress() {
  const [items, setItems] = useState<AddressItem[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<{ [key: string]: string }>({});
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  
  // Table Controls
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  
  // Modal Preview State
  const [previewItem, setPreviewItem] = useState<AddressItem | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Add files to selection
  const handleAddFiles = useCallback((filesList: FileList | null) => {
    if (!filesList) return;
    const valid = Array.from(filesList).filter((f) => f.type.startsWith("image/"));
    if (!valid.length) return;

    setSelectedFiles((prev) => [...prev, ...valid]);
    
    // Create preview URLs
    const newPreviews: { [key: string]: string } = {};
    valid.forEach((f) => {
      newPreviews[`${f.name}_${f.size}`] = URL.createObjectURL(f);
    });
    setPreviews((prev) => ({ ...prev, ...newPreviews }));
  }, []);

  // Process Images via Backend API
  const processImages = async () => {
    if (!selectedFiles.length) return;
    setIsProcessing(true);

    try {
      const formData = new FormData();
      selectedFiles.forEach((file) => {
        formData.append("images", file);
      });

      const response = await fetch(`${Backend}/api/extract-address`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const data = await response.json();
      if (data.success && Array.isArray(data.results)) {
        const newItems: AddressItem[] = data.results.map((res: { id?: string; filename?: string; vehicleText?: string; fullAddress?: string; city?: string; state?: string; pincode?: string; latitude?: string; longitude?: string; dateTime?: string; rawText?: string }, idx: number) => {
          const originalFile = selectedFiles[idx] || selectedFiles.find(f => f.name === res.filename);
          const previewUrl = originalFile 
            ? (previews[`${originalFile.name}_${originalFile.size}`] || URL.createObjectURL(originalFile))
            : "";

          return {
            id: res.id || `item_${Date.now()}_${idx}`,
            file: originalFile,
            preview: previewUrl,
            filename: res.filename || `Image_${idx + 1}`,
            vehicleText: res.vehicleText || "",
            fullAddress: res.fullAddress || "",
            city: res.city || "",
            state: res.state || "",
            pincode: res.pincode || "",
            latitude: res.latitude || "",
            longitude: res.longitude || "",
            dateTime: res.dateTime || "",
            rawText: res.rawText || "",
          };
        });

        setItems((prev) => [...prev, ...newItems]);
        setSelectedFiles([]);
      }
    } catch (err) {
      console.error("Address extraction failed:", err);
      alert("Failed to extract address from images. Make sure backend is running.");
    } finally {
      setIsProcessing(false);
    }
  };

  // Remove single item from table
  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
  };

  // Clear all data
  const clearAll = () => {
    items.forEach((item) => {
      if (item.preview) URL.revokeObjectURL(item.preview);
    });
    setItems([]);
    setSelectedFiles([]);
    setPreviews({});
  };

  // Inline edit handler
  const handleCellEdit = (id: string, field: keyof AddressItem, value: string) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, [field]: value } : item))
    );
  };

  // Export to Excel / ZIP package via Backend endpoint
  const downloadExcel = async () => {
    if (!items.length) return;
    setIsExporting(true);

    try {
      const formData = new FormData();
      formData.append("items", JSON.stringify(items));

      // Append failed images if any exist
      items.forEach((item) => {
        const isFailed = !item.fullAddress || item.fullAddress.trim() === "" || item.fullAddress === "NO ADDRESS DETECTED";
        if (isFailed && item.file) {
          formData.append("failedImages", item.file, item.filename);
        }
      });

      const response = await fetch(`${Backend}/api/export-address-excel`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Export failed");

      const contentType = response.headers.get("content-type") || "";
      const isZip = contentType.includes("zip");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = isZip
        ? `Extracted_Addresses_Package_${new Date().toISOString().slice(0, 10)}.zip`
        : `Extracted_Addresses_${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export failed:", err);
      alert("Failed to generate export package.");
    } finally {
      setIsExporting(false);
    }
  };

  // Filtered & Paginated items
  const filteredItems = useMemo(() => {
    if (!searchQuery.trim()) return items;
    const q = searchQuery.toLowerCase();
    return items.filter(
      (item) =>
        item.filename.toLowerCase().includes(q) ||
        item.fullAddress.toLowerCase().includes(q) ||
        item.vehicleText.toLowerCase().includes(q) ||
        item.city.toLowerCase().includes(q) ||
        item.state.toLowerCase().includes(q) ||
        item.pincode.toLowerCase().includes(q)
    );
  }, [items, searchQuery]);

  const totalPages = Math.ceil(filteredItems.length / pageSize) || 1;
  const paginatedItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredItems.slice(start, start + pageSize);
  }, [filteredItems, currentPage, pageSize]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 py-8 px-4 sm:px-6 transition-colors duration-300">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-gray-200 dark:border-gray-800 pb-5">
          <div>
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <MapPin className="w-6 h-6" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white tracking-tight">
                Extract Address from Images
              </h1>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Upload photos with geotags or location stamps — Tesseract OCR will extract full address details into an editable table with Excel export.
            </p>
          </div>

          {items.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                onClick={clearAll}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-medium
                  text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-800
                  hover:bg-gray-200 dark:hover:bg-gray-700 transition"
              >
                <RefreshCw className="w-4 h-4" />
                Clear All
              </button>

              <button
                onClick={downloadExcel}
                disabled={isExporting}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold
                  bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white shadow-sm transition hover:shadow-md"
              >
                {isExporting ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <FileSpreadsheet className="w-4 h-4" />
                )}
                Download Excel ({items.length})
              </button>
            </div>
          )}
        </div>

        {/* Dropzone & Selected Files */}
        <div className="space-y-4">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleAddFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`
              relative flex flex-col items-center justify-center gap-3
              border-2 border-dashed rounded-2xl cursor-pointer select-none
              py-10 px-6 transition-all duration-200
              ${
                dragging
                  ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                  : "border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-emerald-500 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/20"
              }
            `}
          >
            <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400">
              <UploadCloud className="w-6 h-6" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                Click or drag & drop images here
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                Supports PNG, JPG, JPEG, WEBP (Multiple files supported)
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleAddFiles(e.target.files)}
              onClick={(e) => ((e.target as HTMLInputElement).value = "")}
            />
          </div>

          {/* Pending files bar */}
          {selectedFiles.length > 0 && (
            <div className="flex items-center justify-between p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/50">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                <span className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                  {selectedFiles.length} new image{selectedFiles.length > 1 ? "s" : ""} selected
                </span>
              </div>
              <button
                onClick={processImages}
                disabled={isProcessing}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white transition shadow-sm"
              >
                {isProcessing ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    Extracting Address...
                  </>
                ) : (
                  <>
                    <MapPin className="w-4 h-4" />
                    Extract Address ({selectedFiles.length})
                  </>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Results Table Section */}
        {items.length > 0 && (
          <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
            
            {/* Table Action Bar */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row items-center justify-between gap-4">
              {/* Search */}
              <div className="relative w-full sm:w-80">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search address, filename, state..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full pl-9 pr-4 py-2 rounded-xl text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Page size dropdown */}
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 self-end sm:self-auto">
                <span>Show</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="px-2.5 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white font-medium"
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
                <span>entries per page</span>
              </div>
            </div>

            {/* Editable Data Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-gray-700 dark:text-gray-300">
                <thead className="bg-gray-50 dark:bg-gray-800/60 text-gray-500 dark:text-gray-400 uppercase font-semibold text-[10px] tracking-wider border-b border-gray-200 dark:border-gray-800">
                  <tr>
                    <th className="px-3 py-3 w-12 text-center">#</th>
                    <th className="px-3 py-3 w-20">Preview</th>
                    <th className="px-3 py-3 w-48">Image File Name</th>
                    <th className="px-3 py-3 w-48">Text Inside Image</th>
                    <th className="px-3 py-3 min-w-[280px]">Full Address (Editable)</th>
                    <th className="px-3 py-3 w-28">City</th>
                    <th className="px-3 py-3 w-28">State</th>
                    <th className="px-3 py-3 w-24">Pincode</th>
                    <th className="px-3 py-3 w-16 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                  {paginatedItems.map((item, index) => {
                    const globalIdx = (currentPage - 1) * pageSize + index + 1;
                    return (
                      <tr
                        key={item.id}
                        className="hover:bg-gray-50/80 dark:hover:bg-gray-800/40 transition-colors"
                      >
                        {/* Index */}
                        <td className="px-3 py-3 text-center font-semibold text-gray-400">
                          {globalIdx}
                        </td>

                        {/* Image Preview */}
                        <td className="px-3 py-3">
                          <button
                            onClick={() => setPreviewItem(item)}
                            className="relative group w-12 h-12 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-gray-100 dark:bg-gray-800 flex items-center justify-center"
                          >
                            {item.preview ? (
                              <img
                                src={item.preview}
                                alt={item.filename}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <FileText className="w-5 h-5 text-gray-400" />
                            )}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white">
                              <Eye className="w-4 h-4" />
                            </div>
                          </button>
                        </td>

                        {/* File Name */}
                        <td className="px-3 py-3 font-medium text-gray-900 dark:text-white truncate max-w-[180px]">
                          <span title={item.filename}>{item.filename}</span>
                        </td>

                        {/* Text Inside Image */}
                        <td className="px-3 py-3">
                          <input
                            type="text"
                            value={item.vehicleText}
                            onChange={(e) =>
                              handleCellEdit(item.id, "vehicleText", e.target.value)
                            }
                            placeholder="Text inside image..."
                            className="w-full px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-emerald-500 focus:bg-white dark:focus:bg-gray-800"
                          />
                        </td>

                        {/* Full Address */}
                        <td className="px-3 py-3">
                          <textarea
                            rows={2}
                            value={item.fullAddress}
                            onChange={(e) =>
                              handleCellEdit(item.id, "fullAddress", e.target.value)
                            }
                            placeholder="Full extracted address..."
                            className="w-full px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-emerald-500 focus:bg-white dark:focus:bg-gray-800 resize-y"
                          />
                        </td>

                        {/* City */}
                        <td className="px-3 py-3">
                          <input
                            type="text"
                            value={item.city}
                            onChange={(e) =>
                              handleCellEdit(item.id, "city", e.target.value)
                            }
                            placeholder="City"
                            className="w-full px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-emerald-500"
                          />
                        </td>

                        {/* State */}
                        <td className="px-3 py-3">
                          <input
                            type="text"
                            value={item.state}
                            onChange={(e) =>
                              handleCellEdit(item.id, "state", e.target.value)
                            }
                            placeholder="State"
                            className="w-full px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-emerald-500"
                          />
                        </td>

                        {/* Pincode */}
                        <td className="px-3 py-3">
                          <input
                            type="text"
                            value={item.pincode}
                            onChange={(e) =>
                              handleCellEdit(item.id, "pincode", e.target.value)
                            }
                            placeholder="Pincode"
                            className="w-full px-2 py-1.5 rounded-lg bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-white focus:ring-1 focus:ring-emerald-500 text-center font-mono"
                          />
                        </td>

                        {/* Action */}
                        <td className="px-3 py-3 text-center">
                          <button
                            onClick={() => removeItem(item.id)}
                            title="Delete Row"
                            className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-gray-400">
                        No address records found matching your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls Footer */}
            <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-gray-500 dark:text-gray-400">
              <div>
                Showing{" "}
                <span className="font-semibold text-gray-900 dark:text-white">
                  {filteredItems.length > 0 ? (currentPage - 1) * pageSize + 1 : 0}
                </span>{" "}
                to{" "}
                <span className="font-semibold text-gray-900 dark:text-white">
                  {Math.min(currentPage * pageSize, filteredItems.length)}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-gray-900 dark:text-white">
                  {filteredItems.length}
                </span>{" "}
                entries
              </div>

              {totalPages > 1 && (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setCurrentPage((p) => Math.max(p - 1, 1))}
                    disabled={currentPage === 1}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>

                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((pg) => (
                    <button
                      key={pg}
                      onClick={() => setCurrentPage(pg)}
                      className={`px-3 py-1 rounded-lg font-medium transition ${
                        currentPage === pg
                          ? "bg-emerald-600 text-white font-bold"
                          : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {pg}
                    </button>
                  ))}

                  <button
                    onClick={() => setCurrentPage((p) => Math.min(p + 1, totalPages))}
                    disabled={currentPage === totalPages}
                    className="p-1.5 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-40 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Image Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn">
          <div className="relative bg-white dark:bg-gray-900 rounded-2xl max-w-3xl w-full overflow-hidden shadow-2xl border border-gray-200 dark:border-gray-800">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white truncate">
                {previewItem.filename}
              </h3>
              <button
                onClick={() => setPreviewItem(null)}
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6 max-h-[80vh] overflow-y-auto">
              <div className="bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden flex items-center justify-center aspect-square">
                {previewItem.preview ? (
                  <img
                    src={previewItem.preview}
                    alt={previewItem.filename}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <p className="text-gray-400">No image preview available</p>
                )}
              </div>

              <div className="space-y-4 text-xs">
                <div>
                  <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                    Extracted Full Address
                  </span>
                  <p className="mt-1 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-950 dark:text-emerald-200 font-medium">
                    {previewItem.fullAddress || "No address detected"}
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                      City / District
                    </span>
                    <p className="mt-0.5 font-medium text-gray-800 dark:text-gray-200">
                      {previewItem.city || "-"}
                    </p>
                  </div>
                  <div>
                    <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                      State
                    </span>
                    <p className="mt-0.5 font-medium text-gray-800 dark:text-gray-200">
                      {previewItem.state || "-"}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                      Pincode
                    </span>
                    <p className="mt-0.5 font-mono font-medium text-gray-800 dark:text-gray-200">
                      {previewItem.pincode || "-"}
                    </p>
                  </div>
                  <div>
                    <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                      Timestamp / Date
                    </span>
                    <p className="mt-0.5 font-medium text-gray-800 dark:text-gray-200">
                      {previewItem.dateTime || "-"}
                    </p>
                  </div>
                </div>

                {previewItem.latitude && (
                  <div>
                    <span className="font-semibold text-gray-400 uppercase tracking-wider text-[10px]">
                      GPS Coordinates
                    </span>
                    <p className="mt-0.5 font-mono text-gray-700 dark:text-gray-300">
                      Lat: {previewItem.latitude}, Long: {previewItem.longitude}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
