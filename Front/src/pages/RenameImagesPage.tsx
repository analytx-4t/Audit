import RenameImageCard from "../components/RenameImageCard";
import { ImageIcon } from "lucide-react";

export default function RenameImagesPage() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-gray-100
      dark:from-gray-950 dark:via-gray-900 dark:to-gray-950
      relative overflow-hidden transition-colors duration-300">

      {/* Background Gradients */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[600px] h-[600px] rounded-full bg-emerald-100/50 dark:bg-emerald-900/10 blur-3xl" />
        <div className="absolute top-1/2 -right-40 w-[500px] h-[500px] rounded-full bg-teal-100/50 dark:bg-teal-900/10 blur-3xl" />
        <div className="absolute -bottom-40 left-1/3 w-[500px] h-[500px] rounded-full bg-green-100/40 dark:bg-green-900/10 blur-3xl" />
      </div>

      {/* Content */}
      <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-12">
        {/* Header */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full mb-4
            bg-emerald-100 dark:bg-emerald-500/20
            border border-emerald-300 dark:border-emerald-500/40
            text-xs text-emerald-800 dark:text-emerald-300 font-semibold">
            <ImageIcon className="w-3.5 h-3.5" />
            Rename Images
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white tracking-tight">
            Rename Images Bulk
          </h1>
          <p className="text-gray-500 dark:text-white/40 mt-2 text-base">
            Upload multiple images to automatically rename them and download as a ZIP
          </p>
        </div>

        {/* Card Container */}
        <div className="max-w-2xl mx-auto">
          <RenameImageCard
            title="Rename Images"
            subtitle="Upload multiple images to automatically rename them"
          />
        </div>
      </main>
    </div>
  );
}
