import mongoose, { Schema, Document } from "mongoose";

interface DocumentInfo {
  file : {
  name: string;
  url: string;
  type: string;
  }
  title? : string
  validTill?: Date;
}

export interface DocumentInterface extends Document {
  user: mongoose.Schema.Types.ObjectId;
  createdBy: mongoose.Schema.Types.ObjectId;
  documents: {
    [key: string]: DocumentInfo;
  };
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const DocumentSchema: Schema<DocumentInterface> = new Schema<DocumentInterface>(
  {
    user: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    documents: {
      type : mongoose.Schema.Types.Mixed,
      default: [],
    },
    deletedAt: {
      type: Date,
    },
    createdAt: {
      type: Date,
      default: new Date(),
    },
    updatedAt: {
      type: Date,
    },
  }
);

const DocumentModel = mongoose.model<DocumentInterface>(
  "Document",
  DocumentSchema
);

export default DocumentModel;
