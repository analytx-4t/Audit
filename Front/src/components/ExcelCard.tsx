import React, { useRef, useState } from "react";
import { Upload, FileSpreadsheet } from "lucide-react";

interface ExcelCardProps {
  title: string;
  iconColor: string;
  buttonColor: string;
  borderColor: string;
  onFileSelect: (file: File) => void;
}

const ExcelCard: React.FC<ExcelCardProps> = ({
  title,
  iconColor,
  buttonColor,
  borderColor,
  onFileSelect
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);


  const handleChooseClick = () => {
    fileInputRef.current?.click();
  };

const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
  const selectedFile = e.target.files?.[0];
  if (selectedFile) {
    setFile(selectedFile);
    onFileSelect(selectedFile); // 👈 important
  }
};


  // const handleUpload = async () => {
  //   if (!file) {
  //     alert("Please select a file first");
  //     return;
  //   }

  //   const formData = new FormData();
  //   formData.append("file", file);

  //   try {
  //     const res = await fetch("http://localhost:5000/api/upload", {
  //       method: "POST",
  //       body: formData,
  //     });

  //     const data = await res.json();
  //     console.log("Upload response:", data);
  //     alert("File uploaded successfully");
  //   } catch (error) {
  //     console.error(error);
  //     alert("Upload failed");
  //   }
  // };

  return (
    <div className="bg-white rounded-xl shadow-md p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <div className={`p-2 rounded-lg ${borderColor}`}>
          <FileSpreadsheet className={`w-5 h-5 ${iconColor}`} />
        </div>
        <h3 className="font-semibold text-gray-800">{title}</h3>
      </div>

      {/* Hidden Input */}
      <input
        type="file"
        accept=".xls,.xlsx"
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Upload Box */}
      <div
        onClick={handleChooseClick}
        className="border-2 border-dashed border-gray-300 rounded-lg h-44 flex flex-col items-center justify-center text-center cursor-pointer hover:bg-gray-50 transition"
      >
        <div className={`border-2 ${iconColor} rounded-md p-3 mb-3`}>
          <span className={`font-bold ${iconColor}`}>X</span>
        </div>

        {file ? (
          <p className="text-sm font-medium text-green-600">
            {file.name}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-gray-700">
              Click to upload Excel file
            </p>
            <p className="text-xs text-gray-400 mt-1">
              Supported formats: .xls, .xlsx
            </p>
          </>
        )}
      </div>

      {/* Button */}
      <button
       
        className={`mt-5 w-full py-2.5 rounded-lg text-white font-medium flex items-center justify-center gap-2 ${buttonColor} hover:opacity-90 transition`}
      >
        <Upload size={16} />
        Upload File
      </button>
    </div>
  );
};

export default ExcelCard;