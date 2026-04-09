"use client";
import { useCallback } from "react";

interface Props {
  onUpload: (file: File) => void;
  isLoading: boolean;
}

export default function FileUpload({ onUpload, isLoading }: Props) {
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file?.name.endsWith(".csv")) onUpload(file);
    },
    [onUpload],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onUpload(file);
    },
    [onUpload],
  );

  return (
    <div
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="border-2 border-dashed border-gray-300 rounded-xl p-12
                 text-center hover:border-gray-400 transition-colors"
    >
      {isLoading ? (
        <p className="text-gray-500 text-sm">Parsing CSV...</p>
      ) : (
        <>
          <p className="text-gray-500 text-sm mb-2">
            Drop a CSV file here, or
          </p>
          <label className="cursor-pointer text-sm text-black underline">
            browse
            <input
              type="file"
              accept=".csv"
              onChange={handleChange}
              className="hidden"
            />
          </label>
        </>
      )}
    </div>
  );
}
