import mongoose, { Document, Model, Schema } from "mongoose";

interface IfileSystemSchema extends Document {
  fileId: mongoose.Types.ObjectId;
}

const fileSystemSchema: Schema = new Schema(
  {
    fileId: {
      type: mongoose.Types.ObjectId,
      index: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<IfileSystemSchema>(
  "FileSystem",
  fileSystemSchema
) as Model<IfileSystemSchema>;
