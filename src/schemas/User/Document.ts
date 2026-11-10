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
  company?: mongoose.Types.ObjectId;
  storageSchemaVersion?: number;
  revision?: number;
  user: mongoose.Schema.Types.ObjectId;
  createdBy: mongoose.Schema.Types.ObjectId;
  documents: Array<{
    [key: string]: any;
  }>;
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const DocumentSchema: Schema<DocumentInterface> = new Schema<DocumentInterface>(
  {
    company: { type: Schema.Types.ObjectId, ref: "Company" },
    storageSchemaVersion: { type: Number },
    revision: { type: Number, default: 0, min: 0 },
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

DocumentSchema.index({ company: 1, user: 1, storageSchemaVersion: 1 }, { unique: true, partialFilterExpression: { storageSchemaVersion: 2 } });

const DocumentModel = mongoose.model<DocumentInterface>(
  "Document",
  DocumentSchema
);

export default DocumentModel;
