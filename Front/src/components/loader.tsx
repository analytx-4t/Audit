export default function Loader() {
  return (
   <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-12 w-12 border-4 border-white border-t-transparent rounded-full animate-spin" />
        <p className="text-white text-sm font-medium">
          Please wait...
        </p>
      </div>
    </div>
  );
}
