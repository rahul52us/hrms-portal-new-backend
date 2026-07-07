import mongoose, { Schema, Document } from "mongoose";

interface QualificationInfo {
  file : {
  name: string;
  url: string;
  type: string;
  }
  title? : string
  validTill?: Date;
}

export interface QualificationInterface extends Document {
  user: mongoose.Schema.Types.ObjectId;
  createdBy: mongoose.Schema.Types.ObjectId;
  qualifications: {
    [key: string]: QualificationInfo;
  };
  deletedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const QualificationSchema : Schema<QualificationInterface> = new Schema<QualificationInterface>(
  {
    user: {
      type: Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    qualifications: {
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

const QualificationModel = mongoose.model<QualificationInterface>(
  "Qualification",
  QualificationSchema
);

export default QualificationModel;
