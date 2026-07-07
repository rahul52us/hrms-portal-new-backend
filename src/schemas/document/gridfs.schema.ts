import mongoose from "mongoose";

const GridFSFileSchema = new mongoose.Schema(
  {
    filename: String,
    metadata: mongoose.Schema.Types.Mixed,
  },
  { collection: "fs.files", strict: false }
);

export const GridFSFile = mongoose.models.GridFSFile || mongoose.model("GridFSFile", GridFSFileSchema);
